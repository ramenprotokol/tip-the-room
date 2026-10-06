import type { PayPalConfig } from "./config";
import { SANDBOX_BASE } from "./config";
import { errorFromResponse, PayPalError } from "./errors";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * An OAuth token that outlives one PayPalHttp. A long-lived owner (a Durable Object) keeps one holder and hands it to every
 * invocation's client, so a token is fetched once, not once per request. Metering stays with each client's own fetch.
 */
export class TokenHolder {
  cached?: { token: string; expiresAt: number };
  inflight?: Promise<string>;
}

export interface ClientOptions {
  /** Share a token across clients (default: each client keeps its own). */
  tokenHolder?: TokenHolder;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Total tries for a retryable failure, including the first. Default 3. */
  maxAttempts?: number;
}

export interface RequestOptions {
  method: "GET" | "POST" | "PATCH";
  /** Path starting with "/", e.g. "/v2/checkout/orders". */
  path: string;
  body?: unknown;
  /** PayPal-Request-Id. Required for a POST to be retried. */
  requestId?: string;
  prefer?: "return=representation" | "return=minimal";
}

const TOKEN_MARGIN_MS = 60_000;
const MAX_REQUEST_ID = 108;
const MAX_RETRY_AFTER_MS = 10_000;

export class PayPalHttp {
  private readonly config: PayPalConfig;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly holder: TokenHolder;

  constructor(config: PayPalConfig, opts: ClientOptions = {}) {
    if (config.baseUrl !== SANDBOX_BASE) throw new Error(`PayPal base URL must be ${SANDBOX_BASE}: this project is sandbox-only`);
    this.config = config;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.holder = opts.tokenHolder ?? new TokenHolder();
  }

  async token(force = false): Promise<string> {
    const h = this.holder;
    if (!force && h.cached && this.now() < h.cached.expiresAt - TOKEN_MARGIN_MS) return h.cached.token;
    // Concurrent callers share one token fetch.
    if (!h.inflight) {
      h.inflight = this.fetchToken().finally(() => {
        h.inflight = undefined;
      });
    }
    return h.inflight;
  }

  private async fetchToken(): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.config.clientId}:${this.config.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });
    } catch (e) {
      throw new PayPalError(0, "NETWORK_ERROR", e instanceof Error ? e.message : "network failure");
    }
    if (!res.ok) throw await errorFromResponse(res);
    const body = (await res.json().catch(() => undefined)) as { access_token?: unknown; expires_in?: unknown } | undefined;
    const token = body?.access_token;
    const expiresIn = body?.expires_in;
    if (typeof token !== "string" || token.length === 0 || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new PayPalError(502, "BAD_TOKEN_RESPONSE", "PayPal's token response was missing a usable access_token or expires_in");
    }
    this.holder.cached = { token, expiresAt: this.now() + expiresIn * 1000 };
    return token;
  }

  async request<T>(o: RequestOptions): Promise<T | undefined> {
    if (o.requestId !== undefined && (o.requestId.length === 0 || o.requestId.length > MAX_REQUEST_ID)) {
      throw new RangeError(`PayPal-Request-Id must be 1 to ${MAX_REQUEST_ID} characters`);
    }
    if (!o.path.startsWith("/")) {
      throw new RangeError('PayPal request path must start with "/"');
    }
    const canRetry = o.method === "GET" || o.requestId !== undefined;
    let refreshed = false;
    let last: PayPalError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // Building the request fetches the token. No money request has been sent yet, so a retryable token failure is safe to retry.
      // Local errors (e.g. a circular body) and non-retryable token refusals propagate unchanged.
      let init: RequestInit;
      try {
        init = await this.init(o);
      } catch (e) {
        if (!(e instanceof PayPalError) || !e.retryable || !canRetry) throw e;
        last = e;
        await this.sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      let res: Response;
      try {
        res = await this.fetchFn(`${this.config.baseUrl}${o.path}`, init);
      } catch (e) {
        last = new PayPalError(0, "NETWORK_ERROR", e instanceof Error ? e.message : "network failure");
        if (!canRetry) throw last;
        await this.sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        try {
          await this.token(true);
        } catch (e) {
          if (!(e instanceof PayPalError) || !e.retryable || !canRetry) throw e;
          last = e;
          this.holder.cached = undefined; // the old token is dead: the next attempt must fetch a fresh one
          await this.sleep(250 * 2 ** (attempt - 1));
          continue;
        }
        attempt -= 1; // a token refresh is not a retry
        continue;
      }
      if (res.status === 204) return undefined;
      if (res.ok) {
        const text = await res.text();
        if (!text) return undefined;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new PayPalError(502, "BAD_RESPONSE_BODY", `PayPal answered ${res.status} with a body that is not JSON`);
        }
      }
      last = await errorFromResponse(res);
      if (!last.retryable || !canRetry) throw last;
      await this.sleep(this.retryDelay(res, attempt));
    }
    if (!last) throw new Error("PayPal request made no attempts");
    throw last;
  }

  /** Backoff 250 ms, 500 ms, 1 s…, or PayPal's Retry-After (seconds or an HTTP date) if longer, capped at 10 s. */
  private retryDelay(res: Response, attempt: number): number {
    const backoff = 250 * 2 ** (attempt - 1);
    const header = res.headers.get("retry-after");
    if (!header) return backoff;
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - this.now();
    if (!Number.isFinite(ms)) return backoff;
    return Math.min(Math.max(ms, backoff), MAX_RETRY_AFTER_MS);
  }

  private async init(o: RequestOptions): Promise<RequestInit> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}`, accept: "application/json" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.requestId) headers["paypal-request-id"] = o.requestId;
    if (o.prefer) headers["prefer"] = o.prefer;
    return { method: o.method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) };
  }
}

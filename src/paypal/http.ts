import type { PayPalConfig } from "./config";
import { errorFromResponse, PayPalError } from "./errors";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
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

export class PayPalHttp {
  private readonly config: PayPalConfig;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private cached?: { token: string; expiresAt: number };

  constructor(config: PayPalConfig, opts: ClientOptions = {}) {
    this.config = config;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  async token(force = false): Promise<string> {
    if (!force && this.cached && this.now() < this.cached.expiresAt - TOKEN_MARGIN_MS) return this.cached.token;
    const res = await this.fetchFn(`${this.config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${this.config.clientId}:${this.config.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw await errorFromResponse(res);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async request<T>(o: RequestOptions): Promise<T | undefined> {
    if (o.requestId !== undefined && (o.requestId.length === 0 || o.requestId.length > MAX_REQUEST_ID)) {
      throw new RangeError(`PayPal-Request-Id must be 1 to ${MAX_REQUEST_ID} characters`);
    }
    const canRetry = o.method === "GET" || o.requestId !== undefined;
    let refreshed = false;
    let last: PayPalError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.config.baseUrl}${o.path}`, await this.init(o));
      } catch (e) {
        last = new PayPalError(0, "NETWORK_ERROR", e instanceof Error ? e.message : "network failure");
        if (!canRetry) throw last;
        await this.sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.token(true);
        attempt -= 1; // a token refresh is not a retry
        continue;
      }
      if (res.status === 204) return undefined;
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T | undefined;
      }
      last = await errorFromResponse(res);
      if (!last.retryable || !canRetry) throw last;
      await this.sleep(250 * 2 ** (attempt - 1));
    }
    if (!last) throw new Error("PayPal request made no attempts");
    throw last;
  }

  private async init(o: RequestOptions): Promise<RequestInit> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}`, accept: "application/json" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.requestId) headers["paypal-request-id"] = o.requestId;
    if (o.prefer) headers["prefer"] = o.prefer;
    return { method: o.method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) };
  }
}

# Plan 3 · PayPal Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the PayPal sandbox calls Tip the Room depends on (spec section 10, spikes 1, 2, 3 and 6). Then build the typed, idempotent PayPal REST client, webhook verification and mapping, and a scripted sandbox integration run (spec section 9).

**Architecture:**
- `src/paypal/` is server-side TypeScript, used later by the Worker in Plan 4. It never runs in the browser. Its only I/O is an injected `fetch`, so every unit test runs offline against a fake fetch.
- Every money call carries a **deterministic** `PayPal-Request-Id`, derived from the PayPal id it acts on: `capture:<authId>`, `void:<authId>`, `reauth:<authId>`, `refund:<captureId>`, `hold:<showId>:<pledgeId>`, `authorize:<orderId>`. A payout batch uses `sender_batch_id = payout-<showId>`. Replaying an event can therefore never double-charge or double-pay (Plan 1 ledger notes).
- Live sandbox work happens only in `scripts/`, run by hand with `npm run spike` / `npm run sandbox:check`, never inside `npm test`.

**Tech Stack:** Node 22, TypeScript 6, Vitest 5, tsx (new dev dependency) for running TS scripts with `node --env-file=.dev.vars --import tsx`. Spike 6 only: wrangler + `@paypal/agent-toolkit` in an isolated `spikes/agent-toolkit/` folder.

## Global Constraints

- Repo: `<repo>`. The git identity is ramenprotokol automatically; never change git config.
- **Never** `git push`, deploy (`wrangler deploy` is forbidden, except `--dry-run`), or publish anything. Commit locally only, on branch `plan-3-paypal-sandbox`.
- **Never** read or write outside the repo (plus the npm cache).
- **Secrets:**
  - `.dev.vars` holds `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`.
  - Never `cat`, print, log, echo or commit their values, or any access token. Load them only with `node --env-file=.dev.vars`.
  - Do not edit `.dev.vars`, except to **append** the optional `PAYPAL_SPIKE_PAYOUT_EMAIL=` line if asked.
  - Error messages and logs may name a variable, never show its value.
- **Sandbox only:** the client must refuse any base URL other than `https://api-m.sandbox.paypal.com`.
- Money is integer cents (`Cents` from `src/core/money.ts`). Convert to PayPal's `"15.00"` strings with integer maths only, never `toFixed` on floats.
- Plain-English copy rules from spec 2c apply to anything user-facing. This plan has no UI; `src/web/` and `reference/` must not change, and the GPU parity suite must stay green.
- **Never fake a PayPal ID** (spec 6.3). Fixture files hold real sandbox responses, with personal fields redacted (`email_address`, `merchant_id`, `payer_id`, `account_id` → `"REDACTED"`).
- Run commands from the repo root. Every implementer commit message ends with:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

---

## File structure

| File | Responsibility |
|---|---|
| `src/paypal/config.ts` | Read env → `PayPalConfig`; sandbox-only guard |
| `src/paypal/errors.ts` | `PayPalError` + parsing PayPal error bodies |
| `src/paypal/http.ts` | OAuth token cache, `request()` with request id, retries, 401 refresh |
| `src/paypal/amount.ts` | Cents ⇄ `"15.00"` with integer maths |
| `src/paypal/payments.ts` | Orders, authorize, card holds, capture, void, reauthorize, refund |
| `src/paypal/payouts.ts` | Deterministic payout batch from `PayoutLine[]`; batch status |
| `src/paypal/webhooks.ts` | Signature verification via PayPal; event → `PayPalLedgerEvent` |
| `src/paypal/index.ts` | Barrel |
| `scripts/spikes/paypal-sandbox.ts` | Day-1 spike: live calls, writes fixtures + findings JSON |
| `scripts/sandbox-check.ts` | Spec-9 integration run with the typed client |
| `scripts/lib/redact.ts` | Redact personal fields before saving fixtures |
| `tests/paypal/*.test.ts` | Offline unit tests (fake fetch + fixtures) |
| `tests/paypal/fixtures/*.json` | Real, redacted sandbox responses from the spike |
| `docs/superpowers/spikes/2026-10-05-paypal-sandbox.md` | Spike findings and go/no-go decisions |
| `spikes/agent-toolkit/` | Isolated Worker spike for `@paypal/agent-toolkit` |

---

### Task 1: Sandbox config, errors and HTTP core

**Files:**
- Create: `src/paypal/config.ts`, `src/paypal/errors.ts`, `src/paypal/http.ts`, `src/paypal/index.ts`
- Create: `tests/paypal/fake-fetch.ts`, `tests/paypal/http.test.ts`
- Modify: `package.json` (add `tsx` dev dependency, scripts), `tsconfig.json` (`include` adds `"scripts"`)

**Interfaces:**
- Produces:
  - `loadConfig(env: PayPalEnv): PayPalConfig`
  - `SANDBOX_BASE`
  - `class PayPalError { status; paypalName; debugId?; issues; retryable; hasIssue(code) }`
  - `class PayPalHttp { constructor(config, opts?); token(): Promise<string>; request<T>(o: RequestOptions): Promise<T | undefined> }`
  - `type FetchLike`
  - `tests/paypal/fake-fetch.ts`, exporting `fakeFetch(responses)` → `{ fetch, calls }`

- [ ] **Step 0: Branch and tooling**

```bash
git checkout plan-3-paypal-sandbox   # branch already created by the controller
npm install --save-dev tsx@^4
```

In `package.json`, add these scripts:

```json
"spike": "node --env-file=.dev.vars --import tsx scripts/spikes/paypal-sandbox.ts",
"sandbox:check": "node --env-file=.dev.vars --import tsx scripts/sandbox-check.ts"
```

In `tsconfig.json`, set `"include": ["src", "tests", "scripts", "vite.config.ts", "playwright.config.ts"]`.

- [ ] **Step 1: Write the fake fetch helper**

`tests/paypal/fake-fetch.ts`:

```ts
import type { FetchLike } from "../../src/paypal/http";

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Throw instead of answering (simulates a network failure). */
  networkError?: boolean;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Answers calls in order. Token calls (`/v1/oauth2/token`) are answered automatically and not consumed. */
export function fakeFetch(responses: FakeResponse[], tokenExpiresIn = 32400) {
  const queue = [...responses];
  const calls: RecordedCall[] = [];
  let tokenCalls = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : undefined });
    if (url.endsWith("/v1/oauth2/token")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: tokenExpiresIn, token_type: "Bearer" }), { status: 200 });
    }
    const next = queue.shift();
    if (!next) throw new Error(`fakeFetch: no response queued for ${init.method} ${url}`);
    if (next.networkError) throw new TypeError("fetch failed");
    if (next.status === 204) return new Response(null, { status: 204 });
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status });
  };
  return { fetch, calls, apiCalls: () => calls.filter((c) => !c.url.endsWith("/v1/oauth2/token")), tokenCalls: () => tokenCalls };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/paypal/http.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig, SANDBOX_BASE } from "../../src/paypal/config";
import { PayPalError } from "../../src/paypal/errors";
import { PayPalHttp } from "../../src/paypal/http";
import { fakeFetch } from "./fake-fetch";

const config = { clientId: "id", clientSecret: "secret", baseUrl: SANDBOX_BASE };
const noSleep = async () => {};

describe("loadConfig", () => {
  it("reads the three variables and defaults the base to sandbox", () => {
    expect(loadConfig({ PAYPAL_CLIENT_ID: " a ", PAYPAL_CLIENT_SECRET: "b" })).toEqual({ clientId: "a", clientSecret: "b", baseUrl: SANDBOX_BASE });
  });
  it("strips a trailing slash from the base", () => {
    expect(loadConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_API_BASE: `${SANDBOX_BASE}/` }).baseUrl).toBe(SANDBOX_BASE);
  });
  it("refuses missing keys without echoing any value", () => {
    expect(() => loadConfig({ PAYPAL_CLIENT_ID: "a" })).toThrow(/PAYPAL_CLIENT_SECRET/);
  });
  it("refuses the live API", () => {
    expect(() => loadConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_API_BASE: "https://api-m.paypal.com" })).toThrow(/sandbox-only/);
  });
  it("never puts the secret in an error message", () => {
    try {
      loadConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "s3cr3t", PAYPAL_API_BASE: "https://evil.example" });
    } catch (e) {
      expect(String(e)).not.toContain("s3cr3t");
    }
  });
});

describe("PayPalHttp", () => {
  it("gets a token once and reuses it until near expiry", async () => {
    let now = 0;
    const f = fakeFetch([{ status: 200, body: { a: 1 } }, { status: 200, body: { a: 2 } }, { status: 200, body: { a: 3 } }], 3600);
    const http = new PayPalHttp(config, { fetch: f.fetch, now: () => now, sleep: noSleep });
    await http.request({ method: "GET", path: "/x" });
    await http.request({ method: "GET", path: "/x" });
    expect(f.tokenCalls()).toBe(1);
    now = (3600 - 59) * 1000; // inside the 60 s safety margin
    await http.request({ method: "GET", path: "/x" });
    expect(f.tokenCalls()).toBe(2);
  });

  it("sends basic auth for the token and bearer auth for calls", async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    await http.request({ method: "GET", path: "/x" });
    expect(f.calls[0].headers.authorization).toBe(`Basic ${btoa("id:secret")}`);
    expect(f.calls[0].body).toBe("grant_type=client_credentials");
    expect(f.calls[1].headers.authorization).toBe("Bearer tok-1");
  });

  it("sends JSON, the request id and Prefer", async () => {
    const f = fakeFetch([{ status: 201, body: { id: "C1" } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    const out = await http.request<{ id: string }>({ method: "POST", path: "/v2/y", body: { a: 1 }, requestId: "capture:A1", prefer: "return=representation" });
    expect(out).toEqual({ id: "C1" });
    const call = f.apiCalls()[0];
    expect(call.url).toBe(`${SANDBOX_BASE}/v2/y`);
    expect(call.headers["paypal-request-id"]).toBe("capture:A1");
    expect(call.headers["prefer"]).toBe("return=representation");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toBe('{"a":1}');
  });

  it("returns undefined for 204", async () => {
    const f = fakeFetch([{ status: 204 }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    expect(await http.request({ method: "POST", path: "/v2/z/void", requestId: "void:A1" })).toBeUndefined();
  });

  it("retries 5xx, 429 and network errors with the SAME request id", async () => {
    const f = fakeFetch([{ status: 503, body: { name: "SERVICE_UNAVAILABLE" } }, { status: 0, networkError: true }, { status: 201, body: { ok: true } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep, maxAttempts: 3 });
    await http.request({ method: "POST", path: "/p", body: {}, requestId: "r-1" });
    expect(f.apiCalls().map((c) => c.headers["paypal-request-id"])).toEqual(["r-1", "r-1", "r-1"]);
  });

  it("never retries a POST that has no request id", async () => {
    const f = fakeFetch([{ status: 500, body: { name: "INTERNAL_SERVER_ERROR" } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    await expect(http.request({ method: "POST", path: "/p", body: {} })).rejects.toBeInstanceOf(PayPalError);
    expect(f.apiCalls()).toHaveLength(1);
  });

  it("does not retry 4xx and maps the PayPal error body", async () => {
    const f = fakeFetch([
      { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "nope", debug_id: "dbg1", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED", description: "d" }] } },
    ]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    const err = (await http.request({ method: "POST", path: "/p", requestId: "r" }).catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(422);
    expect(err.paypalName).toBe("UNPROCESSABLE_ENTITY");
    expect(err.debugId).toBe("dbg1");
    expect(err.hasIssue("AUTHORIZATION_ALREADY_CAPTURED")).toBe(true);
    expect(err.retryable).toBe(false);
    expect(f.apiCalls()).toHaveLength(1);
  });

  it("refreshes the token once on 401, then succeeds", async () => {
    const f = fakeFetch([{ status: 401, body: { error: "invalid_token" } }, { status: 200, body: { ok: 1 } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    expect(await http.request({ method: "GET", path: "/x" })).toEqual({ ok: 1 });
    expect(f.tokenCalls()).toBe(2);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const f = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep, maxAttempts: 3 });
    const err = (await http.request({ method: "GET", path: "/x" }).catch((e) => e)) as PayPalError;
    expect(err.status).toBe(500);
    expect(f.apiCalls()).toHaveLength(3);
  });

  it("rejects a request id longer than PayPal's 108-character limit", async () => {
    const f = fakeFetch([]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    await expect(http.request({ method: "POST", path: "/p", requestId: "x".repeat(109) })).rejects.toThrow(/108/);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run tests/paypal/http.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement**

`src/paypal/config.ts`:

```ts
export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

export interface PayPalEnv {
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_API_BASE?: string;
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/** Reads the sandbox keys. Never puts a key's value in an error message. */
export function loadConfig(env: PayPalEnv): PayPalConfig {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  const missing = [!clientId && "PAYPAL_CLIENT_ID", !clientSecret && "PAYPAL_CLIENT_SECRET"].filter(Boolean);
  if (missing.length) throw new Error(`PayPal sandbox keys are missing: set ${missing.join(" and ")} in .dev.vars`);
  const baseUrl = (env.PAYPAL_API_BASE?.trim() || SANDBOX_BASE).replace(/\/+$/, "");
  if (baseUrl !== SANDBOX_BASE) throw new Error(`PAYPAL_API_BASE must be ${SANDBOX_BASE}: this project is sandbox-only`);
  return { clientId: clientId!, clientSecret: clientSecret!, baseUrl };
}
```


`src/paypal/errors.ts`:

```ts
export interface PayPalIssue {
  issue: string;
  description?: string;
  field?: string;
}

export class PayPalError extends Error {
  readonly status: number;
  readonly paypalName: string;
  readonly debugId?: string;
  readonly issues: PayPalIssue[];

  constructor(status: number, paypalName: string, message: string, debugId?: string, issues: PayPalIssue[] = []) {
    super(`PayPal ${status} ${paypalName}: ${message}${debugId ? ` (debug_id ${debugId})` : ""}`);
    this.name = "PayPalError";
    this.status = status;
    this.paypalName = paypalName;
    this.debugId = debugId;
    this.issues = issues;
  }

  /** Network failures (status 0), rate limits and PayPal-side errors are worth retrying with the same request id. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  hasIssue(code: string): boolean {
    return this.issues.some((i) => i.issue === code);
  }
}

interface ErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: PayPalIssue[];
  error?: string;
  error_description?: string;
}

export async function errorFromResponse(res: Response): Promise<PayPalError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    // Non-JSON body: keep the status only.
  }
  const name = body.name ?? body.error ?? `HTTP_${res.status}`;
  const message = body.message ?? body.error_description ?? res.statusText ?? "request failed";
  return new PayPalError(res.status, name, message, body.debug_id, Array.isArray(body.details) ? body.details : []);
}
```

`src/paypal/http.ts`:

```ts
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
    throw last!;
  }

  private async init(o: RequestOptions): Promise<RequestInit> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}`, accept: "application/json" };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    if (o.requestId) headers["paypal-request-id"] = o.requestId;
    if (o.prefer) headers["prefer"] = o.prefer;
    return { method: o.method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) };
  }
}
```

`src/paypal/index.ts`:

```ts
export * from "./config";
export * from "./errors";
export * from "./http";
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run tests/paypal/http.test.ts`
Expected: PASS (all tests).

Then run `npm run typecheck && npm run lint && npm test`. Expected: all green, including the existing core tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/paypal tests/paypal
git commit -m "feat(paypal): sandbox-only config, error mapping, HTTP core with token cache and idempotent retries"
```

---

### Task 2: Day-1 sandbox spike (live)

This task calls the real sandbox. Its findings decide details in Tasks 3–6. **Report every surprise; do not paper over one.**

**Files:**
- Create: `scripts/lib/redact.ts`, `tests/paypal/redact.test.ts`
- Create: `scripts/spikes/paypal-sandbox.ts`
- Create (output): `tests/paypal/fixtures/*.json`, `docs/superpowers/spikes/2026-10-05-paypal-sandbox.md`

**Interfaces:**
- Consumes: `loadConfig`, `PayPalHttp`, `PayPalError` (Task 1).
- Produces:
  - `redact(value: unknown): unknown`
  - Fixture files, named exactly: `order-card-authorize.json`, `authorize-order.json` (only if a CREATED/APPROVED order needed a separate authorize call), `capture.json`, `capture-replay.json`, `void.json` (the body, or `{"status":204}`), `reauthorize-error.json`, `refund.json`, `payout-create.json`, `payout-duplicate.json`, `payout-get.json`
  - The findings doc.

- [ ] **Step 1: Write the redaction test, then the redactor**

`tests/paypal/redact.test.ts`:

```ts
import { expect, it } from "vitest";
import { redact } from "../../scripts/lib/redact";

it("redacts personal fields at any depth and keeps everything else", () => {
  const input = { id: "A1", payee: { email_address: "sb-x@business.example.com", merchant_id: "M1" }, list: [{ payer_id: "P", account_id: "Q", amount: "1.00" }] };
  expect(redact(input)).toEqual({ id: "A1", payee: { email_address: "REDACTED", merchant_id: "REDACTED" }, list: [{ payer_id: "REDACTED", account_id: "REDACTED", amount: "1.00" }] });
});
```

`scripts/lib/redact.ts`:

```ts
const PERSONAL = new Set(["email_address", "merchant_id", "payer_id", "account_id", "receiver", "phone_number", "national_number"]);

/** Deep copy with personal fields replaced by "REDACTED", for saving sandbox responses as test fixtures. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, PERSONAL.has(k) ? "REDACTED" : redact(v)]));
  }
  return value;
}
```

Run `npx vitest run tests/paypal/redact.test.ts` and confirm it passes. (`receiver` is the payout recipient email.)

- [ ] **Step 2: Write the spike script**

`scripts/spikes/paypal-sandbox.ts`:

```ts
// Day-1 PayPal sandbox spike. Run: npm run spike
// Prints only statuses, PayPal error names and ids. Never prints keys or tokens.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../../src/paypal/config";
import { PayPalError } from "../../src/paypal/errors";
import { PayPalHttp } from "../../src/paypal/http";
import { redact } from "../lib/redact";

const FIX = "tests/paypal/fixtures";
mkdirSync(FIX, { recursive: true });
const http = new PayPalHttp(loadConfig(process.env));
const run = `spike-${Date.now()}`;
const results: { check: string; ok: boolean; detail: string }[] = [];

function save(name: string, body: unknown) {
  writeFileSync(`${FIX}/${name}.json`, JSON.stringify(redact(body), null, 2) + "\n");
}
function record(check: string, ok: boolean, detail: string) {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check}  ·  ${detail}`);
}
function errDetail(e: unknown): string {
  return e instanceof PayPalError ? `${e.status} ${e.paypalName} [${e.issues.map((i) => i.issue).join(", ")}] debug_id=${e.debugId ?? "-"}` : String(e);
}

type Auth = { id: string; status: string; create_time?: string; expiration_time?: string };
type Order = { id: string; status: string; purchase_units?: { payments?: { authorizations?: Auth[] } }[] };

/** Spike 3, option 1: a server-side card authorization (no buyer login). */
async function cardHold(tag: string): Promise<Auth> {
  const order = (await http.request<Order>({
    method: "POST",
    path: "/v2/checkout/orders",
    requestId: `${run}-order-${tag}`,
    prefer: "return=representation",
    body: {
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: "pledge", custom_id: `${run}:${tag}`, amount: { currency_code: "USD", value: "15.00" } }],
      payment_source: { card: { number: "4111111111111111", expiry: "2030-12", security_code: "123", name: "Simulated Fan" } },
    },
  }))!;
  if (tag === "a") save("order-card-authorize", order);
  let auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) {
    // The order was created but not authorized yet: authorize it explicitly.
    const authorized = (await http.request<Order>({ method: "POST", path: `/v2/checkout/orders/${order.id}/authorize`, requestId: `${run}-authorize-${tag}`, prefer: "return=representation", body: {} }))!;
    if (tag === "a") save("authorize-order", authorized);
    auth = authorized.purchase_units?.[0]?.payments?.authorizations?.[0];
  }
  if (!auth) throw new Error(`order ${order.id} (${order.status}) has no authorization`);
  return auth;
}

async function main() {
  // 1. Token
  try {
    await http.token();
    record("token", true, "sandbox OAuth token issued");
  } catch (e) {
    record("token", false, errDetail(e));
    return;
  }

  // 2. Card hold (spike 3 option 1) + capture + idempotent replay
  let captureId: string | undefined;
  try {
    const a = await cardHold("a");
    record("card hold", true, `authorization ${a.id} status ${a.status} created ${a.create_time} expires ${a.expiration_time}`);
    const cap = await http.request<{ id: string; status: string }>({ method: "POST", path: `/v2/payments/authorizations/${a.id}/capture`, requestId: `capture:${a.id}`, prefer: "return=representation", body: { final_capture: true } });
    save("capture", cap);
    captureId = cap!.id;
    record("capture", cap!.status === "COMPLETED", `capture ${cap!.id} status ${cap!.status}`);
    const again = await http.request<{ id: string; status: string }>({ method: "POST", path: `/v2/payments/authorizations/${a.id}/capture`, requestId: `capture:${a.id}`, prefer: "return=representation", body: { final_capture: true } });
    save("capture-replay", again);
    record("capture replay is idempotent", again!.id === cap!.id, `replay returned ${again!.id}`);
  } catch (e) {
    record("card hold / capture", false, errDetail(e));
  }

  // 3. Void
  try {
    const b = await cardHold("b");
    const v = await http.request({ method: "POST", path: `/v2/payments/authorizations/${b.id}/void`, requestId: `void:${b.id}`, prefer: "return=representation" });
    save("void", v ?? { status: 204 });
    record("void", true, `voided ${b.id}`);
  } catch (e) {
    record("void", false, errDetail(e));
  }

  // 4. Reauthorize inside the honor period (expected to be refused; record exactly how)
  try {
    const c = await cardHold("c");
    const r = await http.request({ method: "POST", path: `/v2/payments/authorizations/${c.id}/reauthorize`, requestId: `reauth:${c.id}`, prefer: "return=representation", body: { amount: { currency_code: "USD", value: "15.00" } } });
    save("reauthorize-error", { unexpectedSuccess: r });
    record("reauthorize on day 0", true, "UNEXPECTED: PayPal allowed it on day 0");
    await http.request({ method: "POST", path: `/v2/payments/authorizations/${c.id}/void`, requestId: `void:${c.id}` }).catch(() => undefined);
  } catch (e) {
    if (e instanceof PayPalError) save("reauthorize-error", { status: e.status, name: e.paypalName, issues: e.issues });
    record("reauthorize on day 0 refused (expected)", e instanceof PayPalError && e.status < 500, errDetail(e));
  }

  // 5. Refund
  if (captureId) {
    try {
      const rf = await http.request<{ id: string; status: string }>({ method: "POST", path: `/v2/payments/captures/${captureId}/refund`, requestId: `refund:${captureId}`, prefer: "return=representation", body: {} });
      save("refund", rf);
      record("refund", true, `refund ${rf!.id} status ${rf!.status}`);
    } catch (e) {
      record("refund", false, errDetail(e));
    }
  }

  // 6. Payouts (spike 2) + duplicate sender_batch_id
  const receiver = process.env.PAYPAL_SPIKE_PAYOUT_EMAIL?.trim() || "spike-room@example.com";
  const batch = {
    sender_batch_header: { sender_batch_id: `payout-${run}`, email_subject: "Tip the Room payout", recipient_type: "EMAIL" },
    items: [{ recipient_type: "EMAIL", receiver, amount: { value: "1.00", currency: "USD" }, sender_item_id: `${run}-room`, note: "Spike payout" }],
  };
  try {
    const p = await http.request<{ batch_header: { payout_batch_id: string; batch_status: string } }>({ method: "POST", path: "/v1/payments/payouts", requestId: `payout-${run}`, body: batch });
    save("payout-create", p);
    record("payouts enabled", true, `batch ${p!.batch_header.payout_batch_id} status ${p!.batch_header.batch_status} (receiver is ${receiver === "spike-room@example.com" ? "an unclaimed example address" : "PAYPAL_SPIKE_PAYOUT_EMAIL"})`);
    try {
      const dup = await http.request({ method: "POST", path: "/v1/payments/payouts", requestId: `payout-${run}-dup`, body: batch });
      save("payout-duplicate", { unexpectedSuccess: dup });
      record("duplicate sender_batch_id refused", false, "UNEXPECTED: PayPal accepted a second batch with the same sender_batch_id");
    } catch (e) {
      if (e instanceof PayPalError) save("payout-duplicate", { status: e.status, name: e.paypalName, issues: e.issues });
      record("duplicate sender_batch_id refused", e instanceof PayPalError, errDetail(e));
    }
    await new Promise((r) => setTimeout(r, 5000));
    const g = await http.request({ method: "GET", path: `/v1/payments/payouts/${p!.batch_header.payout_batch_id}` });
    save("payout-get", g);
    record("payout batch readable", true, "fetched batch status");
  } catch (e) {
    record("payouts enabled", false, `${errDetail(e)}  → owner may need to tick "Payouts" in the sandbox app's features`);
  }

  writeFileSync("docs/superpowers/spikes/.spike-results.json", JSON.stringify({ run, results }, null, 2) + "\n");
}

await main();
```

- [ ] **Step 3: Run the spike**

```bash
mkdir -p docs/superpowers/spikes
npm run spike
```

Expected: a PASS/FAIL line per check, and fixtures in `tests/paypal/fixtures/`.

- If **card hold** fails, record the exact error. Then try **once** more, with the sandbox card PayPal documents for its card tests (Visa `4032039317984658`, expiry `2030-12`). If both fail, simulated fans fall back to spec 6.3 option 3 ("simulated" rows, no PayPal ids), and the judge's own pledge stays a real hold.
- If **payouts** fails with an authorization or permission error, **stop and report it.** The owner must enable Payouts in the sandbox app, and you must not try to work around it.
- Check that no fixture contains an unredacted email: `grep -rE '@[a-z0-9.-]+\.(com|net)' tests/paypal/fixtures` should print nothing.

- [ ] **Step 4: Write the findings doc**

Create `docs/superpowers/spikes/2026-10-05-paypal-sandbox.md` from `.spike-results.json`. It needs a table (Check | Result | Evidence: status, PayPal name and issue codes, never ids of personal accounts) and a **Decisions** section that answers:
1. **Simulated fans:** which option of spec 6.3 to use.
2. **Order shape:** does a card order come back with `purchase_units[0].payments.authorizations[0]` straight away, or does it need `/authorize`?
3. **Idempotent capture replay:** is the same capture id returned?
4. **Reauthorize:** the exact refusal on day 0. **Day 4–29 rule:** quote PayPal's documented rule ("reauthorize once, between day 4 and day 29", if the docs say so) with a link from `developer.paypal.com`, and mark it "unverified live until a hold is 4+ days old".
5. **Payouts:** does it work, what does the batch status look like, and what does a duplicate `sender_batch_id` return?
6. **Fees:** where in the capture response do gross, fee and net amounts live (`seller_receivable_breakdown`)?

Then delete `.spike-results.json`; the doc replaces it.

- [ ] **Step 5: Commit**

```bash
git add scripts tests/paypal docs/superpowers/spikes
git commit -m "spike(paypal): day-1 sandbox spike with redacted fixtures and findings"
```

**Controller gate:** Opus reads the findings before dispatching Task 3. If a finding contradicts the shapes assumed below, Opus amends Tasks 3–6 first.

---

### Task 3: Payments: holds, capture, void, reauthorize, refund

**Files:**
- Create: `src/paypal/amount.ts`, `src/paypal/payments.ts`
- Create: `tests/paypal/amount.test.ts`, `tests/paypal/payments.test.ts`
- Modify: `src/paypal/index.ts`

**Interfaces:**
- Consumes: `PayPalHttp` (Task 1); fixtures `order-card-authorize.json`, `capture.json`, `refund.json`, `reauthorize-error.json` (Task 2); `Cents` from `src/core/money`.
- Produces:
  - `centsToValue(c: Cents): string`, `valueToCents(v: string): Cents`
  - `interface Hold { authorizationId; orderId; amountCents; status; createdAt: number; expiresAt: number }`
  - `interface Charge { captureId; authorizationId; status; grossCents?; feeCents?; netCents? }`
  - `interface Refund { refundId; captureId; status }`
  - `createPledgeOrder(http, p: PledgeRef): Promise<{ orderId: string }>`
  - `authorizeOrder(http, orderId): Promise<Hold>`
  - `createCardHold(http, p: PledgeRef, card: TestCard): Promise<Hold>`
  - `captureHold(http, authorizationId): Promise<Charge>`
  - `voidHold(http, authorizationId): Promise<void>`
  - `reauthorizeHold(http, authorizationId, amountCents): Promise<Hold>`
  - `refundCharge(http, captureId): Promise<Refund>`
  - `requestIds` (the deterministic id builders)
  - `interface PledgeRef { showId: string; pledgeId: string; amountCents: Cents; description: string }`
  - `interface TestCard { number: string; expiry: string; securityCode: string; name: string }`

If Task 2's findings changed a response shape, **the fixture wins**: parse what PayPal actually returned, and say so in your report.

- [ ] **Step 1: Write the failing tests**

`tests/paypal/amount.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { centsToValue, valueToCents } from "../../src/paypal/amount";

describe("amount", () => {
  it.each([[0, "0.00"], [5, "0.05"], [1500, "15.00"], [123456, "1234.56"]])("%i cents → %s", (c, v) => expect(centsToValue(c)).toBe(v));
  it.each([["15.00", 1500], ["15", 1500], ["15.5", 1550], ["0.05", 5], ["1234.56", 123456]])("%s → %i cents", (v, c) => expect(valueToCents(v)).toBe(c));
  it("rejects bad cents", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => centsToValue(bad)).toThrow(RangeError);
  });
  it("rejects bad values", () => {
    for (const bad of ["", "1.234", "-1.00", "1e3", " 1.00", "abc"]) expect(() => valueToCents(bad)).toThrow(RangeError);
  });
});
```

`tests/paypal/payments.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SANDBOX_BASE } from "../../src/paypal/config";
import { PayPalError } from "../../src/paypal/errors";
import { PayPalHttp } from "../../src/paypal/http";
import { authorizeOrder, captureHold, createCardHold, createPledgeOrder, reauthorizeHold, refundCharge, requestIds, voidHold } from "../../src/paypal/payments";
import { fakeFetch } from "./fake-fetch";

const fixture = (name: string) => JSON.parse(readFileSync(`tests/paypal/fixtures/${name}.json`, "utf8"));
const client = (responses: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(responses);
  return { f, http: new PayPalHttp({ clientId: "i", clientSecret: "s", baseUrl: SANDBOX_BASE }, { fetch: f.fetch, sleep: async () => {} }) };
};
const pledge = { showId: "show1", pledgeId: "p7", amountCents: 1500, description: "Hold for Lucky's Café show" };
const card = { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Simulated Fan" };

describe("request ids", () => {
  it("are deterministic and within 108 chars", () => {
    expect(requestIds.hold("show1", "p7")).toBe("hold:show1:p7");
    expect(requestIds.capture("A1")).toBe("capture:A1");
    expect(requestIds.void("A1")).toBe("void:A1");
    expect(requestIds.reauthorize("A1")).toBe("reauth:A1");
    expect(requestIds.refund("C1")).toBe("refund:C1");
    expect(requestIds.authorize("O1")).toBe("authorize:O1");
  });
});

describe("createPledgeOrder", () => {
  it("creates an AUTHORIZE order in USD with the pledge as custom_id", async () => {
    const { f, http } = client([{ status: 201, body: { id: "O1", status: "CREATED" } }]);
    expect(await createPledgeOrder(http, pledge)).toEqual({ orderId: "O1" });
    const call = f.apiCalls()[0];
    expect(call.url).toBe(`${SANDBOX_BASE}/v2/checkout/orders`);
    expect(call.headers["paypal-request-id"]).toBe("order:show1:p7");
    expect(JSON.parse(call.body!)).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: "show1", custom_id: "show1:p7", description: "Hold for Lucky's Café show", amount: { currency_code: "USD", value: "15.00" } }],
    });
  });
});

describe("createCardHold", () => {
  it("parses the real sandbox card order into a Hold", async () => {
    const body = fixture("order-card-authorize");
    const { f, http } = client([{ status: 201, body }]);
    const hold = await createCardHold(http, pledge, card);
    const auth = body.purchase_units[0].payments.authorizations[0];
    expect(hold).toEqual({
      authorizationId: auth.id,
      orderId: body.id,
      amountCents: 1500,
      status: auth.status,
      createdAt: Date.parse(auth.create_time),
      expiresAt: Date.parse(auth.expiration_time),
    });
    expect(f.apiCalls()[0].headers["paypal-request-id"]).toBe("hold:show1:p7");
    expect(JSON.parse(f.apiCalls()[0].body!).payment_source.card).toEqual({ number: card.number, expiry: card.expiry, security_code: "123", name: card.name });
  });

  it("authorizes explicitly when the order comes back without an authorization", async () => {
    const authorized = fixture("order-card-authorize");
    const { f, http } = client([{ status: 201, body: { id: authorized.id, status: "APPROVED" } }, { status: 201, body: authorized }]);
    const hold = await createCardHold(http, pledge, card);
    expect(hold.orderId).toBe(authorized.id);
    expect(f.apiCalls()[1].url).toBe(`${SANDBOX_BASE}/v2/checkout/orders/${authorized.id}/authorize`);
    expect(f.apiCalls()[1].headers["paypal-request-id"]).toBe(`authorize:${authorized.id}`);
  });

  it("throws when PayPal returns no authorization at all", async () => {
    const { http } = client([{ status: 201, body: { id: "O9", status: "APPROVED" } }, { status: 201, body: { id: "O9", status: "APPROVED" } }]);
    await expect(createCardHold(http, pledge, card)).rejects.toThrow(/O9/);
  });
});

describe("authorizeOrder", () => {
  it("authorizes a buyer-approved order", async () => {
    const body = fixture("order-card-authorize");
    const { f, http } = client([{ status: 201, body }]);
    const hold = await authorizeOrder(http, body.id);
    expect(hold.orderId).toBe(body.id);
    expect(f.apiCalls()[0].headers["paypal-request-id"]).toBe(`authorize:${body.id}`);
  });
});

describe("captureHold", () => {
  it("parses the real capture, including gross, fee and net", async () => {
    const body = fixture("capture");
    const { f, http } = client([{ status: 201, body }]);
    const charge = await captureHold(http, "AUTH1");
    expect(charge.captureId).toBe(body.id);
    expect(charge.authorizationId).toBe("AUTH1");
    expect(charge.status).toBe(body.status);
    const b = body.seller_receivable_breakdown;
    if (b) {
      expect(charge.grossCents).toBe(Math.round(Number(b.gross_amount.value) * 100));
      expect(charge.netCents).toBe(Math.round(Number(b.net_amount.value) * 100));
      expect(charge.grossCents! - charge.feeCents!).toBe(charge.netCents);
    }
    const call = f.apiCalls()[0];
    expect(call.url).toBe(`${SANDBOX_BASE}/v2/payments/authorizations/AUTH1/capture`);
    expect(call.headers["paypal-request-id"]).toBe("capture:AUTH1");
    expect(call.headers["prefer"]).toBe("return=representation");
    expect(JSON.parse(call.body!)).toEqual({ final_capture: true });
  });

  it("leaves net undefined when PayPal returns no breakdown (e.g. PENDING)", async () => {
    const { http } = client([{ status: 201, body: { id: "C2", status: "PENDING" } }]);
    expect(await captureHold(http, "A2")).toEqual({ captureId: "C2", authorizationId: "A2", status: "PENDING", grossCents: undefined, feeCents: undefined, netCents: undefined });
  });

  it("surfaces PayPal refusals as PayPalError", async () => {
    const { http } = client([{ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED" }] } }]);
    const err = (await captureHold(http, "A3").catch((e) => e)) as PayPalError;
    expect(err.hasIssue("AUTHORIZATION_VOIDED")).toBe(true);
  });
});

describe("voidHold", () => {
  it("voids with a deterministic request id and accepts 204 or 200", async () => {
    const { f, http } = client([{ status: 204 }, { status: 200, body: { id: "A5", status: "VOIDED" } }]);
    await voidHold(http, "A4");
    await voidHold(http, "A5");
    expect(f.apiCalls().map((c) => [c.url, c.headers["paypal-request-id"]])).toEqual([
      [`${SANDBOX_BASE}/v2/payments/authorizations/A4/void`, "void:A4"],
      [`${SANDBOX_BASE}/v2/payments/authorizations/A5/void`, "void:A5"],
    ]);
  });
});

describe("reauthorizeHold", () => {
  it("returns the NEW authorization as a Hold", async () => {
    const { f, http } = client([{ status: 201, body: { id: "A6new", status: "CREATED", amount: { currency_code: "USD", value: "15.00" }, create_time: "2026-10-09T10:00:00Z", expiration_time: "2026-11-07T10:00:00Z" } }]);
    const hold = await reauthorizeHold(http, "A6", 1500);
    expect(hold).toMatchObject({ authorizationId: "A6new", amountCents: 1500, createdAt: Date.parse("2026-10-09T10:00:00Z") });
    expect(f.apiCalls()[0].headers["paypal-request-id"]).toBe("reauth:A6");
    expect(JSON.parse(f.apiCalls()[0].body!)).toEqual({ amount: { currency_code: "USD", value: "15.00" } });
  });

  it("surfaces the day-0 refusal recorded in the spike", async () => {
    const rec = fixture("reauthorize-error");
    const { http } = client([{ status: rec.status, body: { name: rec.name, details: rec.issues } }]);
    await expect(reauthorizeHold(http, "A7", 1500)).rejects.toBeInstanceOf(PayPalError);
  });
});

describe("refundCharge", () => {
  it("refunds the full capture with a deterministic request id", async () => {
    const body = fixture("refund");
    const { f, http } = client([{ status: 201, body }]);
    expect(await refundCharge(http, "C9")).toEqual({ refundId: body.id, captureId: "C9", status: body.status });
    expect(f.apiCalls()[0].url).toBe(`${SANDBOX_BASE}/v2/payments/captures/C9/refund`);
    expect(f.apiCalls()[0].headers["paypal-request-id"]).toBe("refund:C9");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/paypal/amount.test.ts tests/paypal/payments.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`src/paypal/amount.ts`:

```ts
import type { Cents } from "../core/money";

/** 1500 → "15.00", using integer maths only. */
export function centsToValue(c: Cents): string {
  if (!Number.isSafeInteger(c) || c < 0) throw new RangeError("amount must be a non-negative whole number of cents");
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

/** "15.00" | "15" | "15.5" → 1500 | 1500 | 1550. */
export function valueToCents(v: string): Cents {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) throw new RangeError(`not a PayPal amount: "${v}"`);
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new RangeError(`amount too large: "${v}"`);
  return cents;
}
```

`src/paypal/payments.ts`:

```ts
import type { Cents } from "../core/money";
import { centsToValue, valueToCents } from "./amount";
import type { PayPalHttp } from "./http";

export interface PledgeRef {
  showId: string;
  pledgeId: string;
  amountCents: Cents;
  /** Shown to the fan in PayPal, e.g. "Hold for Lucky's Café show". */
  description: string;
}

/** A sandbox test card, used only for simulated fans. */
export interface TestCard {
  number: string;
  /** "YYYY-MM". */
  expiry: string;
  securityCode: string;
  name: string;
}

export interface Hold {
  authorizationId: string;
  orderId: string;
  amountCents: Cents;
  status: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  expiresAt: number;
}

export interface Charge {
  captureId: string;
  authorizationId: string;
  status: string;
  grossCents?: Cents;
  feeCents?: Cents;
  /** What actually arrived after PayPal's fee. collectedNet sums this, never a model's number. */
  netCents?: Cents;
}

export interface Refund {
  refundId: string;
  captureId: string;
  status: string;
}

/** Deterministic PayPal-Request-Ids: replaying the same step can never move money twice. */
export const requestIds = {
  order: (showId: string, pledgeId: string) => `order:${showId}:${pledgeId}`,
  hold: (showId: string, pledgeId: string) => `hold:${showId}:${pledgeId}`,
  authorize: (orderId: string) => `authorize:${orderId}`,
  capture: (authorizationId: string) => `capture:${authorizationId}`,
  void: (authorizationId: string) => `void:${authorizationId}`,
  reauthorize: (authorizationId: string) => `reauth:${authorizationId}`,
  refund: (captureId: string) => `refund:${captureId}`,
};

interface Money {
  currency_code: string;
  value: string;
}
interface AuthBody {
  id: string;
  status: string;
  amount?: Money;
  create_time?: string;
  expiration_time?: string;
}
interface OrderBody {
  id: string;
  status: string;
  purchase_units?: { payments?: { authorizations?: AuthBody[] } }[];
}
interface CaptureBody {
  id: string;
  status: string;
  seller_receivable_breakdown?: { gross_amount: Money; paypal_fee?: Money; net_amount: Money };
}

function purchaseUnit(p: PledgeRef) {
  return { reference_id: p.showId, custom_id: `${p.showId}:${p.pledgeId}`, description: p.description, amount: { currency_code: "USD", value: centsToValue(p.amountCents) } };
}

function toHold(orderId: string, a: AuthBody, fallbackCents?: Cents): Hold {
  const createdAt = Date.parse(a.create_time ?? "");
  const expiresAt = Date.parse(a.expiration_time ?? "");
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw new Error(`authorization ${a.id} is missing its create or expiration time`);
  const amountCents = a.amount ? valueToCents(a.amount.value) : fallbackCents;
  if (amountCents === undefined) throw new Error(`authorization ${a.id} has no amount`);
  return { authorizationId: a.id, orderId, amountCents, status: a.status, createdAt, expiresAt };
}

function firstAuth(o: OrderBody | undefined): AuthBody | undefined {
  return o?.purchase_units?.[0]?.payments?.authorizations?.[0];
}

/** For the JS SDK button: the browser approves this order, then the server calls authorizeOrder. */
export async function createPledgeOrder(http: PayPalHttp, p: PledgeRef): Promise<{ orderId: string }> {
  const o = await http.request<OrderBody>({ method: "POST", path: "/v2/checkout/orders", requestId: requestIds.order(p.showId, p.pledgeId), body: { intent: "AUTHORIZE", purchase_units: [purchaseUnit(p)] } });
  return { orderId: o!.id };
}

export async function authorizeOrder(http: PayPalHttp, orderId: string): Promise<Hold> {
  const o = await http.request<OrderBody>({ method: "POST", path: `/v2/checkout/orders/${orderId}/authorize`, requestId: requestIds.authorize(orderId), prefer: "return=representation", body: {} });
  const a = firstAuth(o);
  if (!a) throw new Error(`order ${orderId} (${o?.status}) was not authorized`);
  return toHold(orderId, a);
}

/** Simulated fan: a real sandbox hold on a test card, with no buyer login. */
export async function createCardHold(http: PayPalHttp, p: PledgeRef, card: TestCard): Promise<Hold> {
  const o = await http.request<OrderBody>({
    method: "POST",
    path: "/v2/checkout/orders",
    requestId: requestIds.hold(p.showId, p.pledgeId),
    prefer: "return=representation",
    body: { intent: "AUTHORIZE", purchase_units: [purchaseUnit(p)], payment_source: { card: { number: card.number, expiry: card.expiry, security_code: card.securityCode, name: card.name } } },
  });
  const a = firstAuth(o);
  if (a) return toHold(o!.id, a, p.amountCents);
  return authorizeOrder(http, o!.id);
}

export async function captureHold(http: PayPalHttp, authorizationId: string): Promise<Charge> {
  const c = (await http.request<CaptureBody>({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/capture`, requestId: requestIds.capture(authorizationId), prefer: "return=representation", body: { final_capture: true } }))!;
  const b = c.seller_receivable_breakdown;
  const grossCents = b ? valueToCents(b.gross_amount.value) : undefined;
  const netCents = b ? valueToCents(b.net_amount.value) : undefined;
  const feeCents = b ? (b.paypal_fee ? valueToCents(b.paypal_fee.value) : grossCents! - netCents!) : undefined;
  return { captureId: c.id, authorizationId, status: c.status, grossCents, feeCents, netCents };
}

export async function voidHold(http: PayPalHttp, authorizationId: string): Promise<void> {
  await http.request({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/void`, requestId: requestIds.void(authorizationId) });
}

/** Returns the NEW authorization. PayPal allows this only after the 3-day honor period (see spike findings). */
export async function reauthorizeHold(http: PayPalHttp, authorizationId: string, amountCents: Cents): Promise<Hold> {
  const a = (await http.request<AuthBody>({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/reauthorize`, requestId: requestIds.reauthorize(authorizationId), prefer: "return=representation", body: { amount: { currency_code: "USD", value: centsToValue(amountCents) } } }))!;
  return toHold("", a, amountCents);
}

export async function refundCharge(http: PayPalHttp, captureId: string): Promise<Refund> {
  const r = (await http.request<{ id: string; status: string }>({ method: "POST", path: `/v2/payments/captures/${captureId}/refund`, requestId: requestIds.refund(captureId), prefer: "return=representation", body: {} }))!;
  return { refundId: r.id, captureId, status: r.status };
}
```

`reauthorizeHold` returns `orderId: ""`, because PayPal's reauthorize response doesn't carry the order. The caller (Plan 4) copies the order id over from the old hold. Document this in the JSDoc.

Add these to `src/paypal/index.ts`:

```ts
export * from "./amount";
export * from "./payments";
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/paypal` and then `npm run typecheck && npm run lint && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paypal tests/paypal
git commit -m "feat(paypal): holds, capture with net amounts, void, reauthorize and refund with deterministic request ids"
```

---

### Task 4: Payouts: one deterministic batch per show

**Files:**
- Create: `src/paypal/payouts.ts`, `tests/paypal/payouts.test.ts`
- Modify: `src/paypal/index.ts`

**Interfaces:**
- Consumes: `PayPalHttp`, `centsToValue`, `valueToCents`; `PayoutLine` from `src/core/split`; fixtures `payout-create.json`, `payout-get.json`, `payout-duplicate.json`.
- Produces:
  - `payoutBatchId(showId: string): string`
  - `sendPayouts(http, showId, lines: PayoutLine[]): Promise<SentBatch>`
  - `getPayoutBatch(http, batchId): Promise<PayoutBatch>`
  - `isDuplicateBatch(e: unknown): boolean`
  - `interface SentBatch { batchId; senderBatchId; status; sentLines: PayoutLine[] }`
  - `interface PayoutBatch { batchId; senderBatchId; status; items: PayoutItem[] }`
  - `interface PayoutItem { senderItemId; status; transactionId?; amountCents }`

Rules carried over from Plan 1:
- The executor sends **exactly** the lines it is given. Those are `splitPayout(...).lines` after the guard approves them, never the model's lines.
- $0 lines are dropped.
- `sender_batch_id` is deterministic per show, so a replayed send can't pay twice.
- Use `isDuplicateBatch` to detect PayPal refusing a reused `sender_batch_id`, from the exact name or issue that `payout-duplicate.json` recorded. Plan 4 then reads the stored batch id instead of re-sending.

- [ ] **Step 1: Write the failing tests**

`tests/paypal/payouts.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PayoutLine } from "../../src/core/split";
import { SANDBOX_BASE } from "../../src/paypal/config";
import { PayPalError } from "../../src/paypal/errors";
import { PayPalHttp } from "../../src/paypal/http";
import { getPayoutBatch, isDuplicateBatch, payoutBatchId, sendPayouts } from "../../src/paypal/payouts";
import { fakeFetch } from "./fake-fetch";

const fixture = (name: string) => JSON.parse(readFileSync(`tests/paypal/fixtures/${name}.json`, "utf8"));
const client = (responses: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(responses);
  return { f, http: new PayPalHttp({ clientId: "i", clientSecret: "s", baseUrl: SANDBOX_BASE }, { fetch: f.fetch, sleep: async () => {} }) };
};
const lines: PayoutLine[] = [
  { role: "room", label: "Lucky's Café", paypalEmail: "room@example.com", amount: 10000 },
  { role: "opener", label: "Opener", paypalEmail: "opener@example.com", amount: 0 },
  { role: "artist", label: "Maya", paypalEmail: "maya@example.com", amount: 21250 },
];

describe("payoutBatchId", () => {
  it("is deterministic per show", () => expect(payoutBatchId("show1")).toBe("payout-show1"));
  it("rejects show ids that are empty, unsafe or too long", () => {
    for (const bad of ["", "a b", "a/b", "x".repeat(101)]) expect(() => payoutBatchId(bad)).toThrow(RangeError);
  });
});

describe("sendPayouts", () => {
  it("sends exactly the non-zero lines, with deterministic ids, and returns the batch", async () => {
    const body = fixture("payout-create");
    const { f, http } = client([{ status: 201, body }]);
    const sent = await sendPayouts(http, "show1", lines);
    expect(sent).toEqual({ batchId: body.batch_header.payout_batch_id, senderBatchId: "payout-show1", status: body.batch_header.batch_status, sentLines: [lines[0], lines[2]] });
    const call = f.apiCalls()[0];
    expect(call.url).toBe(`${SANDBOX_BASE}/v1/payments/payouts`);
    expect(call.headers["paypal-request-id"]).toBe("payout-show1");
    expect(JSON.parse(call.body!)).toEqual({
      sender_batch_header: { sender_batch_id: "payout-show1", email_subject: "Your share from Tip the Room", recipient_type: "EMAIL" },
      items: [
        { recipient_type: "EMAIL", receiver: "room@example.com", amount: { value: "100.00", currency: "USD" }, sender_item_id: "show1-room", note: "Lucky's Café: your share of the show" },
        { recipient_type: "EMAIL", receiver: "maya@example.com", amount: { value: "212.50", currency: "USD" }, sender_item_id: "show1-artist", note: "Maya: your share of the show" },
      ],
    });
  });

  it("refuses when every line is $0, without calling PayPal", async () => {
    const { f, http } = client([]);
    await expect(sendPayouts(http, "show1", [{ ...lines[1] }])).rejects.toThrow(/nothing to pay/i);
    expect(f.apiCalls()).toHaveLength(0);
  });

  it("refuses non-integer or negative amounts and duplicate roles", async () => {
    const { http } = client([]);
    await expect(sendPayouts(http, "s", [{ ...lines[0], amount: 10.5 }])).rejects.toThrow(RangeError);
    await expect(sendPayouts(http, "s", [{ ...lines[0], amount: -1 }])).rejects.toThrow(RangeError);
    await expect(sendPayouts(http, "s", [lines[0], lines[0]])).rejects.toThrow(/twice/);
  });

  it("recognises PayPal's duplicate-batch refusal from the spike", async () => {
    const rec = fixture("payout-duplicate");
    const err = new PayPalError(rec.status, rec.name, "dup", undefined, rec.issues);
    expect(isDuplicateBatch(err)).toBe(true);
    expect(isDuplicateBatch(new PayPalError(500, "INTERNAL_SERVER_ERROR", "x"))).toBe(false);
    expect(isDuplicateBatch(new Error("x"))).toBe(false);
  });
});

describe("getPayoutBatch", () => {
  it("parses the real batch status", async () => {
    const body = fixture("payout-get");
    const { http } = client([{ status: 200, body }]);
    const batch = await getPayoutBatch(http, body.batch_header.payout_batch_id);
    expect(batch.batchId).toBe(body.batch_header.payout_batch_id);
    expect(batch.status).toBe(body.batch_header.batch_status);
    expect(batch.items).toHaveLength((body.items ?? []).length);
    for (const item of batch.items) expect(Number.isInteger(item.amountCents)).toBe(true);
  });
});
```

The expected `isDuplicateBatch` match depends on what the spike recorded. If `payout-duplicate.json` holds `unexpectedSuccess` (PayPal accepted the duplicate), **stop and report**: the payout idempotency design must change before this task continues.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/paypal/payouts.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/paypal/payouts.ts`:

```ts
import type { PayoutLine } from "../core/split";
import type { Cents } from "../core/money";
import { centsToValue, valueToCents } from "./amount";
import { PayPalError } from "./errors";
import type { PayPalHttp } from "./http";

export interface SentBatch {
  batchId: string;
  senderBatchId: string;
  status: string;
  sentLines: PayoutLine[];
}

export interface PayoutItem {
  senderItemId: string;
  status: string;
  transactionId?: string;
  amountCents: Cents;
}

export interface PayoutBatch {
  batchId: string;
  senderBatchId: string;
  status: string;
  items: PayoutItem[];
}

/** One batch per show, ever: PayPal refuses a second batch with the same sender_batch_id. */
export function payoutBatchId(showId: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(showId)) throw new RangeError("showId must be 1-100 letters, digits or dashes");
  return `payout-${showId}`;
}

/** Sends exactly these lines (the guard-approved split), minus any $0 line. */
export async function sendPayouts(http: PayPalHttp, showId: string, lines: PayoutLine[]): Promise<SentBatch> {
  const senderBatchId = payoutBatchId(showId);
  const seen = new Set<string>();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount) || l.amount < 0) throw new RangeError(`${l.label}: payout must be a non-negative whole number of cents`);
    if (seen.has(l.role)) throw new Error(`${l.role} appears twice in the payout`);
    seen.add(l.role);
  }
  const sentLines = lines.filter((l) => l.amount > 0);
  if (sentLines.length === 0) throw new Error("Nothing to pay: every payout line is $0");
  const res = await http.request<{ batch_header: { payout_batch_id: string; batch_status: string } }>({
    method: "POST",
    path: "/v1/payments/payouts",
    requestId: senderBatchId,
    body: {
      sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "Your share from Tip the Room", recipient_type: "EMAIL" },
      items: sentLines.map((l) => ({
        recipient_type: "EMAIL",
        receiver: l.paypalEmail,
        amount: { value: centsToValue(l.amount), currency: "USD" },
        sender_item_id: `${showId}-${l.role}`,
        note: `${l.label}: your share of the show`,
      })),
    },
  });
  return { batchId: res!.batch_header.payout_batch_id, senderBatchId, status: res!.batch_header.batch_status, sentLines };
}

interface BatchBody {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header?: { sender_batch_id?: string } };
  items?: { transaction_id?: string; transaction_status?: string; payout_item?: { sender_item_id?: string; amount?: { value: string } } }[];
}

export async function getPayoutBatch(http: PayPalHttp, batchId: string): Promise<PayoutBatch> {
  const b = (await http.request<BatchBody>({ method: "GET", path: `/v1/payments/payouts/${batchId}` }))!;
  return {
    batchId: b.batch_header.payout_batch_id,
    senderBatchId: b.batch_header.sender_batch_header?.sender_batch_id ?? "",
    status: b.batch_header.batch_status,
    items: (b.items ?? []).map((i) => ({
      senderItemId: i.payout_item?.sender_item_id ?? "",
      status: i.transaction_status ?? "UNKNOWN",
      transactionId: i.transaction_id,
      amountCents: valueToCents(i.payout_item?.amount?.value ?? "0"),
    })),
  };
}

/** True when PayPal refused the batch because this sender_batch_id was already used. */
export function isDuplicateBatch(e: unknown): boolean {
  if (!(e instanceof PayPalError)) return false;
  // Fill in the exact name and/or issue code recorded in tests/paypal/fixtures/payout-duplicate.json.
  return DUPLICATE_MARKERS.some((m) => e.paypalName === m || e.hasIssue(m));
}
```

Define `const DUPLICATE_MARKERS = [...]` above `isDuplicateBatch`, holding the **exact** strings from `payout-duplicate.json` (its `name` and every `issues[].issue`, minus generic ones like `VALIDATION_ERROR` if a more specific issue code is present). Replace the comment with a one-line citation of the fixture.

Add this to `src/paypal/index.ts`:

```ts
export * from "./payouts";
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/paypal` and then `npm run typecheck && npm run lint && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paypal tests/paypal
git commit -m "feat(paypal): one deterministic payout batch per show; drops \$0 lines; duplicate-batch detection"
```

---

### Task 5: Webhooks: signature verification and event mapping

**Files:**
- Create: `src/paypal/webhooks.ts`, `tests/paypal/webhooks.test.ts`
- Modify: `src/paypal/index.ts`

**Interfaces:**
- Consumes: `PayPalHttp`, `valueToCents`.
- Produces:
  - `verifyWebhook(http, headers: Headers, rawBody: string, webhookId: string): Promise<boolean>`
  - `mapWebhookEvent(event: WebhookEvent): PayPalLedgerEvent | null`
  - `type LedgerKind = "hold_created" | "hold_voided" | "charged" | "charge_failed" | "refunded" | "payout_batch_done" | "payout_batch_failed" | "payout_item_paid" | "payout_item_failed"`
  - `interface PayPalLedgerEvent { eventId; kind: LedgerKind; ref: string; amountCents?: Cents; customId?: string; at: number }`
  - `interface WebhookEvent`

Notes:
- Verification uses PayPal's `POST /v1/notifications/verify-webhook-signature`. The `webhook_id` comes from registering the webhook URL, which happens once the Worker has a URL (Plan 4/6), so live verification is out of scope here. It is unit-tested against a fake fetch.
- The event is passed as the parsed raw body. Missing signature headers mean `false`, without calling PayPal.
- `eventId` is PayPal's event `id`, so duplicate deliveries are ignored downstream (spec 8).

- [ ] **Step 1: Write the failing tests**

`tests/paypal/webhooks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SANDBOX_BASE } from "../../src/paypal/config";
import { PayPalHttp } from "../../src/paypal/http";
import { mapWebhookEvent, verifyWebhook, type WebhookEvent } from "../../src/paypal/webhooks";
import { fakeFetch } from "./fake-fetch";

const client = (responses: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(responses);
  return { f, http: new PayPalHttp({ clientId: "i", clientSecret: "s", baseUrl: SANDBOX_BASE }, { fetch: f.fetch, sleep: async () => {} }) };
};
const sigHeaders = () =>
  new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "T1",
    "paypal-transmission-sig": "SIG",
    "paypal-transmission-time": "2026-10-05T12:00:00Z",
  });
const raw = JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "2026-10-05T12:00:00Z", resource: { id: "C1" } });

describe("verifyWebhook", () => {
  it("asks PayPal to verify and returns true on SUCCESS", async () => {
    const { f, http } = client([{ status: 200, body: { verification_status: "SUCCESS" } }]);
    expect(await verifyWebhook(http, sigHeaders(), raw, "WHID")).toBe(true);
    const call = f.apiCalls()[0];
    expect(call.url).toBe(`${SANDBOX_BASE}/v1/notifications/verify-webhook-signature`);
    expect(JSON.parse(call.body!)).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      transmission_id: "T1",
      transmission_sig: "SIG",
      transmission_time: "2026-10-05T12:00:00Z",
      webhook_id: "WHID",
      webhook_event: JSON.parse(raw),
    });
  });
  it("returns false on FAILURE", async () => {
    const { http } = client([{ status: 200, body: { verification_status: "FAILURE" } }]);
    expect(await verifyWebhook(http, sigHeaders(), raw, "WHID")).toBe(false);
  });
  it("returns false without calling PayPal when a signature header is missing", async () => {
    const { f, http } = client([]);
    const h = sigHeaders();
    h.delete("paypal-transmission-sig");
    expect(await verifyWebhook(http, h, raw, "WHID")).toBe(false);
    expect(f.apiCalls()).toHaveLength(0);
  });
  it("returns false on a body that is not JSON", async () => {
    const { f, http } = client([]);
    expect(await verifyWebhook(http, sigHeaders(), "not json", "WHID")).toBe(false);
    expect(f.apiCalls()).toHaveLength(0);
  });
  it("rejects a cert URL that is not on a paypal.com host", async () => {
    const { f, http } = client([]);
    const h = sigHeaders();
    h.set("paypal-cert-url", "https://evil.example/cert");
    expect(await verifyWebhook(http, h, raw, "WHID")).toBe(false);
    expect(f.apiCalls()).toHaveLength(0);
  });
});

const ev = (event_type: string, resource: Record<string, unknown>): WebhookEvent => ({ id: "WH-9", event_type, create_time: "2026-10-05T12:00:00Z", resource });
const at = Date.parse("2026-10-05T12:00:00Z");

describe("mapWebhookEvent", () => {
  it.each([
    ["PAYMENT.AUTHORIZATION.CREATED", { id: "A1", amount: { value: "15.00" }, custom_id: "show1:p7" }, { kind: "hold_created", ref: "A1", amountCents: 1500, customId: "show1:p7" }],
    ["PAYMENT.AUTHORIZATION.VOIDED", { id: "A1", custom_id: "show1:p7" }, { kind: "hold_voided", ref: "A1", customId: "show1:p7" }],
    ["PAYMENT.CAPTURE.COMPLETED", { id: "C1", amount: { value: "15.00" }, custom_id: "show1:p7" }, { kind: "charged", ref: "C1", amountCents: 1500, customId: "show1:p7" }],
    ["PAYMENT.CAPTURE.DENIED", { id: "C2", amount: { value: "15.00" } }, { kind: "charge_failed", ref: "C2", amountCents: 1500 }],
    ["PAYMENT.CAPTURE.DECLINED", { id: "C3" }, { kind: "charge_failed", ref: "C3" }],
    ["PAYMENT.CAPTURE.REFUNDED", { id: "C1", amount: { value: "15.00" } }, { kind: "refunded", ref: "C1", amountCents: 1500 }],
    ["PAYMENT.PAYOUTSBATCH.SUCCESS", { batch_header: { payout_batch_id: "B1" } }, { kind: "payout_batch_done", ref: "B1" }],
    ["PAYMENT.PAYOUTSBATCH.DENIED", { batch_header: { payout_batch_id: "B1" } }, { kind: "payout_batch_failed", ref: "B1" }],
    ["PAYMENT.PAYOUTS-ITEM.SUCCEEDED", { payout_item_id: "I1", payout_item: { amount: { value: "100.00" }, sender_item_id: "show1-room" } }, { kind: "payout_item_paid", ref: "I1", amountCents: 10000, customId: "show1-room" }],
    ["PAYMENT.PAYOUTS-ITEM.FAILED", { payout_item_id: "I2", payout_item: { sender_item_id: "show1-room" } }, { kind: "payout_item_failed", ref: "I2", customId: "show1-room" }],
  ])("%s", (type, resource, expected) => {
    expect(mapWebhookEvent(ev(type, resource))).toEqual({ eventId: "WH-9", at, ...expected });
  });

  it("ignores event types we don't use", () => expect(mapWebhookEvent(ev("CHECKOUT.ORDER.APPROVED", { id: "O1" }))).toBeNull());
  it("ignores events with no usable reference", () => expect(mapWebhookEvent(ev("PAYMENT.CAPTURE.COMPLETED", {}))).toBeNull());
});
```

The REFUNDED case: PayPal's refund webhook resource is the **refund**, and its `id` is the refund id. Map `ref` to `resource.id` as the test shows, and keep it. The capture link lives in `resource.links` (rel `up`), which Plan 4 can read if needed.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/paypal/webhooks.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/paypal/webhooks.ts`:

```ts
import type { Cents } from "../core/money";
import { valueToCents } from "./amount";
import type { PayPalHttp } from "./http";

export interface WebhookEvent {
  id: string;
  event_type: string;
  create_time: string;
  resource: Record<string, unknown>;
}

export type LedgerKind =
  | "hold_created"
  | "hold_voided"
  | "charged"
  | "charge_failed"
  | "refunded"
  | "payout_batch_done"
  | "payout_batch_failed"
  | "payout_item_paid"
  | "payout_item_failed";

export interface PayPalLedgerEvent {
  /** PayPal's event id: duplicates are dropped by this key. */
  eventId: string;
  kind: LedgerKind;
  /** The PayPal id the event is about (authorization, capture, refund, batch or item). */
  ref: string;
  amountCents?: Cents;
  /** Our custom_id ("show:pledge") or sender_item_id ("show-role"). */
  customId?: string;
  at: number;
}

const SIG_HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"] as const;

function isPayPalCertUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

/** Asks PayPal whether this delivery is genuine. Any doubt means false. */
export async function verifyWebhook(http: PayPalHttp, headers: Headers, rawBody: string, webhookId: string): Promise<boolean> {
  const h = SIG_HEADERS.map((k) => headers.get(k));
  if (h.some((v) => !v)) return false;
  if (!isPayPalCertUrl(h[1]!)) return false;
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const res = await http.request<{ verification_status: string }>({
    method: "POST",
    path: "/v1/notifications/verify-webhook-signature",
    body: { auth_algo: h[0], cert_url: h[1], transmission_id: h[2], transmission_sig: h[3], transmission_time: h[4], webhook_id: webhookId, webhook_event: event },
  });
  return res?.verification_status === "SUCCESS";
}

const KINDS: Record<string, LedgerKind> = {
  "PAYMENT.AUTHORIZATION.CREATED": "hold_created",
  "PAYMENT.AUTHORIZATION.VOIDED": "hold_voided",
  "PAYMENT.CAPTURE.COMPLETED": "charged",
  "PAYMENT.CAPTURE.DENIED": "charge_failed",
  "PAYMENT.CAPTURE.DECLINED": "charge_failed",
  "PAYMENT.CAPTURE.REFUNDED": "refunded",
  "PAYMENT.PAYOUTSBATCH.SUCCESS": "payout_batch_done",
  "PAYMENT.PAYOUTSBATCH.DENIED": "payout_batch_failed",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": "payout_item_paid",
  "PAYMENT.PAYOUTS-ITEM.FAILED": "payout_item_failed",
};

type R = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as R) : undefined);

export function mapWebhookEvent(event: WebhookEvent): PayPalLedgerEvent | null {
  const kind = KINDS[event.event_type];
  if (!kind) return null;
  const r = event.resource ?? {};
  let ref: string | undefined;
  let amount: string | undefined;
  let customId: string | undefined;
  if (kind.startsWith("payout_batch")) {
    ref = str(obj(r.batch_header)?.payout_batch_id);
  } else if (kind.startsWith("payout_item")) {
    const item = obj(r.payout_item);
    ref = str(r.payout_item_id);
    amount = str(obj(item?.amount)?.value);
    customId = str(item?.sender_item_id);
  } else {
    ref = str(r.id);
    amount = str(obj(r.amount)?.value);
    customId = str(r.custom_id);
  }
  if (!ref) return null;
  const out: PayPalLedgerEvent = { eventId: event.id, kind, ref, at: Date.parse(event.create_time) };
  if (amount !== undefined) out.amountCents = valueToCents(amount);
  if (customId !== undefined) out.customId = customId;
  return out;
}
```

Add this to `src/paypal/index.ts`:

```ts
export * from "./webhooks";
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run tests/paypal` and then `npm run typecheck && npm run lint && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paypal tests/paypal
git commit -m "feat(paypal): webhook signature verification via PayPal and event-to-ledger mapping"
```

---

### Task 6: Sandbox integration run (spec section 9)

**Files:**
- Create: `scripts/sandbox-check.ts`
- Modify: `README.md`, adding a short "Sandbox check" section (how to run it, and that it needs `.dev.vars`)

**Interfaces:**
- Consumes: everything exported from `src/paypal` (Tasks 1, 3, 4).
- Produces: `npm run sandbox:check`, which exits 0 when every step passes and 1 otherwise.

The run must cover, using only the typed client:
1. **Flow A:** card hold → capture → check `netCents` is a whole number below the gross → replay the capture (same capture id) → refund.
2. **Flow B:** card hold → void → a capture attempt on the voided hold must be **refused** (a PayPalError).
3. **Flow C:** reauthorize a fresh hold. It is expected to be refused on day 0; record the refusal as PASS (expected), then void the hold.
4. **Flow D:** `sendPayouts` of a $1.00 line to `PAYPAL_SPIKE_PAYOUT_EMAIL` or `check-room@example.com`, under a unique show id (`check-<timestamp>`). Then send again with the same show id, which must be refused by `isDuplicateBatch`. Then `getPayoutBatch`.

**If the spike chose simulated-fan option 3** (card holds don't work), Flows A–C use an order approved by hand instead. The script prints the order's `approve` link and waits for Enter, so the owner can approve it with a sandbox buyer account. Mark that in the output.

- [ ] **Step 1: Write the script**

`scripts/sandbox-check.ts`:

```ts
// Spec 9 sandbox integration run. Run: npm run sandbox:check
// Prints statuses and PayPal ids only. Never prints keys or tokens.
import {
  captureHold,
  createCardHold,
  getPayoutBatch,
  isDuplicateBatch,
  loadConfig,
  PayPalError,
  PayPalHttp,
  reauthorizeHold,
  refundCharge,
  sendPayouts,
  voidHold,
  type TestCard,
} from "../src/paypal";

const http = new PayPalHttp(loadConfig(process.env));
const run = `check-${Date.now()}`;
const card: TestCard = { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Simulated Fan" };
const pledge = (id: string) => ({ showId: run, pledgeId: id, amountCents: 1500, description: "Sandbox check hold" });
let failures = 0;

function line(ok: boolean, step: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  ·  ${detail}` : ""}`);
}
async function expectRefused(step: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    line(false, step, "PayPal allowed it");
  } catch (e) {
    line(e instanceof PayPalError && e.status < 500, step, e instanceof PayPalError ? `${e.status} ${e.paypalName} ${e.issues.map((i) => i.issue).join(",")}` : String(e));
  }
}

async function flowA() {
  const hold = await createCardHold(http, pledge("a"), card);
  line(hold.amountCents === 1500, "A · hold", hold.authorizationId);
  const charge = await captureHold(http, hold.authorizationId);
  line(charge.status === "COMPLETED", "A · capture", `${charge.captureId} ${charge.status}`);
  line(Number.isInteger(charge.netCents) && charge.netCents! < (charge.grossCents ?? 0), "A · net after fee", `gross ${charge.grossCents} fee ${charge.feeCents} net ${charge.netCents}`);
  const replay = await captureHold(http, hold.authorizationId);
  line(replay.captureId === charge.captureId, "A · capture replay is idempotent", replay.captureId);
  const refund = await refundCharge(http, charge.captureId);
  line(refund.status === "COMPLETED" || refund.status === "PENDING", "A · refund", `${refund.refundId} ${refund.status}`);
}

async function flowB() {
  const hold = await createCardHold(http, pledge("b"), card);
  await voidHold(http, hold.authorizationId);
  line(true, "B · void", hold.authorizationId);
  await expectRefused("B · capture after void is refused", () => captureHold(http, hold.authorizationId));
}

async function flowC() {
  const hold = await createCardHold(http, pledge("c"), card);
  await expectRefused("C · reauthorize on day 0 is refused (expected)", () => reauthorizeHold(http, hold.authorizationId, 1500));
  await voidHold(http, hold.authorizationId);
}

async function flowD() {
  const receiver = process.env.PAYPAL_SPIKE_PAYOUT_EMAIL?.trim() || "check-room@example.com";
  const lines = [{ role: "room" as const, label: "Sandbox Room", paypalEmail: receiver, amount: 100 }];
  const sent = await sendPayouts(http, run, lines);
  line(true, "D · payout batch", `${sent.batchId} ${sent.status}`);
  try {
    await sendPayouts(http, run, lines);
    line(false, "D · second batch for the same show is refused", "PayPal accepted it");
  } catch (e) {
    line(isDuplicateBatch(e), "D · second batch for the same show is refused", e instanceof PayPalError ? e.paypalName : String(e));
  }
  await new Promise((r) => setTimeout(r, 5000));
  const batch = await getPayoutBatch(http, sent.batchId);
  line(batch.batchId === sent.batchId, "D · batch readable", `${batch.status}, ${batch.items.length} item(s)`);
}

for (const [name, flow] of [["A", flowA], ["B", flowB], ["C", flowC], ["D", flowD]] as const) {
  try {
    await flow();
  } catch (e) {
    line(false, `${name} · flow crashed`, e instanceof PayPalError ? `${e.status} ${e.paypalName} debug_id=${e.debugId}` : String(e));
  }
}
console.log(failures === 0 ? "\nSandbox check: all green." : `\nSandbox check: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it live**

Run: `npm run sandbox:check`
Expected: every line PASS, and `Sandbox check: all green.` If a step fails, report the exact output and do not change assertions to make it pass. The controller decides.

- [ ] **Step 3: README section**

Append to `README.md`:

```markdown
## Sandbox check

`npm run sandbox:check` runs the real PayPal **sandbox** flows end to end: hold → charge → refund, hold → cancel, the day-0 reauthorize refusal, and one payout batch (sent once, refused the second time). It needs a `.dev.vars` file with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`. The client refuses any non-sandbox URL.
```

- [ ] **Step 4: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add scripts/sandbox-check.ts README.md
git commit -m "test(paypal): live sandbox integration run (hold, charge, refund, void, reauthorize, payouts)"
```

---

### Task 7: Spike 6: does `@paypal/agent-toolkit` run on Workers?

Run locally only, in `wrangler dev` (workerd). **No deploy, no Cloudflare login.**

**Files:**
- Create: `spikes/agent-toolkit/package.json`, `spikes/agent-toolkit/wrangler.toml`, `spikes/agent-toolkit/src/index.ts`
- Create: a symlink `spikes/agent-toolkit/.dev.vars -> ../../.dev.vars` (gitignored by the root `.gitignore` pattern `.dev.vars`; verify with `git check-ignore`)
- Modify: `docs/superpowers/spikes/2026-10-05-paypal-sandbox.md` (add a "Spike 6" section)
- Modify: root `eslint.config.js` / `tsconfig.json` only if needed to **exclude** `spikes/`

**Interfaces:**
- Produces: a documented go/no-go, plus the exact import path and constructor the toolkit uses on Workers if it's a go.

- [ ] **Step 1: Set up the isolated spike**

`spikes/agent-toolkit/package.json`:

```json
{
  "name": "agent-toolkit-spike",
  "private": true,
  "type": "module",
  "scripts": { "dev": "wrangler dev --local --port 8799" },
  "devDependencies": { "wrangler": "^4" },
  "dependencies": { "@paypal/agent-toolkit": "latest" }
}
```

`spikes/agent-toolkit/wrangler.toml`:

```toml
name = "agent-toolkit-spike"
main = "src/index.ts"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
```

Then:

```bash
cd spikes/agent-toolkit && npm install && ln -s ../../.dev.vars .dev.vars && cd ../..
git check-ignore spikes/agent-toolkit/.dev.vars   # must print the path
```

Pin the toolkit version that was installed: replace `"latest"` with the exact version from `npm ls @paypal/agent-toolkit`.

- [ ] **Step 2: Write the Worker**

Read `spikes/agent-toolkit/node_modules/@paypal/agent-toolkit/README.md` and its `package.json` `exports` first. Use the **framework-neutral or AI-SDK entry point the README documents**, and record which one you used. The Worker must:
1. Construct the toolkit with `env.PAYPAL_CLIENT_ID`, `env.PAYPAL_CLIENT_SECRET` and sandbox mode, enabling only the orders actions (create, get).
2. On `GET /`, list the tool names it exposes, and call the **get-order** tool (or the equivalent "create order" tool, if get needs an id) once against the sandbox.
3. Return JSON `{ tools: string[], call: { ok: boolean, status?: string, error?: string } }`, never the keys.

- [ ] **Step 3: Run it**

Start `npm run dev` inside `spikes/agent-toolkit` as a background process (your Bash tool's background option; log to `spikes/agent-toolkit/wrangler.log`). Wait until the log says it is ready, then run `curl -s localhost:8799/`. Stop the dev server afterwards.

Record exactly one of these:
- **GO:** it bundled, ran in workerd and returned a real sandbox order id. Record the import path, the constructor and the tool names.
- **NO-GO:** the exact error (bundle error, missing Node API, runtime throw). Plan 4 then uses REST only, through `src/paypal/` (spec 6.1 already allows this).

- [ ] **Step 4: Findings and commit**

Add a "Spike 6 · Agent Toolkit on Workers" section to the findings doc, with the result, evidence and decision. Make sure `spikes/agent-toolkit/node_modules`, `.wrangler` and `wrangler.log` are not staged (`git status --short`). Keep the root `npm run lint`, `typecheck` and `test` green, excluding `spikes/` if they pick it up.

```bash
git add spikes/agent-toolkit/package.json spikes/agent-toolkit/package-lock.json spikes/agent-toolkit/wrangler.toml spikes/agent-toolkit/src docs/superpowers/spikes
git commit -m "spike(paypal): agent toolkit on Workers (local workerd) with go/no-go"
```

---

## Done when

- `npm run typecheck && npm run lint && npm test` are green, and `npm run test:gpu` is unchanged and green (no web changes).
- `npm run sandbox:check` is all green against the live sandbox (or any failure is understood and accepted by the controller in writing).
- The findings doc answers spikes 1, 2, 3 and 6, and records the open PLAN 3 SPIKE question from Plan 1 (reauthorize rules).
- The roadmap row for Plan 3 is updated by the controller after the final review and merge.

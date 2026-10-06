# Plan 4 · Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Tip the Room's settlement agent for real: a Cloudflare Worker JSON API plus one Durable Object per campaign that holds an append-only ledger, executes every money effect through the PayPal sandbox exactly once, checks pace with Workers AI under a hard daily budget, and offers a per-visitor judge demo with real sandbox card holds.

**Architecture:**
- All logic lives in plain TypeScript modules under `src/agent/` that take injected ports: `SqlDb` (a slice of Cloudflare's `ctx.storage.sql`), `Clock`, `Random`, `PayPalPort` (wraps `src/paypal`) and `AiPort` + `BudgetPort`. Vitest runs them in Node against a real in-memory SQLite (`node:sqlite`) with the same SQL the Durable Object runs, plus fake PayPal and fake AI ports.
- The ledger is append-only: every ledger event has a deterministic key (`capture:<authId>`, `pledge:<pledgeId>`, `payout:<senderBatchId>`, `webhook:<eventId>` …), so an event is written at most once. Campaign state is rebuilt from the events by replaying them through Plan 1's `reduce()`. Effects emitted during replay are ignored.
- A new event's effects are expanded into **jobs** (an outbox table), one per PayPal call, under deterministic keys, and written in the same transaction as the event, BEFORE any PayPal call. A job runner drains due jobs in small batches (free plan: 50 subrequests per invocation), guards each one against the signed mandate and the current campaign, calls PayPal with Plan 3's deterministic `PayPal-Request-Id`s, and records the result as a ledger event. Replaying the ledger can never re-execute a job.
- The model proposes, the guard decides. `deadline_reached(now)` is applied before any proposal is guarded. Model output is schema-checked (and every number in it must be one code computed) before it is shown; it never feeds a money path.
- `src/worker/` holds the thin Cloudflare layer: a hand-written router (pure, tested in Node), the `CampaignAgent` and `QuotaAgent` Durable Object adapters, and the Worker entry. `src/worker/api-types.ts` is the request/response contract that Plan 5's pages import.

**Tech Stack:** TypeScript 6, Vitest 5 (Node 22, `node:sqlite` for the store tests), Cloudflare Workers + SQLite-backed Durable Objects + DO alarms + Workers AI (free plan), wrangler 4 (local `wrangler dev` only), `@cloudflare/workers-types`, Plan 3's `src/paypal` REST client.

## Controller pre-steps (before dispatching Task 1)

1. `git checkout -b plan-4-agent-runtime` is already done by the planner (this file is committed on it). Implementers commit on this branch.
2. Install the dev dependencies. Tasks must NOT run `npm install`:
   ```bash
   npm install --save-dev wrangler@^4 @cloudflare/workers-types@^5
   ```
   Expected: `package.json` gains `"wrangler": "^4.x"` (4.147.0 at planning time) and `"@cloudflare/workers-types": "^5.x"` (5.20261006.1 at planning time) under `devDependencies`. Commit `package.json` + `package-lock.json` as `chore: add wrangler and workers types for Plan 4`.
3. Confirm `node -e "require('node:sqlite')"` prints only an ExperimentalWarning (Node 22.13+; local is 22.22).
4. `.dev.vars` already holds `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE`. Optional lines the owner may add later (never the implementer): `PAYPAL_WEBHOOK_ID=`, `PAYPAL_RECEIVER_ROOM=`, `PAYPAL_RECEIVER_OPENER=`, `PAYPAL_RECEIVER_ARTIST=`.

## Deviations from the spec (binding controller decisions)

| Spec says | Plan 4 does | Why |
|---|---|---|
| §7 Campaign agent: Cloudflare Agents SDK | One plain Durable Object class `CampaignAgent` per campaign (SQLite storage, `ctx.storage.sql`, DO alarms). No `agents` npm package | Smaller surface, testable logic in plain TS, free-plan friendly |
| §7 Ledger in Cloudflare D1 | The append-only ledger lives in each campaign DO's SQLite (`events` table). No D1 | One store per campaign; no cross-store consistency problem |
| §7 units `money`, `ledger`, `agent` | `src/agent/*` (store, projection, executor, runners, AI jobs, service) + `src/worker/*` (router, DO adapters) | Same responsibilities, ports injected for Node tests |
| §9 Unit tests in Workers runtime (implied) | Vitest in Node with `node:sqlite` + fakes; no `@cloudflare/vitest-pool-workers`. One local integration script `npm run worker:check` drives `wrangler dev --local` end to end | Fast, deterministic unit tests; one real end-to-end run |
| §6.2 "reauthorize any hold older than 3 days immediately before capturing" | Captures go straight to `captureHold` (a card authorization stays capturable for its 29 days; the 3-day honor period only guarantees funds). Reauthorize is never relied on. Simulated holds near expiry are renewed by a fresh card hold first, then the old hold is voided ("re-hold") | Spike decision 4: US/Platform card authorizations carry no `rel: reauthorize`, and day-4 reauthorize is unverified |
| §8 "Payout item fails: retry once" | At most one retry batch, `sender_batch_id = payout-<show>-r1`, containing only the first batch's FAILED/RETURNED/BLOCKED/DENIED/CANCELED/REFUNDED items, each re-checked against the signed split; item ids `<show>-<role>-r1`. A second failure is surfaced to the artist, never retried again | One batch id per show forbids re-sending the same batch |
| §8 "Some captures fail at tipping: settle on what was captured; pause if it no longer covers room + opener + host" | The guard's existing rule: if the collected net is short of fixed costs + the artist minimum, payouts wait for an approved `pay_short` proposal (approval key `payout-shortfall:<net>`); if nothing came in, a $0 payout is recorded without calling PayPal | Plan 1 guard already encodes this; zero-total handled explicitly |
| §6.1 Webhooks update the ledger | Webhooks are recorded (keyed by PayPal event id) and only *trigger* our own GET-based reconcile; counts and money always come from API responses we fetched ourselves | A webhook's capture amount is GROSS; net must come from a capture response |
| §5 "Hard daily budget with caching" | Hard daily neuron budget (default 8,000/day, resets 00:00 UTC) in a singleton `QuotaAgent` DO; each pace check and settlement note runs once per campaign (stored as events), so no extra response cache | Results are persisted, so a cache adds nothing |
| §4 Reset | Reset retires the old demo copy (jumps it to its deadline so open holds are voided, then it deletes itself within an hour) and returns a fresh demo copy | Never abandons sandbox holds silently |
| — (not in spec) | Extra endpoint `POST /api/shows/:id/call-off` (manage key) for spec §3 step 7 (artist calls off a tipped show) | Needed for the cancelled path and refund retries |
| §2b The manage key | A random 32-byte secret returned once by `/sign` (or `/api/demo`); only its SHA-256 hash is stored. `/sign` itself needs the one-time `signToken` returned by `POST /api/shows` | Nobody else can sign or manage someone's show |

## Global Constraints

- Repo: `<repo>`, branch `plan-4-agent-runtime`. The git identity is ramenprotokol automatically; never change git config.
- **Never** `git push`, never deploy (`wrangler deploy` is forbidden except `wrangler deploy --dry-run`), never log in to Cloudflare. Deploying is Plan 6.
- **Never** run `npm install` / `npm i` (the controller installs packages). Never read or write outside the repo (plus the npm cache).
- **Secrets:** `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API_BASE`, `PAYPAL_WEBHOOK_ID` (optional; webhooks are rejected with 403 when it is unset) come from `.dev.vars`. Never `cat`, print, log, echo or commit their values, a PayPal token, a manage key, a demo key or a sign token. Do not edit `.dev.vars`. Error messages may name a variable, never show its value.
- **Sandbox only:** `src/paypal` already refuses any base other than `https://api-m.sandbox.paypal.com`; do not weaken it.
- **Cloudflare FREE plan:** at most `MAX_JOBS_PER_TURN = 12` PayPal jobs per invocation (each job makes at most 2 PayPal calls; free plan allows 50 subrequests); no cron triggers, no D1, no KV writes, no paid features. Workers AI budget 8,000 neurons/day (free tier is 10,000).
- **Models:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (pace proposals, settlement notes) and `@cf/meta/llama-3.1-8b-instruct` (sentence extraction). The implementer of Task 5 must confirm both ids against Cloudflare's Workers AI model catalogue (https://developers.cloudflare.com/workers-ai/models/) and record the check in the commit message; if an id was renamed, change only the `MODELS` constant. Per-call neuron costs are ESTIMATES (documented as such in code).
- **No money flow depends on the model.** Threshold, projections, options, split amounts and every PayPal call are computed by code. Model text is decoration with a template fallback.
- Money is integer cents (`Cents` from `src/core/money.ts`). Never `toFixed` money that is sent to PayPal.
- **Never fake a PayPal ID** (spec 6.3). Fakes in tests use obviously fake ids (`A-p1`, `C-A1`, `B-1`).
- Plain-English copy (spec 2c) for every user-facing string returned by the API (`error.message`, ledger `what`, agent log `did`): no "authorize/capture/void" words outside the agent log's `requestId`/`resultId` fields.
- `src/web/`, `reference/` and `tests/gpu/` must not change. The GPU parity suite must stay green (Plan 4 does not touch it).
- Checks for every task: `npm run typecheck && npm run lint && npm test` (all green). Run commands from the repo root.
- Every implementer commit message ends with:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/paypal/errors.ts` (modify) | `requireBody` helper, `EMPTY_RESPONSE_BODY` | 1 |
| `src/paypal/http.ts` (modify) | One shared in-flight token fetch; honour `Retry-After` | 1 |
| `src/paypal/payments.ts` (modify) | `Hold.customId`; `getOrderPayments`, `getCapture`; empty-body checks | 1 |
| `src/paypal/payouts.ts` (modify) | Retry batch id `payout-<show>-r1`, `payoutItemId`, email + body validation | 1 |
| `scripts/sandbox-check.ts` (modify) | Live check that order + capture GETs parse | 1 |
| `src/agent/sql.ts` | `SqlLike` / `SqlDb` ports | 2 |
| `src/agent/events.ts` | `LedgerEvent` union + deterministic `eventKey` | 2 |
| `src/agent/ids.ts` | Ids, secrets, SHA-256, `Clock`, `Random`, PayPal id-length caps | 2 |
| `src/agent/policy.ts` | Every tunable constant (batch sizes, backoff, demo caps) | 2 |
| `src/agent/project.ts` | Rebuild campaign + pledges + payouts from events (`project`) | 2 |
| `src/agent/store.ts` | SQLite schema; append-only events, jobs outbox, agent log, meta; cached projection | 2 |
| `src/agent/words.ts` | Plain-English helpers for logs | 3 |
| `src/agent/paypal-port.ts` | `PayPalPort` over `src/paypal`; `SIM_CARD` | 3 |
| `src/agent/executor.ts` | `commit` (event + jobs in one transaction), `drain`, job helpers | 3 |
| `src/agent/hold-runner.ts` | capture / void / refund / reconcile jobs | 3 |
| `src/agent/payout-runner.ts` | payout / payout_poll / payout_retry jobs | 4 |
| `src/agent/runners.ts` | Registry of all job runners | 4 |
| `src/agent/quota.ts` | Daily neuron budget + per-visitor rate limits (SQL) | 5 |
| `src/agent/ai.ts` | `AiPort`, `BudgetPort`, models, `askModel` | 5 |
| `src/agent/ai-jobs.ts` | Draft / pace note / settlement note: schema checks + templates | 5 |
| `src/worker/api-types.ts` | Request/response types shared with Plan 5 | 6 |
| `src/agent/errors.ts` | `ServiceError` (HTTP status + plain message) | 6 |
| `src/agent/draft.ts` | API draft fields ⇄ `MandateDraft`; preview threshold | 6 |
| `src/agent/views.ts` | Public show, ledger rows, log rows, proposals, parties | 6 |
| `src/agent/service.ts` | `CampaignService`: sign, orders, authorize, views (6); agent loop (7); demo (10) | 6, 7, 10 |
| `src/agent/dispatch.ts` | JSON op → service method (the DO boundary) | 6, 7, 10 |
| `src/agent/pace.ts` | Pace-check times, numbers and guarded options | 7 |
| `wrangler.toml`, `tsconfig.worker.json` | Worker config (DO SQLite migrations, AI binding, `check` env) | 8 |
| `src/worker/env.ts` | `Env` bindings type | 8 |
| `src/worker/do/sql-adapter.ts` | `ctx.storage` → `SqlDb` | 8 |
| `src/worker/do/campaign-agent.ts` | Campaign DO adapter (fetch + alarm) | 8 |
| `src/worker/do/quota-agent.ts` | Quota DO adapter | 8 |
| `src/worker/quota-client.ts` | Budget/quota ports over the Quota DO | 8 |
| `src/worker/router.ts` | Hand-written router, CORS, rate limits, webhooks | 9, 10 |
| `src/worker/index.ts` | Worker entry: builds router deps from `Env` | 8, 9, 10 |
| `src/agent/demo.ts` | Demo seeds + payout receivers | 10 |
| `src/agent/sim-runner.ts` | sim_hold + rehold jobs (real sandbox card holds) | 10 |
| `scripts/worker-check.ts` | `npm run worker:check` end-to-end run | 11 |
| `tests/agent/*`, `tests/worker/*` | Unit tests + fakes (`sqlite.ts`, `fixtures.ts`, `fake-paypal.ts`, `fake-ai.ts`, `harness.ts`) | 2–10 |

---

### Task 1: PayPal client hardening and the GET calls reconcile needs

**Files:**
- Modify: `src/paypal/errors.ts`, `src/paypal/http.ts`, `src/paypal/payments.ts`, `src/paypal/payouts.ts`, `scripts/sandbox-check.ts`
- Modify: `tests/paypal/fake-fetch.ts`, `tests/paypal/http.test.ts`, `tests/paypal/payments.test.ts`, `tests/paypal/payouts.test.ts`

**Interfaces:**
- Consumes: existing `PayPalHttp`, `PayPalError`, `assertPayPalId`, `centsToValue`, `valueToCents`.
- Produces:
  - `requireBody<T>(body: T | undefined, what: string): T` (throws `PayPalError(502, "EMPTY_RESPONSE_BODY")`, not retryable)
  - `interface Hold { …existing; customId?: string }`
  - `interface OrderPayments { orderId: string; status: string; customId?: string; authorizations: { id: string; status: string }[]; captures: { id: string; status: string }[] }`
  - `getOrderPayments(http: PayPalHttp, orderId: string): Promise<OrderPayments>`
  - `getCapture(http: PayPalHttp, captureId: string, authorizationId: string): Promise<Charge>`
  - `payoutBatchId(showId: string, retry?: boolean): string` → `payout-<show>` | `payout-<show>-r1`
  - `payoutItemId(showId: string, role: string, retry?: boolean): string` → `<show>-<role>` | `<show>-<role>-r1` (≤ 63 chars)
  - `sendPayouts(http, showId, lines, opts?: { retry?: boolean }): Promise<SentBatch>`
  - `PayPalHttp.token()` shares one in-flight fetch; 429 waits `Retry-After` (capped 10 s)

- [ ] **Step 1: Let the fake fetch send headers**

In `tests/paypal/fake-fetch.ts`, replace the `FakeResponse` interface and the last line of the `fetch` function:

```ts
export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Throw instead of answering (simulates a network failure). */
  networkError?: boolean;
  /** Extra response headers, e.g. { "retry-after": "2" }. */
  headers?: Record<string, string>;
}
```

```ts
    if (next.status === 204) return new Response(null, { status: 204, headers: next.headers });
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status, headers: next.headers });
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/paypal/http.test.ts` (inside the top-level file, after the last `describe`):

```ts
describe("PayPalHttp sharing and Retry-After", () => {
  it("shares one token fetch between concurrent requests", async () => {
    const f = fakeFetch([{ status: 200, body: { a: 1 } }, { status: 200, body: { a: 2 } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    await Promise.all([http.request({ method: "GET", path: "/x" }), http.request({ method: "GET", path: "/y" })]);
    expect(f.tokenCalls()).toBe(1);
  });

  it("waits the Retry-After seconds on a 429", async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 429, body: { name: "RATE_LIMIT_REACHED" }, headers: { "retry-after": "2" } }, { status: 200, body: { ok: 1 } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: async (ms) => void waits.push(ms) });
    expect(await http.request({ method: "GET", path: "/x" })).toEqual({ ok: 1 });
    expect(waits).toEqual([2000]);
  });

  it("caps a long Retry-After at 10 seconds", async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 429, body: {}, headers: { "retry-after": "600" } }, { status: 200, body: {} }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: async (ms) => void waits.push(ms) });
    await http.request({ method: "GET", path: "/x" });
    expect(waits).toEqual([10_000]);
  });

  it("uses normal backoff when Retry-After is missing or unreadable", async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 503, body: {} }, { status: 429, body: {}, headers: { "retry-after": "soon" } }, { status: 200, body: {} }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: async (ms) => void waits.push(ms) });
    await http.request({ method: "GET", path: "/x" });
    expect(waits).toEqual([250, 500]);
  });
});
```

In `tests/paypal/payments.test.ts`:

1. Change the import line to:
```ts
import { authorizeOrder, captureHold, createCardHold, createPledgeOrder, getCapture, getOrderPayments, reauthorizeHold, refundCharge, requestIds, voidHold } from "../../src/paypal/payments";
```
2. In the test "parses the real sandbox card order into a Hold", add `customId: auth.custom_id,` after `expiresAt: Date.parse(auth.expiration_time),` inside the `toEqual({...})`.
3. Append:

```ts
describe("empty 2xx bodies", () => {
  it("createPledgeOrder throws EMPTY_RESPONSE_BODY instead of a TypeError", async () => {
    const { http } = client([{ status: 201 }]);
    await expect(createPledgeOrder(http, pledge)).rejects.toMatchObject({ paypalName: "EMPTY_RESPONSE_BODY", status: 502 });
  });
  it("captureHold throws EMPTY_RESPONSE_BODY and it is not retryable", async () => {
    const { http } = client([{ status: 201 }]);
    const err = (await captureHold(http, "A1").catch((e) => e)) as PayPalError;
    expect(err.paypalName).toBe("EMPTY_RESPONSE_BODY");
    expect(err.retryable).toBe(false);
  });
});

describe("Hold.customId", () => {
  it("comes from the authorization, falling back to the purchase unit", async () => {
    const body = fixture("order-card-authorize");
    delete body.purchase_units[0].payments.authorizations[0].custom_id;
    const { http } = client([{ status: 201, body }]);
    const hold = await createCardHold(http, pledge, card);
    expect(hold.customId).toBe(body.purchase_units[0].custom_id);
  });
  it("is absent when PayPal sends none", async () => {
    const body = fixture("order-card-authorize");
    delete body.purchase_units[0].payments.authorizations[0].custom_id;
    delete body.purchase_units[0].custom_id;
    const { http } = client([{ status: 201, body }]);
    expect((await createCardHold(http, pledge, card)).customId).toBeUndefined();
  });
});

describe("getOrderPayments", () => {
  it("lists the order's authorizations and captures", async () => {
    const { f, http } = client([{ status: 200, body: { id: "O1", status: "COMPLETED", purchase_units: [{ custom_id: "s:p", payments: { authorizations: [{ id: "A1", status: "CAPTURED" }], captures: [{ id: "C1", status: "COMPLETED" }] } }] } }]);
    expect(await getOrderPayments(http, "O1")).toEqual({ orderId: "O1", status: "COMPLETED", customId: "s:p", authorizations: [{ id: "A1", status: "CAPTURED" }], captures: [{ id: "C1", status: "COMPLETED" }] });
    expect(f.apiCalls()[0]).toMatchObject({ method: "GET", url: `${SANDBOX_BASE}/v2/checkout/orders/O1` });
  });
  it("returns empty lists when the order has no payments yet", async () => {
    const { http } = client([{ status: 200, body: { id: "O2", status: "CREATED" } }]);
    expect(await getOrderPayments(http, "O2")).toEqual({ orderId: "O2", status: "CREATED", authorizations: [], captures: [] });
  });
  it("refuses an unsafe id before any call", async () => {
    const { f, http } = client([]);
    await expect(getOrderPayments(http, "../x")).rejects.toBeInstanceOf(RangeError);
    expect(f.apiCalls()).toHaveLength(0);
  });
});

describe("getCapture", () => {
  it("parses gross, fee and net like captureHold", async () => {
    const body = fixture("capture");
    const { f, http } = client([{ status: 200, body }]);
    const c = await getCapture(http, body.id, "A11");
    expect(c).toEqual({ captureId: body.id, authorizationId: "A11", status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 });
    expect(f.apiCalls()[0]).toMatchObject({ method: "GET", url: `${SANDBOX_BASE}/v2/payments/captures/${body.id}` });
  });
});
```

In `tests/paypal/payouts.test.ts`:

1. Change the import to:
```ts
import { getPayoutBatch, isDuplicateBatch, payoutBatchId, payoutItemId, sendPayouts } from "../../src/paypal/payouts";
```
2. Append:

```ts
describe("retry batch ids", () => {
  it("names the one retry batch and its items with -r1", () => {
    expect(payoutBatchId("show1", true)).toBe("payout-show1-r1");
    expect(payoutItemId("show1", "room")).toBe("show1-room");
    expect(payoutItemId("show1", "room", true)).toBe("show1-room-r1");
  });
  it("refuses an item id longer than 63 characters", () => {
    expect(() => payoutItemId("x".repeat(60), "artist")).toThrow(RangeError);
  });
  it("sends the retry batch with -r1 ids", async () => {
    const body = fixture("payout-create");
    const { f, http } = client([{ status: 201, body }]);
    const sent = await sendPayouts(http, "show1", [lines[0]], { retry: true });
    expect(sent.senderBatchId).toBe("payout-show1-r1");
    const call = f.apiCalls()[0];
    expect(call.headers["paypal-request-id"]).toBe("payout-show1-r1");
    expect(JSON.parse(call.body!).items[0].sender_item_id).toBe("show1-room-r1");
  });
});

describe("payout validation", () => {
  it("refuses a line without a valid PayPal email, without calling PayPal", async () => {
    const { f, http } = client([]);
    await expect(sendPayouts(http, "s", [{ ...lines[0], paypalEmail: "not-an-email" }])).rejects.toThrow(/PayPal email/);
    expect(f.apiCalls()).toHaveLength(0);
  });
  it("throws when PayPal's answer has no payout_batch_id", async () => {
    const { http } = client([{ status: 201, body: { batch_header: { batch_status: "PENDING" } } }]);
    await expect(sendPayouts(http, "s", [lines[0]])).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY" });
  });
  it("throws when a batch item has no sender_item_id", async () => {
    const body = fixture("payout-get");
    delete body.items[0].payout_item.sender_item_id;
    const { http } = client([{ status: 200, body }]);
    await expect(getPayoutBatch(http, "V8PDK75HD9EW4")).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY" });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run tests/paypal`
Expected: FAIL. Errors include `getOrderPayments is not a function` / `payoutItemId is not a function`, the token test reports `tokenCalls` 2, and the Retry-After tests report waits `[250]`.

- [ ] **Step 4: Add `requireBody` to `src/paypal/errors.ts`**

Replace the `NOT_RETRYABLE` line and append the helper at the end of the file:

```ts
/** Our own checks on a response that may already have succeeded, or that a retry cannot fix. */
const NOT_RETRYABLE = new Set(["UNEXPECTED_CURRENCY", "BAD_AMOUNT", "BAD_RESPONSE_BODY", "BAD_TOKEN_RESPONSE", "EMPTY_RESPONSE_BODY"]);
```

```ts
/** A 2xx with no body where we need one. The call may have succeeded, so callers reconcile instead of retrying blindly. */
export function requireBody<T>(body: T | undefined, what: string): T {
  if (body === undefined || body === null) throw new PayPalError(502, "EMPTY_RESPONSE_BODY", `PayPal returned no ${what}`);
  return body;
}
```

- [ ] **Step 5: Share the token fetch and honour Retry-After in `src/paypal/http.ts`**

Add the constant under `MAX_REQUEST_ID`:

```ts
const MAX_RETRY_AFTER_MS = 10_000;
```

Add the field under `private cached?…`:

```ts
  private inflight?: Promise<string>;
```

Replace the whole `token()` method with:

```ts
  async token(force = false): Promise<string> {
    if (!force && this.cached && this.now() < this.cached.expiresAt - TOKEN_MARGIN_MS) return this.cached.token;
    // Concurrent callers share one token fetch.
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
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
    this.cached = { token, expiresAt: this.now() + expiresIn * 1000 };
    return token;
  }
```

In `request()`, replace the last three lines of the loop body:

```ts
      last = await errorFromResponse(res);
      if (!last.retryable || !canRetry) throw last;
      await this.sleep(250 * 2 ** (attempt - 1));
```

with:

```ts
      last = await errorFromResponse(res);
      if (!last.retryable || !canRetry) throw last;
      await this.sleep(this.retryDelay(res, attempt));
```

Add this private method after `request()`:

```ts
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
```

- [ ] **Step 6: Replace `src/paypal/payments.ts`**

```ts
import type { Cents } from "../core/money";
import { assertPayPalId, centsToValue, valueToCents } from "./amount";
import { PayPalError, requireBody } from "./errors";
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
  /** The custom_id PayPal echoed back ("show:pledge"), when it sent one. */
  customId?: string;
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

/** What PayPal says happened to an order: used to reconcile when an answer was lost or refused. */
export interface OrderPayments {
  orderId: string;
  status: string;
  customId?: string;
  authorizations: { id: string; status: string }[];
  captures: { id: string; status: string }[];
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
  custom_id?: string;
}
interface OrderBody {
  id: string;
  status: string;
  purchase_units?: { custom_id?: string; payments?: { authorizations?: AuthBody[]; captures?: { id: string; status: string }[] } }[];
}
interface CaptureBody {
  id: string;
  status: string;
  seller_receivable_breakdown?: { gross_amount: Money; paypal_fee?: Money; net_amount: Money };
}

function purchaseUnit(p: PledgeRef) {
  return { reference_id: p.showId, custom_id: `${p.showId}:${p.pledgeId}`, description: p.description, amount: { currency_code: "USD", value: centsToValue(p.amountCents) } };
}

/** Every amount must be USD. A CAD sandbox account once returned net in CAD, so never trust a bare number. */
function usdCents(m: Money, field: string): Cents {
  if (m.currency_code !== "USD") throw new PayPalError(502, "UNEXPECTED_CURRENCY", `${field} came back in ${m.currency_code}, expected USD`);
  return valueToCents(m.value);
}

function toHold(orderId: string, a: AuthBody, fallbackCents?: Cents, unitCustomId?: string): Hold {
  const createdAt = Date.parse(a.create_time ?? "");
  const expiresAt = Date.parse(a.expiration_time ?? "");
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw new Error(`authorization ${a.id} is missing its create or expiration time`);
  const amountCents = a.amount ? usdCents(a.amount, "authorization amount") : fallbackCents;
  if (amountCents === undefined) throw new Error(`authorization ${a.id} has no amount`);
  const hold: Hold = { authorizationId: a.id, orderId, amountCents, status: a.status, createdAt, expiresAt };
  const customId = a.custom_id ?? unitCustomId;
  if (customId !== undefined) hold.customId = customId;
  return hold;
}

function firstUnit(o: OrderBody | undefined) {
  return o?.purchase_units?.[0];
}

function firstAuth(o: OrderBody | undefined): AuthBody | undefined {
  return firstUnit(o)?.payments?.authorizations?.[0];
}

function toCharge(c: CaptureBody, authorizationId: string): Charge {
  const b = c.seller_receivable_breakdown;
  const grossCents = b ? usdCents(b.gross_amount, "gross_amount") : undefined;
  const netCents = b ? usdCents(b.net_amount, "net_amount") : undefined;
  const paypalFee = b?.paypal_fee ? usdCents(b.paypal_fee, "paypal_fee") : undefined;
  const feeCents = b ? (paypalFee ?? grossCents! - netCents!) : undefined;
  return { captureId: c.id, authorizationId, status: c.status, grossCents, feeCents, netCents };
}

/** For the JS SDK button: the browser approves this order, then the server calls authorizeOrder. */
export async function createPledgeOrder(http: PayPalHttp, p: PledgeRef): Promise<{ orderId: string }> {
  const o = requireBody(await http.request<OrderBody>({ method: "POST", path: "/v2/checkout/orders", requestId: requestIds.order(p.showId, p.pledgeId), body: { intent: "AUTHORIZE", purchase_units: [purchaseUnit(p)] } }), "order");
  return { orderId: o.id };
}

export async function authorizeOrder(http: PayPalHttp, orderId: string): Promise<Hold> {
  assertPayPalId(orderId, "order id");
  const o = await http.request<OrderBody>({ method: "POST", path: `/v2/checkout/orders/${orderId}/authorize`, requestId: requestIds.authorize(orderId), prefer: "return=representation", body: {} });
  const a = firstAuth(o);
  if (!a) throw new Error(`order ${orderId} (${o?.status}) was not authorized`);
  return toHold(orderId, a, undefined, firstUnit(o)?.custom_id);
}

/** Simulated fan: a real sandbox hold on a test card, with no buyer login. Callers MUST check `status === "CREATED"`. */
export async function createCardHold(http: PayPalHttp, p: PledgeRef, card: TestCard): Promise<Hold> {
  const o = requireBody(
    await http.request<OrderBody>({
      method: "POST",
      path: "/v2/checkout/orders",
      requestId: requestIds.hold(p.showId, p.pledgeId),
      prefer: "return=representation",
      body: { intent: "AUTHORIZE", purchase_units: [purchaseUnit(p)], payment_source: { card: { number: card.number, expiry: card.expiry, security_code: card.securityCode, name: card.name } } },
    }),
    "order",
  );
  const a = firstAuth(o);
  if (a) return toHold(o.id, a, p.amountCents, firstUnit(o)?.custom_id);
  return authorizeOrder(http, o.id);
}

export async function captureHold(http: PayPalHttp, authorizationId: string): Promise<Charge> {
  assertPayPalId(authorizationId, "authorization id");
  const c = requireBody(await http.request<CaptureBody>({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/capture`, requestId: requestIds.capture(authorizationId), prefer: "return=representation", body: { final_capture: true } }), "capture");
  return toCharge(c, authorizationId);
}

/** Reads a capture, e.g. to learn its net after a lost or PENDING answer. */
export async function getCapture(http: PayPalHttp, captureId: string, authorizationId: string): Promise<Charge> {
  assertPayPalId(captureId, "capture id");
  assertPayPalId(authorizationId, "authorization id");
  const c = requireBody(await http.request<CaptureBody>({ method: "GET", path: `/v2/payments/captures/${captureId}` }), "capture");
  return toCharge(c, authorizationId);
}

/** Reads an order's authorizations and captures (reconcile before re-trying a money call). */
export async function getOrderPayments(http: PayPalHttp, orderId: string): Promise<OrderPayments> {
  assertPayPalId(orderId, "order id");
  const o = requireBody(await http.request<OrderBody>({ method: "GET", path: `/v2/checkout/orders/${orderId}` }), "order");
  const unit = firstUnit(o);
  const out: OrderPayments = {
    orderId: o.id,
    status: o.status,
    authorizations: (unit?.payments?.authorizations ?? []).map((a) => ({ id: a.id, status: a.status })),
    captures: (unit?.payments?.captures ?? []).map((c) => ({ id: c.id, status: c.status })),
  };
  if (unit?.custom_id !== undefined) out.customId = unit.custom_id;
  return out;
}

export async function voidHold(http: PayPalHttp, authorizationId: string): Promise<void> {
  assertPayPalId(authorizationId, "authorization id");
  await http.request({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/void`, requestId: requestIds.void(authorizationId) });
}

/**
 * Returns the NEW authorization. `orderId` is "" because PayPal's reauthorize response does not carry the order.
 * Plan 4 never relies on this (spike decision 4); kept for the sandbox check.
 */
export async function reauthorizeHold(http: PayPalHttp, authorizationId: string, amountCents: Cents): Promise<Hold> {
  assertPayPalId(authorizationId, "authorization id");
  const a = requireBody(await http.request<AuthBody>({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/reauthorize`, requestId: requestIds.reauthorize(authorizationId), prefer: "return=representation", body: { amount: { currency_code: "USD", value: centsToValue(amountCents) } } }), "authorization");
  return toHold("", a, amountCents);
}

export async function refundCharge(http: PayPalHttp, captureId: string): Promise<Refund> {
  assertPayPalId(captureId, "capture id");
  const r = requireBody(await http.request<{ id: string; status: string }>({ method: "POST", path: `/v2/payments/captures/${captureId}/refund`, requestId: requestIds.refund(captureId), prefer: "return=representation", body: {} }), "refund");
  return { refundId: r.id, captureId, status: r.status };
}
```

- [ ] **Step 7: Replace `src/paypal/payouts.ts`**

```ts
import type { Cents } from "../core/money";
import type { PayoutLine } from "../core/split";
import { assertPayPalId, centsToValue, valueToCents } from "./amount";
import { PayPalError, requireBody } from "./errors";
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

export interface SendOptions {
  /** The one allowed retry batch: ids end in "-r1". */
  retry?: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** PayPal's sender_item_id cap is unverified (about 63); our ids stay well under it. */
const MAX_ITEM_ID = 63;

/** One batch per show (plus at most one "-r1" retry batch): PayPal refuses a second batch with the same sender_batch_id. */
export function payoutBatchId(showId: string, retry = false): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(showId)) throw new RangeError("showId must be 1-100 letters, digits or dashes");
  return retry ? `payout-${showId}-r1` : `payout-${showId}`;
}

/** sender_item_id: "<show>-<role>", or "<show>-<role>-r1" in the retry batch. */
export function payoutItemId(showId: string, role: string, retry = false): string {
  const id = `${showId}-${role}${retry ? "-r1" : ""}`;
  if (id.length > MAX_ITEM_ID) throw new RangeError(`payout item id must be at most ${MAX_ITEM_ID} characters`);
  return id;
}

/** Sends exactly these lines (the guard-approved split), minus any $0 line. */
export async function sendPayouts(http: PayPalHttp, showId: string, lines: PayoutLine[], opts: SendOptions = {}): Promise<SentBatch> {
  const retry = opts.retry === true;
  const senderBatchId = payoutBatchId(showId, retry);
  const seen = new Set<string>();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount) || l.amount < 0) throw new RangeError(`${l.label}: payout must be a non-negative whole number of cents`);
    if (seen.has(l.role)) throw new Error(`${l.role} appears twice in the payout`);
    seen.add(l.role);
  }
  const sentLines = lines.filter((l) => l.amount > 0);
  if (sentLines.length === 0) throw new Error("Nothing to pay: every payout line is $0");
  for (const l of sentLines) {
    if (typeof l.paypalEmail !== "string" || !EMAIL.test(l.paypalEmail)) throw new RangeError(`${l.label}: needs a valid PayPal email`);
  }
  const res = requireBody(
    await http.request<{ batch_header?: { payout_batch_id?: string; batch_status?: string } }>({
      method: "POST",
      path: "/v1/payments/payouts",
      requestId: senderBatchId,
      body: {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "Your share from Tip the Room", recipient_type: "EMAIL" },
        items: sentLines.map((l) => ({
          recipient_type: "EMAIL",
          receiver: l.paypalEmail,
          amount: { value: centsToValue(l.amount), currency: "USD" },
          sender_item_id: payoutItemId(showId, l.role, retry),
          note: `${l.label}: your share of the show`,
        })),
      },
    }),
    "payout batch",
  );
  const batchId = res.batch_header?.payout_batch_id;
  if (typeof batchId !== "string" || batchId.length === 0) throw new PayPalError(502, "BAD_RESPONSE_BODY", "PayPal's payout answer had no payout_batch_id");
  return { batchId, senderBatchId, status: res.batch_header?.batch_status ?? "UNKNOWN", sentLines };
}

interface BatchBody {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header?: { sender_batch_id?: string } };
  items?: { transaction_id?: string; transaction_status?: string; payout_item?: { sender_item_id?: string; amount?: { value: string; currency: string } } }[];
}

/** Payout amounts use `currency` (not `currency_code`). Never trust a bare number. */
function usdCents(a: { value: string; currency: string } | undefined, field: string): Cents {
  if (!a) throw new Error(`${field} is missing from the payout item`);
  if (a.currency !== "USD") throw new PayPalError(502, "UNEXPECTED_CURRENCY", `${field} came back in ${a.currency}, expected USD`);
  return valueToCents(a.value);
}

export async function getPayoutBatch(http: PayPalHttp, batchId: string): Promise<PayoutBatch> {
  assertPayPalId(batchId, "batch id");
  const b = requireBody(await http.request<BatchBody>({ method: "GET", path: `/v1/payments/payouts/${batchId}` }), "payout batch");
  return {
    batchId: b.batch_header.payout_batch_id,
    senderBatchId: b.batch_header.sender_batch_header?.sender_batch_id ?? "",
    status: b.batch_header.batch_status,
    items: (b.items ?? []).map((i) => {
      const senderItemId = i.payout_item?.sender_item_id;
      if (!senderItemId) throw new PayPalError(502, "BAD_RESPONSE_BODY", "a payout item came back without its sender_item_id");
      return { senderItemId, status: i.transaction_status ?? "UNKNOWN", transactionId: i.transaction_id, amountCents: usdCents(i.payout_item?.amount, "payout item amount") };
    }),
  };
}

/**
 * True when PayPal refused the batch because this sender_batch_id was already used.
 * Shape recorded in tests/paypal/fixtures/payout-duplicate.json. USER_BUSINESS_ERROR is generic, so it is never matched alone.
 * Payouts do NOT replay by PayPal-Request-Id: after a lost response, a resend gets this error, which means "already sent".
 */
export function isDuplicateBatch(e: unknown): boolean {
  if (!(e instanceof PayPalError)) return false;
  if (e.status !== 400 || e.paypalName !== "USER_BUSINESS_ERROR") return false;
  return e.issues.some((i) => i.field === "SENDER_BATCH_ID" || (typeof i.issue === "string" && i.issue.toLowerCase().includes("sender_batch_id already exists")));
}
```

- [ ] **Step 8: Run the PayPal tests**

Run: `npx vitest run tests/paypal`
Expected: PASS (all files, including the existing tests).

- [ ] **Step 9: Add a live order/capture GET check to `scripts/sandbox-check.ts`**

1. Add `getCapture,` and `getOrderPayments,` to the import list from `"../src/paypal"`.
2. Add this flow after `flowD`:

```ts
async function flowE() {
  const hold = await createCardHold(http, pledge("e"), card);
  const charge = await captureHold(http, hold.authorizationId);
  const order = await getOrderPayments(http, hold.orderId);
  line(order.captures.some((c) => c.id === charge.captureId) && order.authorizations.some((a) => a.id === hold.authorizationId), "E · order lists its authorization and capture", `${order.status} auth=${order.authorizations.map((a) => a.status).join(",")} capture=${order.captures.map((c) => c.status).join(",")}`);
  const read = await getCapture(http, charge.captureId, hold.authorizationId);
  line(read.netCents === charge.netCents && read.status === "COMPLETED", "E · capture readable with its net", `net ${read.netCents}`);
  await refundCharge(http, charge.captureId);
}
```

3. Change the loop list to `[["A", flowA], ["B", flowB], ["C", flowC], ["D", flowD], ["E", flowE]] as const`.

- [ ] **Step 10: Run the live sandbox check**

Run: `npm run sandbox:check`
Expected: every line `PASS`, ending `Sandbox check: all green.` The two new lines are `E · order lists its authorization and capture` and `E · capture readable with its net`. If the E lines fail because the order body puts captures somewhere else, record the real shape (statuses only, never personal fields) in the commit message and STOP: report to the controller instead of guessing.

- [ ] **Step 11: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add src/paypal scripts/sandbox-check.ts tests/paypal
git commit -m "feat(paypal): order/capture GETs, retry batch ids, shared token fetch, Retry-After, empty-body checks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Ledger store and projection (append-only events, jobs outbox, state rebuilt from events)

**Files:**
- Create: `src/agent/sql.ts`, `src/agent/events.ts`, `src/agent/ids.ts`, `src/agent/policy.ts`, `src/agent/project.ts`, `src/agent/store.ts`
- Create: `tests/agent/sqlite.ts`, `tests/agent/fixtures.ts`, `tests/agent/store.test.ts`, `tests/agent/project.test.ts`, `tests/agent/ids.test.ts`

**Interfaces:**
- Consumes: `reduce`, `initialCampaign`, `Campaign`, `CampaignEvent` (`src/core/campaign.ts`); `mandateSignedEvent`, `Mandate`, `buildMandate`, `signMandate` (`src/core/mandate.ts`); `PayoutLine`, `Role` (`src/core/split.ts`); `LedgerKind` (`src/paypal/webhooks.ts`); `DAY_MS` (`src/core/holds.ts`).
- Produces:
  - `sql.ts`: `type SqlValue = string | number | null`, `type SqlRow`, `interface SqlLike { exec<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]): { toArray(): T[] } }`, `interface SqlDb { sql: SqlLike; transaction<T>(fn: () => T): T }`
  - `events.ts`: `type AiSource = "model" | "template" | "resting"`, `type ProposalOptionId = "extend" | "lower" | "pay_short"`, `interface ProposalOption`, `interface SettlementNote`, `interface PayoutItemStatus`, `type LedgerEvent` (24 variants below), `eventKey(e: LedgerEvent): string`
  - `ids.ts`: `type Random = (byteCount: number) => Uint8Array`, `cryptoRandom`, `interface Clock { now(): number }`, `systemClock`, `newId(prefix: "s" | "p" | "d", random: Random): string`, `isShowId(id: string): boolean`, `isDemoId(id: string): boolean`, `demoShowIds(demoId: string): [string, string]`, `newSecret(random: Random): string`, `sha256Hex(text: string): Promise<string>`, `sameHex(a: string, b: string): boolean`, `customIdFor(showId: string, pledgeId: string): string`, `showIdFromRef(ref: string): string | null`, `pledgeIdFromCustomId(customId: string): string | null`
  - `policy.ts`: `MAX_JOBS_PER_TURN = 12`, `MAX_JOB_ATTEMPTS = 8`, `LEASE_MS = 60_000`, `RECHECK_MS = 60_000`, `backoffMs(attempt: number): number`, `POLL_DELAY_MS = 60_000`, `PAYOUT_POLL_MAX = 8`, `REHOLD_MARGIN_MS = 2 days`, `PACE_LATE_MS = 72 h`, `DEMO_TTL_MS = 24 h`, `DEMO_GRACE_MS = 1 h`, `DEMO_MAX_GRACES = 3`, `SIM_CAP_PER_SHOW = 60`, `SIM_ADD_MAX = 20`, `MAX_ORDERS_PER_SHOW = 500`, `MONEY_JOBS: JobKind[]`
  - `project.ts`: `PledgeStatus`, `PledgeView`, `OrderView`, `RetiredHold`, `PayoutView`, `ProposalView`, `Projection`, `class LedgerCorrupt`, `emptyProjection()`, `campaignEventFor(e: LedgerEvent, p: Projection): CampaignEvent | null`, `applyEvent(p: Projection, s: StoredEvent): void`, `project(events: StoredEvent[]): Projection`, `heldPledges(p): PledgeView[]`, `chargedPledges(p): PledgeView[]`
  - `store.ts`: `StoredEvent`, `JobKind`, `JobStatus`, `Job`, `NewJob`, `LogEntry`, `LoggedEntry`, `class Store { migrate(); exists(); transaction(fn); getMeta(k); setMeta(k, v); deleteMeta(k); appendEvent(at, e): boolean; hasEvent(key); events(); eventsAfter(seq); projection(); resetProjection(); putJob(job, now): boolean; job(key); jobs(); dueJobs(now, limit); hasPending(kinds); nextJobAt(); updateJob(key, patch); log(entry); logs() }`
  - Tests: `memoryDb(): SqlDb` (`tests/agent/sqlite.ts`); fixtures `SHOW`, `LAUNCH`, `DEADLINE`, `TestClock`, `seqRandom()`, `testMandate()`, `signedEvent()`, `held(n)`, `captured(n, net?)`, `stored(events)` (`tests/agent/fixtures.ts`)

- [ ] **Step 1: Write the SQL port and the node:sqlite test adapter**

`src/agent/sql.ts`:

```ts
/** Values both Cloudflare's SqlStorage and node:sqlite accept and return (we never store blobs). */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqlCursor<T> {
  toArray(): T[];
}

/** The slice of Cloudflare's `ctx.storage.sql` this project uses. Tests adapt node:sqlite to it. */
export interface SqlLike {
  exec<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

/** SQL plus an all-or-nothing wrapper (Cloudflare: ctx.storage.transactionSync; tests: BEGIN/COMMIT). */
export interface SqlDb {
  sql: SqlLike;
  transaction<T>(fn: () => T): T;
}
```

`tests/agent/sqlite.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import type { SqlDb, SqlRow, SqlValue } from "../../src/agent/sql";

/** A fresh in-memory SQLite database behind the same interface the Durable Object uses. */
export function memoryDb(): SqlDb {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    sql: {
      exec<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]) {
        const rows = db.prepare(query).all(...bindings) as unknown as T[];
        return { toArray: () => rows };
      },
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth += 1;
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth -= 1;
      }
    },
  };
}
```

- [ ] **Step 2: Write `src/agent/events.ts`**

```ts
import type { Cents } from "../core/money";
import type { Mandate } from "../core/mandate";
import type { PayoutLine, Role } from "../core/split";
import type { LedgerKind } from "../paypal/webhooks";

/** Who wrote a piece of text: the model, a fixed template, or a template because the daily AI budget is spent. */
export type AiSource = "model" | "template" | "resting";

export type ProposalOptionId = "extend" | "lower" | "pay_short";

export interface ProposalOption {
  id: ProposalOptionId;
  /** The guard approval key this option grants, e.g. "extend:1794000000000" or "payout-shortfall:2824". */
  approvalKey: string;
  /** Plain words for the button, e.g. "Extend 4 days". */
  label: string;
  newDeadline?: number;
  newThreshold?: number;
  collectedNet?: Cents;
}

export interface SettlementNote {
  role: Role;
  label: string;
  text: string;
  source: AiSource;
}

export interface PayoutItemStatus {
  senderItemId: string;
  status: string;
  transactionId?: string;
  amountCents: Cents;
}

/**
 * Append-only ledger events. Money facts come only from PayPal API responses we fetched ourselves.
 * Each event has ONE deterministic key (eventKey), so it can be written at most once.
 */
export type LedgerEvent =
  | { type: "mandate_signed"; mandate: Mandate; hash: string; signedAt: string }
  | { type: "order_created"; orderId: string; pledgeId: string; amountCents: Cents; initials: string }
  | { type: "pledge_held"; pledgeId: string; orderId: string; authorizationId: string; amountCents: Cents; authorizedAt: number; expiresAt: number; initials: string; simulated: boolean }
  | { type: "pledge_rejected"; pledgeId: string; orderId: string | null; authorizationId: string | null; reason: string }
  | { type: "late_hold"; pledgeId: string; orderId: string; authorizationId: string; amountCents: Cents }
  | { type: "hold_replaced"; pledgeId: string; newPaypalPledgeId: string; orderId: string; authorizationId: string; oldOrderId: string; oldAuthorizationId: string; authorizedAt: number; expiresAt: number }
  | { type: "capture_ok"; authorizationId: string; captureId: string; grossCents: Cents; feeCents: Cents; netCents: Cents }
  | { type: "capture_failed"; authorizationId: string; reason: string }
  | { type: "void_ok"; authorizationId: string }
  | { type: "refund_ok"; captureId: string; refundId: string | null; status: string }
  | { type: "deadline_reached"; now: number; deadline: number }
  | { type: "payout_sent"; senderBatchId: string; batchId: string | null; status: string; lines: PayoutLine[]; retry: boolean; recovered: boolean }
  | { type: "payout_items"; batchId: string; items: PayoutItemStatus[] }
  | { type: "payout_batch_seen"; senderBatchId: string; batchId: string }
  | { type: "proposal_made"; proposalId: string; options: ProposalOption[]; explanation: string; recommend: ProposalOptionId | "wait"; source: AiSource }
  | { type: "proposal_approved"; proposalId: string; option: ProposalOptionId; approvalKey: string }
  | { type: "deadline_extended"; newDeadline: number }
  | { type: "threshold_lowered"; newThreshold: number }
  | { type: "show_cancelled" }
  | { type: "pace_checked"; check: 1 | 2 }
  | { type: "webhook_received"; eventId: string; kind: LedgerKind; ref: string; amountCents: Cents | null; customId: string | null }
  | { type: "notes_written"; notes: SettlementNote[] };

/**
 * The deterministic key that makes the ledger idempotent.
 * A pledge has exactly one outcome (held | rejected | late), an authorization exactly one capture outcome (ok | failed).
 */
export function eventKey(e: LedgerEvent): string {
  switch (e.type) {
    case "mandate_signed":
      return "mandate";
    case "order_created":
      return `order:${e.orderId}`;
    case "pledge_held":
    case "pledge_rejected":
    case "late_hold":
      return `pledge:${e.pledgeId}`;
    case "hold_replaced":
      return `replaced:${e.oldAuthorizationId}`;
    case "capture_ok":
    case "capture_failed":
      return `capture:${e.authorizationId}`;
    case "void_ok":
      return `void:${e.authorizationId}`;
    case "refund_ok":
      return `refund:${e.captureId}`;
    case "deadline_reached":
      return `deadline:${e.deadline}`;
    case "payout_sent":
      return `payout:${e.senderBatchId}`;
    case "payout_items":
      return `items:${e.batchId}:${e.items.map((i) => `${i.senderItemId}=${i.status}`).sort().join(",")}`;
    case "payout_batch_seen":
      return `batch:${e.senderBatchId}`;
    case "proposal_made":
      return `proposal:${e.proposalId}`;
    case "proposal_approved":
      return `approved:${e.proposalId}`;
    case "deadline_extended":
      return "extended";
    case "threshold_lowered":
      return `lowered:${e.newThreshold}`;
    case "show_cancelled":
      return "cancelled";
    case "pace_checked":
      return `pace:${e.check}`;
    case "webhook_received":
      return `webhook:${e.eventId}`;
    case "notes_written":
      return "notes";
  }
}
```

- [ ] **Step 3: Write `src/agent/ids.ts` and `src/agent/policy.ts`**

`src/agent/ids.ts`:

```ts
export type Random = (byteCount: number) => Uint8Array;
export const cryptoRandom: Random = (n) => crypto.getRandomValues(new Uint8Array(n));

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** 32 lower-case letters and digits, without l, o, 0 and 1. 256 % 32 === 0, so there is no bias. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** "s" = show, "p" = pledge, "d" = demo copy; plus 10 random characters. */
export function newId(prefix: "s" | "p" | "d", random: Random): string {
  let out: string = prefix;
  for (const b of random(10)) out += ALPHABET[b % 32];
  return out;
}

const SHOW_ID = /^(s[a-z2-9]{10}|d[a-z2-9]{10}[ab])$/;
const DEMO_ID = /^d[a-z2-9]{10}$/;

export function isShowId(id: string): boolean {
  return typeof id === "string" && SHOW_ID.test(id);
}

export function isDemoId(id: string): boolean {
  return typeof id === "string" && DEMO_ID.test(id);
}

/** A demo copy's two shows: "<demoId>a" tips, "<demoId>b" misses. */
export function demoShowIds(demoId: string): [string, string] {
  return [`${demoId}a`, `${demoId}b`];
}

/** 32 random bytes, base64url. Used for manage keys, demo keys and sign tokens. */
export function newSecret(random: Random): string {
  let s = "";
  for (const b of random(32)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two hex digests. */
export function sameHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PayPal custom_id for a pledge: "<show>:<pledge>". PayPal's cap is 127 characters. */
export function customIdFor(showId: string, pledgeId: string): string {
  const id = `${showId}:${pledgeId}`;
  if (id.length > 127) throw new RangeError("custom_id must be at most 127 characters");
  return id;
}

/** Finds our show id in a webhook's custom_id ("show:pledge"), sender_item_id ("show-role[-r1]") or sender_batch_id ("payout-show[-r1]"). */
export function showIdFromRef(ref: string): string | null {
  if (typeof ref !== "string") return null;
  const m = /^payout-([a-z0-9]+)(?:-r1)?$/.exec(ref) ?? /^([a-z0-9]+):/.exec(ref) ?? /^([a-z0-9]+)-[a-z]+(?:-r1)?$/.exec(ref);
  const id = m?.[1];
  return id && isShowId(id) ? id : null;
}

/** The pledge part of "<show>:<pledge>". */
export function pledgeIdFromCustomId(customId: string): string | null {
  const i = customId.indexOf(":");
  return i > 0 && i < customId.length - 1 ? customId.slice(i + 1) : null;
}
```

`src/agent/policy.ts`:

```ts
import { DAY_MS } from "../core/holds";
import type { JobKind } from "./store";

const HOUR_MS = 60 * 60 * 1000;

/** Free plan: 50 subrequests per invocation. A job makes at most 2 PayPal calls (plus one token fetch per turn). */
export const MAX_JOBS_PER_TURN = 12;
export const MAX_JOB_ATTEMPTS = 8;
/** A job being worked on is invisible to other drains for this long (a crash makes it due again). */
export const LEASE_MS = 60_000;
/** How soon to re-check an answer PayPal hasn't finished (PENDING, or no amounts yet). */
export const RECHECK_MS = 60_000;
const BACKOFF = [30_000, 120_000, 600_000, 1_800_000, HOUR_MS];
/** Wait before retry number `attempt` (1-based): 30 s, 2 min, 10 min, 30 min, then hourly. */
export function backoffMs(attempt: number): number {
  return BACKOFF[Math.min(Math.max(attempt, 1), BACKOFF.length) - 1];
}
/** Payout batch polls: n-th poll waits n minutes; at most this many. */
export const POLL_DELAY_MS = 60_000;
export const PAYOUT_POLL_MAX = 8;
/** Renew a simulated hold this long before it expires. */
export const REHOLD_MARGIN_MS = 2 * DAY_MS;
/** The second pace check runs this long before the deadline (spec 3.4). */
export const PACE_LATE_MS = 72 * HOUR_MS;
export const DEMO_TTL_MS = 24 * HOUR_MS;
export const DEMO_GRACE_MS = HOUR_MS;
export const DEMO_MAX_GRACES = 3;
export const SIM_CAP_PER_SHOW = 60;
export const SIM_ADD_MAX = 20;
export const MAX_ORDERS_PER_SHOW = 500;
/** Jobs that move or release money; a show isn't finished while one is pending. */
export const MONEY_JOBS: JobKind[] = ["capture", "void", "refund", "payout", "payout_retry", "reconcile", "sim_hold"];
```

- [ ] **Step 4: Write `src/agent/project.ts`**

```ts
import { initialCampaign, reduce, type Campaign, type CampaignEvent } from "../core/campaign";
import { mandateSignedEvent, type Mandate } from "../core/mandate";
import type { Cents } from "../core/money";
import type { PayoutLine } from "../core/split";
import type { AiSource, LedgerEvent, PayoutItemStatus, ProposalOption, ProposalOptionId, SettlementNote } from "./events";
import type { StoredEvent } from "./store";

export type PledgeStatus = "held" | "charged" | "capture_failed" | "released" | "refunded";

export interface PledgeView {
  pledgeId: string;
  /** 1-based order of arrival, for "Fan 03". */
  number: number;
  /** The pledge id PayPal knows (changes when a simulated hold is renewed: "<pledgeId>-h1"). */
  paypalPledgeId: string;
  orderId: string;
  authorizationId: string;
  amountCents: Cents;
  initials: string;
  simulated: boolean;
  authorizedAt: number;
  expiresAt: number;
  heldAt: number;
  status: PledgeStatus;
  captureId?: string;
  grossCents?: Cents;
  feeCents?: Cents;
  netCents?: Cents;
  refundId?: string | null;
}

export interface OrderView {
  orderId: string;
  pledgeId: string;
  amountCents: Cents;
  initials: string;
  createdAt: number;
  /** True once the order became a pledge, was refused, or arrived late. It is never authorized again. */
  resolved: boolean;
}

/** A hold that is not (or no longer) counted: it only ever gets voided. */
export interface RetiredHold {
  authorizationId: string;
  orderId: string | null;
  pledgeId: string;
  why: "late" | "rejected" | "replaced";
  voided: boolean;
}

export interface PayoutView {
  senderBatchId: string;
  batchId: string | null;
  status: string;
  lines: PayoutLine[];
  retry: boolean;
  recovered: boolean;
  sentAt: number;
  /** Latest status per sender_item_id. */
  items: Record<string, PayoutItemStatus>;
}

export interface ProposalView {
  proposalId: string;
  options: ProposalOption[];
  explanation: string;
  recommend: ProposalOptionId | "wait";
  source: AiSource;
  madeAt: number;
  approved: { option: ProposalOptionId; at: number } | null;
}

export interface Projection {
  campaign: Campaign;
  mandate: Mandate | null;
  mandateHash: string | null;
  signedAt: string | null;
  orders: Map<string, OrderView>;
  /** By our pledge id, in arrival order. */
  pledges: Map<string, PledgeView>;
  /** Current authorization id → pledge id (a renewed hold's old id moves to `retired`). */
  pledgeByAuth: Map<string, string>;
  pledgeByCapture: Map<string, string>;
  retired: Map<string, RetiredHold>;
  approvals: Set<string>;
  proposals: Map<string, ProposalView>;
  /** Sum of netCents from capture responses only. Never a model's number, never a webhook's (gross) amount. */
  collectedNet: Cents;
  collectedGross: Cents;
  payouts: PayoutView[];
  paceChecks: Set<number>;
  notes: SettlementNote[] | null;
  rejected: number;
}

export class LedgerCorrupt extends Error {
  constructor(seq: number, why: string) {
    super(`Ledger event ${seq} cannot be replayed: ${why}`);
    this.name = "LedgerCorrupt";
  }
}

export function emptyProjection(): Projection {
  return {
    campaign: initialCampaign(),
    mandate: null,
    mandateHash: null,
    signedAt: null,
    orders: new Map(),
    pledges: new Map(),
    pledgeByAuth: new Map(),
    pledgeByCapture: new Map(),
    retired: new Map(),
    approvals: new Set(),
    proposals: new Map(),
    collectedNet: 0,
    collectedGross: 0,
    payouts: [],
    paceChecks: new Set(),
    notes: null,
    rejected: 0,
  };
}

function pledgeOf(p: Projection, authorizationId: string): PledgeView | undefined {
  const id = p.pledgeByAuth.get(authorizationId);
  return id ? p.pledges.get(id) : undefined;
}

/** The reducer event a ledger event stands for, judged against the state BEFORE the event. Null = no state change. */
export function campaignEventFor(e: LedgerEvent, p: Projection): CampaignEvent | null {
  switch (e.type) {
    case "mandate_signed":
      return mandateSignedEvent(e.mandate);
    case "pledge_held":
      return { type: "pledge_held" };
    case "capture_ok":
      return pledgeOf(p, e.authorizationId)?.status === "held" ? { type: "pledge_charged" } : null;
    case "capture_failed":
      return pledgeOf(p, e.authorizationId)?.status === "held" ? { type: "pledge_capture_failed" } : null;
    case "void_ok":
      return pledgeOf(p, e.authorizationId)?.status === "held" ? { type: "holds_released", count: 1 } : null;
    case "refund_ok": {
      const id = p.pledgeByCapture.get(e.captureId);
      return id && p.pledges.get(id)?.status === "charged" ? { type: "refunds_sent", count: 1 } : null;
    }
    case "deadline_reached":
      return { type: "deadline_reached", now: e.now };
    case "payout_sent":
      return e.retry ? null : { type: "payouts_sent" };
    case "deadline_extended":
      return { type: "deadline_extended", newDeadline: e.newDeadline };
    case "threshold_lowered":
      return { type: "threshold_lowered", newThreshold: e.newThreshold };
    case "show_cancelled":
      return { type: "show_cancelled" };
    default:
      return null;
  }
}

/** Applies one stored event: first the reducer (effects are ignored: replay never executes anything), then the views. */
export function applyEvent(p: Projection, s: StoredEvent): void {
  const e = s.event;
  const ce = campaignEventFor(e, p);
  if (ce) {
    try {
      p.campaign = reduce(p.campaign, ce).campaign;
    } catch (err) {
      throw new LedgerCorrupt(s.seq, err instanceof Error ? err.message : String(err));
    }
  }
  switch (e.type) {
    case "mandate_signed":
      p.mandate = e.mandate;
      p.mandateHash = e.hash;
      p.signedAt = e.signedAt;
      break;
    case "order_created":
      p.orders.set(e.orderId, { orderId: e.orderId, pledgeId: e.pledgeId, amountCents: e.amountCents, initials: e.initials, createdAt: s.at, resolved: false });
      break;
    case "pledge_held": {
      p.pledges.set(e.pledgeId, {
        pledgeId: e.pledgeId,
        number: p.pledges.size + 1,
        paypalPledgeId: e.pledgeId,
        orderId: e.orderId,
        authorizationId: e.authorizationId,
        amountCents: e.amountCents,
        initials: e.initials,
        simulated: e.simulated,
        authorizedAt: e.authorizedAt,
        expiresAt: e.expiresAt,
        heldAt: s.at,
        status: "held",
      });
      p.pledgeByAuth.set(e.authorizationId, e.pledgeId);
      const order = p.orders.get(e.orderId);
      if (order) order.resolved = true;
      break;
    }
    case "pledge_rejected": {
      p.rejected += 1;
      const order = e.orderId ? p.orders.get(e.orderId) : undefined;
      if (order) order.resolved = true;
      if (e.authorizationId) p.retired.set(e.authorizationId, { authorizationId: e.authorizationId, orderId: e.orderId, pledgeId: e.pledgeId, why: "rejected", voided: false });
      break;
    }
    case "late_hold": {
      const order = p.orders.get(e.orderId);
      if (order) order.resolved = true;
      p.retired.set(e.authorizationId, { authorizationId: e.authorizationId, orderId: e.orderId, pledgeId: e.pledgeId, why: "late", voided: false });
      break;
    }
    case "hold_replaced": {
      const pledge = p.pledges.get(e.pledgeId);
      if (!pledge) break;
      p.retired.set(e.oldAuthorizationId, { authorizationId: e.oldAuthorizationId, orderId: e.oldOrderId, pledgeId: e.pledgeId, why: "replaced", voided: false });
      p.pledgeByAuth.delete(e.oldAuthorizationId);
      pledge.authorizationId = e.authorizationId;
      pledge.orderId = e.orderId;
      pledge.paypalPledgeId = e.newPaypalPledgeId;
      pledge.authorizedAt = e.authorizedAt;
      pledge.expiresAt = e.expiresAt;
      p.pledgeByAuth.set(e.authorizationId, e.pledgeId);
      break;
    }
    case "capture_ok": {
      const pledge = pledgeOf(p, e.authorizationId);
      if (!pledge || pledge.status !== "held") break;
      pledge.status = "charged";
      pledge.captureId = e.captureId;
      pledge.grossCents = e.grossCents;
      pledge.feeCents = e.feeCents;
      pledge.netCents = e.netCents;
      p.pledgeByCapture.set(e.captureId, pledge.pledgeId);
      p.collectedNet += e.netCents;
      p.collectedGross += e.grossCents;
      break;
    }
    case "capture_failed": {
      const pledge = pledgeOf(p, e.authorizationId);
      if (pledge && pledge.status === "held") pledge.status = "capture_failed";
      break;
    }
    case "void_ok": {
      const pledge = pledgeOf(p, e.authorizationId);
      if (pledge && pledge.status === "held") pledge.status = "released";
      const retired = p.retired.get(e.authorizationId);
      if (retired) retired.voided = true;
      break;
    }
    case "refund_ok": {
      const id = p.pledgeByCapture.get(e.captureId);
      const pledge = id ? p.pledges.get(id) : undefined;
      if (pledge && pledge.status === "charged") {
        pledge.status = "refunded";
        pledge.refundId = e.refundId;
      }
      break;
    }
    case "payout_sent":
      p.payouts.push({ senderBatchId: e.senderBatchId, batchId: e.batchId, status: e.status, lines: e.lines, retry: e.retry, recovered: e.recovered, sentAt: s.at, items: {} });
      break;
    case "payout_items": {
      const payout = p.payouts.find((x) => x.batchId === e.batchId);
      if (payout) for (const item of e.items) payout.items[item.senderItemId] = item;
      break;
    }
    case "payout_batch_seen": {
      const payout = p.payouts.find((x) => x.senderBatchId === e.senderBatchId);
      if (payout && payout.batchId === null) payout.batchId = e.batchId;
      break;
    }
    case "proposal_made":
      p.proposals.set(e.proposalId, { proposalId: e.proposalId, options: e.options, explanation: e.explanation, recommend: e.recommend, source: e.source, madeAt: s.at, approved: null });
      break;
    case "proposal_approved": {
      const proposal = p.proposals.get(e.proposalId);
      if (proposal) proposal.approved = { option: e.option, at: s.at };
      p.approvals.add(e.approvalKey);
      break;
    }
    case "show_cancelled":
      // The artist calling the show off IS the refund approval (spec 3.7, guard key "refund").
      p.approvals.add("refund");
      break;
    case "pace_checked":
      p.paceChecks.add(e.check);
      break;
    case "notes_written":
      p.notes = e.notes;
      break;
    default:
      break;
  }
}

export function project(events: StoredEvent[]): Projection {
  const p = emptyProjection();
  for (const s of events) applyEvent(p, s);
  return p;
}

export function heldPledges(p: Projection): PledgeView[] {
  return [...p.pledges.values()].filter((x) => x.status === "held");
}

export function chargedPledges(p: Projection): PledgeView[] {
  return [...p.pledges.values()].filter((x) => x.status === "charged");
}
```

- [ ] **Step 5: Write `src/agent/store.ts`**

```ts
import type { RuleId } from "../core/rules";
import { eventKey, type AiSource, type LedgerEvent } from "./events";
import { applyEvent, emptyProjection, type Projection } from "./project";
import type { SqlDb, SqlValue } from "./sql";

export interface StoredEvent {
  seq: number;
  key: string;
  at: number;
  event: LedgerEvent;
}

export type JobKind = "capture" | "void" | "refund" | "reconcile" | "payout" | "payout_retry" | "payout_poll" | "sim_hold" | "rehold";
export type JobStatus = "pending" | "done" | "failed" | "skipped" | "blocked";

export interface Job {
  key: string;
  kind: JobKind;
  /** The PayPal id or pledge id the job acts on. */
  target: string;
  status: JobStatus;
  attempts: number;
  nextAt: number;
  note: string;
  createdAt: number;
}

export interface NewJob {
  key: string;
  kind: JobKind;
  target: string;
  nextAt: number;
  note?: string;
}

/** One agent-log line: what it saw, what it proposed or did, which rule allowed it, and PayPal's request/result ids. */
export interface LogEntry {
  at: number;
  saw: string;
  did: string;
  rule: RuleId | null;
  requestId: string | null;
  resultId: string | null;
  source: AiSource | "code";
}

export interface LoggedEntry extends LogEntry {
  seq: number;
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, next_at)",
  "CREATE TABLE IF NOT EXISTS agent_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, saw TEXT NOT NULL, did TEXT NOT NULL, rule TEXT, request_id TEXT, result_id TEXT, source TEXT NOT NULL)",
];

type JobRow = { key: string; kind: string; target: string; status: string; attempts: number; next_at: number; note: string; created_at: number };
const JOB_COLUMNS = "key, kind, target, status, attempts, next_at, note, created_at";

function toJob(r: JobRow): Job {
  return { key: r.key, kind: r.kind as JobKind, target: r.target, status: r.status as JobStatus, attempts: r.attempts, nextAt: r.next_at, note: r.note, createdAt: r.created_at };
}

/**
 * The campaign's storage. Events are append-only: there is no update or delete for them.
 * The projection is cached in memory and advanced with new events only.
 */
export class Store {
  private cache: Projection = emptyProjection();
  private cacheSeq = 0;

  constructor(private readonly db: SqlDb) {}

  migrate(): void {
    for (const statement of SCHEMA) this.db.sql.exec(statement);
  }

  /** True once this storage holds a show (an unknown id must never create tables). */
  exists(): boolean {
    try {
      return this.getMeta("show_id") !== undefined;
    } catch {
      return false;
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  getMeta(key: string): string | undefined {
    return this.db.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  deleteMeta(key: string): void {
    this.db.sql.exec("DELETE FROM meta WHERE key = ?", key);
  }

  hasEvent(key: string): boolean {
    return this.db.sql.exec("SELECT 1 AS x FROM events WHERE key = ?", key).toArray().length > 0;
  }

  /** Appends once per deterministic key. Returns false (and writes nothing) when the key already exists. */
  appendEvent(at: number, event: LedgerEvent): boolean {
    const key = eventKey(event);
    if (this.hasEvent(key)) return false;
    this.db.sql.exec("INSERT INTO events (key, at, type, data) VALUES (?, ?, ?, ?)", key, at, event.type, JSON.stringify(event));
    return true;
  }

  events(): StoredEvent[] {
    return this.eventsAfter(0);
  }

  eventsAfter(seq: number): StoredEvent[] {
    return this.db.sql
      .exec<{ seq: number; key: string; at: number; data: string }>("SELECT seq, key, at, data FROM events WHERE seq > ? ORDER BY seq", seq)
      .toArray()
      .map((r) => ({ seq: r.seq, key: r.key, at: r.at, event: JSON.parse(r.data) as LedgerEvent }));
  }

  /** The current state, rebuilt from the events (incrementally). Read-only for callers. */
  projection(): Projection {
    try {
      for (const s of this.eventsAfter(this.cacheSeq)) {
        applyEvent(this.cache, s);
        this.cacheSeq = s.seq;
      }
      return this.cache;
    } catch (e) {
      this.resetProjection();
      throw e;
    }
  }

  /** Forget the cached state (after a rolled-back transaction); the next projection() replays every event. */
  resetProjection(): void {
    this.cache = emptyProjection();
    this.cacheSeq = 0;
  }

  /** Inserts a pending job once per key. Returns false when the key already exists (whatever its status). */
  putJob(job: NewJob, now: number): boolean {
    if (this.job(job.key)) return false;
    this.db.sql.exec(
      "INSERT INTO jobs (key, kind, target, status, attempts, next_at, note, created_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
      job.key,
      job.kind,
      job.target,
      job.nextAt,
      (job.note ?? "").slice(0, 500),
      now,
    );
    return true;
  }

  job(key: string): Job | undefined {
    const row = this.db.sql.exec<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE key = ?`, key).toArray()[0];
    return row ? toJob(row) : undefined;
  }

  jobs(): Job[] {
    return this.db.sql.exec<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY rowid`).toArray().map(toJob);
  }

  dueJobs(now: number, limit: number): Job[] {
    return this.db.sql
      .exec<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE status = 'pending' AND next_at <= ? ORDER BY next_at, rowid LIMIT ?`, now, limit)
      .toArray()
      .map(toJob);
  }

  hasPending(kinds: JobKind[]): boolean {
    if (kinds.length === 0) return false;
    const marks = kinds.map(() => "?").join(", ");
    return this.db.sql.exec(`SELECT 1 AS x FROM jobs WHERE status = 'pending' AND kind IN (${marks}) LIMIT 1`, ...kinds).toArray().length > 0;
  }

  nextJobAt(): number | undefined {
    const t = this.db.sql.exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM jobs WHERE status = 'pending'").toArray()[0]?.t;
    return t === null || t === undefined ? undefined : t;
  }

  updateJob(key: string, patch: { status?: JobStatus; attempts?: number; nextAt?: number; note?: string }): void {
    const sets: string[] = [];
    const values: SqlValue[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.attempts !== undefined) {
      sets.push("attempts = ?");
      values.push(patch.attempts);
    }
    if (patch.nextAt !== undefined) {
      sets.push("next_at = ?");
      values.push(patch.nextAt);
    }
    if (patch.note !== undefined) {
      sets.push("note = ?");
      values.push(patch.note.slice(0, 500));
    }
    if (sets.length === 0) return;
    this.db.sql.exec(`UPDATE jobs SET ${sets.join(", ")} WHERE key = ?`, ...values, key);
  }

  log(entry: LogEntry): void {
    this.db.sql.exec(
      "INSERT INTO agent_log (at, saw, did, rule, request_id, result_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.at,
      entry.saw.slice(0, 600),
      entry.did.slice(0, 600),
      entry.rule,
      entry.requestId,
      entry.resultId,
      entry.source,
    );
  }

  logs(): LoggedEntry[] {
    return this.db.sql
      .exec<{ seq: number; at: number; saw: string; did: string; rule: string | null; request_id: string | null; result_id: string | null; source: string }>(
        "SELECT seq, at, saw, did, rule, request_id, result_id, source FROM agent_log ORDER BY seq",
      )
      .toArray()
      .map((r) => ({ seq: r.seq, at: r.at, saw: r.saw, did: r.did, rule: r.rule as RuleId | null, requestId: r.request_id, resultId: r.result_id, source: r.source as LogEntry["source"] }));
  }
}
```

- [ ] **Step 6: Write the test fixtures**

`tests/agent/fixtures.ts`:

```ts
import { DAY_MS } from "../../src/core/holds";
import { buildMandate, signMandate, type Mandate } from "../../src/core/mandate";
import { eventKey, type LedgerEvent } from "../../src/agent/events";
import type { Random } from "../../src/agent/ids";
import type { StoredEvent } from "../../src/agent/store";

export const SHOW = "sshowtestaa";
export const LAUNCH = Date.parse("2026-11-01T00:00:00Z");
export const DEADLINE = Date.parse("2026-11-08T00:00:00Z");

/** A clock the test moves by hand. */
export class TestClock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
}

/** Deterministic, never-repeating "random" bytes: each call encodes a fresh counter. */
export function seqRandom(): Random {
  let n = 0;
  return (count) => {
    n += 1;
    const out = new Uint8Array(count);
    let v = n;
    for (let i = count - 1; i >= 0; i--) {
      out[i] = v % 32;
      v = Math.floor(v / 32);
    }
    return out;
  };
}

/** $15 pledges, room $20, artist minimum $20, 5% buffer: (2000 + 2000) × 1.05 / 1500 → target 3 fans. */
export function testMandate(): Mandate {
  return buildMandate({
    showId: SHOW,
    showName: "Acoustic Set",
    roomName: "Lucky's Café",
    showDate: "2026-11-10",
    ticketPrice: 1500,
    feeBufferBps: 500,
    parties: [
      { role: "room", label: "Lucky's Café", paypalEmail: "room@example.com", fixed: 2000 },
      { role: "artist", label: "Maya", paypalEmail: "maya@example.com", minimum: 2000 },
    ],
    launchedAt: "2026-11-01T00:00:00Z",
    deadline: "2026-11-08T00:00:00Z",
    timeZone: "UTC",
  });
}

export async function signedEvent(): Promise<LedgerEvent> {
  const s = await signMandate(testMandate(), "2026-11-01T00:00:00Z");
  return { type: "mandate_signed", mandate: s.mandate, hash: s.hash, signedAt: s.signedAt };
}

export function held(n: number, simulated = false): LedgerEvent {
  return { type: "pledge_held", pledgeId: `p${n}`, orderId: `O${n}`, authorizationId: `A${n}`, amountCents: 1500, authorizedAt: LAUNCH + n, expiresAt: LAUNCH + 29 * DAY_MS + n, initials: "AB", simulated };
}

export function captured(n: number, net = 1412): LedgerEvent {
  return { type: "capture_ok", authorizationId: `A${n}`, captureId: `C${n}`, grossCents: 1500, feeCents: 1500 - net, netCents: net };
}

export function stored(events: LedgerEvent[], start = LAUNCH): StoredEvent[] {
  return events.map((event, i) => ({ seq: i + 1, key: eventKey(event), at: start + i, event }));
}
```

- [ ] **Step 7: Write the failing tests**

`tests/agent/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { customIdFor, demoShowIds, isDemoId, isShowId, newId, newSecret, pledgeIdFromCustomId, sameHex, sha256Hex, showIdFromRef } from "../../src/agent/ids";
import { seqRandom } from "./fixtures";

describe("ids", () => {
  it("makes show, pledge and demo ids of 11 characters from a 32-letter alphabet", () => {
    const r = seqRandom();
    const s = newId("s", r);
    expect(s).toMatch(/^s[a-z2-9]{10}$/);
    expect(isShowId(s)).toBe(true);
    const d = newId("d", r);
    expect(isDemoId(d)).toBe(true);
    expect(demoShowIds(d).every(isShowId)).toBe(true);
    expect(newId("p", r)).not.toBe(newId("p", r));
  });
  it("rejects anything else as a show id", () => {
    for (const bad of ["", "s123", "S2345678abc", "sshowtestaa/", "x2345678abcd", "dshowtestaac"]) expect(isShowId(bad)).toBe(false);
  });
  it("makes 43-character base64url secrets", () => {
    expect(newSecret(seqRandom())).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("hashes with SHA-256 and compares in constant time", async () => {
    const h = await sha256Hex("abc");
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sameHex(h, h)).toBe(true);
    expect(sameHex(h, h.replace(/.$/, "0"))).toBe(false);
    expect(sameHex(h, "ab")).toBe(false);
  });
  it("finds the show in every PayPal reference shape we create", () => {
    expect(showIdFromRef("sshowtestaa:p1")).toBe("sshowtestaa");
    expect(showIdFromRef("sshowtestaa-room")).toBe("sshowtestaa");
    expect(showIdFromRef("sshowtestaa-artist-r1")).toBe("sshowtestaa");
    expect(showIdFromRef("payout-sshowtestaa")).toBe("sshowtestaa");
    expect(showIdFromRef("payout-dshowtestaaa-r1")).toBe("dshowtestaaa");
    expect(showIdFromRef("someone-else:p1")).toBeNull();
    expect(showIdFromRef("")).toBeNull();
  });
  it("splits custom ids and caps them at 127 characters", () => {
    expect(customIdFor("sshowtestaa", "p1")).toBe("sshowtestaa:p1");
    expect(pledgeIdFromCustomId("sshowtestaa:p1-h1")).toBe("p1-h1");
    expect(pledgeIdFromCustomId("nocolon")).toBeNull();
    expect(() => customIdFor("s", "p".repeat(130))).toThrow(RangeError);
  });
});
```

`tests/agent/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { backoffMs } from "../../src/agent/policy";
import { Store } from "../../src/agent/store";
import { captured, held, LAUNCH, signedEvent } from "./fixtures";
import { memoryDb } from "./sqlite";

function freshStore(): Store {
  const s = new Store(memoryDb());
  s.migrate();
  return s;
}

describe("Store", () => {
  it("does not exist until a show id is set, and an unmigrated store is not an error", () => {
    expect(new Store(memoryDb()).exists()).toBe(false);
    const s = freshStore();
    expect(s.exists()).toBe(false);
    s.setMeta("show_id", "sshowtestaa");
    expect(s.exists()).toBe(true);
  });

  it("appends each event once per deterministic key", async () => {
    const s = freshStore();
    expect(s.appendEvent(LAUNCH, await signedEvent())).toBe(true);
    expect(s.appendEvent(LAUNCH, held(1))).toBe(true);
    expect(s.appendEvent(LAUNCH + 5, held(1))).toBe(false);
    expect(s.events().map((e) => e.key)).toEqual(["mandate", "pledge:p1"]);
  });

  it("gives a pledge exactly one outcome and an authorization exactly one capture outcome", async () => {
    const s = freshStore();
    s.appendEvent(LAUNCH, held(1));
    expect(s.appendEvent(LAUNCH, { type: "late_hold", pledgeId: "p1", orderId: "O1", authorizationId: "A1", amountCents: 1500 })).toBe(false);
    expect(s.appendEvent(LAUNCH, captured(1))).toBe(true);
    expect(s.appendEvent(LAUNCH, { type: "capture_failed", authorizationId: "A1", reason: "x" })).toBe(false);
  });

  it("keeps the cached projection in step with new events", async () => {
    const s = freshStore();
    s.appendEvent(LAUNCH, await signedEvent());
    expect(s.projection().campaign.state).toBe("live");
    s.appendEvent(LAUNCH, held(1));
    s.appendEvent(LAUNCH, held(2));
    expect(s.projection().pledges.size).toBe(2);
    s.appendEvent(LAUNCH, held(3));
    expect(s.projection().campaign.state).toBe("tipped");
  });

  it("puts a job once per key and returns due jobs in order", () => {
    const s = freshStore();
    expect(s.putJob({ key: "capture:A1", kind: "capture", target: "A1", nextAt: 10 }, 0)).toBe(true);
    expect(s.putJob({ key: "capture:A1", kind: "capture", target: "A1", nextAt: 0 }, 0)).toBe(false);
    s.putJob({ key: "capture:A2", kind: "capture", target: "A2", nextAt: 5 }, 0);
    s.putJob({ key: "void:A3", kind: "void", target: "A3", nextAt: 50 }, 0);
    expect(s.dueJobs(10, 10).map((j) => j.key)).toEqual(["capture:A2", "capture:A1"]);
    expect(s.nextJobAt()).toBe(5);
    s.updateJob("capture:A2", { status: "done", note: "ok" });
    expect(s.job("capture:A2")).toMatchObject({ status: "done", note: "ok", attempts: 0 });
    expect(s.hasPending(["void"])).toBe(true);
    expect(s.hasPending(["refund"])).toBe(false);
    s.updateJob("void:A3", { status: "failed" });
    s.updateJob("capture:A1", { status: "done" });
    expect(s.nextJobAt()).toBeUndefined();
  });

  it("logs agent steps with rule and PayPal ids", () => {
    const s = freshStore();
    s.log({ at: 1, saw: "3 of 3 fans", did: "Charged Fan 01", rule: "rule-2-capture-at-tip", requestId: "capture:A1", resultId: "C1", source: "code" });
    expect(s.logs()).toEqual([{ seq: 1, at: 1, saw: "3 of 3 fans", did: "Charged Fan 01", rule: "rule-2-capture-at-tip", requestId: "capture:A1", resultId: "C1", source: "code" }]);
  });

  it("backs off 30 s, 2 min, 10 min, 30 min, then hourly", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([30_000, 120_000, 600_000, 1_800_000, 3_600_000, 3_600_000]);
  });
});
```

`tests/agent/project.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LedgerCorrupt, project } from "../../src/agent/project";
import { captured, DEADLINE, held, signedEvent, stored } from "./fixtures";

describe("project", () => {
  it("rebuilds the campaign from events: tip, charges, payout", async () => {
    const events = stored([await signedEvent(), held(1), held(2), held(3), captured(1), captured(2), captured(3, 1400), { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE }]);
    const p = project(events);
    expect(p.campaign.state).toBe("paying_out");
    expect(p.campaign.pledges).toEqual({ held: 0, charged: 3, released: 0, refunded: 0, failed: 0 });
    expect(p.collectedNet).toBe(1412 + 1412 + 1400);
    expect(p.collectedGross).toBe(4500);
    expect(p.pledges.get("p3")).toMatchObject({ status: "charged", captureId: "C3", netCents: 1400, number: 3 });
  });

  it("is the same however many times it is replayed", async () => {
    const events = stored([await signedEvent(), held(1), held(2), held(3), captured(1)]);
    expect(project(events).campaign).toEqual(project(events).campaign);
  });

  it("counts net from capture events only; a capture for an unknown hold changes nothing", async () => {
    const p = project(stored([await signedEvent(), held(1), held(2), held(3), captured(9)]));
    expect(p.collectedNet).toBe(0);
    expect(p.campaign.pledges.charged).toBe(0);
  });

  it("releases a held pledge on void, but a retired (late) hold never touches the counts", async () => {
    const p = project(
      stored([
        await signedEvent(),
        held(1),
        { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE },
        { type: "late_hold", pledgeId: "p9", orderId: "O9", authorizationId: "A9", amountCents: 1500 },
        { type: "void_ok", authorizationId: "A9" },
        { type: "void_ok", authorizationId: "A1" },
      ]),
    );
    expect(p.campaign.state).toBe("missed");
    expect(p.campaign.pledges).toMatchObject({ held: 0, released: 1 });
    expect(p.retired.get("A9")).toMatchObject({ why: "late", voided: true });
  });

  it("moves a renewed hold to its new authorization and retires the old one", async () => {
    const p = project(
      stored([
        await signedEvent(),
        held(1, true),
        { type: "hold_replaced", pledgeId: "p1", newPaypalPledgeId: "p1-h1", orderId: "O1b", authorizationId: "A1b", oldOrderId: "O1", oldAuthorizationId: "A1", authorizedAt: 5, expiresAt: 6 },
      ]),
    );
    expect(p.pledges.get("p1")).toMatchObject({ authorizationId: "A1b", orderId: "O1b", paypalPledgeId: "p1-h1", status: "held" });
    expect(p.pledgeByAuth.get("A1b")).toBe("p1");
    expect(p.pledgeByAuth.has("A1")).toBe(false);
    expect(p.retired.get("A1")).toMatchObject({ why: "replaced", orderId: "O1" });
    expect(p.campaign.pledges.held).toBe(1);
  });

  it("records approvals from approved proposals and from calling the show off", async () => {
    const p = project(
      stored([
        await signedEvent(),
        { type: "proposal_made", proposalId: "pace1", options: [{ id: "lower", approvalKey: "lower:2", label: "Lower the target to 2", newThreshold: 2 }], explanation: "x", recommend: "lower", source: "template" },
        { type: "proposal_approved", proposalId: "pace1", option: "lower", approvalKey: "lower:2" },
        { type: "threshold_lowered", newThreshold: 2 },
      ]),
    );
    expect(p.approvals.has("lower:2")).toBe(true);
    expect(p.proposals.get("pace1")?.approved?.option).toBe("lower");
    expect(p.campaign.threshold).toBe(2);
  });

  it("does not treat a retry payout batch as the campaign's payout", async () => {
    const line = { role: "room" as const, label: "Lucky's Café", paypalEmail: "room@example.com", amount: 2000 };
    const p = project(stored([await signedEvent(), held(1), held(2), held(3), captured(1), captured(2), captured(3), { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE }, { type: "payout_sent", senderBatchId: "payout-s", batchId: "B1", status: "PENDING", lines: [line], retry: false, recovered: false }, { type: "payout_sent", senderBatchId: "payout-s-r1", batchId: "B2", status: "PENDING", lines: [line], retry: true, recovered: false }]));
    expect(p.campaign.state).toBe("settled");
    expect(p.payouts.map((x) => x.retry)).toEqual([false, true]);
  });

  it("throws LedgerCorrupt when an event can't be replayed", () => {
    expect(() => project(stored([held(1)]))).toThrow(LedgerCorrupt);
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/agent`
Expected: PASS (an `ExperimentalWarning: SQLite is an experimental feature` line is normal).

- [ ] **Step 9: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add src/agent tests/agent
git commit -m "feat(agent): append-only ledger store, jobs outbox and state rebuilt from events

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Money executor: persist-before-execute jobs, capture / void / refund / reconcile

**Files:**
- Create: `src/agent/words.ts`, `src/agent/paypal-port.ts`, `src/agent/executor.ts`, `src/agent/hold-runner.ts`
- Create: `tests/agent/fake-paypal.ts`, `tests/agent/hold-runner.test.ts`

**Interfaces:**
- Consumes: Task 1 (`captureHold`, `voidHold`, `refundCharge`, `getOrderPayments`, `getCapture`, `createCardHold`, `createPledgeOrder`, `authorizeOrder`, `sendPayouts`, `getPayoutBatch`, `requestIds`, `PayPalError`, types `Charge`, `Hold`, `Refund`, `OrderPayments`, `PledgeRef`, `TestCard`, `SentBatch`, `PayoutBatch`, `payoutItemId`); Task 2 (`Store`, `Job`, `JobKind`, `LedgerEvent`, `eventKey`, `Projection`, `PledgeView`, `campaignEventFor`, `heldPledges`, `chargedPledges`, `Clock`, policy constants); Plan 1 `guard`, `reduce`, `fansCommitted`, `AgentAction`, `GuardDecision`, `Effect`, `RuleId`, `formatUSD`.
- Produces:
  - `words.ts`: `STATE_WORDS: Record<CampaignState, string>`, `fanName(p: PledgeView): string`, `sawCounts(p: Projection): string`, `holdDescription(m: Mandate): string`, `errText(e: unknown): string`
  - `paypal-port.ts`: `interface PayPalPort { createPledgeOrder(p); authorizeOrder(orderId); createCardHold(p, card); captureHold(authId); voidHold(authId); refundCharge(captureId); getOrderPayments(orderId); getCapture(captureId, authId); sendPayouts(showId, lines, retry: boolean); getPayoutBatch(batchId) }`, `paypalPort(http: PayPalHttp): PayPalPort`, `SIM_CARD: TestCard`
  - `executor.ts`: `interface ExecDeps { store: Store; paypal: PayPalPort; clock: Clock; showId: string; card: TestCard }`, `interface CommitResult { appended: boolean; projection: Projection; effects: Effect[] }`, `commit(store: Store, at: number, event: LedgerEvent): CommitResult`, `planJobs(store, p, effects, now): void`, `type Runner = (d: ExecDeps, job: Job, attempt: number) => Promise<void>`, `type Runners = Partial<Record<JobKind, Runner>>`, `drain(d: ExecDeps, runners: Runners, maxJobs?: number): Promise<{ ran: number; more: boolean }>`, helpers `done(d, job, note)`, `skip(d, job, p, decision, did)`, `block(d, job, note)`, `fail(d, job, note)`, `retryLater(d, job, attempt, note)`, `requestReconcile(store, authId, at, note)`, `queueVoid(store, authId, at)`, `decide(p, action): GuardDecision`, `logStep(d, { saw, did, rule, requestId?, resultId?, source? })`
  - `hold-runner.ts`: `HOLD_RUNNERS: Runners` (capture, void, refund, reconcile), `isCountable(c: Charge): boolean`, `recordCharge(d, p, pledge, charge): boolean`
  - Tests: `class FakePayPal implements PayPalPort { calls; script(op, ...answers); count(op) }`

**Rules this task makes testable (money safety):**
1. Jobs are written in the same transaction as the event that needs them, BEFORE any PayPal call, keyed `capture:<authId>`, `void:<authId>`, `refund:<captureId>`, `payout:<showId>`, `reconcile:<authId>`.
2. Replaying the ledger never re-executes: the projection ignores reducer effects, and a committed event key can't be written twice.
3. A capture counts only when `status === "COMPLETED"` and `netCents` and `grossCents` are defined. Anything else is reconciled, never counted as 0.
4. `collectedNet` comes from net amounts only.
5. "Already captured / already voided" answers are reconciled with GET calls and recorded as success.
6. A capture retry (attempt ≥ 2) first asks PayPal whether the capture already exists (request-id retention is limited).
7. Failed voids (missed) and failed refunds (cancelled) retry with backoff, then are surfaced as "Needs attention".
8. Every job is guarded against the current, post-reduce campaign; a denied job is skipped and logged with the rule.

- [ ] **Step 1: Write the plain-English helpers and the PayPal port**

`src/agent/words.ts`:

```ts
import { fansCommitted, type CampaignState } from "../core/campaign";
import type { Mandate } from "../core/mandate";
import { PayPalError } from "../paypal/errors";
import type { PledgeView, Projection } from "./project";

export const STATE_WORDS: Record<CampaignState, string> = {
  draft: "a draft",
  live: "waiting for fans",
  tipped: "on, and charging fans",
  paying_out: "paying everyone",
  settled: "settled, everyone's paid",
  missed: "called off, nobody paid",
  cancelled: "called off by the artist",
};

export function fanName(p: PledgeView): string {
  return `Fan ${String(p.number).padStart(2, "0")} · ${p.initials}`;
}

/** The "saw" column of the agent log. */
export function sawCounts(p: Projection): string {
  const c = p.campaign;
  return `${fansCommitted(c)} of ${c.threshold} fans · ${c.pledges.held} on hold · ${c.pledges.charged} charged · the show is ${STATE_WORDS[c.state]}`;
}

export function holdDescription(m: Mandate): string {
  return `Hold for ${m.showName} at ${m.roomName}`.slice(0, 127);
}

/** Short, secret-free error text for job notes and logs. */
export function errText(e: unknown): string {
  if (e instanceof PayPalError) {
    const issues = e.issues
      .map((i) => i.issue)
      .filter(Boolean)
      .join(",");
    return `${e.status} ${e.paypalName}${issues ? ` ${issues}` : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}
```

`src/agent/paypal-port.ts`:

```ts
import type { PayoutLine } from "../core/split";
import type { PayPalHttp } from "../paypal/http";
import {
  authorizeOrder,
  captureHold,
  createCardHold,
  createPledgeOrder,
  getCapture,
  getOrderPayments,
  refundCharge,
  voidHold,
  type Charge,
  type Hold,
  type OrderPayments,
  type PledgeRef,
  type Refund,
  type TestCard,
} from "../paypal/payments";
import { getPayoutBatch, sendPayouts, type PayoutBatch, type SentBatch } from "../paypal/payouts";

/** Every PayPal call the runtime makes. The Durable Object wires it to src/paypal; tests use a fake. */
export interface PayPalPort {
  createPledgeOrder(p: PledgeRef): Promise<{ orderId: string }>;
  authorizeOrder(orderId: string): Promise<Hold>;
  createCardHold(p: PledgeRef, card: TestCard): Promise<Hold>;
  captureHold(authorizationId: string): Promise<Charge>;
  voidHold(authorizationId: string): Promise<void>;
  refundCharge(captureId: string): Promise<Refund>;
  getOrderPayments(orderId: string): Promise<OrderPayments>;
  getCapture(captureId: string, authorizationId: string): Promise<Charge>;
  sendPayouts(showId: string, lines: PayoutLine[], retry: boolean): Promise<SentBatch>;
  getPayoutBatch(batchId: string): Promise<PayoutBatch>;
}

export function paypalPort(http: PayPalHttp): PayPalPort {
  return {
    createPledgeOrder: (p) => createPledgeOrder(http, p),
    authorizeOrder: (orderId) => authorizeOrder(http, orderId),
    createCardHold: (p, card) => createCardHold(http, p, card),
    captureHold: (id) => captureHold(http, id),
    voidHold: (id) => voidHold(http, id),
    refundCharge: (id) => refundCharge(http, id),
    getOrderPayments: (id) => getOrderPayments(http, id),
    getCapture: (captureId, authorizationId) => getCapture(http, captureId, authorizationId),
    sendPayouts: (showId, lines, retry) => sendPayouts(http, showId, lines, { retry }),
    getPayoutBatch: (id) => getPayoutBatch(http, id),
  };
}

/** The public sandbox Visa test card used for simulated fans (spike decision 1). Not a secret. */
export const SIM_CARD: TestCard = { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Simulated Fan" };
```

- [ ] **Step 2: Write the executor core `src/agent/executor.ts`**

```ts
import { reduce, type Effect } from "../core/campaign";
import { guard, type AgentAction, type GuardDecision } from "../core/guard";
import type { RuleId } from "../core/rules";
import type { TestCard } from "../paypal/payments";
import { eventKey, type AiSource, type LedgerEvent } from "./events";
import type { Clock } from "./ids";
import type { PayPalPort } from "./paypal-port";
import { backoffMs, LEASE_MS, MAX_JOB_ATTEMPTS, MAX_JOBS_PER_TURN } from "./policy";
import { campaignEventFor, chargedPledges, heldPledges, type Projection } from "./project";
import type { Job, JobKind, Store } from "./store";
import { errText, sawCounts } from "./words";

export interface ExecDeps {
  store: Store;
  paypal: PayPalPort;
  /** Campaign time (a demo copy may run ahead of real time). */
  clock: Clock;
  showId: string;
  card: TestCard;
}

export interface CommitResult {
  appended: boolean;
  projection: Projection;
  effects: Effect[];
}

/**
 * Appends one ledger event and, in the same transaction, the jobs its effects need.
 * - An event whose key already exists changes nothing (replay-safe).
 * - The reducer runs first: an event it refuses throws IllegalTransition and nothing is written.
 * - Jobs are planned from the post-event state, under deterministic keys, BEFORE any PayPal call.
 */
export function commit(store: Store, at: number, event: LedgerEvent): CommitResult {
  if (store.hasEvent(eventKey(event))) return { appended: false, projection: store.projection(), effects: [] };
  try {
    return store.transaction(() => {
      const before = store.projection();
      const ce = campaignEventFor(event, before);
      const effects = ce ? reduce(before.campaign, ce).effects : [];
      store.appendEvent(at, event);
      const projection = store.projection();
      planJobs(store, projection, effects, at);
      return { appended: true, projection, effects };
    });
  } catch (e) {
    store.resetProjection();
    throw e;
  }
}

/** Turns reducer effects into one job per PayPal call. Keys make this idempotent. */
export function planJobs(store: Store, p: Projection, effects: Effect[], now: number): void {
  for (const e of effects) {
    switch (e.type) {
      case "capture_all_held":
      case "capture_new_pledge":
        for (const pl of heldPledges(p)) store.putJob({ key: `capture:${pl.authorizationId}`, kind: "capture", target: pl.authorizationId, nextAt: now }, now);
        break;
      case "void_all_held":
        for (const pl of heldPledges(p)) queueVoid(store, pl.authorizationId, now);
        break;
      case "refund_all_charged":
        for (const pl of chargedPledges(p)) if (pl.captureId) store.putJob({ key: `refund:${pl.captureId}`, kind: "refund", target: pl.captureId, nextAt: now }, now);
        break;
      case "send_payouts":
        if (p.mandate) store.putJob({ key: `payout:${p.mandate.showId}`, kind: "payout", target: p.mandate.showId, nextAt: now }, now);
        break;
    }
  }
}

export type Runner = (d: ExecDeps, job: Job, attempt: number) => Promise<void>;
export type Runners = Partial<Record<JobKind, Runner>>;

export interface DrainResult {
  ran: number;
  more: boolean;
}

/** Runs due jobs one at a time, at most `maxJobs` per invocation (free plan subrequest limit). */
export async function drain(d: ExecDeps, runners: Runners, maxJobs = MAX_JOBS_PER_TURN): Promise<DrainResult> {
  let ran = 0;
  while (ran < maxJobs) {
    const [job] = d.store.dueJobs(d.clock.now(), 1);
    if (!job) break;
    ran += 1;
    await runJob(d, runners, job);
  }
  return { ran, more: d.store.dueJobs(d.clock.now(), 1).length > 0 };
}

async function runJob(d: ExecDeps, runners: Runners, job: Job): Promise<void> {
  const attempt = job.attempts + 1;
  // Claim the job first: a concurrent drain won't pick it up while we wait on PayPal.
  d.store.updateJob(job.key, { attempts: attempt, nextAt: d.clock.now() + LEASE_MS });
  const runner = runners[job.kind];
  if (!runner) return fail(d, job, `No runner handles ${job.kind} jobs.`);
  if (attempt > MAX_JOB_ATTEMPTS * 2) return fail(d, job, "This step kept stopping without an answer.");
  try {
    await runner(d, { ...job, attempts: attempt }, attempt);
  } catch (e) {
    fail(d, job, `Stopped on an unexpected error: ${errText(e)}`);
  }
}

export function done(d: ExecDeps, job: Job, note: string): void {
  d.store.updateJob(job.key, { status: "done", note });
}

/** The guard said no: the job is dropped and the reason logged with its rule. */
export function skip(d: ExecDeps, job: Job, p: Projection, decision: GuardDecision, did: string): void {
  d.store.updateJob(job.key, { status: "skipped", note: decision.reason });
  logStep(d, { saw: sawCounts(p), did: `${did} ${decision.reason}`, rule: decision.rule });
}

/** Waits for the artist (e.g. a payout shortfall). Approval sets it back to pending. */
export function block(d: ExecDeps, job: Job, note: string): void {
  d.store.updateJob(job.key, { status: "blocked", note });
}

export function fail(d: ExecDeps, job: Job, note: string): void {
  d.store.updateJob(job.key, { status: "failed", note });
  logStep(d, { saw: `A ${job.kind} step for ${job.target} stopped.`, did: `Needs attention: ${note}`, rule: null });
}

/** Same job, same PayPal-Request-Id, later. Gives up (fail) after MAX_JOB_ATTEMPTS. */
export function retryLater(d: ExecDeps, job: Job, attempt: number, note: string): void {
  if (attempt >= MAX_JOB_ATTEMPTS) return fail(d, job, `Gave up after ${attempt} tries. Last answer: ${note}`);
  d.store.updateJob(job.key, { nextAt: d.clock.now() + backoffMs(attempt), note });
}

/** Ask PayPal (GET) what really happened to this authorization. Re-opens a finished check. */
export function requestReconcile(store: Store, authorizationId: string, at: number, note: string): void {
  const key = `reconcile:${authorizationId}`;
  if (store.putJob({ key, kind: "reconcile", target: authorizationId, nextAt: at, note }, at)) return;
  const j = store.job(key);
  if (j && j.status !== "pending") store.updateJob(key, { status: "pending", nextAt: at, attempts: 0, note });
}

export function queueVoid(store: Store, authorizationId: string, at: number): void {
  store.putJob({ key: `void:${authorizationId}`, kind: "void", target: authorizationId, nextAt: at }, at);
}

/** The guard, against the current (post-reduce) campaign and the signed mandate. */
export function decide(p: Projection, action: AgentAction): GuardDecision {
  if (!p.mandate) return { allowed: false, needsApproval: false, rule: "rule-1-hold-only", reason: "The money rules aren't signed yet." };
  return guard(action, { mandate: p.mandate, campaign: p.campaign, approvals: p.approvals, collectedNet: p.collectedNet });
}

export function logStep(d: ExecDeps, s: { saw: string; did: string; rule: RuleId | null; requestId?: string | null; resultId?: string | null; source?: AiSource | "code" }): void {
  d.store.log({ at: d.clock.now(), saw: s.saw, did: s.did, rule: s.rule, requestId: s.requestId ?? null, resultId: s.resultId ?? null, source: s.source ?? "code" });
}
```

- [ ] **Step 3: Write the hold runners `src/agent/hold-runner.ts`**

```ts
import { formatUSD } from "../core/money";
import type { RuleId } from "../core/rules";
import { PayPalError } from "../paypal/errors";
import { requestIds, type Charge, type OrderPayments, type Refund } from "../paypal/payments";
import { commit, decide, done, fail, logStep, requestReconcile, retryLater, skip, type ExecDeps, type Runner, type Runners } from "./executor";
import { backoffMs, MAX_JOB_ATTEMPTS, RECHECK_MS } from "./policy";
import type { PledgeView, Projection } from "./project";
import { errText, fanName, sawCounts } from "./words";

const FAILED_CAPTURE = new Set(["DECLINED", "FAILED"]);
const GONE_AUTH = new Set(["VOIDED", "EXPIRED", "DENIED"]);
const RETIRED_WORDS = { late: "it arrived after pledging closed", rejected: "PayPal held the wrong thing", replaced: "a fresh hold replaced it" } as const;

/** A capture counts only when PayPal says COMPLETED and gives both gross and net. Undefined net is never 0. */
export function isCountable(c: Charge): boolean {
  return c.status === "COMPLETED" && Number.isInteger(c.netCents) && Number.isInteger(c.grossCents);
}

function pledgeByAuth(p: Projection, authorizationId: string): PledgeView | undefined {
  const id = p.pledgeByAuth.get(authorizationId);
  return id ? p.pledges.get(id) : undefined;
}

/** Records a final capture answer. Returns false (recording nothing) when PayPal hasn't finished. */
export function recordCharge(d: ExecDeps, p: Projection, pledge: PledgeView, charge: Charge): boolean {
  const now = d.clock.now();
  const saw = sawCounts(p);
  if (isCountable(charge)) {
    const gross = charge.grossCents as number;
    const net = charge.netCents as number;
    const fee = charge.feeCents ?? gross - net;
    commit(d.store, now, { type: "capture_ok", authorizationId: pledge.authorizationId, captureId: charge.captureId, grossCents: gross, feeCents: fee, netCents: net });
    logStep(d, { saw, did: `Charged ${fanName(pledge)} ${formatUSD(gross)}. After PayPal's fee, ${formatUSD(net)} came in.`, rule: "rule-2-capture-at-tip", requestId: requestIds.capture(pledge.authorizationId), resultId: charge.captureId });
    if (gross - fee !== net) {
      logStep(d, { saw: `PayPal said gross ${formatUSD(gross)}, fee ${formatUSD(fee)}, net ${formatUSD(net)}.`, did: "Those numbers don't add up, so only the net amount is counted.", rule: "rule-4-pay-the-split", resultId: charge.captureId });
    }
    return true;
  }
  if (FAILED_CAPTURE.has(charge.status)) {
    commit(d.store, now, { type: "capture_failed", authorizationId: pledge.authorizationId, reason: `PayPal answered ${charge.status}` });
    logStep(d, { saw, did: `${fanName(pledge)}'s charge didn't go through. Their money was never taken.`, rule: "rule-2-capture-at-tip", requestId: requestIds.capture(pledge.authorizationId), resultId: charge.captureId });
    return true;
  }
  return false;
}

/** On a retry, look first: PayPal only remembers request ids for a while, so never re-capture blind. */
async function captureAlreadyThere(d: ExecDeps, p: Projection, pledge: PledgeView): Promise<boolean> {
  const order = await d.paypal.getOrderPayments(pledge.orderId);
  const found = order.captures[0];
  if (!found) return false;
  const charge = await d.paypal.getCapture(found.id, pledge.authorizationId);
  return recordCharge(d, p, pledge, charge);
}

const runCapture: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const pledge = pledgeByAuth(p, job.target);
  if (!pledge || pledge.status !== "held") return done(d, job, "Already settled.");
  const decision = decide(p, { kind: "capture_all_held" });
  if (!decision.allowed) return skip(d, job, p, decision, `Did not charge ${fanName(pledge)}.`);
  let charge: Charge;
  try {
    if (attempt > 1 && (await captureAlreadyThere(d, p, pledge))) return done(d, job, "Found the charge at PayPal.");
    charge = await d.paypal.captureHold(pledge.authorizationId);
  } catch (e) {
    if (e instanceof PayPalError && e.retryable) return retryLater(d, job, attempt, errText(e));
    done(d, job, `PayPal gave no usable answer (${errText(e)}). Checking the order with PayPal.`);
    return requestReconcile(d.store, pledge.authorizationId, d.clock.now(), "capture answer unusable");
  }
  if (recordCharge(d, p, pledge, charge)) return done(d, job, `PayPal answered ${charge.status}.`);
  done(d, job, `PayPal answered ${charge.status} without final amounts. Checking again shortly.`);
  requestReconcile(d.store, pledge.authorizationId, d.clock.now() + RECHECK_MS, `capture ${charge.status}`);
};

const runVoid: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const auth = job.target;
  const pledge = pledgeByAuth(p, auth);
  const retired = p.retired.get(auth);
  let rule: RuleId = "rule-1-hold-only";
  let who: string;
  if (pledge) {
    if (pledge.status !== "held") return done(d, job, "Already settled.");
    const decision = decide(p, { kind: "void_all_held" });
    if (!decision.allowed) return skip(d, job, p, decision, `Did not cancel ${fanName(pledge)}'s hold.`);
    rule = decision.rule;
    who = `${fanName(pledge)}'s hold`;
  } else if (retired) {
    if (retired.voided) return done(d, job, "Already cancelled.");
    // A hold that was never counted (or no longer is) is only ever released: rule 1, nobody is charged.
    who = `an extra hold that was never counted (${RETIRED_WORDS[retired.why]})`;
  } else {
    return fail(d, job, "This hold isn't part of this show, so it was left alone.");
  }
  try {
    await d.paypal.voidHold(auth);
  } catch (e) {
    if (e instanceof PayPalError && e.retryable) return retryLater(d, job, attempt, errText(e));
    done(d, job, `PayPal refused (${errText(e)}). Checking the hold with PayPal.`);
    return requestReconcile(d.store, auth, d.clock.now(), "void refused");
  }
  commit(d.store, d.clock.now(), { type: "void_ok", authorizationId: auth });
  logStep(d, { saw: sawCounts(p), did: `Cancelled ${who}. Nobody was charged.`, rule, requestId: requestIds.void(auth), resultId: auth });
  done(d, job, "Cancelled.");
};

const runRefund: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const pledgeId = p.pledgeByCapture.get(job.target);
  const pledge = pledgeId ? p.pledges.get(pledgeId) : undefined;
  if (!pledge) return fail(d, job, "That charge isn't part of this show.");
  if (pledge.status !== "charged") return done(d, job, "Already settled.");
  const decision = decide(p, { kind: "refund_all_charged" });
  if (!decision.allowed) return skip(d, job, p, decision, `Did not refund ${fanName(pledge)}.`);
  let refund: Refund;
  try {
    refund = await d.paypal.refundCharge(job.target);
  } catch (e) {
    if (e instanceof PayPalError && e.hasIssue("CAPTURE_FULLY_REFUNDED")) {
      commit(d.store, d.clock.now(), { type: "refund_ok", captureId: job.target, refundId: null, status: "ALREADY_REFUNDED" });
      logStep(d, { saw: sawCounts(p), did: `PayPal says ${fanName(pledge)} was already refunded.`, rule: decision.rule, requestId: requestIds.refund(job.target) });
      return done(d, job, "Already refunded.");
    }
    // Refunds retry with backoff whatever the error (the retry path for a cancelled show), then need attention.
    return retryLater(d, job, attempt, errText(e));
  }
  if (refund.status === "COMPLETED" || refund.status === "PENDING") {
    commit(d.store, d.clock.now(), { type: "refund_ok", captureId: job.target, refundId: refund.refundId, status: refund.status });
    logStep(d, { saw: sawCounts(p), did: `Refunded ${fanName(pledge)} ${formatUSD(pledge.grossCents ?? pledge.amountCents)}. PayPal keeps its fee on refunds.`, rule: decision.rule, requestId: requestIds.refund(job.target), resultId: refund.refundId });
    return done(d, job, `Refund ${refund.status}.`);
  }
  retryLater(d, job, attempt, `PayPal answered ${refund.status} for the refund.`);
};

/** GET-based truth: what happened to this authorization at PayPal. Records success for "already captured/voided". */
const runReconcile: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const auth = job.target;
  const pledge = pledgeByAuth(p, auth);
  const retired = p.retired.get(auth);
  if (pledge && pledge.status !== "held") return done(d, job, "Already settled.");
  if (!pledge && (!retired || retired.voided)) return done(d, job, "Nothing left to check.");
  const orderId = pledge?.orderId ?? retired?.orderId ?? null;
  if (!orderId) return fail(d, job, "There is no PayPal order to check for this hold.");
  let order: OrderPayments;
  try {
    order = await d.paypal.getOrderPayments(orderId);
  } catch (e) {
    return retryLater(d, job, attempt, errText(e));
  }
  const closing = p.campaign.state === "missed" || p.campaign.state === "cancelled";
  const capture = order.captures[0];
  if (pledge && capture) {
    let charge: Charge;
    try {
      charge = await d.paypal.getCapture(capture.id, auth);
    } catch (e) {
      return retryLater(d, job, attempt, errText(e));
    }
    if (recordCharge(d, p, pledge, charge)) return done(d, job, "Found the charge at PayPal.");
    return retryLater(d, job, attempt, `The charge is ${charge.status} at PayPal.`);
  }
  const status = order.authorizations.find((a) => a.id === auth)?.status ?? "UNKNOWN";
  const now = d.clock.now();
  if (GONE_AUTH.has(status)) {
    if (pledge && !closing) {
      commit(d.store, now, { type: "capture_failed", authorizationId: auth, reason: `The hold was ${status.toLowerCase()} before it could be charged` });
      logStep(d, { saw: `PayPal says the hold is ${status}.`, did: `${fanName(pledge)}'s hold ended before the charge. Their money was never taken.`, rule: "rule-2-capture-at-tip", resultId: auth });
    } else {
      commit(d.store, now, { type: "void_ok", authorizationId: auth });
      logStep(d, { saw: `PayPal says the hold is ${status}.`, did: "That hold is already cancelled. Nobody was charged.", rule: pledge ? "rule-3-void-on-miss" : "rule-1-hold-only", resultId: auth });
    }
    return done(d, job, `The hold is ${status}.`);
  }
  if (status === "CREATED" && pledge && !closing) {
    commit(d.store, now, { type: "capture_failed", authorizationId: auth, reason: "PayPal refused the charge; the hold is still open" });
    logStep(d, { saw: "PayPal refused the charge and the hold is still open.", did: `Counted ${fanName(pledge)} as not charged. The hold lapses on its own; nobody is charged.`, rule: "rule-2-capture-at-tip", resultId: auth });
    return done(d, job, "Charge refused.");
  }
  if (status === "CREATED") {
    const voidJob = d.store.job(`void:${auth}`);
    if (voidJob && voidJob.attempts < MAX_JOB_ATTEMPTS) {
      d.store.updateJob(voidJob.key, { status: "pending", nextAt: now + backoffMs(voidJob.attempts) });
      return done(d, job, "The hold is still open; cancelling it again later.");
    }
    return fail(d, job, `Couldn't cancel a hold. It lapses on its own by ${new Date(pledge?.expiresAt ?? now).toISOString().slice(0, 10)}; nobody is charged.`);
  }
  retryLater(d, job, attempt, `PayPal says the hold is ${status}.`);
};

export const HOLD_RUNNERS: Runners = { capture: runCapture, void: runVoid, refund: runRefund, reconcile: runReconcile };
```

- [ ] **Step 4: Write the fake PayPal port**

`tests/agent/fake-paypal.ts`:

```ts
import { DAY_MS } from "../../src/core/holds";
import type { PayoutLine } from "../../src/core/split";
import type { Clock } from "../../src/agent/ids";
import type { PayPalPort } from "../../src/agent/paypal-port";
import type { Charge, Hold, OrderPayments, PledgeRef, Refund, TestCard } from "../../src/paypal/payments";
import { payoutBatchId, payoutItemId, type PayoutBatch, type PayoutItem, type SentBatch } from "../../src/paypal/payouts";

type Op = keyof PayPalPort;
type Answer = (...args: never[]) => unknown;

/**
 * Records every call. Each op answers with a scripted function (used once, in order) or a sensible default.
 * Ids are obviously fake: A-<pledge>, O-<pledge>, C-<auth>, R-<capture>, B-1.
 */
export class FakePayPal implements PayPalPort {
  readonly calls: { op: Op; args: unknown[] }[] = [];
  private readonly scripted = new Map<Op, Answer[]>();
  private readonly orders = new Map<string, PledgeRef>();
  private readonly batches = new Map<string, PayoutItem[]>();
  private batchCount = 0;

  constructor(private readonly clock: Clock = { now: () => 0 }) {}

  /** Queue answers for an op. An answer may throw (e.g. a PayPalError). */
  script(op: Op, ...answers: Answer[]): this {
    this.scripted.set(op, [...(this.scripted.get(op) ?? []), ...answers]);
    return this;
  }

  count(op: Op): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  private async answer<T>(op: Op, args: unknown[], fallback: () => T): Promise<T> {
    this.calls.push({ op, args });
    const next = this.scripted.get(op)?.shift();
    return (next ? (next as (...a: unknown[]) => T)(...args) : fallback()) as T;
  }

  private hold(p: PledgeRef, orderId: string): Hold {
    const t = this.clock.now();
    return { authorizationId: `A-${p.pledgeId}`, orderId, amountCents: p.amountCents, status: "CREATED", createdAt: t, expiresAt: t + 29 * DAY_MS, customId: `${p.showId}:${p.pledgeId}` };
  }

  createPledgeOrder(p: PledgeRef): Promise<{ orderId: string }> {
    return this.answer("createPledgeOrder", [p], () => {
      const orderId = `O-${p.pledgeId}`;
      this.orders.set(orderId, p);
      return { orderId };
    });
  }

  authorizeOrder(orderId: string): Promise<Hold> {
    return this.answer("authorizeOrder", [orderId], () => {
      const p = this.orders.get(orderId);
      if (!p) throw new Error(`fake: unknown order ${orderId}`);
      return this.hold(p, orderId);
    });
  }

  createCardHold(p: PledgeRef, card: TestCard): Promise<Hold> {
    return this.answer("createCardHold", [p, card], () => this.hold(p, `O-${p.pledgeId}`));
  }

  captureHold(authorizationId: string): Promise<Charge> {
    return this.answer("captureHold", [authorizationId], () => ({ captureId: `C-${authorizationId}`, authorizationId, status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 }));
  }

  voidHold(authorizationId: string): Promise<void> {
    return this.answer("voidHold", [authorizationId], () => undefined);
  }

  refundCharge(captureId: string): Promise<Refund> {
    return this.answer("refundCharge", [captureId], () => ({ refundId: `R-${captureId}`, captureId, status: "COMPLETED" }));
  }

  getOrderPayments(orderId: string): Promise<OrderPayments> {
    return this.answer("getOrderPayments", [orderId], () => ({ orderId, status: "COMPLETED", authorizations: [], captures: [] }));
  }

  getCapture(captureId: string, authorizationId: string): Promise<Charge> {
    return this.answer("getCapture", [captureId, authorizationId], () => ({ captureId, authorizationId, status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 }));
  }

  sendPayouts(showId: string, lines: PayoutLine[], retry: boolean): Promise<SentBatch> {
    return this.answer("sendPayouts", [showId, lines, retry], () => {
      this.batchCount += 1;
      const batchId = `B-${this.batchCount}`;
      const sentLines = lines.filter((l) => l.amount > 0);
      this.batches.set(batchId, sentLines.map((l) => ({ senderItemId: payoutItemId(showId, l.role, retry), status: "SUCCESS", amountCents: l.amount })));
      return { batchId, senderBatchId: payoutBatchId(showId, retry), status: "PENDING", sentLines };
    });
  }

  getPayoutBatch(batchId: string): Promise<PayoutBatch> {
    return this.answer("getPayoutBatch", [batchId], () => ({ batchId, senderBatchId: "", status: "SUCCESS", items: this.batches.get(batchId) ?? [] }));
  }
}
```

- [ ] **Step 5: Write the failing tests**

`tests/agent/hold-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { commit, drain, type ExecDeps } from "../../src/agent/executor";
import { HOLD_RUNNERS } from "../../src/agent/hold-runner";
import { SIM_CARD } from "../../src/agent/paypal-port";
import { project } from "../../src/agent/project";
import { Store } from "../../src/agent/store";
import { PayPalError } from "../../src/paypal/errors";
import { FakePayPal } from "./fake-paypal";
import { DEADLINE, held, LAUNCH, signedEvent, SHOW, TestClock } from "./fixtures";
import { memoryDb } from "./sqlite";

const unprocessable = (issue: string) => new PayPalError(422, "UNPROCESSABLE_ENTITY", "refused", undefined, [{ issue }]);

async function setup(fans: number) {
  const store = new Store(memoryDb());
  store.migrate();
  const clock = new TestClock(LAUNCH + 1000);
  const paypal = new FakePayPal(clock);
  const d: ExecDeps = { store, paypal, clock, showId: SHOW, card: SIM_CARD };
  commit(store, clock.now(), await signedEvent());
  for (let i = 1; i <= fans; i++) commit(store, clock.now(), held(i));
  return { store, clock, paypal, d };
}

/** Drains, moving the clock to each next job, until nothing is due within `horizon`. */
async function settle(h: Awaited<ReturnType<typeof setup>>, horizon = 6 * 60 * 60 * 1000) {
  const end = h.clock.t + horizon;
  for (let i = 0; i < 100; i++) {
    await drain(h.d, HOLD_RUNNERS);
    const next = h.store.nextJobAt();
    if (next === undefined || next > end) return;
    h.clock.t = Math.max(h.clock.t, next);
  }
}

describe("tipping and captures", () => {
  it("persists one capture job per hold, before any PayPal call", async () => {
    const h = await setup(3);
    expect(h.store.jobs().map((j) => [j.key, j.status])).toEqual([
      ["capture:A1", "pending"],
      ["capture:A2", "pending"],
      ["capture:A3", "pending"],
    ]);
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("charges every hold and counts net only, logging rule 2 with PayPal ids", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    const p = h.store.projection();
    expect(p.campaign.pledges).toMatchObject({ held: 0, charged: 3 });
    expect(p.collectedNet).toBe(3 * 1412);
    const log = h.store.logs().find((l) => l.requestId === "capture:A1");
    expect(log).toMatchObject({ rule: "rule-2-capture-at-tip", resultId: "C-A1" });
  });

  it("never re-executes on replay or a second drain", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    await drain(h.d, HOLD_RUNNERS);
    expect(h.paypal.count("captureHold")).toBe(3);
    const again = commit(h.store, h.clock.now(), { type: "capture_ok", authorizationId: "A1", captureId: "C-A1", grossCents: 1500, feeCents: 88, netCents: 1412 });
    expect(again.appended).toBe(false);
    const replayed = project(h.store.events());
    expect(replayed.collectedNet).toBe(3 * 1412);
    expect(replayed.campaign).toEqual(h.store.projection().campaign);
  });

  it("does not count a COMPLETED capture without net; it reconciles and then counts the real net", async () => {
    const h = await setup(3);
    h.paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "COMPLETED", grossCents: 1500 }));
    await drain(h.d, HOLD_RUNNERS);
    let p = h.store.projection();
    expect(p.pledges.get("p1")?.status).toBe("held");
    expect(p.collectedNet).toBe(2 * 1412);
    expect(h.store.job("reconcile:A1")?.status).toBe("pending");
    h.paypal.script("getOrderPayments", () => ({ orderId: "O1", status: "COMPLETED", authorizations: [{ id: "A1", status: "CAPTURED" }], captures: [{ id: "C-A1", status: "COMPLETED" }] }));
    h.paypal.script("getCapture", () => ({ captureId: "C-A1", authorizationId: "A1", status: "COMPLETED", grossCents: 1500, feeCents: 90, netCents: 1410 }));
    await settle(h);
    p = h.store.projection();
    expect(p.pledges.get("p1")).toMatchObject({ status: "charged", netCents: 1410 });
    expect(p.collectedNet).toBe(2 * 1412 + 1410);
  });

  it("treats a PENDING capture the same way: never counted as 0", async () => {
    const h = await setup(3);
    h.paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "PENDING" }));
    await drain(h.d, HOLD_RUNNERS);
    expect(h.store.projection().campaign.pledges).toMatchObject({ held: 1, charged: 2, failed: 0 });
    expect(h.store.job("reconcile:A1")?.nextAt).toBe(h.clock.now() + 60_000);
  });

  it("retries a retryable error later with the same job, and looks before re-capturing", async () => {
    const h = await setup(3);
    h.paypal.script("captureHold", () => {
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
    });
    await drain(h.d, HOLD_RUNNERS);
    expect(h.store.job("capture:A1")).toMatchObject({ status: "pending", attempts: 1, nextAt: h.clock.now() + 30_000 });
    await drain(h.d, HOLD_RUNNERS);
    expect(h.paypal.count("captureHold")).toBe(3);
    h.clock.t += 30_000;
    await drain(h.d, HOLD_RUNNERS);
    expect(h.paypal.count("getOrderPayments")).toBe(1);
    expect(h.store.projection().campaign.pledges.charged).toBe(3);
  });

  it("records 'already captured' as a success after checking the order", async () => {
    const h = await setup(3);
    h.paypal.script("captureHold", () => {
      throw unprocessable("AUTHORIZATION_ALREADY_CAPTURED");
    });
    h.paypal.script("getOrderPayments", () => ({ orderId: "O1", status: "COMPLETED", authorizations: [{ id: "A1", status: "CAPTURED" }], captures: [{ id: "C9", status: "COMPLETED" }] }));
    await settle(h);
    expect(h.store.projection().pledges.get("p1")).toMatchObject({ status: "charged", captureId: "C9" });
  });

  it("counts a DECLINED capture as failed; the money was never taken", async () => {
    const h = await setup(3);
    h.paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "DECLINED" }));
    await drain(h.d, HOLD_RUNNERS);
    const p = h.store.projection();
    expect(p.campaign.pledges).toMatchObject({ failed: 1, charged: 2 });
    expect(p.collectedNet).toBe(2 * 1412);
  });

  it("logs when PayPal's gross minus fee isn't the net, and counts only the net", async () => {
    const h = await setup(3);
    h.paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "COMPLETED", grossCents: 1500, feeCents: 90, netCents: 1412 }));
    await drain(h.d, HOLD_RUNNERS);
    expect(h.store.projection().pledges.get("p1")?.netCents).toBe(1412);
    expect(h.store.logs().some((l) => l.did === "Those numbers don't add up, so only the net amount is counted.")).toBe(true);
  });

  it("skips a capture the guard forbids (show still live) and logs the rule", async () => {
    const h = await setup(1);
    h.store.putJob({ key: "capture:A1", kind: "capture", target: "A1", nextAt: 0 }, 0);
    await drain(h.d, HOLD_RUNNERS);
    expect(h.paypal.count("captureHold")).toBe(0);
    expect(h.store.job("capture:A1")?.status).toBe("skipped");
    expect(h.store.logs().at(-1)?.rule).toBe("rule-1-hold-only");
  });

  it("never runs the same job twice when two drains overlap", async () => {
    const h = await setup(3);
    await Promise.all([drain(h.d, HOLD_RUNNERS), drain(h.d, HOLD_RUNNERS)]);
    expect(h.paypal.count("captureHold")).toBe(3);
  });
});

describe("missed shows and voids", () => {
  it("voids every hold at a missed deadline; 'already voided' counts as success", async () => {
    const h = await setup(2);
    h.clock.t = DEADLINE;
    commit(h.store, DEADLINE, { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE });
    h.paypal.script("voidHold", () => {
      throw unprocessable("AUTHORIZATION_VOIDED");
    });
    h.paypal.script("getOrderPayments", () => ({ orderId: "O1", status: "COMPLETED", authorizations: [{ id: "A1", status: "VOIDED" }], captures: [] }));
    await settle(h);
    const p = h.store.projection();
    expect(p.campaign.state).toBe("missed");
    expect(p.campaign.pledges).toMatchObject({ held: 0, released: 2 });
    expect(h.store.logs().some((l) => l.rule === "rule-3-void-on-miss" && l.requestId === "void:A2")).toBe(true);
  });

  it("retries a refused void while the hold is still open, then asks for attention", async () => {
    const h = await setup(1);
    h.clock.t = DEADLINE;
    commit(h.store, DEADLINE, { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE });
    const refuse = () => {
      throw unprocessable("SOMETHING_ELSE");
    };
    const open = () => ({ orderId: "O1", status: "COMPLETED", authorizations: [{ id: "A1", status: "CREATED" }], captures: [] });
    for (let i = 0; i < 20; i++) {
      h.paypal.script("voidHold", refuse);
      h.paypal.script("getOrderPayments", open);
    }
    await settle(h, 30 * 24 * 60 * 60 * 1000);
    expect(h.store.projection().campaign.pledges.held).toBe(1);
    expect(h.store.logs().some((l) => l.did.startsWith("Needs attention: Couldn't cancel a hold"))).toBe(true);
  });

  it("voids a late hold without touching the counts", async () => {
    const h = await setup(1);
    h.clock.t = DEADLINE;
    commit(h.store, DEADLINE, { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE });
    commit(h.store, DEADLINE, { type: "late_hold", pledgeId: "p9", orderId: "O9", authorizationId: "A9", amountCents: 1500 });
    h.store.putJob({ key: "void:A9", kind: "void", target: "A9", nextAt: DEADLINE }, DEADLINE);
    await settle(h);
    const p = h.store.projection();
    expect(p.retired.get("A9")?.voided).toBe(true);
    expect(p.campaign.pledges).toMatchObject({ held: 0, released: 1 });
  });
});

describe("cancelled shows and refunds", () => {
  it("refunds each charge exactly once, with per-capture request ids", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    await settle(h);
    await settle(h);
    expect(h.paypal.count("refundCharge")).toBe(3);
    expect(h.paypal.calls.filter((c) => c.op === "refundCharge").map((c) => c.args[0])).toEqual(["C-A1", "C-A2", "C-A3"]);
    expect(h.store.projection().campaign.pledges).toMatchObject({ charged: 0, refunded: 3 });
  });

  it("records 'already fully refunded' as success, with no invented refund id", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    h.paypal.script("refundCharge", () => {
      throw unprocessable("CAPTURE_FULLY_REFUNDED");
    });
    await settle(h);
    expect(h.store.projection().pledges.get("p1")).toMatchObject({ status: "refunded", refundId: null });
  });

  it("keeps retrying a failing refund with backoff, then needs attention", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    for (let i = 0; i < 12; i++) {
      h.paypal.script("refundCharge", (c: string) => {
        if (c === "C-A1") throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "no", undefined, [{ issue: "INSUFFICIENT_FUNDS" }]);
        return { refundId: `R-${c}`, captureId: c, status: "COMPLETED" };
      });
    }
    await settle(h, 30 * 24 * 60 * 60 * 1000);
    expect(h.store.job("refund:C-A1")?.status).toBe("failed");
    expect(h.store.projection().campaign.pledges.charged).toBe(1);
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/agent/hold-runner.test.ts`
Expected: before Steps 1–3 exist, FAIL with "Cannot find module '../../src/agent/executor'"; after them, PASS.

- [ ] **Step 7: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add src/agent tests/agent
git commit -m "feat(agent): money executor with persist-before-execute jobs, reconcile and retry paths

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Payouts: one batch from the signed split, duplicate = already sent, polling, one `-r1` retry

**Files:**
- Create: `src/agent/payout-runner.ts`, `src/agent/runners.ts`
- Create: `tests/agent/payout-runner.test.ts`

**Interfaces:**
- Consumes: Task 1 `isDuplicateBatch`, `payoutBatchId`, `SentBatch`, `PayoutBatch`; Task 2 `Projection`, `PayoutView`, policy `POLL_DELAY_MS`, `PAYOUT_POLL_MAX`; Task 3 `commit`, `decide`, `done`, `fail`, `block`, `skip`, `retryLater`, `logStep`, `ExecDeps`, `Runner`, `Runners`, `HOLD_RUNNERS`, `errText`, `sawCounts`; Plan 1 `splitPayout`, `PayoutLine`, `formatUSD`.
- Produces:
  - `PAYOUT_FAILED: ReadonlySet<string>` (FAILED, RETURNED, BLOCKED, DENIED, CANCELED, REFUNDED)
  - `roleOfItem(showId: string, senderItemId: string): string | null`
  - `schedulePoll(d: ExecDeps, batchId: string, n: number): void` (job key `poll:<batchId>:<n>`)
  - `retryLines(showId: string, p: Projection, first: PayoutView): PayoutLine[]`
  - `PAYOUT_RUNNERS: Runners` (payout, payout_poll, payout_retry)
  - `RUNNERS: Runners` in `src/agent/runners.ts` (= HOLD_RUNNERS + PAYOUT_RUNNERS; Task 10 adds SIM_RUNNERS)

**Rules this task makes testable:**
1. The executor sends `splitPayout(collectedNet, mandate.parties).lines` (guard-approved), never a model's lines; `$0` lines are dropped by `sendPayouts` after guard approval.
2. Zero total (`collectedNet === 0` in `paying_out`) records `payout_sent` with status `NOTHING_TO_PAY` and makes no PayPal call.
3. `isDuplicateBatch` on send means "already sent": record `payout_sent` (`recovered: true`, `batchId: null`), never send again. A later `PAYMENT.PAYOUTSBATCH.*` webhook fills the batch id (Task 7).
4. A maybe-sent error (retryable, `BAD_RESPONSE_BODY`, `EMPTY_RESPONSE_BODY`) retries with the same `sender_batch_id`, so PayPal's duplicate check protects us.
5. A shortfall blocks the job and makes a `pay_short` proposal; only the approval key `payout-shortfall:<net>` unblocks it.
6. Items are polled (`PENDING` right after create). Final failures trigger exactly one retry batch `payout-<show>-r1` with only failed items whose lines still match the signed split. A second failure is surfaced, never retried.

- [ ] **Step 1: Write the failing tests**

`tests/agent/payout-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitPayout } from "../../src/core/split";
import { commit, drain, type ExecDeps } from "../../src/agent/executor";
import { SIM_CARD } from "../../src/agent/paypal-port";
import { retryLines } from "../../src/agent/payout-runner";
import { RUNNERS } from "../../src/agent/runners";
import { Store } from "../../src/agent/store";
import { PayPalError } from "../../src/paypal/errors";
import { payoutItemId } from "../../src/paypal/payouts";
import { FakePayPal } from "./fake-paypal";
import { DEADLINE, held, LAUNCH, signedEvent, SHOW, TestClock, testMandate } from "./fixtures";
import { memoryDb } from "./sqlite";

const parties = testMandate().parties;
const duplicate = () => new PayPalError(400, "USER_BUSINESS_ERROR", "dup", undefined, [{ field: "SENDER_BATCH_ID", issue: "Batch with given sender_batch_id already exists" }]);

/** Three fans tip and are charged; the deadline passes; a payout job is waiting. */
async function readyToPay(configure: (paypal: FakePayPal) => void = () => {}) {
  const store = new Store(memoryDb());
  store.migrate();
  const clock = new TestClock(LAUNCH + 1000);
  const paypal = new FakePayPal(clock);
  configure(paypal);
  const d: ExecDeps = { store, paypal, clock, showId: SHOW, card: SIM_CARD };
  commit(store, clock.now(), await signedEvent());
  for (let i = 1; i <= 3; i++) commit(store, clock.now(), held(i));
  await drain(d, RUNNERS);
  clock.t = DEADLINE;
  commit(store, DEADLINE, { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE });
  return { store, clock, paypal, d };
}

async function settle(h: Awaited<ReturnType<typeof readyToPay>>) {
  const end = h.clock.t + 6 * 60 * 60 * 1000;
  for (let i = 0; i < 100; i++) {
    await drain(h.d, RUNNERS);
    const next = h.store.nextJobAt();
    if (next === undefined || next > end) return;
    h.clock.t = Math.max(h.clock.t, next);
  }
}

describe("payout", () => {
  it("sends exactly the signed split of the collected net, once, and settles", async () => {
    const h = await readyToPay();
    expect(h.store.job(`payout:${SHOW}`)?.status).toBe("pending");
    await drain(h.d, RUNNERS);
    const call = h.paypal.calls.find((c) => c.op === "sendPayouts");
    expect(call?.args).toEqual([SHOW, splitPayout(3 * 1412, parties).lines, false]);
    const p = h.store.projection();
    expect(p.campaign.state).toBe("settled");
    expect(p.payouts[0]).toMatchObject({ batchId: "B-1", senderBatchId: `payout-${SHOW}`, retry: false });
    expect(h.store.job("poll:B-1:1")).toMatchObject({ status: "pending", nextAt: DEADLINE + 60_000 });
    expect(h.store.logs().some((l) => l.rule === "rule-4-pay-the-split" && l.requestId === `payout-${SHOW}` && l.resultId === "B-1")).toBe(true);
  });

  it("polls the batch and stops once every item is final", async () => {
    const h = await readyToPay();
    await settle(h);
    const p = h.store.projection();
    expect(p.payouts[0].items[payoutItemId(SHOW, "room")]?.status).toBe("SUCCESS");
    expect(h.store.job("poll:B-1:2")).toBeUndefined();
    expect(h.paypal.count("sendPayouts")).toBe(1);
  });

  it("records a $0 payout without calling PayPal when nothing came in", async () => {
    const h = await readyToPay((paypal) => {
      for (let i = 0; i < 3; i++) paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "DECLINED" }));
    });
    await settle(h);
    const p = h.store.projection();
    expect(p.campaign.state).toBe("settled");
    expect(p.payouts[0]).toMatchObject({ status: "NOTHING_TO_PAY", batchId: null, lines: [] });
    expect(h.paypal.count("sendPayouts")).toBe(0);
  });

  it("treats a duplicate sender_batch_id as already sent and never sends again", async () => {
    const h = await readyToPay((paypal) => paypal.script("sendPayouts", () => { throw duplicate(); }));
    await settle(h);
    const p = h.store.projection();
    expect(p.campaign.state).toBe("settled");
    expect(p.payouts[0]).toMatchObject({ status: "ALREADY_SENT", recovered: true, batchId: null });
    expect(p.payouts[0].lines).toEqual(splitPayout(3 * 1412, parties).lines.filter((l) => l.amount > 0));
    expect(h.paypal.count("sendPayouts")).toBe(1);
    expect(h.store.jobs().some((j) => j.kind === "payout_poll")).toBe(false);
  });

  it("retries a maybe-sent error with the same batch id", async () => {
    const h = await readyToPay((paypal) => paypal.script("sendPayouts", () => { throw new PayPalError(502, "EMPTY_RESPONSE_BODY", "no body"); }));
    await drain(h.d, RUNNERS);
    expect(h.store.job(`payout:${SHOW}`)).toMatchObject({ status: "pending", attempts: 1 });
    await settle(h);
    expect(h.paypal.count("sendPayouts")).toBe(2);
    expect(h.store.projection().payouts).toHaveLength(1);
  });

  it("waits for the artist when the money is short, then pays what came in", async () => {
    const h = await readyToPay((paypal) => {
      paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 }));
      paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 }));
      paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "DECLINED" }));
    });
    await settle(h);
    expect(h.store.job(`payout:${SHOW}`)?.status).toBe("blocked");
    expect(h.paypal.count("sendPayouts")).toBe(0);
    const proposal = h.store.projection().proposals.get("short2824");
    expect(proposal?.options).toEqual([{ id: "pay_short", approvalKey: "payout-shortfall:2824", label: "Pay out what came in", collectedNet: 2824 }]);
    commit(h.store, h.clock.now(), { type: "proposal_approved", proposalId: "short2824", option: "pay_short", approvalKey: "payout-shortfall:2824" });
    h.store.updateJob(`payout:${SHOW}`, { status: "pending", nextAt: h.clock.now() });
    await settle(h);
    expect(h.paypal.calls.find((c) => c.op === "sendPayouts")?.args[1]).toEqual(splitPayout(2824, parties).lines);
    expect(h.store.projection().campaign.state).toBe("settled");
  });

  it("does not pay before the deadline even if a payout job appears", async () => {
    const store = new Store(memoryDb());
    store.migrate();
    const clock = new TestClock(LAUNCH + 1000);
    const paypal = new FakePayPal(clock);
    const d: ExecDeps = { store, paypal, clock, showId: SHOW, card: SIM_CARD };
    commit(store, clock.now(), await signedEvent());
    for (let i = 1; i <= 3; i++) commit(store, clock.now(), held(i));
    await drain(d, RUNNERS);
    store.putJob({ key: `payout:${SHOW}`, kind: "payout", target: SHOW, nextAt: 0 }, 0);
    await drain(d, RUNNERS);
    expect(paypal.count("sendPayouts")).toBe(0);
    expect(store.job(`payout:${SHOW}`)?.status).toBe("skipped");
  });
});

describe("payout retry", () => {
  const roomFailed = (b: string) => ({ batchId: b, senderBatchId: "", status: "SUCCESS", items: [
    { senderItemId: payoutItemId(SHOW, "room"), status: "FAILED", amountCents: 2000 },
    { senderItemId: payoutItemId(SHOW, "artist"), status: "SUCCESS", amountCents: 2236 },
  ] });

  it("retries only the failed items once, as payout-<show>-r1", async () => {
    const h = await readyToPay((paypal) => paypal.script("getPayoutBatch", roomFailed));
    await settle(h);
    const calls = h.paypal.calls.filter((c) => c.op === "sendPayouts");
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual([SHOW, [splitPayout(3 * 1412, parties).lines[0]], true]);
    const p = h.store.projection();
    expect(p.payouts.map((x) => [x.senderBatchId, x.retry])).toEqual([
      [`payout-${SHOW}`, false],
      [`payout-${SHOW}-r1`, true],
    ]);
  });

  it("surfaces a second failure and never sends a third batch", async () => {
    const h = await readyToPay((paypal) => {
      paypal.script("getPayoutBatch", roomFailed);
      paypal.script("getPayoutBatch", (b: string) => ({ batchId: b, senderBatchId: "", status: "SUCCESS", items: [{ senderItemId: payoutItemId(SHOW, "room", true), status: "RETURNED", amountCents: 2000 }] }));
    });
    await settle(h);
    expect(h.paypal.count("sendPayouts")).toBe(2);
    expect(h.store.logs().some((l) => l.did.startsWith("Needs attention") && l.did.includes("Lucky's Café"))).toBe(true);
  });

  it("never retries a line that no longer matches the signed split", async () => {
    const h = await readyToPay((paypal) => paypal.script("getPayoutBatch", roomFailed, () => ({ batchId: "x", senderBatchId: "", status: "SUCCESS", items: [] })));
    await drain(h.d, RUNNERS);
    h.clock.t += 60_000;
    await drain(h.d, RUNNERS);
    const p = h.store.projection();
    const first = p.payouts[0];
    expect(retryLines(SHOW, p, first)).toEqual([first.lines[0]]);
    expect(retryLines(SHOW, p, { ...first, lines: [{ ...first.lines[0], amount: 9999 }, first.lines[1]] })).toEqual([]);
    expect(retryLines(SHOW, p, { ...first, lines: [{ ...first.lines[0], paypalEmail: "thief@example.com" }, first.lines[1]] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/agent/payout-runner.test.ts`
Expected: FAIL with "Cannot find module '../../src/agent/payout-runner'".

- [ ] **Step 3: Write `src/agent/payout-runner.ts`**

```ts
import { formatUSD } from "../core/money";
import { splitPayout, type PayoutLine } from "../core/split";
import { PayPalError } from "../paypal/errors";
import { isDuplicateBatch, payoutBatchId, type PayoutBatch, type SentBatch } from "../paypal/payouts";
import { block, commit, decide, done, fail, logStep, retryLater, skip, type ExecDeps, type Runner, type Runners } from "./executor";
import { PAYOUT_POLL_MAX, POLL_DELAY_MS } from "./policy";
import type { PayoutView, Projection } from "./project";
import { errText, sawCounts } from "./words";

/** Final payout item failures (the same set the webhook mapper calls payout_item_failed). */
export const PAYOUT_FAILED: ReadonlySet<string> = new Set(["FAILED", "RETURNED", "BLOCKED", "DENIED", "CANCELED", "REFUNDED"]);
/** Errors after which the batch may already exist at PayPal: retry with the same sender_batch_id. */
const MAYBE_SENT = new Set(["BAD_RESPONSE_BODY", "EMPTY_RESPONSE_BODY"]);

export function roleOfItem(showId: string, senderItemId: string): string | null {
  const prefix = `${showId}-`;
  if (!senderItemId.startsWith(prefix)) return null;
  return senderItemId.slice(prefix.length).replace(/-r1$/, "") || null;
}

export function schedulePoll(d: ExecDeps, batchId: string, n: number): void {
  const now = d.clock.now();
  d.store.putJob({ key: `poll:${batchId}:${n}`, kind: "payout_poll", target: batchId, nextAt: now + POLL_DELAY_MS * n, note: String(n) }, now);
}

const listLines = (lines: PayoutLine[]) => lines.map((l) => `${l.label} ${formatUSD(l.amount)}`).join(" · ");

function labelOf(p: Projection, showId: string, senderItemId: string): string {
  const role = roleOfItem(showId, senderItemId);
  return p.mandate?.parties.find((x) => x.role === role)?.label ?? senderItemId;
}

function itemWords(status: string): string {
  if (status === "SUCCESS") return "paid";
  if (PAYOUT_FAILED.has(status)) return "couldn't be paid";
  if (status === "UNCLAIMED") return "waiting for them to claim it";
  return "pending";
}

function proposeShortfall(d: ExecDeps, p: Projection, approvalKey: string, shortfall: number): void {
  const proposalId = `short${p.collectedNet}`;
  const { appended } = commit(d.store, d.clock.now(), {
    type: "proposal_made",
    proposalId,
    options: [{ id: "pay_short", approvalKey, label: "Pay out what came in", collectedNet: p.collectedNet }],
    explanation: `After PayPal's fees, ${formatUSD(p.collectedNet)} came in. That is ${formatUSD(shortfall)} short of the amounts you signed. Approve to pay out what came in, in the signed order.`,
    recommend: "pay_short",
    source: "template",
  });
  if (appended) logStep(d, { saw: sawCounts(p), did: "The money is short of the signed amounts, so payouts wait for the artist's OK.", rule: "rule-5-ask-first" });
}

const runPayout: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  if (!p.mandate) return fail(d, job, "The money rules aren't signed.");
  if (p.payouts.some((x) => !x.retry)) return done(d, job, "Payouts were already sent.");
  const senderBatchId = payoutBatchId(d.showId);
  if (p.campaign.state === "paying_out" && p.campaign.pledges.held === 0 && p.collectedNet === 0) {
    commit(d.store, d.clock.now(), { type: "payout_sent", senderBatchId, batchId: null, status: "NOTHING_TO_PAY", lines: [], retry: false, recovered: false });
    logStep(d, { saw: sawCounts(p), did: "No money came in, so there was nothing to pay out.", rule: "rule-4-pay-the-split" });
    return done(d, job, "Nothing to pay.");
  }
  // The split comes from code and the signed mandate, never from the model.
  const expected = splitPayout(p.collectedNet, p.mandate.parties);
  const decision = decide(p, { kind: "send_payouts", lines: expected.lines });
  if (decision.needsApproval && decision.approvalKey) {
    block(d, job, decision.reason);
    return proposeShortfall(d, p, decision.approvalKey, expected.shortfall);
  }
  if (!decision.allowed) return skip(d, job, p, decision, "Did not send payouts.");
  const toSend = expected.lines.filter((l) => l.amount > 0);
  let sent: SentBatch;
  try {
    sent = await d.paypal.sendPayouts(d.showId, expected.lines, false);
  } catch (e) {
    if (isDuplicateBatch(e)) {
      commit(d.store, d.clock.now(), { type: "payout_sent", senderBatchId, batchId: null, status: "ALREADY_SENT", lines: toSend, retry: false, recovered: true });
      logStep(d, { saw: sawCounts(p), did: "PayPal already has this payout batch, so it was not sent again. Waiting for PayPal to confirm it.", rule: decision.rule, requestId: senderBatchId });
      return done(d, job, "Already sent.");
    }
    if (e instanceof PayPalError && (e.retryable || MAYBE_SENT.has(e.paypalName))) return retryLater(d, job, attempt, errText(e));
    return fail(d, job, `PayPal refused the payout batch (${errText(e)}).`);
  }
  commit(d.store, d.clock.now(), { type: "payout_sent", senderBatchId: sent.senderBatchId, batchId: sent.batchId, status: sent.status, lines: sent.sentLines, retry: false, recovered: false });
  logStep(d, { saw: sawCounts(p), did: `Sent the payouts exactly as signed: ${listLines(sent.sentLines)}.`, rule: decision.rule, requestId: sent.senderBatchId, resultId: sent.batchId });
  schedulePoll(d, sent.batchId, 1);
  done(d, job, `Batch ${sent.status}.`);
};

const runPayoutPoll: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const batchId = job.target;
  const payout = p.payouts.find((x) => x.batchId === batchId);
  if (!payout) return fail(d, job, "That payout batch isn't part of this show.");
  let batch: PayoutBatch;
  try {
    batch = await d.paypal.getPayoutBatch(batchId);
  } catch (e) {
    return retryLater(d, job, attempt, errText(e));
  }
  const { appended } = commit(d.store, d.clock.now(), { type: "payout_items", batchId, items: batch.items });
  const failed = batch.items.filter((i) => PAYOUT_FAILED.has(i.status));
  const pending = batch.items.some((i) => i.status !== "SUCCESS" && !PAYOUT_FAILED.has(i.status));
  if (appended) {
    logStep(d, { saw: `PayPal says the payout batch is ${batch.status}.`, did: batch.items.map((i) => `${labelOf(p, d.showId, i.senderItemId)}: ${itemWords(i.status)}`).join(" · ") || "No payout items yet.", rule: "rule-4-pay-the-split", resultId: batchId });
  }
  if (failed.length > 0 && !payout.retry) {
    const now = d.clock.now();
    d.store.putJob({ key: `payout_retry:${d.showId}`, kind: "payout_retry", target: d.showId, nextAt: now }, now);
  }
  if (failed.length > 0 && payout.retry && appended) {
    logStep(d, { saw: "The second try failed too.", did: `Needs attention: ${failed.map((i) => labelOf(p, d.showId, i.senderItemId)).join(", ")} couldn't be paid twice. Check their PayPal email.`, rule: null, resultId: batchId });
  }
  const n = Number(job.note) || 1;
  if (pending && n < PAYOUT_POLL_MAX) schedulePoll(d, batchId, n + 1);
  done(d, job, `Batch ${batch.status}.`);
};

/** The first batch's failed lines, re-checked against the signed split. A line that doesn't match it exactly is never retried. */
export function retryLines(showId: string, p: Projection, first: PayoutView): PayoutLine[] {
  if (!p.mandate || p.campaign.state !== "settled") return [];
  const expected = splitPayout(p.collectedNet, p.mandate.parties).lines;
  const failedRoles = new Set(
    Object.values(first.items)
      .filter((i) => PAYOUT_FAILED.has(i.status))
      .map((i) => roleOfItem(showId, i.senderItemId)),
  );
  return first.lines.filter((l) => l.amount > 0 && failedRoles.has(l.role) && expected.some((x) => x.role === l.role && x.label === l.label && x.paypalEmail === l.paypalEmail && x.amount === l.amount));
}

const runPayoutRetry: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const first = p.payouts.find((x) => !x.retry);
  if (!first) return fail(d, job, "There is no first payout batch to retry.");
  if (p.payouts.some((x) => x.retry)) return done(d, job, "Already retried once.");
  const lines = retryLines(d.showId, p, first);
  if (lines.length === 0) return done(d, job, "Nothing to retry.");
  const senderBatchId = payoutBatchId(d.showId, true);
  let sent: SentBatch;
  try {
    sent = await d.paypal.sendPayouts(d.showId, lines, true);
  } catch (e) {
    if (isDuplicateBatch(e)) {
      commit(d.store, d.clock.now(), { type: "payout_sent", senderBatchId, batchId: null, status: "ALREADY_SENT", lines, retry: true, recovered: true });
      logStep(d, { saw: sawCounts(p), did: "PayPal already has the retry batch, so it was not sent again.", rule: "rule-4-pay-the-split", requestId: senderBatchId });
      return done(d, job, "Already sent.");
    }
    if (e instanceof PayPalError && (e.retryable || MAYBE_SENT.has(e.paypalName))) return retryLater(d, job, attempt, errText(e));
    return fail(d, job, `PayPal refused the retry batch (${errText(e)}).`);
  }
  commit(d.store, d.clock.now(), { type: "payout_sent", senderBatchId: sent.senderBatchId, batchId: sent.batchId, status: sent.status, lines: sent.sentLines, retry: true, recovered: false });
  logStep(d, { saw: sawCounts(p), did: `Tried once more for the payouts that failed: ${listLines(sent.sentLines)}.`, rule: "rule-4-pay-the-split", requestId: sent.senderBatchId, resultId: sent.batchId });
  schedulePoll(d, sent.batchId, 1);
  done(d, job, `Retry batch ${sent.status}.`);
};

export const PAYOUT_RUNNERS: Runners = { payout: runPayout, payout_poll: runPayoutPoll, payout_retry: runPayoutRetry };
```

`src/agent/runners.ts`:

```ts
import type { Runners } from "./executor";
import { HOLD_RUNNERS } from "./hold-runner";
import { PAYOUT_RUNNERS } from "./payout-runner";

/** Every job kind the runtime can execute. */
export const RUNNERS: Runners = { ...HOLD_RUNNERS, ...PAYOUT_RUNNERS };
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/agent`
Expected: PASS.

- [ ] **Step 5: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add src/agent tests/agent
git commit -m "feat(agent): payouts from the signed split with duplicate recovery, polling and one -r1 retry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Workers AI port, daily neuron budget, rate limits and the three AI jobs with templates

**Files:**
- Create: `src/agent/quota.ts`, `src/agent/ai.ts`, `src/agent/ai-jobs.ts`
- Create: `tests/agent/fake-ai.ts`, `tests/agent/quota.test.ts`, `tests/agent/ai-jobs.test.ts`

**Interfaces:**
- Consumes: Task 2 `SqlDb`, `AiSource`, `ProposalOption`, `ProposalOptionId`; Plan 1 `dollarsToCents`, `formatUSD`, `Cents`, `Role`; Task 1 `centsToValue`.
- Produces:
  - `quota.ts`: `DAILY_NEURON_BUDGET = 8000`, `utcDay(now): string`, `nextUtcMidnight(now): number`, `interface RateResult { ok: boolean; retryAfterSec: number }`, `interface QuotaPort { hit(key: string, limit: number, windowMs: number): Promise<RateResult> }`, `class Quota { migrate(); neuronsUsed(now); reserveNeurons(now, cost, limit?): boolean; hit(key, limit, windowMs, now): RateResult }`, `type QuotaOp`, `quotaDispatch(q: Quota, op: QuotaOp, now: number): unknown`
  - `ai.ts`: `MODELS`, `type ModelId`, `NEURON_ESTIMATE`, `AiMessage`, `AiInput`, `interface AiPort { run(model: ModelId, input: AiInput): Promise<unknown> }`, `interface BudgetPort { tryReserve(neurons: number): Promise<boolean> }`, `interface AiDeps { ai: AiPort | null; budget: BudgetPort }`, `interface AiResult<T> { value: T; source: AiSource }`, `askModel(deps, model, input): Promise<{ ok: true; value: unknown } | { ok: false; why: "resting" | "unavailable" }>`
  - `ai-jobs.ts`: `interface DraftSuggestion { showName; roomName; showDate: string | null; ticketPrice: Cents | null; room; opener; host; artistMinimum }`, `parseDraft(raw): DraftSuggestion | null`, `templateDraft(sentence, now): DraftSuggestion`, `draftFromSentence(deps, sentence, now): Promise<AiResult<DraftSuggestion>>`; `interface PaceFacts { committed; threshold; daysLeft; projected; percentElapsed; options: ProposalOption[]; extendDays: number | null; lowerTo: number | null }`, `interface PaceNote { text: string; recommend: ProposalOptionId | "wait" }`, `numbersOk(text, allowed): boolean`, `parsePaceNote(raw, f): PaceNote | null`, `templatePaceNote(f): PaceNote`, `paceNote(deps, f): Promise<AiResult<PaceNote>>`; `interface NoteFacts { role: Role; label; showName; outcome: "paid" | "called_off" | "refunded"; amountCents; fans; ticketPriceCents }`, `templateNote(f): string`, `parseNote(raw, f): string | null`, `settlementNote(deps, f): Promise<AiResult<string>>`

**Model ids (must be confirmed during this task):** open https://developers.cloudflare.com/workers-ai/models/ and check that `@cf/meta/llama-3.3-70b-instruct-fp8-fast` and `@cf/meta/llama-3.1-8b-instruct` are listed and support JSON mode (`response_format`). If an id changed, update only `MODELS`. Write the result in the commit message body ("Model ids checked against the catalogue on <date>: both listed" or the change made). Neuron costs in `NEURON_ESTIMATE` are fixed ESTIMATES per call, deliberately on the high side; they are not measured.

- [ ] **Step 1: Write the test fakes**

`tests/agent/fake-ai.ts`:

```ts
import type { AiInput, AiPort, BudgetPort, ModelId } from "../../src/agent/ai";

/** Answers in order; an Error answer is thrown. */
export class FakeAi implements AiPort {
  readonly calls: { model: ModelId; input: AiInput }[] = [];
  constructor(private readonly answers: unknown[] = []) {}
  async run(model: ModelId, input: AiInput): Promise<unknown> {
    this.calls.push({ model, input });
    const a = this.answers.shift();
    if (a instanceof Error) throw a;
    return a;
  }
}

export function fakeBudget(limit = Number.POSITIVE_INFINITY) {
  let used = 0;
  const port: BudgetPort = {
    async tryReserve(n: number) {
      if (used + n > limit) return false;
      used += n;
      return true;
    },
  };
  return { port, used: () => used };
}

/** A Workers AI text answer carrying JSON. */
export const json = (value: unknown) => ({ response: JSON.stringify(value) });
```

- [ ] **Step 2: Write the failing tests**

`tests/agent/quota.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DAILY_NEURON_BUDGET, nextUtcMidnight, Quota, quotaDispatch, utcDay } from "../../src/agent/quota";
import { memoryDb } from "./sqlite";

const T = Date.parse("2026-11-01T22:00:00Z");

function quota(): Quota {
  const q = new Quota(memoryDb());
  q.migrate();
  return q;
}

describe("daily neuron budget", () => {
  it("reserves until the limit, then refuses", () => {
    const q = quota();
    expect(q.reserveNeurons(T, 5000)).toBe(true);
    expect(q.reserveNeurons(T, 3000)).toBe(true);
    expect(q.reserveNeurons(T, 1)).toBe(false);
    expect(q.neuronsUsed(T)).toBe(DAILY_NEURON_BUDGET);
  });
  it("resets at 00:00 UTC", () => {
    const q = quota();
    q.reserveNeurons(T, 8000);
    expect(q.reserveNeurons(nextUtcMidnight(T), 150)).toBe(true);
    expect(utcDay(nextUtcMidnight(T))).toBe("2026-11-02");
    expect(nextUtcMidnight(T)).toBe(Date.parse("2026-11-02T00:00:00Z"));
  });
  it("refuses a nonsense cost", () => {
    expect(() => quota().reserveNeurons(T, 0)).toThrow(RangeError);
  });
});

describe("rate limits", () => {
  it("allows `limit` hits per window, then says when to retry", () => {
    const q = quota();
    for (let i = 0; i < 3; i++) expect(q.hit("demo:v1", 3, 60_000, T + i).ok).toBe(true);
    expect(q.hit("demo:v1", 3, 60_000, T + 10_000)).toEqual({ ok: false, retryAfterSec: 50 });
    expect(q.hit("demo:v2", 3, 60_000, T + 10_000).ok).toBe(true);
    expect(q.hit("demo:v1", 3, 60_000, T + 60_000).ok).toBe(true);
  });
  it("is reachable through quotaDispatch", () => {
    const q = quota();
    expect(quotaDispatch(q, { op: "reserve", neurons: 100 }, T)).toEqual({ ok: true });
    expect(quotaDispatch(q, { op: "hit", key: "k", limit: 1, windowMs: 1000 }, T)).toEqual({ ok: true, retryAfterSec: 0 });
    expect(quotaDispatch(q, { op: "used" }, T)).toEqual({ used: 100, limit: DAILY_NEURON_BUDGET, restingUntil: null });
  });
});
```

`tests/agent/ai-jobs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MODELS, NEURON_ESTIMATE } from "../../src/agent/ai";
import { draftFromSentence, numbersOk, paceNote, parseDraft, settlementNote, templateDraft, templateNote, templatePaceNote, type NoteFacts, type PaceFacts } from "../../src/agent/ai-jobs";
import { FakeAi, fakeBudget, json } from "./fake-ai";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const SENTENCE = "Acoustic set at Lucky's Café, Nov 20, $15 tickets, café wants $100, I need $200";
const valid = { showName: "Acoustic set", roomName: "Lucky's Café", showDate: "2026-11-20", ticketPriceDollars: 15, roomDollars: 100, openerDollars: 0, hostDollars: 0, artistMinimumDollars: 200 };
const facts: PaceFacts = {
  committed: 8,
  threshold: 20,
  daysLeft: 3,
  projected: 14,
  percentElapsed: 57,
  options: [
    { id: "extend", approvalKey: "extend:1", label: "Extend 7 days", newDeadline: 1 },
    { id: "lower", approvalKey: "lower:14", label: "Lower the target to 14", newThreshold: 14 },
  ],
  extendDays: 7,
  lowerTo: 14,
};
const note: NoteFacts = { role: "room", label: "Lucky's Café", showName: "Acoustic Set", outcome: "paid", amountCents: 10000, fans: 21, ticketPriceCents: 1500 };

describe("models and budget estimates", () => {
  it("uses the 70B model for proposals and notes and the 8B model for extraction, with positive estimates", () => {
    expect(MODELS).toEqual({ big: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", small: "@cf/meta/llama-3.1-8b-instruct" });
    expect(NEURON_ESTIMATE[MODELS.big]).toBeGreaterThan(0);
    expect(NEURON_ESTIMATE[MODELS.small]).toBeGreaterThan(0);
  });
});

describe("sentence → draft", () => {
  it("parses the spec's example sentence with the template", () => {
    expect(templateDraft(SENTENCE, NOW)).toEqual({ showName: "Acoustic set", roomName: "Lucky's Café", showDate: "2026-11-20", ticketPrice: 1500, room: 10000, opener: 0, host: 0, artistMinimum: 20000 });
  });
  it("rolls a date that already passed this year into next year", () => {
    expect(templateDraft("Gig at The Bar, Jan 3, $10 tickets", NOW).showDate).toBe("2027-01-03");
  });
  it("uses the template when there is no AI binding, without touching the budget", async () => {
    const b = fakeBudget();
    const r = await draftFromSentence({ ai: null, budget: b.port }, SENTENCE, NOW);
    expect(r.source).toBe("template");
    expect(b.used()).toBe(0);
  });
  it("uses the model's answer when it passes the schema check, and charges the small model's estimate", async () => {
    const ai = new FakeAi([json(valid)]);
    const b = fakeBudget();
    const r = await draftFromSentence({ ai, budget: b.port }, SENTENCE, NOW);
    expect(r).toEqual({ source: "model", value: { showName: "Acoustic set", roomName: "Lucky's Café", showDate: "2026-11-20", ticketPrice: 1500, room: 10000, opener: 0, host: 0, artistMinimum: 20000 } });
    expect(ai.calls[0].model).toBe(MODELS.small);
    expect(b.used()).toBe(NEURON_ESTIMATE[MODELS.small]);
  });
  it("accepts an answer that is already an object", async () => {
    const r = await draftFromSentence({ ai: new FakeAi([{ response: valid }]), budget: fakeBudget().port }, SENTENCE, NOW);
    expect(r.source).toBe("model");
  });
  it("falls back to the template when the answer fails the schema check", async () => {
    for (const bad of [{ ...valid, ticketPriceDollars: -5 }, { ...valid, showDate: "2026-02-30" }, { ...valid, showName: "" }, "not json", { response: 42 }]) {
      const answer = typeof bad === "string" ? { response: bad } : "response" in bad ? bad : json(bad);
      const r = await draftFromSentence({ ai: new FakeAi([answer]), budget: fakeBudget().port }, SENTENCE, NOW);
      expect(r.source).toBe("template");
    }
  });
  it("says 'resting' when the daily budget is spent, and never calls the model", async () => {
    const ai = new FakeAi([json(valid)]);
    const r = await draftFromSentence({ ai, budget: fakeBudget(0).port }, SENTENCE, NOW);
    expect(r.source).toBe("resting");
    expect(ai.calls).toHaveLength(0);
  });
  it("falls back when the model throws", async () => {
    const r = await draftFromSentence({ ai: new FakeAi([new Error("down")]), budget: fakeBudget().port }, SENTENCE, NOW);
    expect(r.source).toBe("template");
  });
  it("rejects a draft with absurd amounts", () => {
    expect(parseDraft({ ...valid, roomDollars: 1e9 })).toBeNull();
    expect(parseDraft({ ...valid, ticketPriceDollars: 0 })).toBeNull();
  });
});

describe("pace note", () => {
  it("accepts only numbers code computed", () => {
    const allowed = new Set(["8", "20"]);
    expect(numbersOk("8 of 20 fans", allowed)).toBe(true);
    expect(numbersOk("8 of 20 fans, about 99 more", allowed)).toBe(false);
  });
  it("has a template that passes its own number check", () => {
    const t = templatePaceNote(facts);
    expect(t).toEqual({ text: "8 of 20 fans with 3 days left. At this pace about 14 will join. You could extend the deadline 7 days, or lower the target to 14.", recommend: "extend" });
  });
  it("uses a valid model answer from the 70B model", async () => {
    const ai = new FakeAi([json({ text: "You have 8 of 20 fans and 3 days left. Extending 7 days gives fans more time.", recommend: "extend" })]);
    const r = await paceNote({ ai, budget: fakeBudget().port }, facts);
    expect(r.source).toBe("model");
    expect(r.value.recommend).toBe("extend");
    expect(ai.calls[0].model).toBe(MODELS.big);
  });
  it("rejects invented numbers and options that weren't offered", async () => {
    for (const bad of [{ text: "Only 2 days left, lower it to 5.", recommend: "lower" }, { text: "You have 8 of 20 fans.", recommend: "refund" }, { text: "x", recommend: "wait" }]) {
      const r = await paceNote({ ai: new FakeAi([json(bad)]), budget: fakeBudget().port }, facts);
      expect(r.source).toBe("template");
    }
  });
});

describe("settlement note", () => {
  it("has a plain template for each outcome", () => {
    expect(templateNote(note)).toBe("Acoustic Set happened. 21 fans paid $15.00 each, and Lucky's Café was paid $100.00 under the money rules the artist signed.");
    expect(templateNote({ ...note, outcome: "called_off", amountCents: 0 })).toBe("Acoustic Set didn't reach its target, so every hold was cancelled. Nobody was charged, and Lucky's Café receives nothing.");
    expect(templateNote({ ...note, outcome: "refunded", amountCents: 0 })).toBe("Acoustic Set was called off after it tipped. Every fan is being refunded, and Lucky's Café receives nothing.");
  });
  it("uses the model when its numbers match, else the template", async () => {
    const ok = await settlementNote({ ai: new FakeAi([json({ text: "The show happened with 21 fans, and Lucky's Café was paid $100 as signed." })]), budget: fakeBudget().port }, note);
    expect(ok.source).toBe("model");
    const bad = await settlementNote({ ai: new FakeAi([json({ text: "Lucky's Café was paid $250 for the night, thanks to 21 fans." })]), budget: fakeBudget().port }, note);
    expect(bad).toEqual({ source: "template", value: templateNote(note) });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run tests/agent/quota.test.ts tests/agent/ai-jobs.test.ts`
Expected: FAIL with "Cannot find module '../../src/agent/quota'" and "'../../src/agent/ai'".

- [ ] **Step 4: Write `src/agent/quota.ts`**

```ts
import type { SqlDb } from "./sql";

/** Workers AI free tier is 10,000 neurons/day; we stop at 8,000 to stay clear of it. */
export const DAILY_NEURON_BUDGET = 8000;

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export interface RateResult {
  ok: boolean;
  retryAfterSec: number;
}

/** What the router needs from the Quota Durable Object. */
export interface QuotaPort {
  hit(key: string, limit: number, windowMs: number): Promise<RateResult>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** One singleton store for the AI budget and the per-visitor rate limits (fixed windows). */
export class Quota {
  constructor(private readonly db: SqlDb) {}

  migrate(): void {
    this.db.sql.exec("CREATE TABLE IF NOT EXISTS ai_budget (day TEXT PRIMARY KEY, used INTEGER NOT NULL)");
    this.db.sql.exec("CREATE TABLE IF NOT EXISTS rate (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)");
  }

  neuronsUsed(now: number): number {
    return this.db.sql.exec<{ used: number }>("SELECT used FROM ai_budget WHERE day = ?", utcDay(now)).toArray()[0]?.used ?? 0;
  }

  /** Reserves `cost` neurons for today if that stays within `limit`. Hard limit: never goes over. */
  reserveNeurons(now: number, cost: number, limit = DAILY_NEURON_BUDGET): boolean {
    if (!Number.isInteger(cost) || cost <= 0) throw new RangeError("cost must be a positive whole number of neurons");
    return this.db.transaction(() => {
      const day = utcDay(now);
      const used = this.neuronsUsed(now);
      if (used + cost > limit) return false;
      this.db.sql.exec("INSERT INTO ai_budget (day, used) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET used = excluded.used", day, used + cost);
      this.db.sql.exec("DELETE FROM ai_budget WHERE day < ?", day);
      return true;
    });
  }

  hit(key: string, limit: number, windowMs: number, now: number): RateResult {
    return this.db.transaction(() => {
      const row = this.db.sql.exec<{ window_start: number; count: number }>("SELECT window_start, count FROM rate WHERE key = ?", key).toArray()[0];
      const fresh = row === undefined || now - row.window_start >= windowMs;
      const start = row === undefined || fresh ? now : row.window_start;
      const count = row === undefined || fresh ? 0 : row.count;
      if (count >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
      this.db.sql.exec("INSERT INTO rate (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count", key, start, count + 1);
      this.db.sql.exec("DELETE FROM rate WHERE window_start < ?", now - 2 * DAY_MS);
      return { ok: true, retryAfterSec: 0 };
    });
  }
}

export type QuotaOp = { op: "reserve"; neurons: number } | { op: "hit"; key: string; limit: number; windowMs: number } | { op: "used" };

export function quotaDispatch(q: Quota, op: QuotaOp, now: number): unknown {
  switch (op.op) {
    case "reserve":
      return { ok: q.reserveNeurons(now, op.neurons) };
    case "hit":
      return q.hit(op.key, op.limit, op.windowMs, now);
    case "used": {
      const used = q.neuronsUsed(now);
      return { used, limit: DAILY_NEURON_BUDGET, restingUntil: used >= DAILY_NEURON_BUDGET ? new Date(nextUtcMidnight(now)).toISOString() : null };
    }
  }
}
```

- [ ] **Step 5: Write `src/agent/ai.ts`**

```ts
import type { AiSource } from "./events";

/** Confirm against https://developers.cloudflare.com/workers-ai/models/ (Task 5). */
export const MODELS = {
  big: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  small: "@cf/meta/llama-3.1-8b-instruct",
} as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** ESTIMATES, not measurements: the fixed neuron cost charged to the daily budget per call, set high on purpose. */
export const NEURON_ESTIMATE: Record<ModelId, number> = {
  [MODELS.big]: 150,
  [MODELS.small]: 40,
};

export interface AiMessage {
  role: "system" | "user";
  content: string;
}

export interface AiInput {
  messages: AiMessage[];
  max_tokens: number;
  temperature?: number;
  response_format?: { type: "json_schema"; json_schema: Record<string, unknown> };
}

/** The Workers AI binding, reduced to the one call we make. */
export interface AiPort {
  run(model: ModelId, input: AiInput): Promise<unknown>;
}

export interface BudgetPort {
  tryReserve(neurons: number): Promise<boolean>;
}

export interface AiDeps {
  /** Null when there is no binding (local dev, tests): templates only. */
  ai: AiPort | null;
  budget: BudgetPort;
}

export interface AiResult<T> {
  value: T;
  source: AiSource;
}

export type ModelAnswer = { ok: true; value: unknown } | { ok: false; why: "resting" | "unavailable" };

/** Reserves budget, calls the model, and returns its `response` (parsed as JSON when it is a JSON string). Never throws. */
export async function askModel(deps: AiDeps, model: ModelId, input: AiInput): Promise<ModelAnswer> {
  if (!deps.ai) return { ok: false, why: "unavailable" };
  let reserved = false;
  try {
    reserved = await deps.budget.tryReserve(NEURON_ESTIMATE[model]);
  } catch {
    reserved = false;
  }
  if (!reserved) return { ok: false, why: "resting" };
  try {
    const out = await deps.ai.run(model, input);
    const response = out && typeof out === "object" ? (out as { response?: unknown }).response : undefined;
    if (typeof response === "string") {
      try {
        return { ok: true, value: JSON.parse(response) };
      } catch {
        return { ok: true, value: response };
      }
    }
    return response === undefined ? { ok: false, why: "unavailable" } : { ok: true, value: response };
  } catch {
    return { ok: false, why: "unavailable" };
  }
}
```

- [ ] **Step 6: Write `src/agent/ai-jobs.ts`**

```ts
import { dollarsToCents, formatUSD, type Cents } from "../core/money";
import type { Role } from "../core/split";
import { centsToValue } from "../paypal/amount";
import { askModel, MODELS, type AiDeps, type AiResult, type ModelAnswer } from "./ai";
import type { AiSource, ProposalOption, ProposalOptionId } from "./events";

const fallbackSource = (a: ModelAnswer): AiSource => (!a.ok && a.why === "resting" ? "resting" : "template");
const pad = (n: number) => String(n).padStart(2, "0");

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Every number in `text` (commas ignored) must be one code computed. Stops a model inventing figures. */
export function numbersOk(text: string, allowed: ReadonlySet<string>): boolean {
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    if (!allowed.has(m[0].replace(/,/g, ""))) return false;
  }
  return true;
}

function digitsIn(...texts: string[]): string[] {
  return texts.flatMap((t) => [...t.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")));
}

function moneyForms(c: Cents): string[] {
  const v = centsToValue(c);
  return c % 100 === 0 ? [v, String(c / 100)] : [v];
}

/* ---------- 1 · sentence → draft (small model; code computes the threshold) ---------- */

export interface DraftSuggestion {
  showName: string;
  roomName: string;
  showDate: string | null;
  ticketPrice: Cents | null;
  room: Cents;
  opener: Cents;
  host: Cents;
  artistMinimum: Cents;
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    showName: { type: "string" },
    roomName: { type: "string" },
    showDate: { type: ["string", "null"] },
    ticketPriceDollars: { type: ["number", "null"] },
    roomDollars: { type: "number" },
    openerDollars: { type: "number" },
    hostDollars: { type: "number" },
    artistMinimumDollars: { type: "number" },
  },
  required: ["showName", "roomName", "showDate", "ticketPriceDollars", "roomDollars", "openerDollars", "hostDollars", "artistMinimumDollars"],
};

const DRAFT_SYSTEM =
  "You turn one sentence about a small live show into JSON. Use only facts in the sentence. " +
  "Money is in US dollars as plain numbers. Use 0 for a missing amount, and null for a missing showDate or ticketPriceDollars. " +
  "showDate is YYYY-MM-DD. roomName is the venue. artistMinimumDollars is what the artist says they need. Answer with JSON only.";

/** Schema check for the model's draft. Null means "use the template". */
export function parseDraft(raw: unknown): DraftSuggestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, allowEmpty: boolean) => (typeof v === "string" && v.trim().length <= 80 && (allowEmpty || v.trim().length > 0) ? v.trim() : null);
  const dollars = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? dollarsToCents(v) : null);
  const showName = text(r.showName, false);
  const roomName = text(r.roomName, true);
  const showDate = r.showDate === null ? null : typeof r.showDate === "string" && isIsoDate(r.showDate) ? r.showDate : undefined;
  const ticketPrice = r.ticketPriceDollars === null ? null : dollars(r.ticketPriceDollars, 1000);
  const room = dollars(r.roomDollars, 100_000);
  const opener = dollars(r.openerDollars, 100_000);
  const host = dollars(r.hostDollars, 100_000);
  const artistMinimum = dollars(r.artistMinimumDollars, 100_000);
  if (showName === null || roomName === null || showDate === undefined) return null;
  if (r.ticketPriceDollars !== null && (ticketPrice === null || ticketPrice === 0)) return null;
  if (room === null || opener === null || host === null || artistMinimum === null) return null;
  return { showName, roomName, showDate, ticketPrice, room, opener, host, artistMinimum };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const AMOUNT = String.raw`(\d+(?:\.\d{1,2})?)`;

/** Deterministic fallback: the same patterns the Start page's preview used, returning cents. */
export function templateDraft(sentence: string, now: number): DraftSuggestion {
  const t = sentence.replace(/[’]/g, "'");
  const num = (re: RegExp): number | null => {
    const m = re.exec(t);
    return m ? Number(m[1]) : null;
  };
  const cents = (n: number | null): Cents => (n === null || !Number.isFinite(n) || n < 0 || n > 100_000 ? 0 : dollarsToCents(n));
  const price =
    num(new RegExp(String.raw`\$${AMOUNT}\s*(?:tickets?|a ticket|each|a spot|per (?:ticket|person|fan))`, "i")) ??
    num(new RegExp(String.raw`tickets?\s*(?:are|at)?\s*\$${AMOUNT}`, "i"));
  const room = num(new RegExp(String.raw`(?:caf[eé]|room|venue|bar|shop|store|place)\s+(?:wants|needs|gets|charges)\s+\$${AMOUNT}`, "i"));
  const opener = num(new RegExp(String.raw`opener\s+(?:wants|needs|gets)\s+\$${AMOUNT}`, "i"));
  const host = num(new RegExp(String.raw`host\s+(?:wants|needs|gets)\s+\$${AMOUNT}`, "i"));
  const me = num(new RegExp(String.raw`\bI\s+(?:need|want|get)\s+\$${AMOUNT}`, "i"));
  let showDate: string | null = null;
  const dm = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(t);
  if (dm) {
    const month = MONTHS.indexOf(dm[1].toLowerCase());
    const day = Number(dm[2]);
    const today = new Date(now);
    let year = today.getUTCFullYear();
    if (Date.UTC(year, month, day) < Date.UTC(year, today.getUTCMonth(), today.getUTCDate())) year += 1;
    const iso = `${year}-${pad(month + 1)}-${pad(day)}`;
    showDate = isIsoDate(iso) ? iso : null;
  }
  const roomName = (/\bat\s+((?:[A-Z][\w'é&.-]*\s?)+?)(?=\s+on\b|,|$)/.exec(t)?.[1] ?? "").trim().slice(0, 80);
  const showName = (/^\s*([^,]+?)\s+at\s+/i.exec(t)?.[1] ?? "").trim().slice(0, 80) || "My show";
  return {
    showName,
    roomName,
    showDate,
    ticketPrice: price !== null && price > 0 && price <= 1000 ? dollarsToCents(price) : null,
    room: cents(room),
    opener: cents(opener),
    host: cents(host),
    artistMinimum: cents(me),
  };
}

export async function draftFromSentence(deps: AiDeps, sentence: string, now: number): Promise<AiResult<DraftSuggestion>> {
  const answer = await askModel(deps, MODELS.small, {
    messages: [
      { role: "system", content: DRAFT_SYSTEM },
      { role: "user", content: `Today is ${new Date(now).toISOString().slice(0, 10)}. Sentence: ${sentence.slice(0, 500)}` },
    ],
    max_tokens: 256,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: DRAFT_SCHEMA },
  });
  if (answer.ok) {
    const value = parseDraft(answer.value);
    if (value) return { value, source: "model" };
  }
  return { value: templateDraft(sentence, now), source: fallbackSource(answer) };
}

/* ---------- 2 · pace check: explain code's numbers and options (70B) ---------- */

export interface PaceFacts {
  committed: number;
  threshold: number;
  daysLeft: number;
  projected: number;
  percentElapsed: number;
  /** Already guard-approved options (needsApproval), computed by code. */
  options: ProposalOption[];
  extendDays: number | null;
  lowerTo: number | null;
}

export interface PaceNote {
  text: string;
  recommend: ProposalOptionId | "wait";
}

const PACE_SCHEMA = { type: "object", properties: { text: { type: "string" }, recommend: { type: "string" } }, required: ["text", "recommend"] };
const PACE_SYSTEM =
  "You help an artist whose small show needs more fans. In 1 to 3 short, plain sentences, explain the numbers given and the options given. " +
  "Use ONLY the numbers provided. No jargon: say 'on hold', never 'authorized'. Then set recommend to one option id, or \"wait\". Answer with JSON only.";

function paceAllowed(f: PaceFacts): Set<string> {
  const nums = [f.committed, f.threshold, f.daysLeft, f.projected, f.percentElapsed, Math.max(0, f.threshold - f.committed)];
  if (f.extendDays !== null) nums.push(f.extendDays);
  if (f.lowerTo !== null) nums.push(f.lowerTo);
  return new Set(nums.map(String));
}

export function parsePaceNote(raw: unknown, f: PaceFacts): PaceNote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string" || r.text.trim().length < 10 || r.text.length > 400) return null;
  const ids: string[] = ["wait", ...f.options.map((o) => o.id)];
  if (typeof r.recommend !== "string" || !ids.includes(r.recommend)) return null;
  if (!numbersOk(r.text, paceAllowed(f))) return null;
  return { text: r.text.trim(), recommend: r.recommend as ProposalOptionId | "wait" };
}

export function templatePaceNote(f: PaceFacts): PaceNote {
  const first = `${f.committed} of ${f.threshold} fans with ${f.daysLeft} day${f.daysLeft === 1 ? "" : "s"} left. At this pace about ${f.projected} will join.`;
  const choices: string[] = [];
  if (f.extendDays !== null) choices.push(`extend the deadline ${f.extendDays} day${f.extendDays === 1 ? "" : "s"}`);
  if (f.lowerTo !== null) choices.push(`lower the target to ${f.lowerTo}`);
  return {
    text: choices.length ? `${first} You could ${choices.join(", or ")}.` : `${first} Nothing needs changing yet.`,
    recommend: f.extendDays !== null ? "extend" : f.lowerTo !== null ? "lower" : "wait",
  };
}

export async function paceNote(deps: AiDeps, f: PaceFacts): Promise<AiResult<PaceNote>> {
  const answer = await askModel(deps, MODELS.big, {
    messages: [
      { role: "system", content: PACE_SYSTEM },
      { role: "user", content: JSON.stringify({ fans: f.committed, target: f.threshold, daysLeft: f.daysLeft, percentOfTimeUsed: f.percentElapsed, projectedFans: f.projected, options: f.options.map((o) => ({ id: o.id, label: o.label })) }) },
    ],
    max_tokens: 200,
    temperature: 0.2,
    response_format: { type: "json_schema", json_schema: PACE_SCHEMA },
  });
  if (answer.ok) {
    const value = parsePaceNote(answer.value, f);
    if (value) return { value, source: "model" };
  }
  return { value: templatePaceNote(f), source: fallbackSource(answer) };
}

/* ---------- 3 · plain-English settlement note per party (70B) ---------- */

export interface NoteFacts {
  role: Role;
  label: string;
  showName: string;
  outcome: "paid" | "called_off" | "refunded";
  amountCents: Cents;
  fans: number;
  ticketPriceCents: Cents;
}

const NOTE_SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const NOTE_SYSTEM =
  "Write one or two plain sentences for the named person about how a small show's money settled. " +
  "Use only the facts and numbers given. No jargon: say 'on hold', 'charged', 'cancelled', 'refunded'. Answer with JSON only.";

export function templateNote(f: NoteFacts): string {
  switch (f.outcome) {
    case "paid":
      return `${f.showName} happened. ${f.fans} fans paid ${formatUSD(f.ticketPriceCents)} each, and ${f.label} was paid ${formatUSD(f.amountCents)} under the money rules the artist signed.`;
    case "called_off":
      return `${f.showName} didn't reach its target, so every hold was cancelled. Nobody was charged, and ${f.label} receives nothing.`;
    case "refunded":
      return `${f.showName} was called off after it tipped. Every fan is being refunded, and ${f.label} receives nothing.`;
  }
}

export function parseNote(raw: unknown, f: NoteFacts): string | null {
  if (!raw || typeof raw !== "object") return null;
  const text = (raw as Record<string, unknown>).text;
  if (typeof text !== "string" || text.trim().length < 20 || text.length > 400) return null;
  const allowed = new Set([String(f.fans), ...moneyForms(f.amountCents), ...moneyForms(f.ticketPriceCents), ...digitsIn(f.showName, f.label)]);
  return numbersOk(text, allowed) ? text.trim() : null;
}

export async function settlementNote(deps: AiDeps, f: NoteFacts): Promise<AiResult<string>> {
  const answer = await askModel(deps, MODELS.big, {
    messages: [
      { role: "system", content: NOTE_SYSTEM },
      { role: "user", content: JSON.stringify({ person: f.label, role: f.role, show: f.showName, outcome: f.outcome, theirAmount: formatUSD(f.amountCents), fans: f.fans, pricePerFan: formatUSD(f.ticketPriceCents) }) },
    ],
    max_tokens: 160,
    temperature: 0.3,
    response_format: { type: "json_schema", json_schema: NOTE_SCHEMA },
  });
  if (answer.ok) {
    const value = parseNote(answer.value, f);
    if (value) return { value, source: "model" };
  }
  return { value: templateNote(f), source: fallbackSource(answer) };
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/agent`
Expected: PASS.

- [ ] **Step 8: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add src/agent tests/agent
git commit -m "feat(agent): Workers AI port with daily neuron budget, rate limits and template fallbacks

Model ids checked against the Workers AI catalogue on <YYYY-MM-DD>: <result>.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(Replace the two `<…>` with the date and the catalogue result before committing.)

---
### Task 6: API contract and campaign service core (sign, orders, authorize with browser-id validation, views)

**Files:**
- Create: `src/worker/api-types.ts`, `src/agent/errors.ts`, `src/agent/draft.ts`, `src/agent/views.ts`, `src/agent/service.ts`, `src/agent/dispatch.ts`
- Create: `tests/agent/harness.ts`, `tests/agent/service-core.test.ts`, `tests/agent/draft.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 (`Store`, `commit`, `logStep`, `queueVoid`, `ExecDeps`, `PayPalPort`, `Projection`, `OrderView`, `PledgeStatus`, `PayoutItemStatus`, `PAYOUT_FAILED`, `fanName`, `sawCounts`, `holdDescription`, ids helpers, `MAX_ORDERS_PER_SHOW`, `AiDeps`, `DraftSuggestion`, `templateDraft`); Plan 1 `buildMandate`, `signMandate`, `MandateDraftError`, `validateDraft`, `thresholdPledges`, `DEFAULT_FEE_BUFFER_BPS`, `reduce`, `IllegalTransition`, `fansCommitted`, `RULES`; Task 1 `assertPayPalId`, `requestIds`, `payoutItemId`, `PayPalError`.
- Produces:
  - `src/worker/api-types.ts` (Plan 5 imports this; types only): `ErrorCode`, `ApiError`, `PartyInput`, `DraftFields`, `CreateShowRequest`, `CreateShowResponse`, `SignRequest`, `SignResponse`, `StatusWords`, `BulbStatus`, `PublicParty`, `PublicShow`, `CreateOrderRequest`, `CreateOrderResponse`, `AuthorizeResponse`, `LedgerStatus`, `LedgerRowDto`, `AgentLogDto`, `ProposalDto`, `ManageParty`, `NoteDto`, `ManageView`, `ApproveRequest`, `ApproveResponse`, `CallOffResponse`, `DemoResponse`, `DemoFansRequest`, `DemoFansResponse`, `DemoFastForwardResponse`, `MANAGE_KEY_HEADER = "x-manage-key"`
  - `class ServiceError extends Error { status: number; code: ErrorCode; problems?: string[] }`
  - `toMandateDraft(showId: string, f: DraftFields, launchedAt: string): MandateDraft`, `draftFields(s: DraftSuggestion, req: CreateShowRequest, now: number): DraftFields`, `previewDraft(showId: string, f: DraftFields, now: number): { threshold: number | null; problems: string[] }`
  - `statusWords(s)`, `publicShow(p, m, mandateHash, o)`, `ledgerRows(events, p, showId)`, `logRows(entries)`, `proposalRows(p)`, `manageParties(p, showId)`
  - `interface ServiceDeps { store: Store; paypal: PayPalPort; clock: Clock; ai: AiDeps; random: Random; paypalClientId: string; card: TestCard }`
  - `class CampaignService { ensureSchema(); exists(); clockOffset(); now(); showId(); kind(); exec(): ExecDeps; project(); init({ showId, signTokenHash }); sign(req): Promise<SignResponse>; publicView(p?): PublicShow; checkKey(key: string | null): Promise<void>; createOrder(req): Promise<CreateOrderResponse>; authorize(orderId: string): Promise<AuthorizeResponse>; manageView(): ManageView; applyDeadline(): Projection }`
  - `type CampaignOp` (`init`, `sign`, `public`, `order`, `authorize`, `manage`), `type CampaignReply = { ok: true; data: unknown } | { ok: false; status: number; error: ApiError["error"] }`, `dispatch(service: CampaignService, op: CampaignOp): Promise<CampaignReply>`
  - Tests: `makeService(opts?)`, `signedService(opts?)`, `pledge(svc, initials?)`, `DRAFT`, `SIGN_TOKEN` (`tests/agent/harness.ts`)

**Rules this task makes testable:**
1. Browser ids are never trusted: `authorize` only accepts an order id this show created (`order_created` in the ledger), validated with `assertPayPalId` first; an unknown id is 404 with no PayPal call.
2. The hold PayPal returns must match: same order, status `CREATED`, amount == the order's amount == the ticket price, and `custom_id` (when present) == `<show>:<pledge>`. Otherwise the pledge is rejected and a CREATED/PENDING hold is queued to be voided.
3. `createCardHold`/`authorizeOrder` DENIED holds are never counted.
4. A hold that lands after pledging closed becomes `late_hold` and is voided (Plan 1 Task 6 requirement).
5. `deadline_reached(now)` is applied before every order, authorize and manage read.
6. The manage key is a random secret returned once; only its SHA-256 hash is stored; signing needs the one-time sign token.
7. The public view never contains a PayPal email.

- [ ] **Step 1: Write the API contract `src/worker/api-types.ts`**

```ts
// Request/response types for the Tip the Room API. Plan 5's pages import this file: keep it types-only.
import type { CampaignState } from "../core/campaign";
import type { Cents } from "../core/money";
import type { RuleId } from "../core/rules";
import type { Role } from "../core/split";
import type { AiSource, ProposalOptionId } from "../agent/events";

export const MANAGE_KEY_HEADER = "x-manage-key";

export type ErrorCode = "bad_request" | "not_found" | "forbidden" | "conflict" | "invalid" | "rate_limited" | "paypal_error" | "too_large" | "unavailable" | "internal";

/** Every error body. `message` is plain English and safe to show. */
export interface ApiError {
  error: { code: ErrorCode; message: string; problems?: string[]; retryAfterSec?: number };
}

export interface PartyInput {
  role: Role;
  label: string;
  paypalEmail: string;
  /** Room, opener, host: what they get, in cents. */
  fixedCents?: Cents;
  /** Artist: the least they must get, in cents. */
  minimumCents?: Cents;
}

/** The editable draft the Start page shows. The server sets showId and launchedAt when signing. */
export interface DraftFields {
  showName: string;
  roomName: string;
  /** YYYY-MM-DD. */
  showDate: string;
  ticketPriceCents: Cents;
  feeBufferBps: number;
  /** ISO timestamp with Z or an offset. */
  deadline: string;
  timeZone: string;
  parties: PartyInput[];
}

export interface CreateShowRequest {
  sentence: string;
  deadline?: string;
  timeZone?: string;
  emails?: Partial<Record<Role, string>>;
}

export interface CreateShowResponse {
  showId: string;
  /** One-time secret needed to sign this draft. Keep it in the browser; it is not stored in plain form. */
  signToken: string;
  draft: DraftFields;
  /** Fan target computed by code (null when the price is missing). */
  threshold: number | null;
  problems: string[];
  source: AiSource;
}

export interface SignRequest {
  signToken: string;
  draft: DraftFields;
}

export interface SignResponse {
  showId: string;
  /** Returned ONCE. Only its SHA-256 hash is stored. Send it as the x-manage-key header. */
  manageKey: string;
  mandateHash: string;
  threshold: number;
  deadline: string;
  sharePath: string;
  managePath: string;
  show: PublicShow;
}

export type StatusWords = "Draft" | "Waiting for fans" | "It's on!" | "Paying everyone" | "Everyone's paid" | "Called off · nobody paid" | "Called off · refunding";
export type BulbStatus = "held" | "charged" | "released" | "refunded" | "failed";

export interface PublicParty {
  role: Role;
  label: string;
  fixedCents: Cents | null;
  minimumCents: Cents | null;
}

/** Everything the pledge page needs. Never contains a PayPal email. */
export interface PublicShow {
  showId: string;
  demo: boolean;
  state: CampaignState;
  status: StatusWords;
  showName: string;
  roomName: string;
  showDate: string;
  timeZone: string;
  ticketPriceCents: Cents;
  threshold: number;
  deadline: string;
  launchedAt: string;
  fans: { committed: number; held: number; charged: number; released: number; refunded: number; failed: number; more: number };
  money: { heldCents: Cents; chargedCents: Cents };
  /** One per pledge, in arrival order (bulb slots). */
  bulbs: { initials: string; status: BulbStatus }[];
  split: PublicParty[];
  mandateHash: string;
  /** For the PayPal JS SDK script tag (public value). */
  paypalClientId: string;
}

export interface CreateOrderRequest {
  /** 1 to 3 letters. */
  initials: string;
}

export interface CreateOrderResponse {
  orderId: string;
  pledgeId: string;
  amountCents: Cents;
}

export interface AuthorizeResponse {
  pledgeId: string;
  status: "held";
  /** True once the show has reached its target (this pledge may have tipped it). */
  tipped: boolean;
  show: PublicShow;
}

export type LedgerStatus = "On hold" | "Charged" | "Paid" | "Cancelled" | "Refunded" | "Failed" | "Pending" | "Info";

export interface LedgerRowDto {
  seq: number;
  at: number;
  what: string;
  who: string;
  amountCents: Cents | null;
  /** PayPal id (small print "PayPal ref" column). */
  ref: string | null;
  status: LedgerStatus;
}

export interface AgentLogDto {
  seq: number;
  at: number;
  saw: string;
  did: string;
  rule: RuleId | null;
  ruleTitle: string | null;
  requestId: string | null;
  resultId: string | null;
  source: AiSource | "code";
}

export interface ProposalDto {
  proposalId: string;
  explanation: string;
  recommend: ProposalOptionId | "wait";
  source: AiSource;
  options: { id: ProposalOptionId; label: string }[];
  approved: ProposalOptionId | null;
  madeAt: number;
}

export interface ManageParty extends PublicParty {
  paypalEmail: string;
  payoutCents: Cents | null;
  payoutStatus: "planned" | "paid" | "pending" | "failed" | "none";
}

export interface NoteDto {
  role: Role;
  label: string;
  text: string;
  source: AiSource;
}

/** The artist's show page. Ledger and log are newest first. */
export interface ManageView {
  show: PublicShow;
  ledger: LedgerRowDto[];
  log: AgentLogDto[];
  proposals: ProposalDto[];
  parties: ManageParty[];
  notes: NoteDto[];
  /** Plain-English problems that need the artist (failed or blocked steps). */
  attention: string[];
  collectedNetCents: Cents;
}

export interface ApproveRequest {
  option: ProposalOptionId;
}

export interface ApproveResponse {
  proposalId: string;
  option: ProposalOptionId;
  rule: RuleId;
  show: PublicShow;
}

export interface CallOffResponse {
  show: PublicShow;
}

export interface DemoResponse {
  demoId: string;
  /** Returned once; works as the x-manage-key for both demo shows and the demo controls. */
  demoKey: string;
  /** [the show that tips, the show that misses]. */
  shows: [PublicShow, PublicShow];
}

export interface DemoFansRequest {
  show: "a" | "b";
  count: number;
}

export interface DemoFansResponse {
  queued: number;
  show: PublicShow;
}

export interface DemoFastForwardResponse {
  shows: [PublicShow, PublicShow];
}
```

- [ ] **Step 2: Write `src/agent/errors.ts` and `src/agent/draft.ts`**

`src/agent/errors.ts`:

```ts
import type { ErrorCode } from "../worker/api-types";

/** A refusal with an HTTP status and a plain-English message that is safe to show. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly problems?: string[],
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
```

`src/agent/draft.ts`:

```ts
import { DAY_MS } from "../core/holds";
import { validateDraft, type MandateDraft } from "../core/mandate";
import type { Party, Role } from "../core/split";
import { DEFAULT_FEE_BUFFER_BPS, thresholdPledges } from "../core/threshold";
import type { CreateShowRequest, DraftFields, PartyInput } from "../worker/api-types";
import type { DraftSuggestion } from "./ai-jobs";
import { ServiceError } from "./errors";

const ROLES: readonly Role[] = ["room", "opener", "host", "artist"];
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isCents = (v: unknown): v is number | undefined => v === undefined || (typeof v === "number" && Number.isFinite(v));

/** Shape-checks the browser's draft and maps it onto Plan 1's MandateDraft. Semantic checks stay in validateDraft. */
export function toMandateDraft(showId: string, f: DraftFields, launchedAt: string): MandateDraft {
  const bad = (what: string) => new ServiceError(400, "bad_request", `The draft's ${what} is missing or the wrong shape.`);
  if (!f || typeof f !== "object") throw bad("fields");
  if (!isText(f.showName, 80)) throw bad("show name");
  if (!isText(f.roomName, 80)) throw bad("room name");
  if (!isText(f.showDate, 10)) throw bad("show date");
  if (typeof f.ticketPriceCents !== "number") throw bad("pledge amount");
  if (typeof f.feeBufferBps !== "number") throw bad("fee buffer");
  if (!isText(f.deadline, 40)) throw bad("deadline");
  if (f.timeZone !== undefined && !isText(f.timeZone, 64)) throw bad("time zone");
  if (!Array.isArray(f.parties) || f.parties.length < 1 || f.parties.length > 4) throw bad("payees");
  const parties: Party[] = f.parties.map((x: PartyInput) => {
    if (!x || typeof x !== "object" || !ROLES.includes(x.role) || !isText(x.label, 60) || !isText(x.paypalEmail, 254) || !isCents(x.fixedCents) || !isCents(x.minimumCents)) throw bad("payees");
    const party: Party = { role: x.role, label: x.label, paypalEmail: x.paypalEmail.trim() };
    if (x.fixedCents !== undefined) party.fixed = x.fixedCents;
    if (x.minimumCents !== undefined) party.minimum = x.minimumCents;
    return party;
  });
  return { showId, showName: f.showName, roomName: f.roomName, showDate: f.showDate, ticketPrice: f.ticketPriceCents, feeBufferBps: f.feeBufferBps, parties, launchedAt, deadline: f.deadline, timeZone: f.timeZone || "UTC" };
}

/** The editable draft from the model's (or template's) suggestion plus the artist's own fields. */
export function draftFields(s: DraftSuggestion, req: CreateShowRequest, now: number): DraftFields {
  const deadline = typeof req.deadline === "string" && req.deadline.length <= 40 && !Number.isNaN(Date.parse(req.deadline)) ? req.deadline : new Date(now + 7 * DAY_MS).toISOString();
  const email = (role: Role) => {
    const v = req.emails?.[role];
    return typeof v === "string" ? v.trim().slice(0, 254) : "";
  };
  const parties: PartyInput[] = [{ role: "room", label: (s.roomName || "The room").slice(0, 60), paypalEmail: email("room"), fixedCents: s.room }];
  if (s.opener > 0) parties.push({ role: "opener", label: "Opener", paypalEmail: email("opener"), fixedCents: s.opener });
  if (s.host > 0) parties.push({ role: "host", label: "Host", paypalEmail: email("host"), fixedCents: s.host });
  parties.push({ role: "artist", label: "You", paypalEmail: email("artist"), minimumCents: s.artistMinimum });
  return {
    showName: s.showName,
    roomName: s.roomName,
    showDate: s.showDate ?? new Date(Date.parse(deadline)).toISOString().slice(0, 10),
    ticketPriceCents: s.ticketPrice ?? 0,
    feeBufferBps: DEFAULT_FEE_BUFFER_BPS,
    deadline,
    timeZone: typeof req.timeZone === "string" && req.timeZone.length > 0 && req.timeZone.length <= 64 ? req.timeZone : "UTC",
    parties,
  };
}

/** Code computes the fan target (spec 3.1), even before every email is filled in. */
export function previewDraft(showId: string, f: DraftFields, now: number): { threshold: number | null; problems: string[] } {
  const problems = validateDraft(toMandateDraft(showId, f, new Date(now).toISOString()));
  let threshold: number | null = null;
  try {
    threshold = thresholdPledges({
      fixedCosts: f.parties.filter((x) => x.role !== "artist").map((x) => x.fixedCents ?? 0),
      artistMinimum: f.parties.find((x) => x.role === "artist")?.minimumCents ?? 0,
      ticketPrice: f.ticketPriceCents,
      feeBufferBps: f.feeBufferBps,
    });
  } catch {
    threshold = null;
  }
  return { threshold, problems };
}
```

- [ ] **Step 3: Write `src/agent/views.ts`**

```ts
import { fansCommitted, type CampaignState } from "../core/campaign";
import type { Mandate } from "../core/mandate";
import { RULES } from "../core/rules";
import { payoutItemId } from "../paypal/payouts";
import type { AgentLogDto, BulbStatus, LedgerRowDto, LedgerStatus, ManageParty, ProposalDto, PublicShow, StatusWords } from "../worker/api-types";
import type { PayoutItemStatus } from "./events";
import { PAYOUT_FAILED } from "./payout-runner";
import type { PledgeStatus, PledgeView, Projection } from "./project";
import type { LoggedEntry, StoredEvent } from "./store";
import { fanName } from "./words";

export function statusWords(s: CampaignState): StatusWords {
  switch (s) {
    case "draft":
      return "Draft";
    case "live":
      return "Waiting for fans";
    case "tipped":
      return "It's on!";
    case "paying_out":
      return "Paying everyone";
    case "settled":
      return "Everyone's paid";
    case "missed":
      return "Called off · nobody paid";
    case "cancelled":
      return "Called off · refunding";
  }
}

const BULB: Record<PledgeStatus, BulbStatus> = { held: "held", charged: "charged", capture_failed: "failed", released: "released", refunded: "refunded" };
const HOLD_ROW: Record<PledgeStatus, LedgerStatus> = { held: "On hold", charged: "Charged", capture_failed: "Failed", released: "Cancelled", refunded: "Refunded" };

export function publicShow(p: Projection, m: Mandate, mandateHash: string, o: { demo: boolean; paypalClientId: string }): PublicShow {
  const c = p.campaign;
  const committed = fansCommitted(c);
  const pledges = [...p.pledges.values()];
  return {
    showId: m.showId,
    demo: o.demo,
    state: c.state,
    status: statusWords(c.state),
    showName: m.showName,
    roomName: m.roomName,
    showDate: m.showDate,
    timeZone: m.timeZone ?? "UTC",
    ticketPriceCents: m.ticketPrice,
    threshold: c.threshold,
    deadline: new Date(c.deadline).toISOString(),
    launchedAt: m.launchedAt,
    fans: { committed, held: c.pledges.held, charged: c.pledges.charged, released: c.pledges.released, refunded: c.pledges.refunded, failed: c.pledges.failed, more: Math.max(0, c.threshold - committed) },
    money: {
      heldCents: pledges.filter((x) => x.status === "held").reduce((s, x) => s + x.amountCents, 0),
      chargedCents: pledges.filter((x) => x.status === "charged").reduce((s, x) => s + (x.grossCents ?? x.amountCents), 0),
    },
    bulbs: pledges.map((x) => ({ initials: x.initials, status: BULB[x.status] })),
    split: m.parties.map((x) => ({ role: x.role, label: x.label, fixedCents: x.fixed ?? null, minimumCents: x.minimum ?? null })),
    mandateHash,
    paypalClientId: o.paypalClientId,
  };
}

function itemStatus(item: PayoutItemStatus | undefined): LedgerStatus {
  if (!item) return "Pending";
  if (item.status === "SUCCESS") return "Paid";
  return PAYOUT_FAILED.has(item.status) ? "Failed" : "Pending";
}

/** The settlement sheet, newest first. Every row is plain words plus the PayPal ref. */
export function ledgerRows(events: StoredEvent[], p: Projection, showId: string): LedgerRowDto[] {
  const rows: LedgerRowDto[] = [];
  const byAuth = (auth: string): PledgeView | undefined => {
    const id = p.pledgeByAuth.get(auth);
    return id ? p.pledges.get(id) : undefined;
  };
  const byCapture = (captureId: string): PledgeView | undefined => {
    const id = p.pledgeByCapture.get(captureId);
    return id ? p.pledges.get(id) : undefined;
  };
  for (const s of events) {
    const e = s.event;
    const base = { seq: s.seq, at: s.at };
    switch (e.type) {
      case "pledge_held": {
        const pl = p.pledges.get(e.pledgeId);
        if (pl) rows.push({ ...base, what: e.simulated ? "Simulated fan held a spot" : "Fan held a spot", who: fanName(pl), amountCents: e.amountCents, ref: e.authorizationId, status: HOLD_ROW[pl.status] });
        break;
      }
      case "capture_ok": {
        const pl = byCapture(e.captureId);
        rows.push({ ...base, what: "Charged", who: pl ? fanName(pl) : "A fan", amountCents: e.grossCents, ref: e.captureId, status: pl?.status === "refunded" ? "Refunded" : "Charged" });
        break;
      }
      case "capture_failed": {
        const pl = byAuth(e.authorizationId);
        rows.push({ ...base, what: "Charge didn't go through · money never taken", who: pl ? fanName(pl) : "A fan", amountCents: null, ref: e.authorizationId, status: "Failed" });
        break;
      }
      case "void_ok": {
        const pl = byAuth(e.authorizationId);
        rows.push({ ...base, what: pl ? "Hold cancelled · nobody charged" : "Extra hold cancelled · nobody charged", who: pl ? fanName(pl) : "Not counted", amountCents: null, ref: e.authorizationId, status: "Cancelled" });
        break;
      }
      case "refund_ok": {
        const pl = byCapture(e.captureId);
        rows.push({ ...base, what: "Refunded", who: pl ? fanName(pl) : "A fan", amountCents: pl?.grossCents ?? null, ref: e.refundId, status: "Refunded" });
        break;
      }
      case "late_hold":
        rows.push({ ...base, what: "Hold arrived after pledging closed", who: "Not counted", amountCents: e.amountCents, ref: e.authorizationId, status: p.retired.get(e.authorizationId)?.voided ? "Cancelled" : "Pending" });
        break;
      case "pledge_rejected":
        rows.push({ ...base, what: "Hold refused", who: "Not counted", amountCents: null, ref: e.authorizationId, status: "Failed" });
        break;
      case "hold_replaced": {
        const pl = p.pledges.get(e.pledgeId);
        rows.push({ ...base, what: "Hold renewed before it expired", who: pl ? fanName(pl) : "A fan", amountCents: null, ref: e.authorizationId, status: "Info" });
        break;
      }
      case "payout_sent": {
        const payout = p.payouts.find((x) => x.senderBatchId === e.senderBatchId);
        if (e.lines.length === 0) {
          rows.push({ ...base, what: "Nothing to pay out", who: "Everyone", amountCents: 0, ref: null, status: "Info" });
          break;
        }
        for (const l of e.lines) {
          rows.push({ ...base, what: e.retry ? `Paid ${l.label} (second try)` : `Paid ${l.label}`, who: l.label, amountCents: l.amount, ref: payout?.batchId ?? e.senderBatchId, status: itemStatus(payout?.items[payoutItemId(showId, l.role, e.retry)]) });
        }
        break;
      }
      case "deadline_reached":
        rows.push({ ...base, what: "Deadline reached", who: "Everyone", amountCents: null, ref: null, status: "Info" });
        break;
      case "show_cancelled":
        rows.push({ ...base, what: "The artist called the show off", who: "Everyone", amountCents: null, ref: null, status: "Info" });
        break;
      case "deadline_extended":
        rows.push({ ...base, what: `Deadline moved to ${new Date(e.newDeadline).toUTCString()}`, who: "Everyone", amountCents: null, ref: null, status: "Info" });
        break;
      case "threshold_lowered":
        rows.push({ ...base, what: `Target lowered to ${e.newThreshold} fans`, who: "Everyone", amountCents: null, ref: null, status: "Info" });
        break;
      default:
        break;
    }
  }
  return rows.reverse();
}

export function logRows(entries: LoggedEntry[]): AgentLogDto[] {
  return entries.map((e) => ({ ...e, ruleTitle: e.rule ? RULES[e.rule].title : null })).reverse();
}

export function proposalRows(p: Projection): ProposalDto[] {
  return [...p.proposals.values()]
    .map((x) => ({ proposalId: x.proposalId, explanation: x.explanation, recommend: x.recommend, source: x.source, options: x.options.map((o) => ({ id: o.id, label: o.label })), approved: x.approved?.option ?? null, madeAt: x.madeAt }))
    .reverse();
}

export function manageParties(p: Projection, showId: string): ManageParty[] {
  const m = p.mandate;
  if (!m) return [];
  const first = p.payouts.find((x) => !x.retry);
  const retry = p.payouts.find((x) => x.retry);
  return m.parties.map((x) => {
    const line = first?.lines.find((l) => l.role === x.role);
    const payoutStatus = ((): ManageParty["payoutStatus"] => {
      if (!first) return "planned";
      if (!line) return "none";
      const s = retry?.items[payoutItemId(showId, x.role, true)]?.status ?? first.items[payoutItemId(showId, x.role)]?.status;
      if (s === "SUCCESS") return "paid";
      if (s && PAYOUT_FAILED.has(s)) return "failed";
      return "pending";
    })();
    return { role: x.role, label: x.label, fixedCents: x.fixed ?? null, minimumCents: x.minimum ?? null, paypalEmail: x.paypalEmail, payoutCents: line?.amount ?? null, payoutStatus };
  });
}
```

- [ ] **Step 4: Write `src/agent/service.ts`**

```ts
import { fansCommitted, IllegalTransition, reduce } from "../core/campaign";
import { buildMandate, MandateDraftError, signMandate, type Mandate } from "../core/mandate";
import { formatUSD } from "../core/money";
import { assertPayPalId } from "../paypal/amount";
import { PayPalError } from "../paypal/errors";
import { requestIds, type Hold, type TestCard } from "../paypal/payments";
import type { AuthorizeResponse, CreateOrderRequest, CreateOrderResponse, ManageView, PublicShow, SignRequest, SignResponse } from "../worker/api-types";
import type { AiDeps } from "./ai";
import { toMandateDraft } from "./draft";
import { ServiceError } from "./errors";
import { commit, logStep, queueVoid, type ExecDeps } from "./executor";
import { customIdFor, newId, newSecret, sameHex, sha256Hex, type Clock, type Random } from "./ids";
import type { PayPalPort } from "./paypal-port";
import { MAX_ORDERS_PER_SHOW } from "./policy";
import type { OrderView, Projection } from "./project";
import type { Store } from "./store";
import { ledgerRows, logRows, manageParties, proposalRows, publicShow } from "./views";
import { fanName, holdDescription, sawCounts } from "./words";

export interface ServiceDeps {
  store: Store;
  paypal: PayPalPort;
  /** Real time. A demo copy adds its stored clock offset on top. */
  clock: Clock;
  ai: AiDeps;
  random: Random;
  paypalClientId: string;
  card: TestCard;
}

type LogInput = Parameters<typeof logStep>[1];
const INITIALS = /^[A-Za-z]{1,3}$/;

/** Why PayPal's hold can't be counted for this order, or null when it matches exactly. */
function holdProblem(h: Hold, orderId: string, order: OrderView, m: Mandate): string | null {
  if (h.orderId !== orderId) return "PayPal answered for a different order";
  if (h.status !== "CREATED") return `PayPal's hold status was ${h.status}`;
  if (h.amountCents !== order.amountCents || h.amountCents !== m.ticketPrice) return `PayPal held ${formatUSD(h.amountCents)} instead of ${formatUSD(m.ticketPrice)}`;
  if (h.customId !== undefined && h.customId !== customIdFor(m.showId, order.pledgeId)) return "PayPal's hold belongs to a different pledge";
  return null;
}

/** One campaign. Every public method is safe to call again (deterministic keys, deadline applied first). */
export class CampaignService {
  constructor(private readonly deps: ServiceDeps) {}

  ensureSchema(): void {
    this.deps.store.migrate();
  }

  exists(): boolean {
    return this.deps.store.exists();
  }

  clockOffset(): number {
    const v = Number(this.deps.store.getMeta("clock_offset") ?? "0");
    return Number.isFinite(v) ? v : 0;
  }

  /** Campaign time. */
  now(): number {
    return this.deps.clock.now() + this.clockOffset();
  }

  showId(): string {
    const id = this.deps.store.getMeta("show_id");
    if (!id) throw new ServiceError(404, "not_found", "There's no show here.");
    return id;
  }

  kind(): "real" | "demo" {
    return this.deps.store.getMeta("kind") === "demo" ? "demo" : "real";
  }

  exec(): ExecDeps {
    return { store: this.deps.store, paypal: this.deps.paypal, clock: { now: () => this.now() }, showId: this.showId(), card: this.deps.card };
  }

  project(): Projection {
    return this.deps.store.projection();
  }

  private log(s: LogInput): void {
    logStep(this.exec(), s);
  }

  private requireMandate(p: Projection): Mandate {
    if (!p.mandate) throw new ServiceError(404, "not_found", "This show isn't live yet.");
    return p.mandate;
  }

  init(input: { showId: string; signTokenHash: string }): { showId: string } {
    const store = this.deps.store;
    if (store.getMeta("show_id")) throw new ServiceError(409, "conflict", "That show already exists.");
    store.transaction(() => {
      store.setMeta("show_id", input.showId);
      store.setMeta("kind", "real");
      store.setMeta("sign_token_hash", input.signTokenHash);
      store.setMeta("created_at", String(this.deps.clock.now()));
    });
    return { showId: input.showId };
  }

  async sign(req: SignRequest): Promise<SignResponse> {
    const store = this.deps.store;
    const showId = this.showId();
    const now = this.now();
    const at = new Date(now).toISOString();
    if (typeof req?.signToken !== "string" || req.signToken.length === 0 || req.signToken.length > 200) throw new ServiceError(403, "forbidden", "This sign link isn't valid.");
    const draft = toMandateDraft(showId, req.draft, at);
    let mandate: Mandate;
    try {
      mandate = buildMandate(draft);
    } catch (e) {
      if (e instanceof MandateDraftError) throw new ServiceError(422, "invalid", "Some details need fixing.", e.problems);
      throw e;
    }
    const [tokenHash, signed] = await Promise.all([sha256Hex(req.signToken), signMandate(mandate, at)]);
    const manageKey = newSecret(this.deps.random);
    const keyHash = await sha256Hex(manageKey);
    // No awaits from here on: the checks and the writes happen together, so two signs can't both win.
    if (this.project().mandate) throw new ServiceError(409, "conflict", "This show is already signed.");
    const stored = store.getMeta("sign_token_hash");
    if (!stored || !sameHex(tokenHash, stored)) throw new ServiceError(403, "forbidden", "This sign link isn't valid.");
    store.transaction(() => {
      store.setMeta("manage_key_hash", keyHash);
      store.deleteMeta("sign_token_hash");
    });
    const { projection } = commit(store, now, { type: "mandate_signed", mandate: signed.mandate, hash: signed.hash, signedAt: signed.signedAt });
    this.log({ saw: "The artist read the money rules and held to sign.", did: `Opened pledging: ${mandate.threshold} fans by ${new Date(Date.parse(mandate.deadline)).toUTCString()}.`, rule: null, resultId: signed.hash.slice(0, 12) });
    return { showId, manageKey, mandateHash: signed.hash, threshold: mandate.threshold, deadline: mandate.deadline, sharePath: `/s/${showId}`, managePath: `/s/${showId}/manage`, show: this.publicView(projection) };
  }

  publicView(p: Projection = this.project()): PublicShow {
    if (!p.mandate || !p.mandateHash) throw new ServiceError(404, "not_found", "This show isn't live yet.");
    return publicShow(p, p.mandate, p.mandateHash, { demo: this.kind() === "demo", paypalClientId: this.deps.paypalClientId });
  }

  async checkKey(key: string | null): Promise<void> {
    const hash = this.deps.store.getMeta("manage_key_hash");
    const ok = !!hash && typeof key === "string" && key.length >= 20 && key.length <= 200 && sameHex(await sha256Hex(key), hash);
    if (!ok) throw new ServiceError(403, "forbidden", "That manage link isn't valid.");
  }

  /** Applies deadline_reached(now) when it changes the state. Called before anything is decided. */
  applyDeadline(): Projection {
    const p = this.project();
    if (!p.mandate) return p;
    const now = this.now();
    const before = p.campaign.state;
    const deadline = p.campaign.deadline;
    if (reduce(p.campaign, { type: "deadline_reached", now }).campaign.state === before) return p;
    const r = commit(this.deps.store, now, { type: "deadline_reached", now, deadline });
    const after = r.projection.campaign;
    if (after.state === "missed") {
      this.log({ saw: sawCounts(r.projection), did: `The deadline passed at ${fansCommitted(after)} of ${after.threshold} fans. Cancelling every hold; nobody pays.`, rule: "rule-3-void-on-miss" });
    } else if (after.state === "paying_out") {
      this.log({ saw: sawCounts(r.projection), did: "The deadline passed. Payouts go out once every charge has settled.", rule: "rule-4-pay-the-split" });
    }
    return r.projection;
  }

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResponse> {
    const raw = req?.initials;
    if (typeof raw !== "string" || !INITIALS.test(raw.trim())) throw new ServiceError(422, "invalid", "Initials must be 1 to 3 letters.");
    const initials = raw.trim().toUpperCase();
    const p = this.applyDeadline();
    const m = this.requireMandate(p);
    if (p.campaign.state !== "live" && p.campaign.state !== "tipped") throw new ServiceError(409, "conflict", "Pledging has closed for this show.");
    if (p.orders.size >= MAX_ORDERS_PER_SHOW) throw new ServiceError(409, "conflict", "This show has taken as many pledges as it can.");
    const pledgeId = newId("p", this.deps.random);
    let orderId: string;
    try {
      ({ orderId } = await this.deps.paypal.createPledgeOrder({ showId: m.showId, pledgeId, amountCents: m.ticketPrice, description: holdDescription(m) }));
    } catch (e) {
      if (e instanceof PayPalError) throw new ServiceError(502, "paypal_error", "PayPal is having trouble. Nothing was held or charged; please try again.");
      throw e;
    }
    commit(this.deps.store, this.now(), { type: "order_created", orderId, pledgeId, amountCents: m.ticketPrice, initials });
    return { orderId, pledgeId, amountCents: m.ticketPrice };
  }

  /** The browser says "PayPal approved order X". We only act on an order this show created. */
  async authorize(orderIdRaw: string): Promise<AuthorizeResponse> {
    let orderId: string;
    try {
      orderId = assertPayPalId(orderIdRaw, "order id");
    } catch {
      throw new ServiceError(400, "bad_request", "That isn't a PayPal order id.");
    }
    const store = this.deps.store;
    let p = this.applyDeadline();
    const m = this.requireMandate(p);
    const order = p.orders.get(orderId);
    if (!order) throw new ServiceError(404, "not_found", "We didn't create that order for this show.");
    if (order.resolved) {
      const existing = p.pledges.get(order.pledgeId);
      if (!existing) throw new ServiceError(409, "conflict", "This order was already used and didn't become a pledge.");
      return { pledgeId: existing.pledgeId, status: "held", tipped: p.campaign.state !== "live", show: this.publicView(p) };
    }
    if (p.campaign.state !== "live" && p.campaign.state !== "tipped") throw new ServiceError(409, "conflict", "Pledging has closed for this show. Nothing was held or charged.");
    let hold: Hold;
    try {
      hold = await this.deps.paypal.authorizeOrder(orderId);
    } catch (e) {
      if (e instanceof PayPalError && !e.retryable) throw new ServiceError(409, "conflict", "PayPal didn't place the hold. Nothing was charged.");
      throw new ServiceError(502, "paypal_error", "PayPal is having trouble. Nothing was charged; please try again.");
    }
    p = this.applyDeadline(); // the deadline may have passed while PayPal answered
    const now = this.now();
    const problem = holdProblem(hold, orderId, order, m);
    if (problem) {
      commit(store, now, { type: "pledge_rejected", pledgeId: order.pledgeId, orderId, authorizationId: hold.authorizationId || null, reason: problem });
      if (hold.authorizationId && (hold.status === "CREATED" || hold.status === "PENDING")) queueVoid(store, hold.authorizationId, now);
      this.log({ saw: `PayPal answered for order ${orderId}: ${problem}.`, did: "Refused this hold and queued it to be cancelled. Nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: hold.authorizationId || null });
      throw new ServiceError(422, "invalid", "PayPal didn't hold the right amount, so that hold is being cancelled. Nothing was charged.");
    }
    const wasLive = p.campaign.state === "live";
    try {
      p = commit(store, now, { type: "pledge_held", pledgeId: order.pledgeId, orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents, authorizedAt: hold.createdAt, expiresAt: hold.expiresAt, initials: order.initials, simulated: false }).projection;
    } catch (e) {
      if (!(e instanceof IllegalTransition)) throw e;
      commit(store, now, { type: "late_hold", pledgeId: order.pledgeId, orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents });
      queueVoid(store, hold.authorizationId, now);
      this.log({ saw: sawCounts(this.project()), did: "A hold arrived after pledging closed. Cancelling it; nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: hold.authorizationId });
      throw new ServiceError(409, "conflict", "Pledging closed before your hold arrived, so it is being cancelled. Nothing was charged.");
    }
    const pledge = p.pledges.get(order.pledgeId)!;
    this.log({ saw: sawCounts(p), did: `${fanName(pledge)} held a spot. PayPal is holding ${formatUSD(hold.amountCents)}; nobody is charged yet.`, rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: hold.authorizationId });
    if (wasLive && p.campaign.state === "tipped") this.log({ saw: sawCounts(p), did: "The show reached its target. Charging every hold now.", rule: "rule-2-capture-at-tip" });
    return { pledgeId: pledge.pledgeId, status: "held", tipped: p.campaign.state !== "live", show: this.publicView(p) };
  }

  manageView(): ManageView {
    const p = this.applyDeadline();
    const showId = this.showId();
    return {
      show: this.publicView(p),
      ledger: ledgerRows(this.deps.store.events(), p, showId),
      log: logRows(this.deps.store.logs()),
      proposals: proposalRows(p),
      parties: manageParties(p, showId),
      notes: (p.notes ?? []).map((n) => ({ role: n.role, label: n.label, text: n.text, source: n.source })),
      attention: this.deps.store
        .jobs()
        .filter((j) => j.status === "failed" || j.status === "blocked")
        .map((j) => j.note),
      collectedNetCents: p.collectedNet,
    };
  }
}
```

- [ ] **Step 5: Write `src/agent/dispatch.ts`**

```ts
import { PayPalError } from "../paypal/errors";
import type { ApiError, CreateOrderRequest, SignRequest } from "../worker/api-types";
import { ServiceError } from "./errors";
import type { CampaignService } from "./service";

/** The JSON messages the Worker sends to a campaign's Durable Object. */
export type CampaignOp =
  | { op: "init"; showId: string; signTokenHash: string }
  | { op: "sign"; body: SignRequest }
  | { op: "public" }
  | { op: "order"; body: CreateOrderRequest }
  | { op: "authorize"; orderId: string }
  | { op: "manage"; manageKey: string | null };

export type CampaignReply = { ok: true; data: unknown } | { ok: false; status: number; error: ApiError["error"] };

/** Ops that create a show. Every other op on an empty store is a 404 and creates nothing. */
const CREATES: ReadonlySet<string> = new Set(["init"]);

export async function dispatch(service: CampaignService, op: CampaignOp): Promise<CampaignReply> {
  try {
    if (CREATES.has(op.op)) service.ensureSchema();
    else if (!service.exists()) return { ok: false, status: 404, error: { code: "not_found", message: "There's no show here." } };
    return { ok: true, data: await run(service, op) };
  } catch (e) {
    return toReply(e);
  }
}

async function run(service: CampaignService, op: CampaignOp): Promise<unknown> {
  switch (op.op) {
    case "init":
      return service.init(op);
    case "sign":
      return service.sign(op.body);
    case "public":
      return service.publicView(service.applyDeadline());
    case "order":
      return service.createOrder(op.body);
    case "authorize":
      return service.authorize(op.orderId);
    case "manage":
      await service.checkKey(op.manageKey);
      return service.manageView();
  }
}

function toReply(e: unknown): CampaignReply {
  if (e instanceof ServiceError) return { ok: false, status: e.status, error: { code: e.code, message: e.message, ...(e.problems ? { problems: e.problems } : {}) } };
  if (e instanceof PayPalError) return { ok: false, status: 502, error: { code: "paypal_error", message: "PayPal didn't answer as expected. Nothing was charged." } };
  return { ok: false, status: 500, error: { code: "internal", message: "Something went wrong on our side." } };
}
```

- [ ] **Step 6: Write the test harness**

`tests/agent/harness.ts`:

```ts
import type { AiDeps } from "../../src/agent/ai";
import { sha256Hex } from "../../src/agent/ids";
import { SIM_CARD } from "../../src/agent/paypal-port";
import { CampaignService } from "../../src/agent/service";
import { Store } from "../../src/agent/store";
import type { AuthorizeResponse, DraftFields } from "../../src/worker/api-types";
import { FakePayPal } from "./fake-paypal";
import { LAUNCH, seqRandom, SHOW, TestClock } from "./fixtures";
import { memoryDb } from "./sqlite";

export const SIGN_TOKEN = "sign-token-for-tests-0123456789";

/** Same rules as fixtures.testMandate(): target 3 fans. */
export const DRAFT: DraftFields = {
  showName: "Acoustic Set",
  roomName: "Lucky's Café",
  showDate: "2026-11-10",
  ticketPriceCents: 1500,
  feeBufferBps: 500,
  deadline: "2026-11-08T00:00:00Z",
  timeZone: "UTC",
  parties: [
    { role: "room", label: "Lucky's Café", paypalEmail: "room@example.com", fixedCents: 2000 },
    { role: "artist", label: "Maya", paypalEmail: "maya@example.com", minimumCents: 2000 },
  ],
};

export interface HarnessOptions {
  ai?: AiDeps;
  clock?: TestClock;
  paypal?: FakePayPal;
  store?: Store;
}

export function makeService(opts: HarnessOptions = {}) {
  const store = opts.store ?? new Store(memoryDb());
  const clock = opts.clock ?? new TestClock(LAUNCH);
  const paypal = opts.paypal ?? new FakePayPal(clock);
  const svc = new CampaignService({ store, paypal, clock, ai: opts.ai ?? { ai: null, budget: { tryReserve: async () => true } }, random: seqRandom(), paypalClientId: "test-client-id", card: SIM_CARD });
  return { store, clock, paypal, svc };
}

export async function signedService(opts: HarnessOptions = {}) {
  const h = makeService(opts);
  h.svc.ensureSchema();
  h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
  const signed = await h.svc.sign({ signToken: SIGN_TOKEN, draft: DRAFT });
  return { ...h, manageKey: signed.manageKey };
}

export async function pledge(svc: CampaignService, initials = "AB"): Promise<AuthorizeResponse> {
  const order = await svc.createOrder({ initials });
  return svc.authorize(order.orderId);
}
```

- [ ] **Step 7: Write the failing tests**

`tests/agent/draft.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/holds";
import { templateDraft } from "../../src/agent/ai-jobs";
import { draftFields, previewDraft, toMandateDraft } from "../../src/agent/draft";
import { ServiceError } from "../../src/agent/errors";
import type { DraftFields } from "../../src/worker/api-types";
import { SHOW } from "./fixtures";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const suggestion = templateDraft("Acoustic set at Lucky's Café, Nov 20, $15 tickets, café wants $100, I need $200", NOW);

describe("draft fields", () => {
  it("builds the editable draft with the artist's emails and a 7-day default deadline", () => {
    expect(draftFields(suggestion, { sentence: "x", emails: { room: " room@example.com ", artist: "maya@example.com" } }, NOW)).toEqual({
      showName: "Acoustic set",
      roomName: "Lucky's Café",
      showDate: "2026-11-20",
      ticketPriceCents: 1500,
      feeBufferBps: 500,
      deadline: new Date(NOW + 7 * DAY_MS).toISOString(),
      timeZone: "UTC",
      parties: [
        { role: "room", label: "Lucky's Café", paypalEmail: "room@example.com", fixedCents: 10000 },
        { role: "artist", label: "You", paypalEmail: "maya@example.com", minimumCents: 20000 },
      ],
    });
  });

  it("previews the fan target in code, even with emails missing", () => {
    const withEmails = draftFields(suggestion, { sentence: "x", emails: { room: "room@example.com", artist: "maya@example.com" } }, NOW);
    expect(previewDraft(SHOW, withEmails, NOW)).toEqual({ threshold: 21, problems: [] });
    const noEmails = draftFields(suggestion, { sentence: "x" }, NOW);
    const preview = previewDraft(SHOW, noEmails, NOW);
    expect(preview.threshold).toBe(21);
    expect(preview.problems).toContain("You needs a valid PayPal email.");
  });

  it("refuses a malformed draft with a 400", () => {
    const bad = { ...draftFields(suggestion, { sentence: "x" }, NOW), parties: "nope" } as unknown as DraftFields;
    expect(() => toMandateDraft(SHOW, bad, new Date(NOW).toISOString())).toThrow(ServiceError);
  });
});
```

`tests/agent/service-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RULES } from "../../src/core/rules";
import { dispatch } from "../../src/agent/dispatch";
import { sha256Hex } from "../../src/agent/ids";
import { PayPalError } from "../../src/paypal/errors";
import { DRAFT, makeService, pledge, SIGN_TOKEN, signedService } from "./harness";
import { DEADLINE, SHOW } from "./fixtures";

describe("init and sign", () => {
  it("signs with the one-time token, returns the manage key once and stores only its hash", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    const r = await h.svc.sign({ signToken: SIGN_TOKEN, draft: DRAFT });
    expect(r.threshold).toBe(3);
    expect(r.manageKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.store.getMeta("manage_key_hash")).toBe(await sha256Hex(r.manageKey));
    expect(h.store.getMeta("sign_token_hash")).toBeUndefined();
    expect(JSON.stringify(h.store.events())).not.toContain(r.manageKey);
    expect(r.show.state).toBe("live");
    expect(r.sharePath).toBe(`/s/${SHOW}`);
    await expect(h.svc.sign({ signToken: SIGN_TOKEN, draft: DRAFT })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a wrong sign token", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    await expect(h.svc.sign({ signToken: "not-the-token", draft: DRAFT })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(h.svc.project().mandate).toBeNull();
  });

  it("returns plain-English problems for a draft that breaks the rules", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    const err = await h.svc.sign({ signToken: SIGN_TOKEN, draft: { ...DRAFT, deadline: "2026-12-01T00:00:00Z" } }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: "invalid" });
    expect(err.problems).toContain("The pledge window can be at most 21 days.");
  });

  it("refuses to create the same show twice", async () => {
    const h = await signedService();
    expect(() => h.svc.init({ showId: SHOW, signTokenHash: "x" })).toThrow(/already exists/);
  });
});

describe("public view", () => {
  it("shows the pledge page's numbers and never a PayPal email", async () => {
    const h = await signedService();
    const v = h.svc.publicView();
    expect(JSON.stringify(v)).not.toContain("@");
    expect(v).toMatchObject({ threshold: 3, status: "Waiting for fans", fans: { committed: 0, more: 3 }, ticketPriceCents: 1500, paypalClientId: "test-client-id", demo: false });
  });
});

describe("orders and authorize", () => {
  it("creates a PayPal order for a pledge with plain initials", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: " jr " });
    expect(o.amountCents).toBe(1500);
    expect(h.paypal.calls[0]).toEqual({ op: "createPledgeOrder", args: [{ showId: SHOW, pledgeId: o.pledgeId, amountCents: 1500, description: "Hold for Acoustic Set at Lucky's Café" }] });
    expect(h.svc.project().orders.get(o.orderId)).toMatchObject({ initials: "JR", resolved: false });
  });

  it("refuses initials that aren't 1 to 3 letters, before calling PayPal", async () => {
    const h = await signedService();
    for (const bad of ["J1", "", "ABCD", 5]) await expect(h.svc.createOrder({ initials: bad as string })).rejects.toMatchObject({ status: 422 });
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("holds the pledge once PayPal authorizes the order we created", async () => {
    const h = await signedService();
    const r = await pledge(h.svc);
    expect(r).toMatchObject({ status: "held", tipped: false, show: { fans: { committed: 1, held: 1, more: 2 }, bulbs: [{ initials: "AB", status: "held" }] } });
    expect(h.store.logs().at(-1)).toMatchObject({ rule: "rule-1-hold-only", requestId: `authorize:O-${r.pledgeId}`, resultId: `A-${r.pledgeId}` });
  });

  it("refuses an order id this show didn't create, and never calls PayPal", async () => {
    const h = await signedService();
    await expect(h.svc.authorize("5O190127TN364715T")).rejects.toMatchObject({ status: 404 });
    expect(h.paypal.count("authorizeOrder")).toBe(0);
  });

  it("refuses a malformed order id before anything else", async () => {
    const h = await signedService();
    await expect(h.svc.authorize("../../v1/oauth2")).rejects.toMatchObject({ status: 400 });
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("is idempotent: authorizing the same order twice asks PayPal once", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    await h.svc.authorize(o.orderId);
    const again = await h.svc.authorize(o.orderId);
    expect(again.status).toBe("held");
    expect(h.paypal.count("authorizeOrder")).toBe(1);
    expect(h.svc.project().campaign.pledges.held).toBe(1);
  });

  it("rejects a hold for the wrong amount and queues it to be cancelled", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => ({ authorizationId: "A-wrong", orderId, amountCents: 100, status: "CREATED", createdAt: 0, expiresAt: 1, customId: `${SHOW}:${o.pledgeId}` }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422 });
    const p = h.svc.project();
    expect(p.campaign.pledges.held).toBe(0);
    expect(p.retired.get("A-wrong")).toMatchObject({ why: "rejected" });
    expect(h.store.job("void:A-wrong")?.status).toBe("pending");
  });

  it("rejects a hold whose custom_id belongs to another pledge", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => ({ authorizationId: "A-other", orderId, amountCents: 1500, status: "CREATED", createdAt: 0, expiresAt: 1, customId: `${SHOW}:someone-else` }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422 });
    expect(h.svc.project().campaign.pledges.held).toBe(0);
  });

  it("never counts a DENIED hold and has nothing to cancel", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => ({ authorizationId: "A-denied", orderId, amountCents: 1500, status: "DENIED", createdAt: 0, expiresAt: 1 }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422 });
    expect(h.store.job("void:A-denied")).toBeUndefined();
  });

  it("refuses to authorize after the deadline, without asking PayPal", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.clock.t = DEADLINE + 1;
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 409 });
    expect(h.paypal.count("authorizeOrder")).toBe(0);
    expect(h.svc.project().campaign.state).toBe("missed");
  });

  it("cancels a hold that lands after pledging closed while PayPal was answering", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => {
      h.clock.t = DEADLINE + 1;
      return { authorizationId: "A-late", orderId, amountCents: 1500, status: "CREATED", createdAt: 0, expiresAt: 1, customId: `${SHOW}:${o.pledgeId}` };
    });
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 409 });
    const p = h.svc.project();
    expect(p.retired.get("A-late")).toMatchObject({ why: "late" });
    expect(h.store.job("void:A-late")?.status).toBe("pending");
    expect(p.campaign.pledges.held).toBe(0);
  });

  it("tips on the pledge that reaches the target and persists capture jobs without running them", async () => {
    const h = await signedService();
    await pledge(h.svc, "AA");
    await pledge(h.svc, "BB");
    const third = await pledge(h.svc, "CC");
    expect(third.tipped).toBe(true);
    expect(h.store.jobs().filter((j) => j.kind === "capture" && j.status === "pending")).toHaveLength(3);
    expect(h.paypal.count("captureHold")).toBe(0);
    expect(h.store.logs().some((l) => l.rule === "rule-2-capture-at-tip")).toBe(true);
  });
});

describe("manage view", () => {
  it("needs the manage key", async () => {
    const h = await signedService();
    await expect(h.svc.checkKey(null)).rejects.toMatchObject({ status: 403 });
    await expect(h.svc.checkKey("a-wrong-key-that-is-long-enough")).rejects.toMatchObject({ status: 403 });
    await expect(h.svc.checkKey(h.manageKey)).resolves.toBeUndefined();
  });

  it("shows ledger rows newest first, the agent log with rule titles, and the parties with emails", async () => {
    const h = await signedService();
    await pledge(h.svc);
    const v = h.svc.manageView();
    expect(v.ledger[0]).toMatchObject({ what: "Fan held a spot", who: "Fan 01 · AB", amountCents: 1500, status: "On hold" });
    expect(v.parties.map((p) => [p.paypalEmail, p.payoutStatus])).toEqual([
      ["room@example.com", "planned"],
      ["maya@example.com", "planned"],
    ]);
    expect(v.log[0].ruleTitle).toBe(RULES["rule-1-hold-only"].title);
    expect(v.attention).toEqual([]);
  });
});

describe("dispatch", () => {
  it("answers 404 for a show that doesn't exist, without creating storage", async () => {
    const h = makeService();
    expect(await dispatch(h.svc, { op: "public" })).toEqual({ ok: false, status: 404, error: { code: "not_found", message: "There's no show here." } });
    expect(h.store.exists()).toBe(false);
  });

  it("turns refusals into plain replies", async () => {
    const h = await signedService();
    expect(await dispatch(h.svc, { op: "authorize", orderId: "5O190127TN364715T" })).toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
    h.paypal.script("createPledgeOrder", () => {
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
    });
    expect(await dispatch(h.svc, { op: "order", body: { initials: "AB" } })).toMatchObject({ ok: false, status: 502, error: { code: "paypal_error" } });
    expect(await dispatch(h.svc, { op: "manage", manageKey: null })).toMatchObject({ ok: false, status: 403 });
    expect(await dispatch(h.svc, { op: "manage", manageKey: h.manageKey })).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/agent`
Expected: PASS.

- [ ] **Step 9: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add src/agent src/worker/api-types.ts tests/agent
git commit -m "feat(agent): API contract and campaign service: sign, orders, authorize with id checks, views

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 7: The agent loop: deadline first, pace checks, guarded proposals, approvals, call-off, webhooks, notes, wake times

**Files:**
- Create: `src/agent/pace.ts`
- Modify: `src/agent/service.ts` (new imports + new methods), `src/agent/dispatch.ts` (three ops)
- Create: `tests/agent/pace.test.ts`, `tests/agent/agent-loop.test.ts`

**Interfaces:**
- Consumes: Task 6 `CampaignService`, `dispatch`, harness; Task 5 `paceNote`, `settlementNote`, `PaceFacts`; Task 3/4 `drain`, `RUNNERS`, `requestReconcile`, `commit`; Task 2 `MONEY_JOBS`, `PACE_LATE_MS`, `ProposalOption`, `SettlementNote`, `pledgeIdFromCustomId`; Plan 1 `guard`, `AgentAction`, `thresholdPledges`, `splitPayout`, `DAY_MS`, `MAX_CAMPAIGN_DAYS`, `MAX_EXTENSION_DAYS`, `fansCommitted`; Task 1 `PayPalLedgerEvent`.
- Produces:
  - `pace.ts`: `interface PaceNumbers { committed; threshold; daysLeft; projected; percentElapsed }`, `paceCheckTimes(m: Mandate, c: Campaign): [number, number | null]`, `duePaceCheck(m, c, checked: ReadonlySet<number>, now): { run: 1 | 2 | null; mark: (1 | 2)[] }`, `paceNumbers(m, c, now): PaceNumbers`, `paceOptions(m, c, approvals: ReadonlySet<string>, collectedNet: Cents, n: PaceNumbers): ProposalOption[]`
  - `CampaignService.tick(): Promise<{ expired: boolean }>`, `approve(proposalId: string, req: ApproveRequest): Promise<ApproveResponse>`, `callOff(): Promise<CallOffResponse>`, `ingestWebhook(e: PayPalLedgerEvent): Promise<{ recorded: boolean }>`, `nextWakeAt(): number | null` (REAL epoch ms for the DO alarm, or null)
  - `CampaignOp` gains `{ op: "approve"; manageKey; proposalId; body: ApproveRequest }`, `{ op: "call_off"; manageKey }`, `{ op: "webhook"; event: PayPalLedgerEvent }`

**Rules this task makes testable:**
1. `deadline_reached(now)` is applied at the start of `tick`, `approve`, `callOff` and `ingestWebhook`, so a stale proposal can't be approved after the deadline (the guard has no clock).
2. Code computes the pace numbers and the options; each option exists only if the guard says "needs approval". The model only explains (schema- and number-checked) and picks a recommendation among offered ids.
3. An approved `lower_threshold` is wired to a `threshold_lowered` event (which may tip the show and plan captures); an approved `extend_deadline` to `deadline_extended`; `pay_short` unblocks the payout job.
4. Calling off is allowed only for a tipped show (no cancel after the deadline; a live show is voided at its deadline).
5. Webhooks are deduplicated by PayPal event id and never change counts: a capture webhook triggers a GET reconcile; a payout-batch webhook fills a recovered batch id and polls it; `charge_reversed` and `payout_item_pending` are recorded and surfaced.
6. Settlement notes run once, after every money job is finished.

- [ ] **Step 1: Write the failing pace tests**

`tests/agent/pace.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initialCampaign, reduce } from "../../src/core/campaign";
import { DAY_MS } from "../../src/core/holds";
import { mandateSignedEvent } from "../../src/core/mandate";
import { duePaceCheck, paceCheckTimes, paceNumbers, paceOptions } from "../../src/agent/pace";
import { DEADLINE, LAUNCH, testMandate } from "./fixtures";

const m = testMandate();
const live = reduce(initialCampaign(), mandateSignedEvent(m)).campaign;
const HALF = LAUNCH + 3.5 * DAY_MS;
const LATE = DEADLINE - 3 * DAY_MS;

describe("pace checks", () => {
  it("are at 50% of the window and 72 hours before the deadline", () => {
    expect(paceCheckTimes(m, live)).toEqual([HALF, LATE]);
  });
  it("drop the 72-hour check when it would be before launch", () => {
    expect(paceCheckTimes(m, { ...live, deadline: LAUNCH + 2 * DAY_MS })[1]).toBeNull();
  });
  it("run only the latest due check and mark earlier ones done", () => {
    expect(duePaceCheck(m, live, new Set(), HALF - 1)).toEqual({ run: null, mark: [] });
    expect(duePaceCheck(m, live, new Set(), HALF)).toEqual({ run: 1, mark: [] });
    expect(duePaceCheck(m, live, new Set(), LATE)).toEqual({ run: 2, mark: [1] });
    expect(duePaceCheck(m, live, new Set([2]), LATE)).toEqual({ run: null, mark: [1] });
    expect(duePaceCheck(m, live, new Set(), DEADLINE)).toEqual({ run: null, mark: [] });
  });
  it("project the final count linearly", () => {
    const one = { ...live, pledges: { ...live.pledges, held: 1 } };
    expect(paceNumbers(m, one, HALF)).toEqual({ committed: 1, threshold: 3, daysLeft: 4, projected: 2, percentElapsed: 50 });
  });
  it("offer only guard-approved options: extend within 21 days, lower no further than the fixed costs", () => {
    const one = { ...live, pledges: { ...live.pledges, held: 1 } };
    const options = paceOptions(m, one, new Set(), 0, paceNumbers(m, one, HALF));
    expect(options).toEqual([
      { id: "extend", approvalKey: `extend:${DEADLINE + 7 * DAY_MS}`, label: "Extend 7 days", newDeadline: DEADLINE + 7 * DAY_MS },
      { id: "lower", approvalKey: "lower:2", label: "Lower the target to 2", newThreshold: 2 },
    ]);
    const extended = { ...one, extensionsUsed: 1 };
    expect(paceOptions(m, extended, new Set(), 0, paceNumbers(m, extended, HALF)).map((o) => o.id)).toEqual(["lower"]);
  });
});
```

- [ ] **Step 2: Write `src/agent/pace.ts`**

```ts
import { fansCommitted, type Campaign } from "../core/campaign";
import { guard } from "../core/guard";
import { DAY_MS, MAX_CAMPAIGN_DAYS, MAX_EXTENSION_DAYS } from "../core/holds";
import type { Mandate } from "../core/mandate";
import type { Cents } from "../core/money";
import { thresholdPledges } from "../core/threshold";
import type { ProposalOption } from "./events";
import { PACE_LATE_MS } from "./policy";

export interface PaceNumbers {
  committed: number;
  threshold: number;
  daysLeft: number;
  projected: number;
  percentElapsed: number;
}

/** Spec 3.4: at 50% of the window, and 72 hours before the deadline (dropped if that is before launch). */
export function paceCheckTimes(m: Mandate, c: Campaign): [number, number | null] {
  const launched = Date.parse(m.launchedAt);
  const half = launched + Math.floor((c.deadline - launched) / 2);
  const late = c.deadline - PACE_LATE_MS;
  return [half, late > launched ? late : null];
}

/** Which check to run now (the latest due one) and which earlier unchecked ones to just mark done. */
export function duePaceCheck(m: Mandate, c: Campaign, checked: ReadonlySet<number>, now: number): { run: 1 | 2 | null; mark: (1 | 2)[] } {
  if (c.state !== "live" || now >= c.deadline) return { run: null, mark: [] };
  const [half, late] = paceCheckTimes(m, c);
  const due: { n: 1 | 2; at: number }[] = [];
  if (now >= half) due.push({ n: 1, at: half });
  if (late !== null && now >= late) due.push({ n: 2, at: late });
  due.sort((a, b) => a.at - b.at);
  const last = due[due.length - 1];
  const run = last && !checked.has(last.n) ? last.n : null;
  const mark = due.filter((x) => x.n !== run && !checked.has(x.n)).map((x) => x.n);
  return { run, mark };
}

/** Code, not the model, computes the numbers. */
export function paceNumbers(m: Mandate, c: Campaign, now: number): PaceNumbers {
  const launched = Date.parse(m.launchedAt);
  const span = Math.max(1, c.deadline - launched);
  const elapsed = Math.min(1, Math.max(0, (now - launched) / span));
  const committed = fansCommitted(c);
  return {
    committed,
    threshold: c.threshold,
    daysLeft: Math.max(0, Math.ceil((c.deadline - now) / DAY_MS)),
    projected: elapsed > 0 ? Math.round(committed / elapsed) : committed,
    percentElapsed: Math.round(elapsed * 100),
  };
}

/** Options the artist may approve. Each is kept only when the guard answers "needs approval". */
export function paceOptions(m: Mandate, c: Campaign, approvals: ReadonlySet<string>, collectedNet: Cents, n: PaceNumbers): ProposalOption[] {
  const ctx = { mandate: m, campaign: c, approvals, collectedNet };
  const options: ProposalOption[] = [];
  if (c.extensionsUsed < m.maxExtensions) {
    const newDeadline = Math.min(c.deadline + MAX_EXTENSION_DAYS * DAY_MS, Date.parse(m.launchedAt) + MAX_CAMPAIGN_DAYS * DAY_MS);
    if (newDeadline > c.deadline) {
      const d = guard({ kind: "extend_deadline", newDeadline }, ctx);
      if (d.needsApproval && d.approvalKey) {
        const days = Math.ceil((newDeadline - c.deadline) / DAY_MS);
        options.push({ id: "extend", approvalKey: d.approvalKey, label: `Extend ${days} day${days === 1 ? "" : "s"}`, newDeadline });
      }
    }
  }
  const floor = thresholdPledges({ fixedCosts: m.parties.filter((x) => x.role !== "artist").map((x) => x.fixed ?? 0), artistMinimum: 0, ticketPrice: m.ticketPrice, feeBufferBps: m.feeBufferBps });
  const target = Math.max(n.projected, floor, 1);
  if (target < c.threshold) {
    const d = guard({ kind: "lower_threshold", newThreshold: target }, ctx);
    if (d.needsApproval && d.approvalKey) options.push({ id: "lower", approvalKey: d.approvalKey, label: `Lower the target to ${target}`, newThreshold: target });
  }
  return options;
}
```

- [ ] **Step 3: Run the pace tests**

Run: `npx vitest run tests/agent/pace.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing agent-loop tests**

`tests/agent/agent-loop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/holds";
import { dispatch } from "../../src/agent/dispatch";
import { PayPalError } from "../../src/paypal/errors";
import type { PayPalLedgerEvent } from "../../src/paypal/webhooks";
import { FakeAi, fakeBudget, json } from "./fake-ai";
import { DEADLINE, LAUNCH, SHOW } from "./fixtures";
import { pledge, signedService } from "./harness";

const HALF = LAUNCH + 3.5 * DAY_MS;
const hook = (e: Partial<PayPalLedgerEvent> & Pick<PayPalLedgerEvent, "kind" | "ref">): PayPalLedgerEvent => ({ eventId: "WH-1", at: LAUNCH, ...e });

describe("pace check", () => {
  it("runs once at 50%, proposing only code-made, guard-approved options", async () => {
    const h = await signedService();
    await pledge(h.svc);
    h.clock.t = HALF;
    await h.svc.tick();
    await h.svc.tick();
    const proposals = [...h.svc.project().proposals.values()];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      proposalId: "pace1",
      source: "template",
      recommend: "extend",
      explanation: "1 of 3 fans with 4 days left. At this pace about 2 will join. You could extend the deadline 7 days, or lower the target to 2.",
    });
    expect(proposals[0].options.map((o) => o.id)).toEqual(["extend", "lower"]);
    expect(h.store.logs().at(-1)).toMatchObject({ rule: "rule-5-ask-first", source: "template" });
  });

  it("proposes nothing when the show is on pace", async () => {
    const h = await signedService();
    await pledge(h.svc, "AA");
    await pledge(h.svc, "BB");
    h.clock.t = HALF;
    await h.svc.tick();
    expect(h.svc.project().proposals.size).toBe(0);
    expect(h.svc.project().paceChecks.has(1)).toBe(true);
    expect(h.store.logs().at(-1)?.did).toBe("On pace. Nothing to change.");
  });

  it("uses the model's explanation only when it passes the checks", async () => {
    const good = await signedService({ ai: { ai: new FakeAi([json({ text: "You have 1 of 3 fans with 4 days left. Extending 7 days gives fans time.", recommend: "extend" })]), budget: fakeBudget().port } });
    await pledge(good.svc);
    good.clock.t = HALF;
    await good.svc.tick();
    expect(good.svc.project().proposals.get("pace1")?.source).toBe("model");

    const bad = await signedService({ ai: { ai: new FakeAi([json({ text: "You have 1 of 3 fans. Refund everyone now.", recommend: "refund" })]), budget: fakeBudget().port } });
    await pledge(bad.svc);
    bad.clock.t = HALF;
    await bad.svc.tick();
    const proposal = bad.svc.project().proposals.get("pace1");
    expect(proposal?.source).toBe("template");
    expect(proposal?.options.map((o) => o.id)).toEqual(["extend", "lower"]);
    expect(bad.store.jobs().some((j) => j.kind === "refund")).toBe(false);
  });

  it("says the AI is resting when the budget is spent", async () => {
    const h = await signedService({ ai: { ai: new FakeAi([]), budget: fakeBudget(0).port } });
    await pledge(h.svc);
    h.clock.t = HALF;
    await h.svc.tick();
    expect(h.svc.project().proposals.get("pace1")?.source).toBe("resting");
    expect(h.store.logs().at(-1)?.did).toContain("resting until 00:00 UTC");
  });
});

describe("approvals", () => {
  it("approving 'extend' moves the deadline, once", async () => {
    const h = await signedService();
    await pledge(h.svc);
    h.clock.t = HALF;
    await h.svc.tick();
    const r = await h.svc.approve("pace1", { option: "extend" });
    expect(r.rule).toBe("rule-5-ask-first");
    expect(r.show.deadline).toBe(new Date(DEADLINE + 7 * DAY_MS).toISOString());
    await expect(h.svc.approve("pace1", { option: "extend" })).rejects.toMatchObject({ status: 409 });
    await expect(h.svc.approve("nope", { option: "extend" })).rejects.toMatchObject({ status: 404 });
  });

  it("approving 'lower' records threshold_lowered, which can tip the show and charge everyone", async () => {
    const h = await signedService();
    await pledge(h.svc, "AA");
    await pledge(h.svc, "BB");
    h.clock.t = DEADLINE - DAY_MS;
    await h.svc.tick();
    expect(h.svc.project().proposals.get("pace2")?.options.find((o) => o.id === "lower")?.newThreshold).toBe(2);
    const r = await h.svc.approve("pace2", { option: "lower" });
    expect(r.show).toMatchObject({ threshold: 2, state: "tipped" });
    await h.svc.tick();
    expect(h.svc.project().campaign.pledges.charged).toBe(2);
  });

  it("applies the deadline before guarding: a stale proposal can't be approved after it", async () => {
    const h = await signedService();
    await pledge(h.svc);
    h.clock.t = HALF;
    await h.svc.tick();
    h.clock.t = DEADLINE + 1;
    await expect(h.svc.approve("pace1", { option: "extend" })).rejects.toMatchObject({ status: 409, message: "Only an open show can be extended." });
    const p = h.svc.project();
    expect(p.campaign.state).toBe("missed");
    expect(h.store.hasEvent("extended")).toBe(false);
    expect(h.store.jobs().some((j) => j.kind === "void" && j.status === "pending")).toBe(true);
  });

  it("refuses an option the proposal didn't offer", async () => {
    const h = await signedService();
    await pledge(h.svc);
    h.clock.t = HALF;
    await h.svc.tick();
    await expect(h.svc.approve("pace1", { option: "pay_short" })).rejects.toMatchObject({ status: 422 });
  });
});

describe("calling off", () => {
  it("is refused for a live show and allowed once it tipped; every charge is refunded", async () => {
    const h = await signedService();
    await pledge(h.svc, "AA");
    await expect(h.svc.callOff()).rejects.toMatchObject({ status: 409 });
    await pledge(h.svc, "BB");
    await pledge(h.svc, "CC");
    await h.svc.tick();
    const r = await h.svc.callOff();
    expect(r.show.state).toBe("cancelled");
    await h.svc.tick();
    const p = h.svc.project();
    expect(p.campaign.pledges).toMatchObject({ charged: 0, refunded: 3 });
    expect(p.notes?.map((n) => n.text)).toEqual([
      "Acoustic Set was called off after it tipped. Every fan is being refunded, and Lucky's Café receives nothing.",
      "Acoustic Set was called off after it tipped. Every fan is being refunded, and Maya receives nothing.",
    ]);
  });

  it("is refused after the deadline", async () => {
    const h = await signedService();
    for (const i of ["AA", "BB", "CC"]) await pledge(h.svc, i);
    await h.svc.tick();
    h.clock.t = DEADLINE;
    await expect(h.svc.callOff()).rejects.toMatchObject({ status: 409 });
  });
});

describe("full runs", () => {
  it("tip → charge → deadline → payout → notes, then nothing left to wake for", async () => {
    const h = await signedService();
    for (const i of ["AA", "BB", "CC"]) await pledge(h.svc, i);
    await h.svc.tick();
    expect(h.svc.project().campaign.pledges.charged).toBe(3);
    h.clock.t = DEADLINE;
    await h.svc.tick();
    let p = h.svc.project();
    expect(p.campaign.state).toBe("settled");
    expect(p.notes?.[0]).toEqual({ role: "room", label: "Lucky's Café", source: "template", text: "Acoustic Set happened. 3 fans paid $15.00 each, and Lucky's Café was paid $20.00 under the money rules the artist signed." });
    expect(h.svc.nextWakeAt()).toBe(DEADLINE + 60_000);
    h.clock.t = DEADLINE + 60_000;
    await h.svc.tick();
    p = h.svc.project();
    expect(p.payouts[0].items[`${SHOW}-room`]?.status).toBe("SUCCESS");
    expect(h.svc.nextWakeAt()).toBeNull();
  });

  it("a missed show voids every hold and the notes say nobody paid", async () => {
    const h = await signedService();
    await pledge(h.svc);
    h.clock.t = DEADLINE;
    await h.svc.tick();
    const p = h.svc.project();
    expect(p.campaign).toMatchObject({ state: "missed", pledges: { held: 0, released: 1 } });
    expect(p.notes?.[1].text).toBe("Acoustic Set didn't reach its target, so every hold was cancelled. Nobody was charged, and Maya receives nothing.");
  });

  it("wakes at the first pace check, then the deadline", async () => {
    const h = await signedService();
    expect(h.svc.nextWakeAt()).toBe(HALF);
    h.clock.t = HALF;
    await h.svc.tick();
    expect(h.svc.nextWakeAt()).toBe(DEADLINE - 3 * DAY_MS);
  });
});

describe("webhooks", () => {
  it("ignore a repeated PayPal event id", async () => {
    const h = await signedService();
    expect(await h.svc.ingestWebhook(hook({ kind: "hold_created", ref: "A1" }))).toEqual({ recorded: true });
    expect(await h.svc.ingestWebhook(hook({ kind: "hold_created", ref: "A1" }))).toEqual({ recorded: false });
    expect(h.store.events().filter((e) => e.event.type === "webhook_received")).toHaveLength(1);
  });

  it("never count a capture from a webhook: they trigger a reconcile", async () => {
    const h = await signedService();
    await pledge(h.svc, "AA");
    await pledge(h.svc, "BB");
    const third = await pledge(h.svc, "CC");
    await h.svc.ingestWebhook(hook({ kind: "charged", ref: "C-x", customId: `${SHOW}:${third.pledgeId}`, amountCents: 1500 }));
    const p = h.svc.project();
    expect(p.pledges.get(third.pledgeId)?.status).toBe("held");
    expect(p.collectedNet).toBe(0);
    expect(h.store.job(`reconcile:A-${third.pledgeId}`)?.status).toBe("pending");
  });

  it("fill in a recovered payout batch id and poll it", async () => {
    const h = await signedService();
    for (const i of ["AA", "BB", "CC"]) await pledge(h.svc, i);
    await h.svc.tick();
    h.paypal.script("sendPayouts", () => {
      throw new PayPalError(400, "USER_BUSINESS_ERROR", "dup", undefined, [{ field: "SENDER_BATCH_ID", issue: "Batch with given sender_batch_id already exists" }]);
    });
    h.clock.t = DEADLINE;
    await h.svc.tick();
    expect(h.svc.project().payouts[0]).toMatchObject({ recovered: true, batchId: null });
    await h.svc.ingestWebhook(hook({ eventId: "WH-9", kind: "payout_batch_done", ref: "BATCH9", customId: `payout-${SHOW}` }));
    expect(h.svc.project().payouts[0].batchId).toBe("BATCH9");
    expect(h.store.job("poll:BATCH9:hook-WH-9")?.status).toBe("pending");
  });

  it("surface a chargeback for attention without changing anything", async () => {
    const h = await signedService();
    await h.svc.ingestWebhook(hook({ kind: "charge_reversed", ref: "C-1", customId: `${SHOW}:p1` }));
    expect(h.store.logs().at(-1)?.did).toMatch(/^Needs attention: PayPal reversed a charge/);
  });

  it("are reachable through dispatch, and approvals need the manage key", async () => {
    const h = await signedService();
    expect(await dispatch(h.svc, { op: "webhook", event: hook({ kind: "hold_created", ref: "A1" }) })).toEqual({ ok: true, data: { recorded: true } });
    expect(await dispatch(h.svc, { op: "call_off", manageKey: "wrong-key-wrong-key-wrong" })).toMatchObject({ ok: false, status: 403 });
    expect(await dispatch(h.svc, { op: "approve", manageKey: null, proposalId: "pace1", body: { option: "extend" } })).toMatchObject({ ok: false, status: 403 });
  });
});
```

- [ ] **Step 5: Run the agent-loop tests to see them fail**

Run: `npx vitest run tests/agent/agent-loop.test.ts`
Expected: FAIL with "h.svc.tick is not a function".

- [ ] **Step 6: Add the agent loop to `src/agent/service.ts`**

Replace the whole import block at the top of `src/agent/service.ts` with:

```ts
import { fansCommitted, IllegalTransition, reduce } from "../core/campaign";
import { guard, type AgentAction } from "../core/guard";
import { buildMandate, MandateDraftError, signMandate, type Mandate } from "../core/mandate";
import { formatUSD } from "../core/money";
import { splitPayout } from "../core/split";
import { assertPayPalId } from "../paypal/amount";
import { PayPalError } from "../paypal/errors";
import { requestIds, type Hold, type TestCard } from "../paypal/payments";
import type { PayPalLedgerEvent } from "../paypal/webhooks";
import type { ApproveRequest, ApproveResponse, AuthorizeResponse, CallOffResponse, CreateOrderRequest, CreateOrderResponse, ManageView, PublicShow, SignRequest, SignResponse } from "../worker/api-types";
import type { AiDeps } from "./ai";
import { paceNote, settlementNote, type PaceFacts } from "./ai-jobs";
import { toMandateDraft } from "./draft";
import { ServiceError } from "./errors";
import type { ProposalOption, SettlementNote } from "./events";
import { commit, drain, logStep, queueVoid, requestReconcile, type ExecDeps } from "./executor";
import { customIdFor, newId, newSecret, pledgeIdFromCustomId, sameHex, sha256Hex, type Clock, type Random } from "./ids";
import { duePaceCheck, paceCheckTimes, paceNumbers, paceOptions } from "./pace";
import type { PayPalPort } from "./paypal-port";
import { MAX_ORDERS_PER_SHOW, MONEY_JOBS } from "./policy";
import type { OrderView, PledgeView, Projection } from "./project";
import { RUNNERS } from "./runners";
import type { Store } from "./store";
import { ledgerRows, logRows, manageParties, proposalRows, publicShow } from "./views";
import { fanName, holdDescription, sawCounts } from "./words";
```

Add this function after `holdProblem` (outside the class):

```ts
/** The guard action an approved option stands for. A missing number becomes NaN, which the guard refuses. */
function actionFor(o: ProposalOption, p: Projection): AgentAction {
  switch (o.id) {
    case "extend":
      return { kind: "extend_deadline", newDeadline: o.newDeadline ?? Number.NaN };
    case "lower":
      return { kind: "lower_threshold", newThreshold: o.newThreshold ?? Number.NaN };
    case "pay_short":
      return { kind: "send_payouts", lines: p.mandate ? splitPayout(p.collectedNet, p.mandate.parties).lines : [] };
  }
}
```

Add these methods inside the class, after `manageView()`:

```ts
  /** One alarm turn: deadline first, then a due pace check, then due money jobs, then notes. */
  async tick(): Promise<{ expired: boolean }> {
    if (!this.exists()) return { expired: false };
    let p = this.applyDeadline();
    if (p.mandate) {
      const due = duePaceCheck(p.mandate, p.campaign, p.paceChecks, this.now());
      for (const n of due.mark) commit(this.deps.store, this.now(), { type: "pace_checked", check: n });
      if (due.run !== null) await this.runPaceCheck(due.run);
    }
    await drain(this.exec(), RUNNERS);
    p = this.applyDeadline();
    if (this.notesDue(p)) await this.writeNotes(p);
    return { expired: false };
  }

  private async runPaceCheck(check: 1 | 2): Promise<void> {
    const store = this.deps.store;
    const p = this.project();
    const m = this.requireMandate(p);
    const c = p.campaign;
    const nums = paceNumbers(m, c, this.now());
    const saw = `${nums.committed} of ${nums.threshold} fans with ${nums.daysLeft} day${nums.daysLeft === 1 ? "" : "s"} left (${nums.percentElapsed}% of the way). At this pace, about ${nums.projected}.`;
    if (nums.projected >= c.threshold) {
      commit(store, this.now(), { type: "pace_checked", check });
      return this.log({ saw, did: "On pace. Nothing to change.", rule: null });
    }
    const options = paceOptions(m, c, p.approvals, p.collectedNet, nums);
    if (options.length === 0) {
      commit(store, this.now(), { type: "pace_checked", check });
      return this.log({ saw, did: "Behind pace, but the signed rules leave nothing to propose.", rule: "rule-5-ask-first" });
    }
    const extend = options.find((o) => o.id === "extend");
    const lower = options.find((o) => o.id === "lower");
    const facts: PaceFacts = { ...nums, options, extendDays: extend?.newDeadline !== undefined ? Math.ceil((extend.newDeadline - c.deadline) / 86_400_000) : null, lowerTo: lower?.newThreshold ?? null };
    const note = await paceNote(this.deps.ai, facts);
    // The model call took time: re-apply the deadline before recording a proposal.
    if (this.applyDeadline().campaign.state !== "live") {
      commit(store, this.now(), { type: "pace_checked", check });
      return;
    }
    commit(store, this.now(), { type: "proposal_made", proposalId: `pace${check}`, options, explanation: note.value.text, recommend: note.value.recommend, source: note.source });
    commit(store, this.now(), { type: "pace_checked", check });
    const resting = note.source === "resting" ? " The AI is resting until 00:00 UTC, so a plain template wrote this." : "";
    this.log({ saw, did: `Proposed: ${options.map((o) => o.label).join(" or ")}. Waiting for the artist.${resting}`, rule: "rule-5-ask-first", source: note.source });
  }

  /** The artist approves one option. Deadline first, then the guard with the option's approval key. */
  async approve(proposalId: string, req: ApproveRequest): Promise<ApproveResponse> {
    const store = this.deps.store;
    const p = this.applyDeadline();
    const m = this.requireMandate(p);
    const proposal = p.proposals.get(proposalId);
    if (!proposal) throw new ServiceError(404, "not_found", "There's no such proposal.");
    if (proposal.approved) throw new ServiceError(409, "conflict", "That proposal was already approved.");
    const option = proposal.options.find((o) => o.id === req?.option);
    if (!option) throw new ServiceError(422, "invalid", "Pick one of the proposal's options.");
    const action = actionFor(option, p);
    const decision = guard(action, { mandate: m, campaign: p.campaign, approvals: new Set([...p.approvals, option.approvalKey]), collectedNet: p.collectedNet });
    const saw = sawCounts(p);
    if (!decision.allowed) {
      this.log({ saw, did: `Did not apply "${option.label}". ${decision.reason}`, rule: decision.rule });
      throw new ServiceError(409, "conflict", decision.reason);
    }
    const now = this.now();
    commit(store, now, { type: "proposal_approved", proposalId, option: option.id, approvalKey: option.approvalKey });
    if (action.kind === "extend_deadline") commit(store, now, { type: "deadline_extended", newDeadline: action.newDeadline });
    if (action.kind === "lower_threshold") commit(store, now, { type: "threshold_lowered", newThreshold: action.newThreshold });
    if (action.kind === "send_payouts") {
      const key = `payout:${m.showId}`;
      if (store.job(key)?.status === "blocked") store.updateJob(key, { status: "pending", nextAt: now });
    }
    this.log({ saw, did: `The artist approved "${option.label}". ${decision.reason}`, rule: decision.rule });
    return { proposalId, option: option.id, rule: decision.rule, show: this.publicView() };
  }

  /** Spec 3.7: only a tipped show can be called off. Open holds are voided, every charge refunded. */
  async callOff(): Promise<CallOffResponse> {
    const p = this.applyDeadline();
    this.requireMandate(p);
    if (p.campaign.state !== "tipped") {
      throw new ServiceError(409, "conflict", p.campaign.state === "live" ? "A show that hasn't reached its target can't be called off; if it misses, every hold is cancelled at the deadline." : "This show can no longer be called off.");
    }
    const saw = sawCounts(p);
    const r = commit(this.deps.store, this.now(), { type: "show_cancelled" });
    this.log({ saw, did: "The artist called the show off. Cancelling open holds and refunding every charge.", rule: "rule-5-ask-first" });
    return { show: this.publicView(r.projection) };
  }

  /** Records a verified PayPal webhook once. It never changes counts: it only asks for a GET-based check. */
  async ingestWebhook(e: PayPalLedgerEvent): Promise<{ recorded: boolean }> {
    const store = this.deps.store;
    const now = this.now();
    const p = this.applyDeadline();
    const r = commit(store, now, { type: "webhook_received", eventId: e.eventId, kind: e.kind, ref: e.ref, amountCents: e.amountCents ?? null, customId: e.customId ?? null });
    if (!r.appended) return { recorded: false };
    let did = "Recorded it. Amounts only come from PayPal answers we fetch ourselves.";
    switch (e.kind) {
      case "charged":
      case "charge_failed":
      case "hold_voided": {
        const auth = this.authForWebhook(p, e);
        if (auth) {
          requestReconcile(store, auth, now, `PayPal sent ${e.kind}`);
          did = "Checking that hold with PayPal before counting anything.";
        }
        break;
      }
      case "payout_batch_done":
      case "payout_batch_failed":
        if (e.customId && p.payouts.some((x) => x.senderBatchId === e.customId)) {
          commit(store, now, { type: "payout_batch_seen", senderBatchId: e.customId, batchId: e.ref });
          store.putJob({ key: `poll:${e.ref}:hook-${e.eventId}`, kind: "payout_poll", target: e.ref, nextAt: now, note: "1" }, now);
          did = "Checking the payout batch with PayPal.";
        }
        break;
      case "payout_item_paid":
      case "payout_item_failed":
      case "payout_item_pending": {
        const retry = e.customId?.endsWith("-r1") ?? false;
        const batchId = p.payouts.find((x) => x.retry === retry)?.batchId;
        if (batchId) {
          store.putJob({ key: `poll:${batchId}:hook-${e.eventId}`, kind: "payout_poll", target: batchId, nextAt: now, note: "1" }, now);
          did = "Checking the payout batch with PayPal.";
        }
        break;
      }
      case "charge_reversed":
        did = "Needs attention: PayPal reversed a charge (a chargeback). Nothing was changed automatically.";
        break;
      default:
        break;
    }
    this.log({ saw: `PayPal sent ${e.kind} for ${e.ref}.`, did, rule: null, resultId: e.ref });
    return { recorded: true };
  }

  private authForWebhook(p: Projection, e: PayPalLedgerEvent): string | null {
    if (p.pledgeByAuth.has(e.ref) || p.retired.has(e.ref)) return e.ref;
    const pid = e.customId ? pledgeIdFromCustomId(e.customId) : null;
    if (!pid) return null;
    const pledge: PledgeView | undefined = p.pledges.get(pid) ?? [...p.pledges.values()].find((x) => x.paypalPledgeId === pid);
    return pledge && pledge.status === "held" ? pledge.authorizationId : null;
  }

  private notesDue(p: Projection): boolean {
    if (!p.mandate || p.notes) return false;
    const s = p.campaign.state;
    if (s !== "settled" && s !== "missed" && s !== "cancelled") return false;
    if (p.campaign.pledges.held > 0) return false;
    if (s === "cancelled" && p.campaign.pledges.charged > 0) return false;
    return !this.deps.store.hasPending(MONEY_JOBS);
  }

  private async writeNotes(p: Projection): Promise<void> {
    const m = this.requireMandate(p);
    const s = p.campaign.state;
    const outcome = s === "settled" ? "paid" : s === "missed" ? "called_off" : "refunded";
    const first = p.payouts.find((x) => !x.retry);
    const fans = s === "settled" ? p.campaign.pledges.charged : s === "missed" ? p.campaign.pledges.released : p.campaign.pledges.refunded;
    const saw = sawCounts(p);
    const notes: SettlementNote[] = [];
    for (const party of m.parties) {
      const amountCents = outcome === "paid" ? (first?.lines.find((l) => l.role === party.role)?.amount ?? 0) : 0;
      const r = await settlementNote(this.deps.ai, { role: party.role, label: party.label, showName: m.showName, outcome, amountCents, fans, ticketPriceCents: m.ticketPrice });
      notes.push({ role: party.role, label: party.label, text: r.value, source: r.source });
    }
    const { appended } = commit(this.deps.store, this.now(), { type: "notes_written", notes });
    if (appended) this.log({ saw, did: `Wrote a plain-English settlement note for each of the ${notes.length} people involved.`, rule: null, source: notes.some((n) => n.source === "model") ? "model" : (notes[0]?.source ?? "template") });
  }

  /** When the Durable Object alarm should next fire, in REAL time; null when nothing is left to do. */
  nextWakeAt(): number | null {
    if (!this.exists()) return null;
    const p = this.project();
    const now = this.now();
    const c = p.campaign;
    const times: number[] = [];
    if (p.mandate && (c.state === "live" || c.state === "tipped")) times.push(c.deadline);
    if (p.mandate && c.state === "live") {
      const [half, late] = paceCheckTimes(p.mandate, c);
      if (!p.paceChecks.has(1)) times.push(half);
      if (late !== null && !p.paceChecks.has(2)) times.push(late);
    }
    const job = this.deps.store.nextJobAt();
    if (job !== undefined) times.push(job);
    if (this.notesDue(p)) times.push(now);
    if (times.length === 0) return null;
    return Math.max(Math.min(...times), now) - this.clockOffset();
  }
```

- [ ] **Step 7: Add the three ops to `src/agent/dispatch.ts`**

Replace the import block and the `CampaignOp` type with:

```ts
import { PayPalError } from "../paypal/errors";
import type { PayPalLedgerEvent } from "../paypal/webhooks";
import type { ApiError, ApproveRequest, CreateOrderRequest, SignRequest } from "../worker/api-types";
import { ServiceError } from "./errors";
import type { CampaignService } from "./service";

/** The JSON messages the Worker sends to a campaign's Durable Object. */
export type CampaignOp =
  | { op: "init"; showId: string; signTokenHash: string }
  | { op: "sign"; body: SignRequest }
  | { op: "public" }
  | { op: "order"; body: CreateOrderRequest }
  | { op: "authorize"; orderId: string }
  | { op: "manage"; manageKey: string | null }
  | { op: "approve"; manageKey: string | null; proposalId: string; body: ApproveRequest }
  | { op: "call_off"; manageKey: string | null }
  | { op: "webhook"; event: PayPalLedgerEvent };
```

Add these cases at the end of the `switch` in `run()`:

```ts
    case "approve":
      await service.checkKey(op.manageKey);
      return service.approve(op.proposalId, op.body);
    case "call_off":
      await service.checkKey(op.manageKey);
      return service.callOff();
    case "webhook":
      return service.ingestWebhook(op.event);
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/agent`
Expected: PASS.

- [ ] **Step 9: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add src/agent tests/agent
git commit -m "feat(agent): agent loop with deadline-first guarding, pace proposals, approvals, call-off, webhooks and notes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Cloudflare adapters: Durable Objects (SQLite + alarms), wrangler config, worker type-check

**Files:**
- Create: `wrangler.toml`, `tsconfig.worker.json`, `src/worker/env.ts`, `src/worker/do/sql-adapter.ts`, `src/worker/do/campaign-agent.ts`, `src/worker/do/quota-agent.ts`, `src/worker/quota-client.ts`, `src/worker/index.ts`
- Modify: `tsconfig.json` (exclude the Cloudflare-typed files), `package.json` (scripts), `.dev.vars.example` (variable names only)

**Interfaces:**
- Consumes: `CampaignService`, `dispatch`, `CampaignOp`, `Store`, `paypalPort`, `SIM_CARD`, `cryptoRandom`, `systemClock`, `Quota`, `quotaDispatch`, `QuotaOp`, `QuotaPort`, `RateResult`, `BudgetPort`, `SqlDb`, `loadConfig`, `PayPalHttp`. Cloudflare global types from `@cloudflare/workers-types` (installed by the controller).
- Produces:
  - `interface Env { CAMPAIGN: DurableObjectNamespace; QUOTA: DurableObjectNamespace; AI?: WorkersAiBinding; PAYPAL_CLIENT_ID?; PAYPAL_CLIENT_SECRET?; PAYPAL_API_BASE?; PAYPAL_WEBHOOK_ID?; PAYPAL_RECEIVER_ROOM?; PAYPAL_RECEIVER_OPENER?; PAYPAL_RECEIVER_ARTIST?; ALLOWED_ORIGINS?; RATE_SALT? }`
  - `cfDb(storage: DurableObjectStorage): SqlDb`
  - `class CampaignAgent` (fetch: one `CampaignOp` JSON → `CampaignReply` JSON; alarm: `tick()`, deletes all storage when a demo copy expires; always re-arms the alarm at `nextWakeAt()`)
  - `class QuotaAgent` (fetch: one `QuotaOp` JSON → result JSON), addressed by `idFromName("global")`
  - `budgetPort(env: Env): BudgetPort` (fails closed: any error → false → templates), `quotaPort(env: Env): QuotaPort`
  - npm scripts: `typecheck` (root + worker), `worker:dev`

Notes for the implementer:
- The DO classes do NOT extend anything and do NOT use the `agents` package. SQLite storage comes from the `new_sqlite_classes` migration.
- `src/worker/index.ts` in this task only answers `/api/health`; Task 9 wires the router.
- There is no Node unit test for these adapters (they need the Workers runtime). They are checked by the worker type-check, a `wrangler deploy --dry-run` bundle, a local `wrangler dev` health call here, and end to end by Task 11.

- [ ] **Step 1: Write the Worker config**

`wrangler.toml`:

```toml
name = "tip-the-room-api"
main = "src/worker/index.ts"
compatibility_date = "2026-10-01"

# One Durable Object per campaign, plus one singleton for the AI budget and rate limits. SQLite storage (free plan).
[[durable_objects.bindings]]
name = "CAMPAIGN"
class_name = "CampaignAgent"

[[durable_objects.bindings]]
name = "QUOTA"
class_name = "QuotaAgent"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["CampaignAgent", "QuotaAgent"]

[ai]
binding = "AI"

[vars]
ALLOWED_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"

# Local end-to-end check (npm run worker:dev / worker:check): same Durable Objects, no AI binding,
# so it needs no Cloudflare login and the agent uses its templates.
[env.check.vars]
ALLOWED_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"

[[env.check.durable_objects.bindings]]
name = "CAMPAIGN"
class_name = "CampaignAgent"

[[env.check.durable_objects.bindings]]
name = "QUOTA"
class_name = "QuotaAgent"
```

`tsconfig.worker.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src/worker/**/*.ts", "src/agent/**/*.ts", "src/core/**/*.ts", "src/paypal/**/*.ts"]
}
```

In `tsconfig.json`, add this key after `"include"` (the Cloudflare-typed files are checked by the worker config only):

```json
  "exclude": ["src/worker/env.ts", "src/worker/index.ts", "src/worker/quota-client.ts", "src/worker/do"]
```

In `package.json` `"scripts"`, replace `"typecheck"` and add `"worker:dev"`:

```json
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.worker.json",
    "worker:dev": "wrangler dev --local --env check --port 8788",
```

Append to `.dev.vars.example` (names only, no values):

```
# Plan 4 (optional). Webhooks are refused until PAYPAL_WEBHOOK_ID is set.
# PAYPAL_WEBHOOK_ID=
# Sandbox PERSONAL accounts that receive demo payouts (unset → example.com addresses that stay UNCLAIMED).
# PAYPAL_RECEIVER_ROOM=
# PAYPAL_RECEIVER_OPENER=
# PAYPAL_RECEIVER_ARTIST=
```

- [ ] **Step 2: Write the bindings type and the SQL adapter**

`src/worker/env.ts`:

```ts
/** The Workers AI binding, reduced to the one call we make. */
export interface WorkersAiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

/** Bindings and vars for the Worker and its Durable Objects. Secrets come from .dev.vars locally (never printed). */
export interface Env {
  CAMPAIGN: DurableObjectNamespace;
  QUOTA: DurableObjectNamespace;
  AI?: WorkersAiBinding;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_API_BASE?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_RECEIVER_ROOM?: string;
  PAYPAL_RECEIVER_OPENER?: string;
  PAYPAL_RECEIVER_ARTIST?: string;
  ALLOWED_ORIGINS?: string;
  RATE_SALT?: string;
}
```

`src/worker/do/sql-adapter.ts`:

```ts
import type { SqlDb, SqlRow, SqlValue } from "../../agent/sql";

/** ctx.storage → the SqlDb port. The cursor is read straight away, so writes run now (same as node:sqlite in tests). */
export function cfDb(storage: DurableObjectStorage): SqlDb {
  return {
    sql: {
      exec<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]) {
        const rows = storage.sql.exec(query, ...bindings).toArray() as unknown as T[];
        return { toArray: () => rows };
      },
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    },
  };
}
```

- [ ] **Step 3: Write the quota client and the two Durable Objects**

`src/worker/quota-client.ts`:

```ts
import type { BudgetPort } from "../agent/ai";
import type { QuotaOp, QuotaPort, RateResult } from "../agent/quota";
import type { Env } from "./env";

async function quotaCall<T>(env: Env, op: QuotaOp): Promise<T> {
  const stub = env.QUOTA.get(env.QUOTA.idFromName("global"));
  const res = await stub.fetch("https://quota/op", { method: "POST", body: JSON.stringify(op) });
  if (!res.ok) throw new Error(`quota answered ${res.status}`);
  return (await res.json()) as T;
}

/** Fails closed: if the budget can't be checked, the agent uses its templates. */
export function budgetPort(env: Env): BudgetPort {
  return {
    async tryReserve(neurons: number): Promise<boolean> {
      try {
        return (await quotaCall<{ ok: boolean }>(env, { op: "reserve", neurons })).ok === true;
      } catch {
        return false;
      }
    },
  };
}

export function quotaPort(env: Env): QuotaPort {
  return { hit: (key, limit, windowMs) => quotaCall<RateResult>(env, { op: "hit", key, limit, windowMs }) };
}
```

`src/worker/do/quota-agent.ts`:

```ts
import { Quota, quotaDispatch, type QuotaOp } from "../../agent/quota";
import { cfDb } from "./sql-adapter";

/** Singleton ("global"): the daily AI neuron budget and the per-visitor rate limits. */
export class QuotaAgent {
  private quota: Quota | null = null;

  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (!this.quota) {
      this.quota = new Quota(cfDb(this.ctx.storage));
      this.quota.migrate();
    }
    const op = (await request.json()) as QuotaOp;
    return Response.json(quotaDispatch(this.quota, op, Date.now()));
  }
}
```

`src/worker/do/campaign-agent.ts`:

```ts
import type { AiPort } from "../../agent/ai";
import { dispatch, type CampaignOp } from "../../agent/dispatch";
import { cryptoRandom, systemClock } from "../../agent/ids";
import { paypalPort, SIM_CARD } from "../../agent/paypal-port";
import { CampaignService } from "../../agent/service";
import { Store } from "../../agent/store";
import { loadConfig } from "../../paypal/config";
import { PayPalHttp } from "../../paypal/http";
import type { Env } from "../env";
import { budgetPort } from "../quota-client";
import { cfDb } from "./sql-adapter";

/** One campaign = one Durable Object with SQLite storage. A thin adapter: the logic is in CampaignService. */
export class CampaignAgent {
  private service: CampaignService | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private svc(): CampaignService {
    if (!this.service) {
      const config = loadConfig(this.env);
      const binding = this.env.AI;
      const ai: AiPort | null = binding ? { run: (model, input) => binding.run(model, input) } : null;
      this.service = new CampaignService({
        store: new Store(cfDb(this.ctx.storage)),
        paypal: paypalPort(new PayPalHttp(config)),
        clock: systemClock,
        ai: { ai, budget: budgetPort(this.env) },
        random: cryptoRandom,
        paypalClientId: config.clientId,
        card: SIM_CARD,
      });
    }
    return this.service;
  }

  async fetch(request: Request): Promise<Response> {
    let op: CampaignOp;
    try {
      op = (await request.json()) as CampaignOp;
    } catch {
      return Response.json({ ok: false, status: 400, error: { code: "bad_request", message: "That request isn't valid JSON." } });
    }
    const service = this.svc();
    const reply = await dispatch(service, op);
    await this.reschedule(service);
    return Response.json(reply);
  }

  async alarm(): Promise<void> {
    const service = this.svc();
    if (!service.exists()) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const { expired } = await service.tick();
    if (expired) {
      // A demo copy is 24 h old and has no money step left: delete everything it stored.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.service = null;
      return;
    }
    await this.reschedule(service);
  }

  private async reschedule(service: CampaignService): Promise<void> {
    if (!service.exists()) return;
    const at = service.nextWakeAt();
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }
}
```

`src/worker/index.ts` (health only for now):

```ts
import type { Env } from "./env";

export { CampaignAgent } from "./do/campaign-agent";
export { QuotaAgent } from "./do/quota-agent";

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/api/health") return Response.json({ ok: true });
    return Response.json({ error: { code: "not_found", message: "There's nothing here." } }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 4: Type-check both configs**

Run: `npm run typecheck`
Expected: no errors from either `tsc` run. If `DurableObjectState`, `DurableObjectStorage`, `DurableObjectNamespace` or `ExportedHandler` is reported missing, run `npx tsc --noEmit -p tsconfig.worker.json --traceResolution | grep workers-types | head` to confirm the package resolves, and report to the controller (do not install anything).

- [ ] **Step 5: Bundle without deploying**

Run: `npx wrangler deploy --dry-run --outdir .wrangler/dry-run`
Expected: ends with `--dry-run: exiting now.` and lists the bindings `env.CAMPAIGN (CampaignAgent)`, `env.QUOTA (QuotaAgent)` and `env.AI`. No login prompt. (`.wrangler/` is gitignored.)

- [ ] **Step 6: Start it locally and call health**

Start `npm run worker:dev` as a background process, logging to `.wrangler/worker-dev.log`. Wait until the log contains `Ready on http://`. Then run:

```bash
curl -s http://127.0.0.1:8788/api/health
```

Expected: `{"ok":true}`. Stop the dev server. If wrangler refuses to start because the `check` environment has no migrations, add this block to `wrangler.toml` under the `env.check` bindings and retry:

```toml
[[env.check.migrations]]
tag = "v1"
new_sqlite_classes = ["CampaignAgent", "QuotaAgent"]
```

Never print `.dev.vars` or the wrangler log lines that show variable values (wrangler masks secrets; do not unmask them).

- [ ] **Step 7: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add wrangler.toml tsconfig.json tsconfig.worker.json package.json .dev.vars.example src/worker
git commit -m "feat(worker): campaign and quota Durable Objects (SQLite, alarms), wrangler config, worker type-check

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Worker router: JSON API, manage key, CORS, rate limits, webhooks

**Files:**
- Create: `src/worker/router.ts`
- Modify: `src/worker/index.ts`
- Create: `tests/worker/harness.ts`, `tests/worker/router.test.ts`

**Interfaces:**
- Consumes: `dispatch`, `CampaignOp`, `CampaignReply`, `draftFromSentence`, `draftFields`, `previewDraft`, `ServiceError`, `isShowId`, `newId`, `newSecret`, `sha256Hex`, `showIdFromRef`, `Clock`, `Random`, `QuotaPort`, `AiDeps`, `mapWebhookEvent`, `verifyWebhook`, `PayPalLedgerEvent`, `WebhookEvent`, api-types; Task 8 `Env`, `budgetPort`, `quotaPort`, DO classes.
- Produces:
  - `interface CampaignsPort { call(showId: string, op: CampaignOp): Promise<CampaignReply> }`
  - `interface RouterConfig { allowedOrigins: string[]; webhookId: string | null; rateSalt: string }`
  - `interface RouterDeps { campaigns: CampaignsPort; quota: QuotaPort; ai: AiDeps; random: Random; clock: Clock; config: RouterConfig; verifyWebhook(headers: Headers, rawBody: string, webhookId: string): Promise<boolean> }`
  - `LIMITS` (per visitor per hour unless noted): createShow 10, sign 20, order 30, manage 240, demo 5, demoFans 12, demoGlobal 300/day (Task 10 uses the demo ones)
  - `class HttpError`, `route(req: Request, deps: RouterDeps): Promise<Response>`
  - Routes: `GET /api/health`, `POST /api/shows` (201), `POST /api/shows/:id/sign`, `GET /api/shows/:id`, `POST /api/shows/:id/orders` (201), `POST /api/shows/:id/orders/:orderId/authorize`, `GET /api/shows/:id/manage`, `POST /api/shows/:id/proposals/:pid/approve`, `POST /api/shows/:id/call-off`, `POST /api/webhooks/paypal`
  - Tests: `workerHarness(opts?)` → `{ deps, clock, paypal, shows, call(method, path, body?, headers?) }`

**Rules this task makes testable:**
1. The manage key travels only in the `x-manage-key` header and is checked inside the campaign (hash compare).
2. Per-visitor fixed-window rate limits (visitor = SHA-256 of a salt + `cf-connecting-ip`); 429 carries `Retry-After`.
3. Bodies over 16 KB (webhooks 64 KB) are refused with 413; invalid JSON with 400; ids are format-checked before reaching a Durable Object.
4. Webhooks: refused (403) when `PAYPAL_WEBHOOK_ID` is unset; 400 on a failed signature; 502 when verification itself fails (PayPal redelivers); routed by `custom_id` / `sender_item_id` / `sender_batch_id`; unknown shows and unmappable events are acknowledged (200) and ignored; a known PayPal event type that maps to null is logged (`console.warn`, ids only).

- [ ] **Step 1: Write the router harness**

`tests/worker/harness.ts`:

```ts
import { dispatch, type CampaignOp, type CampaignReply } from "../../src/agent/dispatch";
import { Quota } from "../../src/agent/quota";
import type { CampaignService } from "../../src/agent/service";
import type { Store } from "../../src/agent/store";
import { route, type RouterDeps } from "../../src/worker/router";
import { FakePayPal } from "../agent/fake-paypal";
import { LAUNCH, seqRandom, TestClock } from "../agent/fixtures";
import { makeService } from "../agent/harness";
import { memoryDb } from "../agent/sqlite";

export interface WorkerHarnessOptions {
  webhookId?: string | null;
  verify?: (headers: Headers, rawBody: string, webhookId: string) => Promise<boolean>;
}

/** The router with in-process "Durable Objects": one CampaignService per show id, JSON round-tripped like the real boundary. */
export function workerHarness(opts: WorkerHarnessOptions = {}) {
  const clock = new TestClock(LAUNCH);
  const paypal = new FakePayPal(clock);
  const shows = new Map<string, { svc: CampaignService; store: Store }>();
  const quota = new Quota(memoryDb());
  quota.migrate();
  const deps: RouterDeps = {
    campaigns: {
      async call(showId: string, op: CampaignOp): Promise<CampaignReply> {
        let s = shows.get(showId);
        if (!s) {
          const h = makeService({ clock, paypal });
          s = { svc: h.svc, store: h.store };
          shows.set(showId, s);
        }
        return JSON.parse(JSON.stringify(await dispatch(s.svc, JSON.parse(JSON.stringify(op)) as CampaignOp))) as CampaignReply;
      },
    },
    quota: { hit: async (key, limit, windowMs) => quota.hit(key, limit, windowMs, clock.now()) },
    ai: { ai: null, budget: { tryReserve: async () => true } },
    random: seqRandom(),
    clock,
    config: { allowedOrigins: ["http://localhost:5173"], webhookId: opts.webhookId ?? null, rateSalt: "test-salt" },
    verifyWebhook: opts.verify ?? (async () => false),
  };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    route(
      new Request(`http://api.test${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
      deps,
    );
  return { deps, clock, paypal, shows, call };
}
```

- [ ] **Step 2: Write the failing router tests**

`tests/worker/router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AuthorizeResponse, CreateOrderResponse, CreateShowResponse, ManageView, PublicShow, SignResponse } from "../../src/worker/api-types";
import { workerHarness } from "./harness";

const SENTENCE = "Acoustic set at Lucky's Café, Nov 20, $15 tickets, café wants $100, I need $200";

async function createAndSign(w: ReturnType<typeof workerHarness>) {
  const created = await w.call("POST", "/api/shows", { sentence: SENTENCE, deadline: "2026-11-08T00:00:00Z", emails: { room: "room@example.com", artist: "maya@example.com" } });
  const c = (await created.json()) as CreateShowResponse;
  const signed = await w.call("POST", `/api/shows/${c.showId}/sign`, { signToken: c.signToken, draft: c.draft });
  return { created, c, signed, s: (await signed.json()) as SignResponse };
}

describe("router", () => {
  it("answers health", async () => {
    const res = await workerHarness().call("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("creates a draft (code computes the target), signs it once, and serves the public show without emails", async () => {
    const w = workerHarness();
    const { created, c, signed, s } = await createAndSign(w);
    expect(created.status).toBe(201);
    expect(c).toMatchObject({ threshold: 21, problems: [], source: "template", draft: { showName: "Acoustic set", ticketPriceCents: 1500 } });
    expect(signed.status).toBe(200);
    expect(s.manageKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const show = await w.call("GET", `/api/shows/${c.showId}`);
    const text = await show.text();
    expect(show.status).toBe(200);
    expect(text).not.toContain("@");
    expect((JSON.parse(text) as PublicShow).threshold).toBe(21);
  });

  it("refuses a too-short sentence", async () => {
    const res = await workerHarness().call("POST", "/api/shows", { sentence: "hi" });
    expect(res.status).toBe(422);
  });

  it("answers 404 for bad and unknown show ids without touching a campaign", async () => {
    const w = workerHarness();
    expect((await w.call("GET", "/api/shows/NOT-AN-ID")).status).toBe(404);
    const unknown = await w.call("GET", "/api/shows/sabcdefghjk");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: "not_found", message: "There's no show here." } });
  });

  it("takes a pledge end to end and never authorizes an order id the show didn't create", async () => {
    const w = workerHarness();
    const { c } = await createAndSign(w);
    const orderRes = await w.call("POST", `/api/shows/${c.showId}/orders`, { initials: "AB" });
    expect(orderRes.status).toBe(201);
    const order = (await orderRes.json()) as CreateOrderResponse;
    const auth = await w.call("POST", `/api/shows/${c.showId}/orders/${order.orderId}/authorize`);
    expect(auth.status).toBe(200);
    expect(((await auth.json()) as AuthorizeResponse).show.fans.committed).toBe(1);
    const forged = await w.call("POST", `/api/shows/${c.showId}/orders/5O190127TN364715T/authorize`);
    expect(forged.status).toBe(404);
    expect(w.paypal.count("authorizeOrder")).toBe(1);
  });

  it("guards the manage view and the artist's actions with the manage key header", async () => {
    const w = workerHarness();
    const { c, s } = await createAndSign(w);
    expect((await w.call("GET", `/api/shows/${c.showId}/manage`)).status).toBe(403);
    const ok = await w.call("GET", `/api/shows/${c.showId}/manage`, undefined, { "x-manage-key": s.manageKey });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ManageView).parties[0].paypalEmail).toBe("room@example.com");
    expect((await w.call("POST", `/api/shows/${c.showId}/call-off`)).status).toBe(403);
    expect((await w.call("POST", `/api/shows/${c.showId}/proposals/pace1/approve`, { option: "extend" })).status).toBe(403);
  });

  it("rate-limits each visitor and says when to retry", async () => {
    const w = workerHarness();
    for (let i = 0; i < 10; i++) expect((await w.call("POST", "/api/shows", { sentence: SENTENCE })).status).toBe(201);
    const limited = await w.call("POST", "/api/shows", { sentence: SENTENCE });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited", retryAfterSec: 3600 } });
    expect((await w.call("POST", "/api/shows", { sentence: SENTENCE }, { "cf-connecting-ip": "203.0.113.9" })).status).toBe(201);
  });

  it("refuses invalid JSON and oversized bodies", async () => {
    const w = workerHarness();
    expect((await w.call("POST", "/api/shows", "{not json")).status).toBe(400);
    expect((await w.call("POST", "/api/shows", JSON.stringify({ sentence: "x".repeat(17_000) }))).status).toBe(413);
  });

  it("sends CORS headers only to allowed origins and answers preflight", async () => {
    const w = workerHarness();
    const allowed = await w.call("GET", "/api/health", undefined, { origin: "http://localhost:5173" });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await w.call("GET", "/api/health", undefined, { origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await w.call("OPTIONS", "/api/shows", undefined, { origin: "http://localhost:5173" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-manage-key");
  });

  it("answers 404 for unknown paths and wrong methods", async () => {
    const w = workerHarness();
    expect((await w.call("GET", "/api/nope")).status).toBe(404);
    expect((await w.call("DELETE", "/api/health")).status).toBe(404);
  });
});

describe("PayPal webhooks", () => {
  const event = (showId: string, id = "WH-1") => ({ id, event_type: "PAYMENT.AUTHORIZATION.CREATED", create_time: "2026-11-01T00:00:00Z", resource: { id: "A1", custom_id: `${showId}:p1`, amount: { currency_code: "USD", value: "15.00" } } });

  it("are refused when PAYPAL_WEBHOOK_ID is not set", async () => {
    const res = await workerHarness().call("POST", "/api/webhooks/paypal", event("sabcdefghjk"));
    expect(res.status).toBe(403);
  });

  it("are refused when the signature check fails, and 502 when PayPal can't be asked", async () => {
    expect((await workerHarness({ webhookId: "WH-ID", verify: async () => false }).call("POST", "/api/webhooks/paypal", event("sabcdefghjk"))).status).toBe(400);
    const down = workerHarness({
      webhookId: "WH-ID",
      verify: async () => {
        throw new Error("network");
      },
    });
    expect((await down.call("POST", "/api/webhooks/paypal", event("sabcdefghjk"))).status).toBe(502);
  });

  it("route a verified event to its show by custom_id, once", async () => {
    const seen: string[] = [];
    const w = workerHarness({
      webhookId: "WH-ID",
      verify: async (_h, raw, id) => {
        seen.push(id);
        return raw.includes("PAYMENT.");
      },
    });
    const { c } = await createAndSign(w);
    const res = await w.call("POST", "/api/webhooks/paypal", event(c.showId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual(["WH-ID"]);
    const store = w.shows.get(c.showId)!.store;
    expect(store.events().filter((e) => e.event.type === "webhook_received")).toHaveLength(1);
  });

  it("acknowledge and ignore events for unknown shows or unknown types", async () => {
    const w = workerHarness({ webhookId: "WH-ID", verify: async () => true });
    expect(await (await w.call("POST", "/api/webhooks/paypal", event("sabcdefghjk"))).json()).toEqual({ ignored: true });
    expect(await (await w.call("POST", "/api/webhooks/paypal", { ...event("sabcdefghjk"), event_type: "CHECKOUT.ORDER.APPROVED" })).json()).toEqual({ ignored: true });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run tests/worker`
Expected: FAIL with "Cannot find module '../../src/worker/router'".

- [ ] **Step 4: Write `src/worker/router.ts`**

```ts
import type { AiDeps } from "../agent/ai";
import { draftFromSentence } from "../agent/ai-jobs";
import type { CampaignOp, CampaignReply } from "../agent/dispatch";
import { draftFields, previewDraft } from "../agent/draft";
import { ServiceError } from "../agent/errors";
import { isShowId, newId, newSecret, sha256Hex, showIdFromRef, type Clock, type Random } from "../agent/ids";
import type { QuotaPort } from "../agent/quota";
import { mapWebhookEvent, type PayPalLedgerEvent, type WebhookEvent } from "../paypal/webhooks";
import { MANAGE_KEY_HEADER, type ApiError, type CreateShowRequest, type CreateShowResponse, type ErrorCode } from "./api-types";

export interface CampaignsPort {
  call(showId: string, op: CampaignOp): Promise<CampaignReply>;
}

export interface RouterConfig {
  allowedOrigins: string[];
  /** Null when PAYPAL_WEBHOOK_ID is unset: webhooks are then refused. */
  webhookId: string | null;
  rateSalt: string;
}

export interface RouterDeps {
  campaigns: CampaignsPort;
  quota: QuotaPort;
  ai: AiDeps;
  random: Random;
  clock: Clock;
  config: RouterConfig;
  verifyWebhook(headers: Headers, rawBody: string, webhookId: string): Promise<boolean>;
}

const HOUR = 60 * 60 * 1000;
/** Spec 8: per-visitor limits (fixed windows) plus a global cap on new demo copies. */
export const LIMITS = {
  createShow: { limit: 10, windowMs: HOUR },
  sign: { limit: 20, windowMs: HOUR },
  order: { limit: 30, windowMs: HOUR },
  manage: { limit: 240, windowMs: HOUR },
  demo: { limit: 5, windowMs: HOUR },
  demoFans: { limit: 12, windowMs: HOUR },
  demoGlobal: { limit: 300, windowMs: 24 * HOUR },
} as const;
type LimitName = keyof typeof LIMITS;

const MAX_BODY = 16_384;
const MAX_WEBHOOK_BODY = 65_536;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface Ctx {
  req: Request;
  deps: RouterDeps;
  params: string[];
}
type Handler = (c: Ctx) => Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function errorBody(code: ErrorCode, message: string, extra: Partial<ApiError["error"]> = {}): ApiError {
  return { error: { code, message, ...extra } };
}

async function readText(req: Request, max: number): Promise<string> {
  if (Number(req.headers.get("content-length") ?? "0") > max) throw new HttpError(413, "too_large", "That request is too large.");
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "too_large", "That request is too large.");
  return text;
}

async function readJson<T>(req: Request): Promise<T> {
  const text = await readText(req, MAX_BODY);
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw new HttpError(400, "bad_request", "That request isn't valid JSON.");
  }
}

function fromReply(reply: CampaignReply, okStatus = 200): Response {
  return reply.ok ? json(okStatus, reply.data) : json(reply.status, { error: reply.error });
}

async function visitor(c: Ctx): Promise<string> {
  const ip = c.req.headers.get("cf-connecting-ip") ?? "local";
  return (await sha256Hex(`${c.deps.config.rateSalt}|${ip}`)).slice(0, 24);
}

async function limit(c: Ctx, name: LimitName, scope?: string): Promise<void> {
  const l = LIMITS[name];
  const r = await c.deps.quota.hit(`${name}:${scope ?? (await visitor(c))}`, l.limit, l.windowMs);
  if (!r.ok) throw new HttpError(429, "rate_limited", "Too many tries. Please wait a moment and try again.", r.retryAfterSec);
}

function showParam(c: Ctx): string {
  const id = c.params[0];
  if (!isShowId(id)) throw new HttpError(404, "not_found", "There's no show here.");
  return id;
}

const manageKey = (c: Ctx) => c.req.headers.get(MANAGE_KEY_HEADER);

const createShow: Handler = async (c) => {
  await limit(c, "createShow");
  const body = await readJson<CreateShowRequest>(c.req);
  if (!body || typeof body.sentence !== "string" || body.sentence.trim().length < 5 || body.sentence.length > 500) {
    throw new HttpError(422, "invalid", "Describe the show in one sentence (5 to 500 characters).");
  }
  const now = c.deps.clock.now();
  const suggestion = await draftFromSentence(c.deps.ai, body.sentence, now);
  const showId = newId("s", c.deps.random);
  const signToken = newSecret(c.deps.random);
  const reply = await c.deps.campaigns.call(showId, { op: "init", showId, signTokenHash: await sha256Hex(signToken) });
  if (!reply.ok) return fromReply(reply);
  const draft = draftFields(suggestion.value, body, now);
  const preview = previewDraft(showId, draft, now);
  const res: CreateShowResponse = { showId, signToken, draft, threshold: preview.threshold, problems: preview.problems, source: suggestion.source };
  return json(201, res);
};

const sign: Handler = async (c) => {
  await limit(c, "sign");
  const id = showParam(c);
  return fromReply(await c.deps.campaigns.call(id, { op: "sign", body: await readJson(c.req) }));
};

const getShow: Handler = async (c) => fromReply(await c.deps.campaigns.call(showParam(c), { op: "public" }));

const createOrder: Handler = async (c) => {
  await limit(c, "order");
  const id = showParam(c);
  return fromReply(await c.deps.campaigns.call(id, { op: "order", body: await readJson(c.req) }), 201);
};

const authorize: Handler = async (c) => {
  await limit(c, "order");
  const id = showParam(c);
  return fromReply(await c.deps.campaigns.call(id, { op: "authorize", orderId: c.params[1] }));
};

const manage: Handler = async (c) => {
  await limit(c, "manage");
  return fromReply(await c.deps.campaigns.call(showParam(c), { op: "manage", manageKey: manageKey(c) }));
};

const approve: Handler = async (c) => {
  await limit(c, "manage");
  const id = showParam(c);
  return fromReply(await c.deps.campaigns.call(id, { op: "approve", manageKey: manageKey(c), proposalId: c.params[1], body: await readJson(c.req) }));
};

const callOff: Handler = async (c) => {
  await limit(c, "manage");
  return fromReply(await c.deps.campaigns.call(showParam(c), { op: "call_off", manageKey: manageKey(c) }));
};

const paypalWebhook: Handler = async (c) => {
  const webhookId = c.deps.config.webhookId;
  if (!webhookId) return json(403, errorBody("forbidden", "Webhooks are not configured."));
  const raw = await readText(c.req, MAX_WEBHOOK_BODY);
  let genuine: boolean;
  try {
    genuine = await c.deps.verifyWebhook(c.req.headers, raw, webhookId);
  } catch {
    return json(502, errorBody("unavailable", "Couldn't verify the message with PayPal. Please retry."));
  }
  if (!genuine) return json(400, errorBody("bad_request", "The signature check failed."));
  let event: WebhookEvent;
  try {
    event = JSON.parse(raw) as WebhookEvent;
  } catch {
    return json(200, { ignored: true });
  }
  let mapped: PayPalLedgerEvent | null;
  try {
    mapped = mapWebhookEvent(event);
  } catch {
    console.warn(`webhook ${String(event?.id)} (${String(event?.event_type)}) has an unexpected amount or currency; ignored`);
    return json(200, { ignored: true });
  }
  if (!mapped) {
    if (typeof event?.event_type === "string" && event.event_type.startsWith("PAYMENT.")) {
      console.warn(`webhook ${String(event.id)} (${event.event_type}) could not be mapped (missing id, reference or time); ignored`);
    }
    return json(200, { ignored: true });
  }
  const showId = mapped.customId ? showIdFromRef(mapped.customId) : null;
  if (!showId) return json(200, { ignored: true });
  const reply = await c.deps.campaigns.call(showId, { op: "webhook", event: mapped });
  if (reply.ok) return json(200, { ok: true });
  if (reply.status === 404) return json(200, { ignored: true });
  return json(500, errorBody("internal", "Couldn't record that message yet. Please retry."));
};

const ROUTES: { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: "GET", pattern: /^\/api\/health$/, handler: async () => json(200, { ok: true }) },
  { method: "POST", pattern: /^\/api\/shows$/, handler: createShow },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/sign$/, handler: sign },
  { method: "GET", pattern: /^\/api\/shows\/([a-z0-9]+)$/, handler: getShow },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/orders$/, handler: createOrder },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/orders\/([A-Za-z0-9-]+)\/authorize$/, handler: authorize },
  { method: "GET", pattern: /^\/api\/shows\/([a-z0-9]+)\/manage$/, handler: manage },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/proposals\/([a-z0-9]+)\/approve$/, handler: approve },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/call-off$/, handler: callOff },
  { method: "POST", pattern: /^\/api\/webhooks\/paypal$/, handler: paypalWebhook },
];

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": `content-type, ${MANAGE_KEY_HEADER}`,
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const retry = e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {};
    return json(e.status, errorBody(e.code, e.message, retry), e.retryAfterSec ? { "retry-after": String(e.retryAfterSec) } : {});
  }
  if (e instanceof ServiceError) return json(e.status, errorBody(e.code, e.message, e.problems ? { problems: e.problems } : {}));
  return json(500, errorBody("internal", "Something went wrong on our side."));
}

export async function route(req: Request, deps: RouterDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), deps.config.allowedOrigins);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const path = new URL(req.url).pathname;
  for (const r of ROUTES) {
    const m = r.pattern.exec(path);
    if (!m || r.method !== req.method) continue;
    try {
      return withHeaders(await r.handler({ req, deps, params: m.slice(1) }), cors);
    } catch (e) {
      return withHeaders(errorResponse(e), cors);
    }
  }
  return withHeaders(json(404, errorBody("not_found", "There's nothing here.")), cors);
}
```

- [ ] **Step 5: Wire the router into `src/worker/index.ts`**

Replace the file with:

```ts
import type { CampaignOp, CampaignReply } from "../agent/dispatch";
import { cryptoRandom, systemClock } from "../agent/ids";
import { loadConfig } from "../paypal/config";
import { PayPalHttp } from "../paypal/http";
import { verifyWebhook } from "../paypal/webhooks";
import type { Env } from "./env";
import { budgetPort, quotaPort } from "./quota-client";
import { route, type CampaignsPort, type RouterDeps } from "./router";

export { CampaignAgent } from "./do/campaign-agent";
export { QuotaAgent } from "./do/quota-agent";

function campaigns(env: Env): CampaignsPort {
  return {
    async call(showId: string, op: CampaignOp): Promise<CampaignReply> {
      const stub = env.CAMPAIGN.get(env.CAMPAIGN.idFromName(showId));
      const res = await stub.fetch("https://campaign/op", { method: "POST", body: JSON.stringify(op) });
      return (await res.json()) as CampaignReply;
    },
  };
}

function routerDeps(env: Env): RouterDeps {
  const binding = env.AI;
  return {
    campaigns: campaigns(env),
    quota: quotaPort(env),
    ai: { ai: binding ? { run: (model, input) => binding.run(model, input) } : null, budget: budgetPort(env) },
    random: cryptoRandom,
    clock: systemClock,
    config: {
      allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || null,
      rateSalt: env.RATE_SALT ?? "tip-the-room",
    },
    verifyWebhook: (headers, rawBody, webhookId) => verifyWebhook(new PayPalHttp(loadConfig(env)), headers, rawBody, webhookId),
  };
}

export default {
  fetch: (request: Request, env: Env) => route(request, routerDeps(env)),
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/worker tests/agent`
Expected: PASS.

- [ ] **Step 7: Smoke-test the real Worker locally**

Start `npm run worker:dev` in the background (log to `.wrangler/worker-dev.log`), wait for `Ready on http://`, then:

```bash
curl -s -X POST http://127.0.0.1:8788/api/shows -H 'content-type: application/json' \
  -d '{"sentence":"Acoustic set at Lucky'"'"'s Café, Nov 20, $15 tickets, café wants $100, I need $200"}' | head -c 300
```

Expected: JSON starting `{"showId":"s` with `"threshold":21` and `"source":"template"`. Stop the dev server.

- [ ] **Step 8: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add src/worker tests/worker
git commit -m "feat(worker): JSON API router with manage key, CORS, rate limits and verified webhooks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Judge demo: per-visitor copies, simulated fans as real sandbox card holds, fast-forward, reset, 24 h expiry, re-hold

**Files:**
- Create: `src/agent/demo.ts`, `src/agent/sim-runner.ts`
- Modify: `src/agent/runners.ts`, `src/agent/service.ts`, `src/agent/dispatch.ts`, `src/worker/router.ts`, `src/worker/index.ts`, `tests/worker/harness.ts`
- Create: `tests/agent/demo.test.ts`, `tests/agent/sim-runner.test.ts`, `tests/worker/router-demo.test.ts`

**Interfaces:**
- Consumes: everything above; `createCardHold` via `PayPalPort`; `SIM_CARD`; policy `DEMO_TTL_MS`, `DEMO_GRACE_MS`, `DEMO_MAX_GRACES`, `SIM_CAP_PER_SHOW`, `SIM_ADD_MAX`, `REHOLD_MARGIN_MS`, `MONEY_JOBS`; `demoShowIds`, `isDemoId`.
- Produces:
  - `demo.ts`: `interface Receivers { room: string; opener: string; artist: string }`, `receiversFrom(env: { PAYPAL_RECEIVER_ROOM?; PAYPAL_RECEIVER_OPENER?; PAYPAL_RECEIVER_ARTIST? }): Receivers`, `interface DemoSeed { key: "a" | "b"; draft: Omit<MandateDraft, "showId" | "launchedAt" | "deadline" | "showDate">; windowMs: number; startFans: number }`, `demoSeeds(r: Receivers): [DemoSeed, DemoSeed]`
  - `sim-runner.ts`: `SIM_INITIALS: string[]`, `SIM_RUNNERS: Runners` (`sim_hold`, `rehold`)
  - `CampaignService.initDemo({ showId, seed, demoKeyHash }): Promise<PublicShow>`, `addSimFans(count: unknown): DemoFansResponse`, `fastForward(topUp: boolean): PublicShow`, `retire(): { retired: true }`; `tick()` now also handles fast-forward, re-hold planning and expiry; `nextWakeAt()` includes the demo expiry
  - `CampaignOp` gains `demo_init`, `demo_fans`, `demo_ff`, `demo_retire`
  - `RouterConfig` gains `receivers: Receivers`; routes `POST /api/demo` (201 `DemoResponse`), `POST /api/demo/:id/fans` (`DemoFansRequest` → `DemoFansResponse`), `POST /api/demo/:id/fast-forward` (`DemoFastForwardResponse`), `POST /api/demo/:id/reset` (201 `DemoResponse`, a NEW copy)

**Rules this task makes testable:**
1. Simulated fans are REAL sandbox holds (`createCardHold` with the sandbox test card, no buyer login). Never a fake PayPal id.
2. A hold counts only when `status === "CREATED"` and the amount equals the ticket price. A declined pledge id is never reused: one retry with a NEW pledge id (`<pledgeId>-r1`, so a new `PayPal-Request-Id`), then give up.
3. Hold expiry: a simulated hold within `REHOLD_MARGIN_MS` (2 days) of expiring is renewed with a fresh card hold under a new pledge id (`<pledgeId>-h<n>`) first, then the old hold is voided. The fan's counts never change.
4. Caps: at most `SIM_ADD_MAX` (20) per request and `SIM_CAP_PER_SHOW` (60) per demo show; demo creation limited per visitor (5/h) and globally (300/day).
5. Each visitor gets a private copy (`d<10 chars>` + `a`/`b`), keyed by a demo key whose hash is stored. Copies expire 24 h after creation: a live show is first jumped to its deadline (holds voided), the alarm waits up to 3 × 1 h for money jobs, then deletes the storage.
6. Fast-forward: show A is topped up to its target with simulated holds, and once they are all seated the demo clock jumps past the deadline (A pays out); show B jumps straight away (B misses and every hold is voided).

- [ ] **Step 1: Write the failing tests**

`tests/agent/sim-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/holds";
import { commit, drain, type ExecDeps } from "../../src/agent/executor";
import { SIM_CARD } from "../../src/agent/paypal-port";
import { RUNNERS } from "../../src/agent/runners";
import { Store } from "../../src/agent/store";
import { FakePayPal } from "./fake-paypal";
import { LAUNCH, signedEvent, SHOW, TestClock } from "./fixtures";
import { memoryDb } from "./sqlite";

async function withSimHold(expiresAt: number) {
  const store = new Store(memoryDb());
  store.migrate();
  const clock = new TestClock(LAUNCH);
  const paypal = new FakePayPal(clock);
  const d: ExecDeps = { store, paypal, clock, showId: SHOW, card: SIM_CARD };
  commit(store, LAUNCH, await signedEvent());
  commit(store, LAUNCH, { type: "pledge_held", pledgeId: "p1", orderId: "O1", authorizationId: "A1", amountCents: 1500, authorizedAt: LAUNCH, expiresAt, initials: "JR", simulated: true });
  store.putJob({ key: "rehold:A1", kind: "rehold", target: "p1", nextAt: expiresAt - 2 * DAY_MS }, LAUNCH);
  return { store, clock, paypal, d };
}

describe("re-hold before expiry", () => {
  it("does nothing before it is due, and moves the job to the due time", async () => {
    const h = await withSimHold(LAUNCH + 3 * DAY_MS);
    h.store.updateJob("rehold:A1", { nextAt: LAUNCH });
    await drain(h.d, RUNNERS);
    expect(h.paypal.count("createCardHold")).toBe(0);
    expect(h.store.job("rehold:A1")).toMatchObject({ status: "pending", nextAt: LAUNCH + DAY_MS });
  });

  it("creates a fresh hold under a new pledge id first, then voids the OLD hold; counts never change", async () => {
    const h = await withSimHold(LAUNCH + 3 * DAY_MS);
    h.clock.t = LAUNCH + DAY_MS;
    await drain(h.d, RUNNERS);
    await drain(h.d, RUNNERS);
    const card = h.paypal.calls.find((c) => c.op === "createCardHold");
    expect(card?.args).toEqual([{ showId: SHOW, pledgeId: "p1-h1", amountCents: 1500, description: "Hold for Acoustic Set at Lucky's Café" }, SIM_CARD]);
    expect(h.paypal.calls.filter((c) => c.op === "voidHold").map((c) => c.args[0])).toEqual(["A1"]);
    const p = h.store.projection();
    expect(p.pledges.get("p1")).toMatchObject({ authorizationId: "A-p1-h1", paypalPledgeId: "p1-h1", status: "held" });
    expect(p.retired.get("A1")).toMatchObject({ why: "replaced", voided: true });
    expect(p.campaign.pledges).toMatchObject({ held: 1, released: 0 });
  });

  it("keeps the old hold when PayPal refuses the renewal", async () => {
    const h = await withSimHold(LAUNCH + 3 * DAY_MS);
    h.clock.t = LAUNCH + DAY_MS;
    h.paypal.script("createCardHold", (p: { pledgeId: string }) => ({ authorizationId: `A-${p.pledgeId}`, orderId: "O9", amountCents: 1500, status: "DENIED", createdAt: 0, expiresAt: 0 }));
    await drain(h.d, RUNNERS);
    expect(h.store.projection().pledges.get("p1")?.authorizationId).toBe("A1");
    expect(h.store.job("rehold:A1")?.status).toBe("failed");
    expect(h.paypal.count("voidHold")).toBe(0);
  });
});
```

`tests/agent/demo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/holds";
import { splitPayout } from "../../src/core/split";
import { demoSeeds, receiversFrom } from "../../src/agent/demo";
import { sha256Hex } from "../../src/agent/ids";
import { SIM_CARD } from "../../src/agent/paypal-port";
import type { HarnessOptions } from "./harness";
import { makeService } from "./harness";
import { LAUNCH } from "./fixtures";

const DEMO_KEY = "demo-key-for-tests-0123456789abc";

async function demoShow(key: "a" | "b", opts: HarnessOptions = {}) {
  const h = makeService(opts);
  h.svc.ensureSchema();
  const seed = demoSeeds(receiversFrom({}))[key === "a" ? 0 : 1];
  const show = await h.svc.initDemo({ showId: `dshowtestaa${key}`, seed, demoKeyHash: await sha256Hex(DEMO_KEY) });
  return { ...h, show, seed };
}

/** Ticks, moving the real clock to each next job, while that job is less than an hour away. */
async function run(h: Awaited<ReturnType<typeof demoShow>>, maxSteps = 300) {
  for (let i = 0; i < maxSteps; i++) {
    await h.svc.tick();
    const next = h.store.nextJobAt();
    if (next === undefined) return;
    const real = next - h.svc.clockOffset();
    if (real > h.clock.t + 60 * 60 * 1000) return;
    h.clock.t = Math.max(h.clock.t, real);
  }
}

describe("demo seeds and receivers", () => {
  it("seeds the two reference shows: 34 fans at $15 and 28 fans at $12", async () => {
    const a = await demoShow("a");
    const b = await demoShow("b");
    expect([a.show.threshold, a.show.ticketPriceCents, a.show.demo]).toEqual([34, 1500, true]);
    expect([b.show.threshold, b.show.ticketPriceCents]).toEqual([28, 1200]);
    expect(a.seed.startFans).toBe(29);
    expect(b.seed.startFans).toBe(19);
  });

  it("pays example.com receivers unless real sandbox receivers are configured", () => {
    expect(receiversFrom({})).toEqual({ room: "tip-the-room-room@example.com", opener: "tip-the-room-opener@example.com", artist: "tip-the-room-artist@example.com" });
    expect(receiversFrom({ PAYPAL_RECEIVER_ROOM: " room-sb@personal.example ", PAYPAL_RECEIVER_ARTIST: "not an email" })).toMatchObject({ room: "room-sb@personal.example", artist: "tip-the-room-artist@example.com" });
  });
});

describe("simulated fans", () => {
  it("seats the starting fans as real sandbox card holds", async () => {
    const h = await demoShow("a");
    await run(h);
    const p = h.svc.project();
    expect(p.campaign.pledges.held).toBe(29);
    expect([...p.pledges.values()].every((x) => x.simulated)).toBe(true);
    expect(h.paypal.count("createCardHold")).toBe(29);
    expect(h.paypal.calls.find((c) => c.op === "createCardHold")?.args[1]).toEqual(SIM_CARD);
    expect(h.store.getMeta("expires_at")).toBe(String(LAUNCH + DAY_MS));
  });

  it("retries a declined fan once with a NEW pledge id, then gives up", async () => {
    const h = await demoShow("b");
    const first = h.store.jobs()[0].target;
    h.paypal.script("createCardHold", (p: { pledgeId: string }) => ({ authorizationId: `A-${p.pledgeId}`, orderId: `O-${p.pledgeId}`, amountCents: 1200, status: "DENIED", createdAt: 0, expiresAt: 0 }));
    await run(h);
    let p = h.svc.project();
    expect(p.campaign.pledges.held).toBe(19);
    expect(p.pledges.has(`${first}-r1`)).toBe(true);
    expect(p.rejected).toBe(1);

    const g = await demoShow("b");
    const firstG = g.store.jobs()[0].target;
    for (let i = 0; i < 40; i++) {
      g.paypal.script("createCardHold", (q: { pledgeId: string; amountCents: number }) => ({ authorizationId: `A-${q.pledgeId}`, orderId: `O-${q.pledgeId}`, amountCents: q.amountCents, status: q.pledgeId.startsWith(firstG) ? "DENIED" : "CREATED", createdAt: 0, expiresAt: 29 * DAY_MS }));
    }
    await run(g);
    p = g.svc.project();
    expect(p.campaign.pledges.held).toBe(18);
    expect(g.store.logs().some((l) => l.did.startsWith("Gave up on this simulated fan"))).toBe(true);
  });

  it("caps simulated fans per request and per show", async () => {
    const h = await demoShow("a");
    expect(() => h.svc.addSimFans(21)).toThrow(/between 1 and 20/);
    expect(() => h.svc.addSimFans(0)).toThrow(/between 1 and 20/);
    expect(h.svc.addSimFans(20).queued).toBe(20);
    expect(() => h.svc.addSimFans(20)).toThrow(/at most 60/);
  });

  it("plans a re-hold for every seated simulated fan", async () => {
    const h = await demoShow("b");
    await run(h);
    const reholds = h.store.jobs().filter((j) => j.kind === "rehold");
    expect(reholds).toHaveLength(19);
    expect(reholds[0].nextAt).toBe(LAUNCH + 27 * DAY_MS);
  });
});

describe("fast-forward", () => {
  it("tops show A up to its target, charges everyone at tipping, then pays out at the jumped deadline", async () => {
    const h = await demoShow("a");
    await run(h);
    const before = h.svc.fastForward(true);
    expect(before.state).toBe("live");
    await run(h);
    const p = h.svc.project();
    expect(p.campaign.state).toBe("settled");
    expect(p.campaign.pledges.charged).toBe(34);
    expect(h.paypal.count("sendPayouts")).toBe(1);
    expect(h.paypal.calls.find((c) => c.op === "sendPayouts")?.args[1]).toEqual(splitPayout(34 * 1412, p.mandate!.parties).lines);
    expect(p.payouts[0].senderBatchId).toBe("payout-dshowtestaaa");
  });

  it("makes show B miss and voids every hold", async () => {
    const h = await demoShow("b");
    await run(h);
    expect(h.svc.fastForward(false).state).toBe("missed");
    await run(h);
    const p = h.svc.project();
    expect(p.campaign.pledges).toMatchObject({ held: 0, released: 19 });
    expect(p.notes?.length).toBe(3);
  });
});

describe("expiry", () => {
  it("voids a live copy's holds at 24 h, waits for the voids, then expires", async () => {
    const h = await demoShow("b");
    await run(h);
    h.clock.t = LAUNCH + DAY_MS;
    expect(await h.svc.tick()).toEqual({ expired: false });
    expect(h.svc.project().campaign.state).toBe("missed");
    await run(h);
    expect(h.svc.project().campaign.pledges.held).toBe(0);
    h.clock.t = Number(h.store.getMeta("expires_at"));
    expect(await h.svc.tick()).toEqual({ expired: true });
  });

  it("refuses demo controls on a real show", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: "sshowtestaa", signTokenHash: "x" });
    expect(() => h.svc.addSimFans(1)).toThrow(/only in the demo/);
  });
});
```

`tests/worker/router-demo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DemoFansResponse, DemoResponse } from "../../src/worker/api-types";
import { workerHarness } from "./harness";

describe("demo routes", () => {
  it("create a private copy with two seeded shows and a demo key", async () => {
    const w = workerHarness();
    const res = await w.call("POST", "/api/demo");
    expect(res.status).toBe(201);
    const d = (await res.json()) as DemoResponse;
    expect(d.demoId).toMatch(/^d[a-z2-9]{10}$/);
    expect(d.demoKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(d.shows.map((s) => [s.showId, s.threshold])).toEqual([
      [`${d.demoId}a`, 34],
      [`${d.demoId}b`, 28],
    ]);
  });

  it("need the demo key to add fans, fast-forward or reset", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    expect((await w.call("POST", `/api/demo/${d.demoId}/fans`, { show: "a", count: 2 })).status).toBe(403);
    const fans = await w.call("POST", `/api/demo/${d.demoId}/fans`, { show: "a", count: 2 }, { "x-manage-key": d.demoKey });
    expect(fans.status).toBe(200);
    expect(((await fans.json()) as DemoFansResponse).queued).toBe(2);
    expect((await w.call("POST", `/api/demo/${d.demoId}/fans`, { show: "c", count: 2 }, { "x-manage-key": d.demoKey })).status).toBe(422);
    expect((await w.call("POST", `/api/demo/${d.demoId}/fast-forward`)).status).toBe(403);
    const ff = await w.call("POST", `/api/demo/${d.demoId}/fast-forward`, undefined, { "x-manage-key": d.demoKey });
    expect(ff.status).toBe(200);
  });

  it("reset retires the old copy and returns a new one", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    const res = await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { "x-manage-key": d.demoKey });
    expect(res.status).toBe(201);
    const fresh = (await res.json()) as DemoResponse;
    expect(fresh.demoId).not.toBe(d.demoId);
    const old = w.shows.get(`${d.demoId}b`)!;
    expect(Number(old.store.getMeta("expires_at"))).toBeLessThanOrEqual(w.clock.now() + 60 * 60 * 1000);
    expect(old.svc.project().campaign.state).toBe("missed");
  });

  it("limits demo copies per visitor and answers 404 for a bad demo id", async () => {
    const w = workerHarness();
    for (let i = 0; i < 5; i++) expect((await w.call("POST", "/api/demo")).status).toBe(201);
    expect((await w.call("POST", "/api/demo")).status).toBe(429);
    expect((await w.call("POST", "/api/demo/NOPE/fast-forward")).status).toBe(404);
    expect((await w.call("POST", "/api/demo/dabcdefghjk/fast-forward", undefined, { "x-manage-key": "x".repeat(43) })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/agent/demo.test.ts tests/agent/sim-runner.test.ts tests/worker/router-demo.test.ts`
Expected: FAIL with "Cannot find module '../../src/agent/demo'" and missing runner errors.

- [ ] **Step 3: Write `src/agent/demo.ts`**

```ts
import type { MandateDraft } from "../core/mandate";

export interface Receivers {
  room: string;
  opener: string;
  artist: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Demo payout receivers. Unset (or invalid) → example.com addresses, which PayPal leaves UNCLAIMED.
 * Owner action (Plan 6): create three sandbox PERSONAL accounts and set PAYPAL_RECEIVER_* so payouts reach SUCCESS.
 */
export function receiversFrom(env: { PAYPAL_RECEIVER_ROOM?: string; PAYPAL_RECEIVER_OPENER?: string; PAYPAL_RECEIVER_ARTIST?: string }): Receivers {
  const pick = (v: string | undefined, fallback: string) => (v && EMAIL.test(v.trim()) ? v.trim() : fallback);
  return {
    room: pick(env.PAYPAL_RECEIVER_ROOM, "tip-the-room-room@example.com"),
    opener: pick(env.PAYPAL_RECEIVER_OPENER, "tip-the-room-opener@example.com"),
    artist: pick(env.PAYPAL_RECEIVER_ARTIST, "tip-the-room-artist@example.com"),
  };
}

export interface DemoSeed {
  key: "a" | "b";
  draft: Omit<MandateDraft, "showId" | "launchedAt" | "deadline" | "showDate">;
  /** Time from creation to the deadline (the reference's countdowns). */
  windowMs: number;
  /** Simulated fans seated at creation, as real sandbox card holds. */
  startFans: number;
}

/** The two fictional shows from reference/v2: A tips (34 × $15), B misses (28 × $12). */
export function demoSeeds(r: Receivers): [DemoSeed, DemoSeed] {
  return [
    {
      key: "a",
      windowMs: 200_460_000,
      startFans: 29,
      draft: {
        showName: "Juniper Vale",
        roomName: "Spindle Records",
        ticketPrice: 1500,
        feeBufferBps: 500,
        timeZone: "UTC",
        parties: [
          { role: "room", label: "Spindle Records", paypalEmail: r.room, fixed: 8000 },
          { role: "opener", label: "The Low Tides", paypalEmail: r.opener, fixed: 10000 },
          { role: "artist", label: "Juniper Vale", paypalEmail: r.artist, minimum: 30000 },
        ],
      },
    },
    {
      key: "b",
      windowMs: 373_260_000,
      startFans: 19,
      draft: {
        showName: "Marlow Finch",
        roomName: "Elm St house",
        ticketPrice: 1200,
        feeBufferBps: 500,
        timeZone: "UTC",
        parties: [
          { role: "room", label: "Elm St house", paypalEmail: r.room, fixed: 6000 },
          { role: "opener", label: "The opener", paypalEmail: r.opener, fixed: 4000 },
          { role: "artist", label: "Marlow Finch", paypalEmail: r.artist, minimum: 22000 },
        ],
      },
    },
  ];
}
```

- [ ] **Step 4: Write `src/agent/sim-runner.ts` and register it**

```ts
import { IllegalTransition } from "../core/campaign";
import { PayPalError } from "../paypal/errors";
import { requestIds, type Hold } from "../paypal/payments";
import { commit, done, fail, logStep, queueVoid, retryLater, type ExecDeps, type Runner, type Runners } from "./executor";
import { REHOLD_MARGIN_MS } from "./policy";
import type { Job } from "./store";
import { errText, fanName, holdDescription, sawCounts } from "./words";

export const SIM_INITIALS = ["JR", "AK", "LM", "TD", "SO", "PB", "NV", "CH", "EW", "RG", "MI", "BF", "OT", "KS", "DL", "HY", "QA", "UZ", "WN", "XE", "GP", "VC", "IB", "FM", "YJ", "ZR"];

/** Records a refused simulated hold. A refused pledge id is never reused: one retry with a NEW id, then give up. */
function declined(d: ExecDeps, job: Job, pledgeId: string, orderId: string | null, authorizationId: string | null, reason: string, needsVoid: boolean): void {
  const now = d.clock.now();
  commit(d.store, now, { type: "pledge_rejected", pledgeId, orderId, authorizationId, reason });
  if (needsVoid && authorizationId) queueVoid(d.store, authorizationId, now);
  const last = pledgeId.endsWith("-r1");
  if (!last) d.store.putJob({ key: `sim:${pledgeId}-r1`, kind: "sim_hold", target: `${pledgeId}-r1`, nextAt: now, note: job.note }, now);
  logStep(d, { saw: `PayPal refused a simulated fan's hold (${reason}).`, did: last ? "Gave up on this simulated fan. Nothing was charged." : "Trying once more with a new pledge. Nothing was charged.", rule: "rule-1-hold-only", requestId: requestIds.hold(d.showId, pledgeId), resultId: authorizationId });
  done(d, job, `Refused: ${reason}`);
}

const runSimHold: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const m = p.mandate;
  if (!m) return fail(d, job, "The money rules aren't signed.");
  const pledgeId = job.target;
  if (d.store.hasEvent(`pledge:${pledgeId}`)) return done(d, job, "Already recorded.");
  if (p.campaign.state !== "live" && p.campaign.state !== "tipped") return done(d, job, "Pledging has closed, so no simulated fan was added.");
  let hold: Hold;
  try {
    hold = await d.paypal.createCardHold({ showId: d.showId, pledgeId, amountCents: m.ticketPrice, description: holdDescription(m) }, d.card);
  } catch (e) {
    if (e instanceof PayPalError && e.retryable) return retryLater(d, job, attempt, errText(e));
    return declined(d, job, pledgeId, null, null, errText(e), false);
  }
  if (hold.status !== "CREATED" || hold.amountCents !== m.ticketPrice) {
    return declined(d, job, pledgeId, hold.orderId || null, hold.authorizationId || null, `PayPal answered ${hold.status} for ${hold.amountCents} cents`, hold.status === "CREATED" || hold.status === "PENDING");
  }
  const now = d.clock.now();
  try {
    commit(d.store, now, { type: "pledge_held", pledgeId, orderId: hold.orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents, authorizedAt: hold.createdAt, expiresAt: hold.expiresAt, initials: job.note || "SF", simulated: true });
  } catch (e) {
    if (!(e instanceof IllegalTransition)) throw e;
    commit(d.store, now, { type: "late_hold", pledgeId, orderId: hold.orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents });
    queueVoid(d.store, hold.authorizationId, now);
    logStep(d, { saw: sawCounts(d.store.projection()), did: "A simulated fan's hold arrived after pledging closed. Cancelling it; nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.hold(d.showId, pledgeId), resultId: hold.authorizationId });
    return done(d, job, "Arrived late; cancelling.");
  }
  const after = d.store.projection();
  const pledge = after.pledges.get(pledgeId);
  logStep(d, { saw: sawCounts(after), did: `Simulated ${pledge ? fanName(pledge) : "fan"} held a spot with a real sandbox card hold. Nobody is charged yet.`, rule: "rule-1-hold-only", requestId: requestIds.hold(d.showId, pledgeId), resultId: hold.authorizationId });
  done(d, job, "Held.");
};

/** Renews a simulated hold near expiry: a fresh card hold first, then the old one is voided. Reauthorize is never used. */
const runRehold: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const m = p.mandate;
  const pledge = p.pledges.get(job.target);
  if (!m || !pledge || pledge.status !== "held" || !pledge.simulated) return done(d, job, "Nothing to renew.");
  if (p.campaign.state !== "live") return done(d, job, "Only an open show renews holds.");
  const now = d.clock.now();
  const dueAt = pledge.expiresAt - REHOLD_MARGIN_MS;
  if (now < dueAt) return d.store.updateJob(job.key, { nextAt: dueAt });
  // Copy the old ids now: the projection object changes as soon as hold_replaced is committed.
  const oldAuthorizationId = pledge.authorizationId;
  const oldOrderId = pledge.orderId;
  const who = fanName(pledge);
  const n = Number(/-h(\d+)$/.exec(pledge.paypalPledgeId)?.[1] ?? "0") + 1;
  const newPledgeId = `${pledge.pledgeId}-h${n}`;
  let hold: Hold;
  try {
    hold = await d.paypal.createCardHold({ showId: d.showId, pledgeId: newPledgeId, amountCents: pledge.amountCents, description: holdDescription(m) }, d.card);
  } catch (e) {
    if (e instanceof PayPalError && e.retryable) return retryLater(d, job, attempt, errText(e));
    return fail(d, job, `Couldn't renew ${who}'s hold (${errText(e)}). The old hold stays until it lapses.`);
  }
  if (hold.status !== "CREATED" || hold.amountCents !== pledge.amountCents) {
    if (hold.status === "CREATED" || hold.status === "PENDING") {
      commit(d.store, now, { type: "pledge_rejected", pledgeId: newPledgeId, orderId: hold.orderId || null, authorizationId: hold.authorizationId || null, reason: `renewal answered ${hold.status}` });
      if (hold.authorizationId) queueVoid(d.store, hold.authorizationId, now);
    }
    return fail(d, job, `PayPal refused to renew ${who}'s hold. The old hold stays until it lapses.`);
  }
  commit(d.store, now, { type: "hold_replaced", pledgeId: pledge.pledgeId, newPaypalPledgeId: newPledgeId, orderId: hold.orderId, authorizationId: hold.authorizationId, oldOrderId, oldAuthorizationId, authorizedAt: hold.createdAt, expiresAt: hold.expiresAt });
  queueVoid(d.store, oldAuthorizationId, now);
  logStep(d, { saw: sawCounts(d.store.projection()), did: `Renewed ${who}'s hold before it expired: a new hold first, then the old one is cancelled. Nobody was charged.`, rule: "rule-1-hold-only", requestId: requestIds.hold(d.showId, newPledgeId), resultId: hold.authorizationId });
  done(d, job, "Renewed.");
};

export const SIM_RUNNERS: Runners = { sim_hold: runSimHold, rehold: runRehold };
```

Replace `src/agent/runners.ts` with:

```ts
import type { Runners } from "./executor";
import { HOLD_RUNNERS } from "./hold-runner";
import { PAYOUT_RUNNERS } from "./payout-runner";
import { SIM_RUNNERS } from "./sim-runner";

/** Every job kind the runtime can execute. */
export const RUNNERS: Runners = { ...HOLD_RUNNERS, ...PAYOUT_RUNNERS, ...SIM_RUNNERS };
```

- [ ] **Step 5: Add demo mode to `src/agent/service.ts`**

Replace the whole import block with:

```ts
import { fansCommitted, IllegalTransition, reduce } from "../core/campaign";
import { guard, type AgentAction } from "../core/guard";
import { DAY_MS } from "../core/holds";
import { buildMandate, MandateDraftError, signMandate, type Mandate } from "../core/mandate";
import { formatUSD } from "../core/money";
import { splitPayout } from "../core/split";
import { assertPayPalId } from "../paypal/amount";
import { PayPalError } from "../paypal/errors";
import { requestIds, type Hold, type TestCard } from "../paypal/payments";
import type { PayPalLedgerEvent } from "../paypal/webhooks";
import type { ApproveRequest, ApproveResponse, AuthorizeResponse, CallOffResponse, CreateOrderRequest, CreateOrderResponse, DemoFansResponse, ManageView, PublicShow, SignRequest, SignResponse } from "../worker/api-types";
import type { AiDeps } from "./ai";
import { paceNote, settlementNote, type PaceFacts } from "./ai-jobs";
import type { DemoSeed } from "./demo";
import { toMandateDraft } from "./draft";
import { ServiceError } from "./errors";
import type { ProposalOption, SettlementNote } from "./events";
import { commit, drain, logStep, queueVoid, requestReconcile, type ExecDeps } from "./executor";
import { customIdFor, newId, newSecret, pledgeIdFromCustomId, sameHex, sha256Hex, type Clock, type Random } from "./ids";
import { duePaceCheck, paceCheckTimes, paceNumbers, paceOptions } from "./pace";
import type { PayPalPort } from "./paypal-port";
import { DEMO_GRACE_MS, DEMO_MAX_GRACES, DEMO_TTL_MS, MAX_ORDERS_PER_SHOW, MONEY_JOBS, REHOLD_MARGIN_MS, SIM_ADD_MAX, SIM_CAP_PER_SHOW } from "./policy";
import type { OrderView, PledgeView, Projection } from "./project";
import { RUNNERS } from "./runners";
import { SIM_INITIALS } from "./sim-runner";
import type { Store } from "./store";
import { ledgerRows, logRows, manageParties, proposalRows, publicShow } from "./views";
import { fanName, holdDescription, sawCounts } from "./words";
```

Replace the whole `tick()` method with:

```ts
  /** One alarm turn: demo fast-forward, deadline, a due pace check, re-hold planning, money jobs, notes, demo expiry. */
  async tick(): Promise<{ expired: boolean }> {
    if (!this.exists()) return { expired: false };
    const demo = this.kind() === "demo";
    if (demo && this.deps.store.getMeta("ff_pending") && !this.deps.store.hasPending(["sim_hold"])) this.jumpToDeadline();
    let p = this.applyDeadline();
    if (p.mandate) {
      const due = duePaceCheck(p.mandate, p.campaign, p.paceChecks, this.now());
      for (const n of due.mark) commit(this.deps.store, this.now(), { type: "pace_checked", check: n });
      if (due.run !== null) await this.runPaceCheck(due.run);
    }
    this.planReholds(this.project());
    await drain(this.exec(), RUNNERS);
    p = this.applyDeadline();
    if (this.notesDue(p)) await this.writeNotes(p);
    return { expired: demo ? this.checkExpiry() : false };
  }
```

In `nextWakeAt()`, replace the line `if (this.notesDue(p)) times.push(now);` with:

```ts
    if (this.notesDue(p)) times.push(now);
    if (this.kind() === "demo") {
      const expiresAt = Number(this.deps.store.getMeta("expires_at"));
      if (Number.isFinite(expiresAt)) times.push(expiresAt + this.clockOffset());
      if (this.deps.store.getMeta("ff_pending") && !this.deps.store.hasPending(["sim_hold"])) times.push(now);
    }
```

Add these methods inside the class, after `nextWakeAt()`:

```ts
  /** A judge's private demo show: signed at once with fictional rules, starting fans queued as real sandbox holds. */
  async initDemo(input: { showId: string; seed: DemoSeed; demoKeyHash: string }): Promise<PublicShow> {
    const store = this.deps.store;
    if (store.getMeta("show_id")) throw new ServiceError(409, "conflict", "That demo show already exists.");
    const real = this.deps.clock.now();
    const launchedAt = new Date(real).toISOString();
    const deadline = real + input.seed.windowMs;
    const mandate = buildMandate({ ...input.seed.draft, showId: input.showId, launchedAt, deadline: new Date(deadline).toISOString(), showDate: new Date(deadline + 3 * DAY_MS).toISOString().slice(0, 10) });
    const signed = await signMandate(mandate, launchedAt);
    if (store.getMeta("show_id")) throw new ServiceError(409, "conflict", "That demo show already exists.");
    store.transaction(() => {
      store.setMeta("show_id", input.showId);
      store.setMeta("kind", "demo");
      store.setMeta("manage_key_hash", input.demoKeyHash);
      store.setMeta("created_at", String(real));
      store.setMeta("expires_at", String(real + DEMO_TTL_MS));
    });
    commit(store, real, { type: "mandate_signed", mandate: signed.mandate, hash: signed.hash, signedAt: signed.signedAt });
    this.log({ saw: "A judge opened the demo.", did: `Seeded ${mandate.showName}: ${mandate.threshold} fans needed. Simulated fans are real sandbox card holds; nobody is charged unless the show tips.`, rule: null, resultId: signed.hash.slice(0, 12) });
    this.queueSimHolds(input.seed.startFans);
    return this.publicView();
  }

  private requireDemo(): void {
    if (this.kind() !== "demo") throw new ServiceError(404, "not_found", "Simulated fans and demo controls exist only in the demo.");
  }

  private pendingSims(): number {
    return this.deps.store.jobs().filter((j) => j.kind === "sim_hold" && j.status === "pending").length;
  }

  private queueSimHolds(count: number): number {
    const store = this.deps.store;
    const now = this.now();
    const base = this.project().pledges.size + this.pendingSims();
    for (let i = 0; i < count; i++) {
      const pledgeId = newId("p", this.deps.random);
      store.putJob({ key: `sim:${pledgeId}`, kind: "sim_hold", target: pledgeId, nextAt: now, note: SIM_INITIALS[(base + i) % SIM_INITIALS.length] }, now);
    }
    return count;
  }

  addSimFans(count: unknown): DemoFansResponse {
    this.requireDemo();
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > SIM_ADD_MAX) throw new ServiceError(422, "invalid", `Add between 1 and ${SIM_ADD_MAX} fans at a time.`);
    const p = this.applyDeadline();
    if (p.campaign.state !== "live" && p.campaign.state !== "tipped") throw new ServiceError(409, "conflict", "Pledging has closed for this show.");
    const sims = [...p.pledges.values()].filter((x) => x.simulated).length + this.pendingSims();
    if (sims + count > SIM_CAP_PER_SHOW) throw new ServiceError(409, "conflict", `This demo show can take at most ${SIM_CAP_PER_SHOW} simulated fans.`);
    const queued = this.queueSimHolds(count);
    return { queued, show: this.publicView(p) };
  }

  /** topUp: queue simulated holds up to the target first, and jump once they are seated (show A). Otherwise jump now (show B). */
  fastForward(topUp: boolean): PublicShow {
    this.requireDemo();
    const p = this.applyDeadline();
    const c = p.campaign;
    if (c.state !== "live" && c.state !== "tipped") return this.publicView(p);
    if (topUp && c.state === "live") {
      const need = c.threshold - fansCommitted(c) - this.pendingSims();
      if (need > 0) this.queueSimHolds(Math.min(need, SIM_CAP_PER_SHOW));
      this.deps.store.setMeta("ff_pending", "1");
      return this.publicView(p);
    }
    this.jumpToDeadline();
    return this.publicView();
  }

  /** Reset: jump the old copy to its deadline (open holds are voided) and let it delete itself within an hour. */
  retire(): { retired: true } {
    this.requireDemo();
    const p = this.applyDeadline();
    if (p.campaign.state === "live" || p.campaign.state === "tipped") this.jumpToDeadline();
    const real = this.deps.clock.now();
    const current = Number(this.deps.store.getMeta("expires_at"));
    this.deps.store.setMeta("expires_at", String(Math.min(Number.isFinite(current) ? current : real, real + DEMO_GRACE_MS)));
    return { retired: true };
  }

  /** Demo only: move the campaign clock just past the deadline, then apply it. */
  private jumpToDeadline(): void {
    const store = this.deps.store;
    store.deleteMeta("ff_pending");
    const p = this.project();
    if (!p.mandate) return;
    const saw = sawCounts(p);
    const offset = p.campaign.deadline + 1000 - this.deps.clock.now();
    if (offset > this.clockOffset()) store.setMeta("clock_offset", String(offset));
    this.log({ saw, did: "Demo: skipped ahead to the deadline.", rule: null });
    this.applyDeadline();
  }

  private planReholds(p: Projection): void {
    if (p.campaign.state !== "live") return;
    const now = this.now();
    for (const x of p.pledges.values()) {
      if (x.simulated && x.status === "held") this.deps.store.putJob({ key: `rehold:${x.authorizationId}`, kind: "rehold", target: x.pledgeId, nextAt: x.expiresAt - REHOLD_MARGIN_MS }, now);
    }
  }

  /** True when a demo copy is past its expiry and has no money step left (the adapter then deletes the storage). */
  private checkExpiry(): boolean {
    const store = this.deps.store;
    const real = this.deps.clock.now();
    const expiresAt = Number(store.getMeta("expires_at"));
    if (!Number.isFinite(expiresAt) || real < expiresAt) return false;
    const state = this.project().campaign.state;
    if (state === "live" || state === "tipped") this.jumpToDeadline();
    const graces = Number(store.getMeta("expiry_graces") ?? "0");
    if (store.hasPending(MONEY_JOBS) && graces < DEMO_MAX_GRACES) {
      store.setMeta("expires_at", String(real + DEMO_GRACE_MS));
      store.setMeta("expiry_graces", String(graces + 1));
      return false;
    }
    return true;
  }
```

- [ ] **Step 6: Add the demo ops to `src/agent/dispatch.ts`**

1. Add `import type { DemoSeed } from "./demo";` to the imports.
2. Add these members to the `CampaignOp` union:

```ts
  | { op: "demo_init"; showId: string; seed: DemoSeed; demoKeyHash: string }
  | { op: "demo_fans"; manageKey: string | null; count: number }
  | { op: "demo_ff"; manageKey: string | null; topUp: boolean }
  | { op: "demo_retire"; manageKey: string | null };
```

(Move the `;` from the previous last member, `webhook`, to the new last member.)

3. Replace the `CREATES` line with:

```ts
const CREATES: ReadonlySet<string> = new Set(["init", "demo_init"]);
```

4. Add these cases at the end of the `switch` in `run()`:

```ts
    case "demo_init":
      return service.initDemo(op);
    case "demo_fans":
      await service.checkKey(op.manageKey);
      return service.addSimFans(op.count);
    case "demo_ff":
      await service.checkKey(op.manageKey);
      return service.fastForward(op.topUp);
    case "demo_retire":
      await service.checkKey(op.manageKey);
      return service.retire();
```

- [ ] **Step 7: Add the demo routes to `src/worker/router.ts`**

1. Change the imports:

```ts
import { demoSeeds, type Receivers } from "../agent/demo";
import { demoShowIds, isDemoId, isShowId, newId, newSecret, sha256Hex, showIdFromRef, type Clock, type Random } from "../agent/ids";
import { MANAGE_KEY_HEADER, type ApiError, type CreateShowRequest, type CreateShowResponse, type DemoFansRequest, type DemoFastForwardResponse, type DemoResponse, type ErrorCode, type PublicShow } from "./api-types";
```

(replacing the existing `../agent/ids` and `./api-types` import lines; keep the others).

2. Add `receivers` to `RouterConfig`:

```ts
export interface RouterConfig {
  allowedOrigins: string[];
  /** Null when PAYPAL_WEBHOOK_ID is unset: webhooks are then refused. */
  webhookId: string | null;
  rateSalt: string;
  /** Demo payout receivers (example.com unless sandbox accounts are configured). */
  receivers: Receivers;
}
```

3. Add these handlers before `const ROUTES`:

```ts
function demoParam(c: Ctx): string {
  const id = c.params[0];
  if (!isDemoId(id)) throw new HttpError(404, "not_found", "There's no demo here.");
  return id;
}

async function newDemoCopy(c: Ctx): Promise<DemoResponse> {
  const demoId = newId("d", c.deps.random);
  const demoKey = newSecret(c.deps.random);
  const demoKeyHash = await sha256Hex(demoKey);
  const shows: PublicShow[] = [];
  for (const seed of demoSeeds(c.deps.config.receivers)) {
    const showId = `${demoId}${seed.key}`;
    const reply = await c.deps.campaigns.call(showId, { op: "demo_init", showId, seed, demoKeyHash });
    if (!reply.ok) throw new HttpError(reply.status, reply.error.code, reply.error.message);
    shows.push(reply.data as PublicShow);
  }
  return { demoId, demoKey, shows: [shows[0], shows[1]] };
}

const createDemo: Handler = async (c) => {
  await limit(c, "demo");
  await limit(c, "demoGlobal", "all");
  return json(201, await newDemoCopy(c));
};

const demoFans: Handler = async (c) => {
  await limit(c, "demoFans");
  const demoId = demoParam(c);
  const body = await readJson<DemoFansRequest>(c.req);
  if (body?.show !== "a" && body?.show !== "b") throw new HttpError(422, "invalid", "Pick show a or b.");
  return fromReply(await c.deps.campaigns.call(`${demoId}${body.show}`, { op: "demo_fans", manageKey: manageKey(c), count: body.count }));
};

const demoFastForward: Handler = async (c) => {
  const [a, b] = demoShowIds(demoParam(c));
  const ra = await c.deps.campaigns.call(a, { op: "demo_ff", manageKey: manageKey(c), topUp: true });
  if (!ra.ok) return fromReply(ra);
  const rb = await c.deps.campaigns.call(b, { op: "demo_ff", manageKey: manageKey(c), topUp: false });
  if (!rb.ok) return fromReply(rb);
  const res: DemoFastForwardResponse = { shows: [ra.data as PublicShow, rb.data as PublicShow] };
  return json(200, res);
};

const demoReset: Handler = async (c) => {
  await limit(c, "demo");
  for (const id of demoShowIds(demoParam(c))) {
    const r = await c.deps.campaigns.call(id, { op: "demo_retire", manageKey: manageKey(c) });
    if (!r.ok) return fromReply(r);
  }
  await limit(c, "demoGlobal", "all");
  return json(201, await newDemoCopy(c));
};
```

4. Add these entries at the end of the `ROUTES` array:

```ts
  { method: "POST", pattern: /^\/api\/demo$/, handler: createDemo },
  { method: "POST", pattern: /^\/api\/demo\/([a-z0-9]+)\/fans$/, handler: demoFans },
  { method: "POST", pattern: /^\/api\/demo\/([a-z0-9]+)\/fast-forward$/, handler: demoFastForward },
  { method: "POST", pattern: /^\/api\/demo\/([a-z0-9]+)\/reset$/, handler: demoReset },
```

- [ ] **Step 8: Pass the receivers in the Worker entry and the test harness**

In `src/worker/index.ts`, add `import { receiversFrom } from "../agent/demo";` and add this line inside `config: { ... }` after `rateSalt`:

```ts
      receivers: receiversFrom(env),
```

In `tests/worker/harness.ts`, add `import { receiversFrom } from "../../src/agent/demo";` and change the `config` line to:

```ts
    config: { allowedOrigins: ["http://localhost:5173"], webhookId: opts.webhookId ?? null, rateSalt: "test-salt", receivers: receiversFrom({}) },
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run tests/agent tests/worker`
Expected: PASS.

- [ ] **Step 10: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add src/agent src/worker tests/agent tests/worker
git commit -m "feat(demo): per-visitor demo copies with real sandbox card holds, fast-forward, reset, expiry and re-hold

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End-to-end integration script (`npm run worker:check`)

**Files:**
- Create: `scripts/worker-check.ts`
- Modify: `package.json` (script `worker:check`)

**Interfaces:**
- Consumes: the running Worker (`wrangler dev --local --env check`, Task 8–10) over HTTP; types from `src/worker/api-types.ts`.
- Produces: `npm run worker:check` → exit 0 and `Worker check: all green.` when every line passes. Spec 9's "integration" layer: the real Worker, real Durable Objects and alarms (local workerd), real PayPal sandbox calls.

**What it proves (each a PASS/FAIL line):** health; draft with code-computed target; sign returns a manage key; public view has no emails; a forged order id is refused (404) with no hold; a real sandbox order is created and an unapproved order is NOT counted; the manage view needs the key; webhooks are refused without `PAYPAL_WEBHOOK_ID` (or the unsigned call fails verification when it is set); the demo seats 29 + 19 simulated fans as REAL sandbox card holds; adding fans works; fast-forward makes A tip, charge every hold and send the payout batch, and makes B miss with every hold voided; the ledgers carry PayPal ids and the agent log carries the rules; reset returns a new copy.

- [ ] **Step 1: Add the script entry**

In `package.json` `"scripts"`, add:

```json
    "worker:check": "node --import tsx scripts/worker-check.ts",
```

(No `--env-file`: wrangler reads `.dev.vars` itself, and this script never needs a secret.)

- [ ] **Step 2: Write `scripts/worker-check.ts`**

```ts
// Spec 9 "integration": drives the real Worker (wrangler dev --local, env "check") end to end against the PayPal sandbox.
// Run: npm run worker:check. Prints statuses and PayPal ids only. Never prints keys, tokens, manage keys or demo keys.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import type { CreateOrderResponse, CreateShowResponse, DemoResponse, ManageView, PublicShow, SignResponse } from "../src/worker/api-types";

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_DIR = ".wrangler/worker-check";
let failures = 0;

function line(ok: boolean, step: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  ·  ${detail}` : ""}`);
}

async function api<T>(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["x-manage-key"] = key;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`(timed out waiting for ${what})`);
  return undefined;
}

const looksLikePayPalId = (s: string | null) => typeof s === "string" && /^[A-Z0-9]{10,25}$/.test(s);

rmSync(STATE_DIR, { recursive: true, force: true });
mkdirSync(".wrangler", { recursive: true });
const log = createWriteStream(".wrangler/worker-check.log");
const child = spawn("npx", ["wrangler", "dev", "--local", "--env", "check", "--port", String(PORT), "--persist-to", STATE_DIR], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(log);
child.stderr.pipe(log);

try {
  const up = await waitFor("the Worker", async () => ((await api<{ ok: boolean }>("GET", "/api/health")).data?.ok ? true : undefined), 90_000);
  line(up === true, "health");
  if (!up) throw new Error("Worker did not start; see .wrangler/worker-check.log");

  // ---- a real show (the artist path) ----
  const deadline = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const created = await api<CreateShowResponse>("POST", "/api/shows", { sentence: "Worker check at Test Room, Dec 20, $15 tickets, room wants $10, I need $10", deadline, emails: { room: "check-room@example.com", artist: "check-artist@example.com" } });
  line(created.status === 201 && created.data.threshold === 2, "draft: code computes the target", `status ${created.status}, target ${created.data?.threshold}, written by ${created.data?.source}`);
  const signed = await api<SignResponse>("POST", `/api/shows/${created.data.showId}/sign`, { signToken: created.data.signToken, draft: created.data.draft });
  const showId = signed.data?.showId;
  line(signed.status === 200 && typeof signed.data.manageKey === "string" && signed.data.manageKey.length === 43, "sign returns a manage key once", `status ${signed.status}, show ${showId}`);
  const pub = await api<PublicShow>("GET", `/api/shows/${showId}`);
  line(pub.status === 200 && pub.data.state === "live" && !JSON.stringify(pub.data).includes("@"), "public show is live and has no emails");
  const forged = await api("POST", `/api/shows/${showId}/orders/1AB23456CD789012E/authorize`);
  line(forged.status === 404, "a forged order id is refused", `status ${forged.status}`);
  const order = await api<CreateOrderResponse>("POST", `/api/shows/${showId}/orders`, { initials: "WC" });
  line(order.status === 201 && looksLikePayPalId(order.data.orderId), "real sandbox order created", `order ${order.data?.orderId}`);
  const unapproved = await api("POST", `/api/shows/${showId}/orders/${order.data.orderId}/authorize`);
  const afterUnapproved = await api<PublicShow>("GET", `/api/shows/${showId}`);
  line(unapproved.status === 409 && afterUnapproved.data.fans.committed === 0, "an order the buyer never approved is not counted", `status ${unapproved.status}`);
  const noKey = await api("GET", `/api/shows/${showId}/manage`);
  const withKey = await api<ManageView>("GET", `/api/shows/${showId}/manage`, undefined, signed.data.manageKey);
  line(noKey.status === 403 && withKey.status === 200, "manage view needs the manage key");
  const hook = await api("POST", "/api/webhooks/paypal", { id: "WH-CHECK", event_type: "PAYMENT.AUTHORIZATION.CREATED", create_time: new Date().toISOString(), resource: { id: "X" } });
  line(hook.status === 403 || hook.status === 400, "webhooks need PAYPAL_WEBHOOK_ID and a valid signature", hook.status === 403 ? "refused: PAYPAL_WEBHOOK_ID not set" : "refused: signature check failed");

  // ---- the judge demo ----
  const demo = await api<DemoResponse>("POST", "/api/demo");
  line(demo.status === 201 && demo.data.shows[0].threshold === 34 && demo.data.shows[1].threshold === 28, "demo copy created", `demo ${demo.data?.demoId}`);
  const [a, b] = [demo.data.shows[0].showId, demo.data.shows[1].showId];
  const key = demo.data.demoKey;
  const seated = await waitFor(
    "29 + 19 simulated fans",
    async () => {
      const [sa, sb] = await Promise.all([api<PublicShow>("GET", `/api/shows/${a}`), api<PublicShow>("GET", `/api/shows/${b}`)]);
      return sa.data.fans.committed === 29 && sb.data.fans.committed === 19 ? true : undefined;
    },
    240_000,
  );
  line(seated === true, "simulated fans seated as sandbox card holds");
  const firstHold = (await api<ManageView>("GET", `/api/shows/${a}/manage`, undefined, key)).data.ledger.find((r) => r.status === "On hold");
  line(looksLikePayPalId(firstHold?.ref ?? null), "a simulated fan's ledger row carries a real PayPal authorization id", firstHold?.ref ?? "none");
  const more = await api("POST", `/api/demo/${demo.data.demoId}/fans`, { show: "a", count: 2 }, key);
  const thirtyOne = await waitFor("31 fans on show A", async () => ((await api<PublicShow>("GET", `/api/shows/${a}`)).data.fans.committed === 31 ? true : undefined), 120_000);
  line(more.status === 200 && thirtyOne === true, "add 2 fans");
  const ff = await api("POST", `/api/demo/${demo.data.demoId}/fast-forward`, undefined, key);
  line(ff.status === 200, "fast-forward accepted");
  const settledA = await waitFor("show A settled", async () => ((await api<PublicShow>("GET", `/api/shows/${a}`)).data.state === "settled" ? true : undefined), 420_000);
  const missedB = await waitFor("show B missed with every hold voided", async () => {
    const s = (await api<PublicShow>("GET", `/api/shows/${b}`)).data;
    return s.state === "missed" && s.fans.held === 0 && s.fans.released === 19 ? true : undefined;
  }, 240_000);
  const manageA = (await api<ManageView>("GET", `/api/shows/${a}/manage`, undefined, key)).data;
  const charged = manageA.ledger.filter((r) => r.what === "Charged" && looksLikePayPalId(r.ref));
  const paid = manageA.ledger.filter((r) => r.what.startsWith("Paid "));
  line(settledA === true && manageA.show.fans.charged === 34, "show A tipped: every hold charged", `${charged.length} charge rows with PayPal capture ids`);
  line(paid.length >= 1 && manageA.log.some((l) => l.rule === "rule-4-pay-the-split"), "show A payout batch sent under rule 4", paid.map((r) => `${r.who} ${r.amountCents} ${r.status}`).join(" · "));
  line(manageA.collectedNetCents > 0 && manageA.collectedNetCents < 34 * 1500, "collected net comes from PayPal's net amounts", `net ${manageA.collectedNetCents} of gross ${34 * 1500}`);
  const manageB = (await api<ManageView>("GET", `/api/shows/${b}/manage`, undefined, key)).data;
  line(missedB === true && manageB.ledger.filter((r) => r.status === "Cancelled").length >= 19 && manageB.log.some((l) => l.rule === "rule-3-void-on-miss"), "show B missed: every hold cancelled under rule 3");
  const reset = await api<DemoResponse>("POST", `/api/demo/${demo.data.demoId}/reset`, undefined, key);
  line(reset.status === 201 && reset.data.demoId !== demo.data.demoId, "reset returns a fresh copy", `new demo ${reset.data?.demoId}`);
} catch (e) {
  line(false, "check crashed", e instanceof Error ? e.message : String(e));
} finally {
  child.kill("SIGTERM");
  log.end();
}

console.log(failures === 0 ? "\nWorker check: all green." : `\nWorker check: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Run it against the sandbox**

Run: `npm run worker:check`
Expected (takes a few minutes; ~120 sandbox calls):

```
PASS  health
PASS  draft: code computes the target  ·  status 201, target 2, written by template
PASS  sign returns a manage key once  ·  status 200, show s…
PASS  public show is live and has no emails
PASS  a forged order id is refused  ·  status 404
PASS  real sandbox order created  ·  order …
PASS  an order the buyer never approved is not counted  ·  status 409
PASS  manage view needs the manage key
PASS  webhooks need PAYPAL_WEBHOOK_ID and a valid signature  ·  refused: PAYPAL_WEBHOOK_ID not set
PASS  demo copy created  ·  demo d…
PASS  simulated fans seated as sandbox card holds
PASS  a simulated fan's ledger row carries a real PayPal authorization id  ·  …
PASS  add 2 fans
PASS  fast-forward accepted
PASS  show A tipped: every hold charged  ·  34 charge rows with PayPal capture ids
PASS  show A payout batch sent under rule 4  ·  Spindle Records 8000 Pending · The Low Tides 10000 Pending · Juniper Vale … Pending
PASS  collected net comes from PayPal's net amounts  ·  net … of gross 51000
PASS  show B missed: every hold cancelled under rule 3
PASS  reset returns a fresh copy  ·  new demo d…

Worker check: all green.
```

Payout rows stay `Pending` with example.com receivers (they never claim); that is expected. If a line fails, read `.wrangler/worker-check.log` (never paste lines that show variable values) and fix the cause in the matching task's code with a unit test first; do not loosen the check. If PayPal declines a simulated hold twice and show A ends `missed` instead of `settled`, re-run once and report it to the controller if it repeats. Show A clears its signed amounts by only 8 cents at 34 fans with the sandbox's $0.88 fee per $15 (net 34 × $14.12 = $480.08 vs $480.00 signed): if A stops at "Paying everyone" with a `pay_short` proposal, PayPal's sandbox fee changed; report it, do not change the seeds.

- [ ] **Step 4: Full checks and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

```bash
git add scripts/worker-check.ts package.json
git commit -m "test(worker): end-to-end worker:check against wrangler dev and the PayPal sandbox

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Done when

- `npm run typecheck && npm run lint && npm test` are green, and `npm run test:gpu` is unchanged and green (no `src/web`, `reference` or `tests/gpu` changes).
- `npm run sandbox:check` is all green (Task 1 adds two lines) and `npm run worker:check` is all green against the live sandbox (or any failure is understood and accepted by the controller in writing).
- No secret, token, manage key, demo key or sign token appears in any commit, log file that is committed, or test fixture.
- The roadmap row for Plan 4 is updated by the controller after the final review and merge (deviations above recorded there too).

## Owner actions (not blocking Plan 4)

1. **Payout receivers (for Plan 6):** create three sandbox PERSONAL accounts in the PayPal developer dashboard and put their emails in `PAYPAL_RECEIVER_ROOM`, `PAYPAL_RECEIVER_OPENER`, `PAYPAL_RECEIVER_ARTIST` (in `.dev.vars` and later as Worker vars). Until then demo payouts go to example.com addresses and stay UNCLAIMED/PENDING.
2. **Webhook id (for Plan 6):** webhooks need a public URL. After the first deploy, register `https://<worker>/api/webhooks/paypal` in the sandbox app for the authorization, capture, refund and payouts events and set `PAYPAL_WEBHOOK_ID`. The live webhook check (re-serialized body verifies as SUCCESS; the real `PAYMENT.CAPTURE.REVERSED` payload shape) can only happen then.
3. **Spec amendments to accept:** the deviations table at the top (Agents SDK → plain DO, D1 → DO SQLite, no reauthorize before capture, payout retry `-r1`, reset = new copy, the extra call-off endpoint).

---
## Requirements traceability (every "PLAN 4 REQUIREMENTS" line in `.git/sdd/progress.md`)

| # | Source (ledger) | Requirement | Task | Proving test(s) |
|---|---|---|---|---|
| 1 | Plan 1 Task 6 | Capture worker must ALWAYS report charged \| failed for every requested capture (reconcile sweep vs PayPal) | 3 | `hold-runner`: "does not count a COMPLETED capture without net…", "treats a PENDING capture…", "records 'already captured'…", "counts a DECLINED capture as failed". An unanswerable capture is surfaced as "Needs attention" after 8 tries, never silently dropped |
| 2 | Plan 1 Task 6 | `refund_all_charged` idempotent: per-charge refunds with idempotency keys | 3 | "refunds each charge exactly once, with per-capture request ids" |
| 3 | Plan 1 Task 6 | Payout handler must handle zero total | 4 | "records a $0 payout without calling PayPal when nothing came in" |
| 4 | Plan 1 Task 6 | A `pledge_held` after close throws → runtime voids that hold itself | 6, 10 | `service-core`: "cancels a hold that lands after pledging closed while PayPal was answering"; sim runner late path; `hold-runner`: "voids a late hold without touching the counts" |
| 5 | Plan 1 Task 6 | Failed refunds leave charged > 0 in cancelled (need retry) | 3, 7 | "keeps retrying a failing refund with backoff, then needs attention"; notes wait while `charged > 0` (`notesDue`) |
| 6 | Plan 1 Task 6 | Product: tipped show below threshold after capture failures still pays out; no cancel after deadline | 4, 7 | "waits for the artist when the money is short, then pays what came in"; `agent-loop`: "is refused after the deadline" |
| 7 | Plan 1 Task 7 (Plan 3 reqs) | Deterministic `sender_batch_id`; drop $0 lines after guard approval; executor sends `expected.lines` from `splitPayout`, never the model's | 1, 4 | "sends exactly the signed split of the collected net, once, and settles" |
| 8 | Plan 1 Task 7 | Apply `deadline_reached(now)` BEFORE guarding any proposal | 6, 7 | "applies the deadline before guarding: a stale proposal can't be approved after it"; "refuses to authorize after the deadline, without asking PayPal" |
| 9 | Plan 1 Task 7 | Validate model output against a schema before the guard | 5, 7 | `ai-jobs`: "falls back to the template when the answer fails the schema check", "rejects invented numbers and options that weren't offered"; `agent-loop`: "uses the model's explanation only when it passes the checks" |
| 10 | Plan 1 Task 7 | Evaluate effects against the post-reduce campaign | 3 | `commit` plans jobs from the post-event projection; each runner guards against the current state: "skips a capture the guard forbids…", "does not pay before the deadline even if a payout job appears" |
| 11 | Plan 1 Task 7 | Wire approved `lower_threshold` → `threshold_lowered` event | 7 | "approving 'lower' records threshold_lowered, which can tip the show and charge everyone" |
| 12 | Plan 1 final review | `collectedNet` summed from actual PayPal capture responses, never the model | 2, 3 | `project`: "counts net from capture events only…"; `hold-runner`: "charges every hold and counts net only…" |
| 13 | Plan 1 final review | Effects re-emitted during replay must not re-execute (per-auth request ids; deterministic batch id) | 2, 3 | `project` ignores reducer effects; "never re-executes on replay or a second drain"; "never runs the same job twice when two drains overlap" |
| 14 | Plan 1 final review | Failed voids in missed / failed refunds in cancelled need a retry path | 3 | "retries a refused void while the hold is still open, then asks for attention"; row 5 |
| 15 | Plan 3 Task 2 | No `rel: reauthorize` on US/Platform card auths → hold-expiry fallback = void + fresh hold; don't rely on reauthorize | 10 (+ header) | `sim-runner`: "creates a fresh hold under a new pledge id first, then voids the OLD hold…", "keeps the old hold when PayPal refuses the renewal"; deviation table |
| 16 | Plan 3 Task 2 | Refunds keep PayPal's fee | 3 | Refund log says "PayPal keeps its fee on refunds"; ledger refund rows show the gross refunded; a cancelled show never pays out, so `collectedNet` is not reused |
| 17 | Plan 3 Task 2 | Payout receivers must be real sandbox personal accounts to see SUCCESS | 10 | `receiversFrom` config + owner action 1; "pays example.com receivers unless real sandbox receivers are configured" |
| 18 | Plan 3 Task 3 | `createCardHold` returns DENIED holds; callers must check status | 6, 10 | "never counts a DENIED hold…"; "retries a declined fan once with a NEW pledge id, then gives up" |
| 19 | Plan 3 Task 3 (+ final) | Compare the authorization amount (and custom_id) with the pledge | 6 | "rejects a hold for the wrong amount and queues it to be cancelled", "rejects a hold whose custom_id belongs to another pledge" |
| 20 | Plan 3 Task 4 | Payout items are PENDING right after create → poll `getPayoutBatch` / rely on PAYOUTS webhooks | 4, 7 | "polls the batch and stops once every item is final"; webhook payout events schedule polls |
| 21 | Plan 3 Task 5 | Consume `payout_item_pending` and `charge_reversed` | 7 | "surface a chargeback for attention without changing anything"; item events schedule a poll (code path in `ingestWebhook`) |
| 22 | Plan 3 Task 5 | Confirm the real REVERSED payload (ref may be the reversal id; link via `rel=up`) | 7 (deferred live check) | Handled safely without relying on `ref`: recorded by event id, logged for attention, no money action. Live payload check needs a public webhook URL → owner action 2 (Plan 6) |
| 23 | Plan 3 Task 5 | Log null mappings from known event types (bad `create_time`) | 9 | `paypalWebhook` `console.warn` for `PAYMENT.*` events that map to null (ids only) |
| 24 | Plan 3 Task 5 | Verify the body is re-serialized JSON — watch for FAILURE on genuine events in a live webhook check | 9 (deferred live check) | Router passes the raw body unchanged to `verifyWebhook`; the live check needs a public URL → owner action 2 |
| 25 | Plan 3 final | Never pass browser-supplied ids to capture/void/refund without checking stored state | 6, 3 | "refuses an order id this show didn't create, and never calls PayPal"; "refuses a malformed order id…"; runners only act on ids from the ledger |
| 26 | Plan 3 final | Capture counts only if status COMPLETED and `netCents` defined (undefined ⇒ reconcile, never 0) | 3 | `isCountable`; row 1 tests |
| 27 | Plan 3 final | Webhook "charged" amount is GROSS; `collectedNet` from net breakdown only | 7, 2 | "never count a capture from a webhook: they trigger a reconcile" |
| 28 | Plan 3 final | `isDuplicateBatch` on `sendPayouts` == already sent: recover the batch id | 4, 7 | "treats a duplicate sender_batch_id as already sent and never sends again"; "fill in a recovered payout batch id and poll it" |
| 29 | Plan 3 final | Spec 8 "retry payout once" vs one batch per show: design the retry id | 1, 4 | `payout-<show>-r1`, failed items only: "retries only the failed items once…", "surfaces a second failure and never sends a third batch", "never retries a line that no longer matches the signed split" |
| 30 | Plan 3 final | Share one in-flight token fetch; honour `Retry-After` | 1 | `http`: "shares one token fetch between concurrent requests", "waits the Retry-After seconds on a 429", "caps a long Retry-After at 10 seconds" |
| 31 | Plan 3 final | `PAYPAL_WEBHOOK_ID` config, non-empty | 9 | "are refused when PAYPAL_WEBHOOK_ID is not set" |
| 32 | Plan 3 final | Id length caps: `sender_item_id` (~63), `custom_id` (~127), request ids ≤ 108 | 1, 2 | `payoutItemId` ≤ 63 test; `customIdFor` ≤ 127 test; request-id cap already in `PayPalHttp`; our ids are 11–17 characters |
| 33 | Plan 3 final | Treat already-voided / already-captured on replay as success; a hold retry after a decline needs a NEW pledge id | 3, 10 | "voids every hold at a missed deadline; 'already voided' counts as success"; "records 'already captured' as a success…"; `-r1` retry test |
| 34 | Plan 3 final | Request-id retention is limited: reconcile (GET) before re-capture after long gaps | 3 | "retries a retryable error later with the same job, and looks before re-capturing" (`captureAlreadyThere` on attempt ≥ 2) |
| 35 | Plan 3 final | Compare `Hold.amountCents` + `custom_id` vs the pledge; log a gross − fee ≠ net mismatch | 6, 3 | row 19; "logs when PayPal's gross minus fee isn't the net, and counts only the net" |
| 36 | Plan 3 final | Empty-body → `PayPalError(502)` helper; throw on missing `sender_item_id`; validate `paypalEmail` | 1 | "empty 2xx bodies" tests; "throws when a batch item has no sender_item_id"; "refuses a line without a valid PayPal email…" |
| 37 | Plan 3 final | Spec 9 reauthorize step + spec 10.1 "reauth more than once" unverified → drop in favour of void + re-hold | header, 10 | Deviation table; row 15 |

Controller decisions are covered as follows: 1 → Tasks 2, 8 (DO + SQLite + alarms, no Agents SDK, no D1); 2 → Tasks 2–7 ports + Task 11 script; 3 → Task 5 (+ budget DO in Task 8); 4 → Tasks 3, 6, 7; 5 → Tasks 6, 9, 10; 6 → Task 10; 7 → Tasks 8, 9; 8 → Controller pre-steps; 9 → Global Constraints; 10 → 11 tasks in the required order.

---

## Self-review against the spec

**1. Spec coverage**

- §2b artist flow: sentence → draft (Task 5 model/template, Task 9 `POST /api/shows`), code computes the target (Task 6 `previewDraft`, `buildMandate`), hold-to-sign = mandate (Task 6 `sign`, manage key once), share/manage paths returned. Fan flow: order + server authorize (Tasks 6, 9). Agent settles (Tasks 3, 4, 7).
- §2c plain words: every `message`, ledger `what` and log `did` is plain; PayPal terms only appear in `requestId`/`resultId`/`ref`.
- §3 state machine: Plan 1 `reduce` is the only state logic; capture at tipping (Task 3 jobs from `capture_all_held`/`capture_new_pledge`), one payout batch at the deadline once every capture settled (reducer + Task 4), void on miss (Task 3), cancel after tipping → refunds (Task 7 `callOff`, Task 3 refunds). Pace checks at 50% and 72 h (Task 7). Extend at most once / ≤ 7 days / ≤ 21 days total and lower-threshold floor come from Plan 1's guard (Task 7 `paceOptions`).
- §4 judge mode: per-visitor copies, two seeded shows, "Add fans", fast-forward (A tips, B misses), reset, 24 h expiry, agent trace (log with saw/did/rule/ids), settlement ledger rows (Tasks 6, 10). AG Grid itself is Plan 5.
- §5 AI: three jobs with templates, 70B for proposals/notes, 8B for extraction, hard daily budget, "resting until 00:00 UTC", no money flow depends on the model (Task 5, 7).
- §6.1 APIs: orders/authorize, capture, void, payouts, refunds, webhooks (verified), all through `src/paypal`; Agent Toolkit is NO-GO (spike) so REST only. Reauthorize deliberately unused (deviation).
- §6.2 hold timing: windows ≤ 21 days (Plan 1), capture at tipping, every money call with a deterministic `PayPal-Request-Id` (Plan 3) plus deterministic ledger/job keys (Tasks 2–3).
- §6.3 simulated fans: option 1 (real card holds), never a fake PayPal id (Task 10, Task 11 check).
- §7: Worker + one DO per campaign (SQLite, alarms); deviations recorded.
- §8 errors: capture failures (settle on what was captured, shortfall waits for the artist), payout item retry once, duplicate/out-of-order webhooks (keyed by event id; counts only from GETs), late deadline alarm (idempotent `applyDeadline`, `deadline:<ms>` key), budget exhausted (templates), demo hold expiry (re-hold), abuse (rate limits, caps, sandbox only).
- §9: unit tests per unit, the sandbox integration (`sandbox:check`, extended), the Worker integration (`worker:check`). Playwright E2E against the deployed site is Plan 6.

Gaps deliberately left to later plans: AG Grid and all UI (Plan 5); deploy, webhook registration, live webhook payload checks, real receiver accounts (Plan 6, owner actions). Demo shows will not reach a pace check inside their 24 h life (their 50% points are 1.16 and 2.16 days away), so a judge sees proposals only on a real show or if Plan 5 adds a demo control for it; Plan 5 should decide.

Known limits recorded for the reviewer: if PayPal never gives a final capture answer, the pledge stays "on hold" and payouts wait (surfaced as "Needs attention" after 8 checks over about 4.7 hours) rather than paying on a guess. Show A's demo seed clears its signed amounts by 8 cents at the sandbox fee (Task 11 note).

**2. Placeholder scan:** no "TBD"/"TODO"/"similar to Task N". The only fill-ins are the commit-message date and catalogue result in Task 5 Step 8, which the implementer must write from the check they perform (stated explicitly). Task 8 Step 6 gives an exact fallback block for one wrangler behaviour that can't be known before running it.

**3. Type consistency (checked across tasks):** `commit(store, at, event)` / `CommitResult`; `Runner(d, job, attempt)` and `Runners`; `RUNNERS` (Task 4, extended in Task 10); `ExecDeps.clock` is campaign time and `CampaignService.nextWakeAt()` returns REAL time (`- clockOffset()`); `eventKey` shapes used by tests (`pledge:`, `capture:`, `void:`, `refund:`, `payout:`, `extended`, `approved:`); job keys (`capture:<auth>`, `void:<auth>`, `refund:<capture>`, `reconcile:<auth>`, `payout:<show>`, `payout_retry:<show>`, `poll:<batch>:<n>`, `sim:<pledge>`, `rehold:<auth>`); `ProposalOption` fields (`id`, `approvalKey`, `label`, `newDeadline?`, `newThreshold?`, `collectedNet?`); `CampaignOp` grows in Tasks 7 and 10 by replacing the union as written; `RouterConfig.receivers` added in Task 10 together with both of its constructors (index + harness); `payoutBatchId(showId, retry?)` and `payoutItemId(showId, role, retry?)` match the fake PayPal and the views.

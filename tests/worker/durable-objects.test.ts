import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/agent/ids";
import { TURN_CALL_BUDGET } from "../../src/agent/policy";
import type { CampaignOp, CampaignReply } from "../../src/agent/dispatch";
import { meteredPayPal, type PayPalPort } from "../../src/agent/paypal-port";
import { SANDBOX_BASE } from "../../src/paypal/config";
import { TokenHolder } from "../../src/paypal/http";
import { fakeFetch } from "../paypal/fake-fetch";
import { ALARM_BACKOFF_MAX_MS, ALARM_BACKOFF_MIN_MS, CampaignAgent } from "../../src/worker/do/campaign-agent";
import { QuotaAgent } from "../../src/worker/do/quota-agent";
import type { StorageLike } from "../../src/worker/do/sql-adapter";
import type { Env } from "../../src/worker/env";
import { DRAFT, SIGN_TOKEN } from "../agent/harness";
import { FakePayPal } from "../agent/fake-paypal";
import { LAUNCH, SHOW, TestClock } from "../agent/fixtures";

/** ctx.storage fake: node:sqlite plus an alarm slot. */
function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  let open = false;
  const state = { alarm: null as number | null };
  const kv = new Map<string, unknown>();
  const storage: StorageLike & { setAlarm(t: number): Promise<void>; deleteAlarm(): Promise<void>; deleteAll(): Promise<void>; get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; delete(k: string): Promise<boolean> } = {
    get: async <T,>(k: string) => kv.get(k) as T | undefined,
    put: async (k, v) => void kv.set(k, v),
    delete: async (k) => kv.delete(k),
    sql: { exec: (q, ...b) => ({ toArray: () => db.prepare(q).all(...b) }) },
    transactionSync<T>(fn: () => T): T {
      if (open) throw new Error("nested");
      open = true;
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        open = false;
      }
    },
    setAlarm: async (t) => void (state.alarm = t),
    deleteAlarm: async () => void (state.alarm = null),
    deleteAll: async () => void kv.clear(),
  };
  return { ctx: { storage } as unknown as DurableObjectState, state, kv };
}

const ENV = { PAYPAL_CLIENT_ID: "test-id", PAYPAL_CLIENT_SECRET: "test-secret" } as unknown as Env;
const FETCHES_PER_CALL = 20;

function setup(makePort?: (n: number) => PayPalPort) {
  const { ctx, state } = fakeCtx();
  const clock = new TestClock(LAUNCH);
  const fakes: FakePayPal[] = [];
  const agent = new CampaignAgent(ctx, ENV, {
    clock,
    paypal: () => {
      if (makePort) return makePort(fakes.length);
      const f = new FakePayPal(clock);
      f.fetchesPerCall = FETCHES_PER_CALL;
      // PayPal remembers orders across invocations; each fake is new, so share the order book.
      if (fakes[0]) (f as unknown as { orders: unknown }).orders = (fakes[0] as unknown as { orders: unknown }).orders;
      fakes.push(f);
      return f;
    },
  });
  const send = async (op: CampaignOp) => (await (await agent.fetch(new Request("https://do/op", { method: "POST", body: JSON.stringify(op) }))).json()) as CampaignReply;
  return { agent, send, state, clock, fakes };
}

async function signed(h: ReturnType<typeof setup>) {
  await h.send({ op: "init", showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
  const r = await h.send({ op: "sign", body: { signToken: SIGN_TOKEN, draft: DRAFT } });
  expect(r.ok).toBe(true);
}

describe("CampaignAgent per-invocation subrequest meter", () => {
  it("gives interleaved invocations their own count, and neither passes the budget", async () => {
    const h = setup();
    await signed(h);
    const created = (await h.send({ op: "order", body: { initials: "AB" } })) as { ok: true; data: { orderId: string } };
    const orderId = created.data.orderId;
    // Invocation A's authorize call waits on a gate, like a slow PayPal answer.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const before = h.fakes.length;
    const callers: FakePayPal[] = [];
    const origAuth = FakePayPal.prototype.authorizeOrder;
    FakePayPal.prototype.authorizeOrder = async function (this: FakePayPal, id: string) {
      callers.push(h.fakes.find((f) => f === this) as FakePayPal);
      await gate;
      return origAuth.call(this, id);
    };
    try {
      const a = h.send({ op: "authorize", orderId });
      await Promise.resolve();
      // Invocation B runs completely while A is waiting: an alarm turn and a second fan's order.
      await h.agent.alarm();
      const second = await h.send({ op: "order", body: { initials: "CD" } });
      expect(second.ok).toBe(true);
      release();
      expect(await a).toMatchObject({ ok: true });
    } finally {
      FakePayPal.prototype.authorizeOrder = origAuth;
    }
    const aFake = callers[0];
    if (!aFake) throw new Error("authorize never ran");
    expect(aFake.calls.map((c) => c.op)).toContain("authorizeOrder");
    // A saw only its own calls; the other invocations' calls are on their own ports.
    expect(h.fakes.length - before).toBe(3);
    expect(aFake.meter.used).toBe(aFake.calls.length * FETCHES_PER_CALL);
    for (const f of h.fakes) {
      expect(f.meter.used).toBe(f.calls.length * FETCHES_PER_CALL);
      expect(f.meter.used).toBeLessThanOrEqual(TURN_CALL_BUDGET);
    }
    expect(new Set(h.fakes).size).toBe(h.fakes.length);
  });
});

describe("CampaignAgent OAuth token", () => {
  it("is fetched once and reused by later invocations (each invocation still meters its own fetches)", async () => {
    const f = fakeFetch([
      { status: 201, body: { id: "ORDER1" } },
      { status: 201, body: { id: "ORDER2" } },
    ]);
    const { ctx } = fakeCtx();
    const clock = new TestClock(LAUNCH);
    const agent = new CampaignAgent(ctx, ENV, { clock, fetch: f.fetch });
    const send = async (op: CampaignOp) => (await (await agent.fetch(new Request("https://do/op", { method: "POST", body: JSON.stringify(op) }))).json()) as CampaignReply;
    await send({ op: "init", showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    await send({ op: "sign", body: { signToken: SIGN_TOKEN, draft: DRAFT } });
    expect(await send({ op: "order", body: { initials: "AB" } })).toMatchObject({ ok: true });
    expect(await send({ op: "order", body: { initials: "CD" } })).toMatchObject({ ok: true });
    expect(f.apiCalls()).toHaveLength(2);
    expect(f.tokenCalls()).toBe(1);
  });

  it("is metered when it is fetched, and not when another invocation already holds it", async () => {
    const f = fakeFetch([]);
    const holder = new TokenHolder();
    const config = { clientId: "id", clientSecret: "secret", baseUrl: SANDBOX_BASE };
    const first = meteredPayPal(config, { fetch: f.fetch, tokenHolder: holder });
    const second = meteredPayPal(config, { fetch: f.fetch, tokenHolder: holder });
    await first.http.token();
    await second.http.token();
    expect(f.tokenCalls()).toBe(1);
    expect(first.meter.used).toBe(1);
    expect(second.meter.used).toBe(0);
  });
});

describe("CampaignAgent alarm", () => {
  function throwingPort(): PayPalPort {
    return new Proxy({} as PayPalPort, {
      get() {
        throw new Error("boom");
      },
    });
  }

  it("re-arms no later than now + 60 s when the turn throws, and still throws", async () => {
    let throwNow = false;
    const clock = new TestClock(LAUNCH);
    const { ctx, state } = fakeCtx();
    const agent = new CampaignAgent(ctx, ENV, { clock, paypal: () => (throwNow ? throwingPort() : new FakePayPal(clock)) });
    const send = (op: CampaignOp) => agent.fetch(new Request("https://do/op", { method: "POST", body: JSON.stringify(op) }));
    await send({ op: "init", showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    await send({ op: "sign", body: { signToken: SIGN_TOKEN, draft: DRAFT } });
    state.alarm = LAUNCH + 10 * 86_400_000;
    throwNow = true;
    await expect(agent.alarm()).rejects.toThrow("boom");
    expect(state.alarm).not.toBeNull();
    expect(state.alarm).toBeLessThanOrEqual(LAUNCH + ALARM_BACKOFF_MIN_MS);
  });

  it("backs off 60 s, 2 min, 4 min ... up to 1 h when the turn keeps throwing, and resets on success", async () => {
    let throwNow = false;
    const clock = new TestClock(LAUNCH);
    const { ctx, state, kv } = fakeCtx();
    const agent = new CampaignAgent(ctx, ENV, { clock, paypal: () => (throwNow ? throwingPort() : new FakePayPal(clock)) });
    const send = (op: CampaignOp) => agent.fetch(new Request("https://do/op", { method: "POST", body: JSON.stringify(op) }));
    await send({ op: "init", showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    await send({ op: "sign", body: { signToken: SIGN_TOKEN, draft: DRAFT } });
    state.alarm = LAUNCH + 10 * 86_400_000;
    throwNow = true;
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      await expect(agent.alarm()).rejects.toThrow("boom");
      waits.push((state.alarm as number) - clock.now());
    }
    expect(waits).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, ALARM_BACKOFF_MAX_MS, ALARM_BACKOFF_MAX_MS, ALARM_BACKOFF_MAX_MS]);
    expect(kv.get("alarm_backoff_ms")).toBe(ALARM_BACKOFF_MAX_MS);
    throwNow = false;
    await agent.alarm();
    expect(kv.has("alarm_backoff_ms")).toBe(false);
    throwNow = true;
    await expect(agent.alarm()).rejects.toThrow("boom");
    expect((state.alarm as number) - clock.now()).toBe(ALARM_BACKOFF_MIN_MS);
  });

  it("backs off the same way while the sandbox keys are missing, and recovers when they return", async () => {
    const clock = new TestClock(LAUNCH);
    const { ctx, state, kv } = fakeCtx();
    const env = { PAYPAL_CLIENT_ID: "test-id", PAYPAL_CLIENT_SECRET: "test-secret" } as unknown as Env & Record<string, string | undefined>;
    const agent = new CampaignAgent(ctx, env, { clock, paypal: () => new FakePayPal(clock) });
    const send = (op: CampaignOp) => agent.fetch(new Request("https://do/op", { method: "POST", body: JSON.stringify(op) }));
    await send({ op: "init", showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    await send({ op: "sign", body: { signToken: SIGN_TOKEN, draft: DRAFT } });
    delete env.PAYPAL_CLIENT_SECRET;
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await agent.alarm();
      waits.push((state.alarm as number) - clock.now());
    }
    expect(waits).toEqual([60_000, 120_000, 240_000]);
    env.PAYPAL_CLIENT_SECRET = "test-secret";
    await agent.alarm();
    expect(kv.has("alarm_backoff_ms")).toBe(false);
  });

  it("re-arms normally when the turn succeeds", async () => {
    const h = setup();
    await signed(h);
    h.state.alarm = null;
    await h.agent.alarm();
    expect(h.state.alarm).not.toBeNull();
  });
});

describe("QuotaAgent", () => {
  it("answers 400 to invalid JSON", async () => {
    const { ctx } = fakeCtx();
    const res = await new QuotaAgent(ctx).fetch(new Request("https://quota/op", { method: "POST", body: "{nope" }));
    expect(res.status).toBe(400);
  });

  it("still answers a valid op", async () => {
    const { ctx } = fakeCtx();
    const res = await new QuotaAgent(ctx).fetch(new Request("https://quota/op", { method: "POST", body: JSON.stringify({ op: "reserve", neurons: 1 }) }));
    expect(res.status).toBe(200);
  });
});

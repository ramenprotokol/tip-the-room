import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { receiversFrom, demoSeeds } from "../../src/agent/demo";
import { sha256Hex } from "../../src/agent/ids";
import { TURN_CALL_BUDGET } from "../../src/agent/policy";
import type { CampaignOp, CampaignReply } from "../../src/agent/dispatch";
import { meteredPayPal, type PayPalPort } from "../../src/agent/paypal-port";
import { SANDBOX_BASE } from "../../src/paypal/config";
import { TokenHolder } from "../../src/paypal/http";
import { fakeFetch } from "../paypal/fake-fetch";
import { ALARM_BACKOFF_MAX_MS, ALARM_BACKOFF_MIN_MS, CampaignAgent } from "../../src/worker/do/campaign-agent";
import { CampaignService } from "../../src/agent/service";
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

describe("CampaignAgent alarm writes", () => {
  function counted() {
    const h = setup();
    let sets = 0;
    let deletes = 0;
    const storage = (h.agent as unknown as { ctx: { storage: { setAlarm(t: number): Promise<void>; deleteAlarm(): Promise<void> } } }).ctx.storage;
    const set = storage.setAlarm;
    const del = storage.deleteAlarm;
    storage.setAlarm = async (t) => (sets++, set(t));
    storage.deleteAlarm = async () => (deletes++, del());
    return { h, sets: () => sets, deletes: () => deletes };
  }

  it("sets the alarm once for repeated polls, and again when the wake time changes", async () => {
    const wake = vi.spyOn(CampaignService.prototype, "nextWakeAt").mockReturnValue(LAUNCH + 1000);
    try {
      const c = counted();
      await signed(c.h);
      expect(c.sets()).toBe(1);
      for (let i = 0; i < 5; i++) await c.h.send({ op: "public" });
      expect(c.sets()).toBe(1);
      wake.mockReturnValue(LAUNCH + 2000);
      await c.h.send({ op: "public" });
      await c.h.send({ op: "public" });
      expect(c.sets()).toBe(2);
      expect(c.h.state.alarm).toBe(LAUNCH + 2000);
      wake.mockReturnValue(null);
      await c.h.send({ op: "public" });
      await c.h.send({ op: "public" });
      expect(c.deletes()).toBe(1);
      expect(c.h.state.alarm).toBeNull();
    } finally {
      wake.mockRestore();
    }
  });

  it("the first fetch after a new instance sets the alarm, then polls are free", async () => {
    const c = counted();
    await c.h.send({ op: "init", showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    await c.h.send({ op: "sign", body: { signToken: SIGN_TOKEN, draft: DRAFT } });
    expect(c.sets()).toBeGreaterThan(0);
    const after = c.sets();
    await c.h.send({ op: "public" });
    await c.h.send({ op: "public" });
    expect(c.sets()).toBe(after);
    c.h.state.alarm = null; // the platform fired it
    await c.h.agent.alarm();
    expect(c.h.state.alarm).not.toBeNull();
  });

  it("logs a rows=0 line for bad JSON and for an alarm with nothing stored", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const h = setup();
      await h.agent.fetch(new Request("https://do/op", { method: "POST", body: "{nope" }));
      await h.agent.alarm();
      const noKeys = new CampaignAgent(fakeCtx().ctx, {} as unknown as Env);
      await noKeys.fetch(new Request("https://do/op", { method: "POST", body: JSON.stringify({ op: "public" }) }));
      const lines = spy.mock.calls.map((a) => String(a[0]));
      expect(lines).toContain("do_rows do=campaign kind=fetch op=other rows=0");
      expect(lines).toContain("do_rows do=campaign kind=alarm op=tick rows=0");
      expect(lines).toContain("do_rows do=campaign kind=fetch op=public rows=0");
    } finally {
      spy.mockRestore();
    }
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

describe("CampaignAgent AI budget", () => {
  /** A demo show asked for a pace check makes one model call, which reserves from the Quota DO: the reserve says whose budget. */
  async function reserves(judge: boolean | undefined) {
    const sent: unknown[] = [];
    const env = {
      ...ENV,
      AI: { run: async () => ({ response: "{}" }) },
      QUOTA: { idFromName: () => "q", get: () => ({ fetch: async (_u: string, init: { body: string }) => (sent.push(JSON.parse(init.body)), Response.json({ ok: true })) }) },
    } as unknown as Env;
    const { ctx } = fakeCtx();
    const agent = new CampaignAgent(ctx, env, { clock: new TestClock(LAUNCH), paypal: () => new FakePayPal(new TestClock(LAUNCH)) });
    const send = async (op: CampaignOp) => (await (await agent.fetch(new Request("https://do/op", { method: "POST", body: JSON.stringify(op) }))).json()) as CampaignReply;
    const key = "k".repeat(43);
    const [seed] = demoSeeds(receiversFrom({}));
    expect(await send({ op: "demo_init", showId: "dabcdefghjka", seed, demoKeyHash: await sha256Hex(key), judge })).toMatchObject({ ok: true });
    expect(await send({ op: "demo_pace", manageKey: key })).toMatchObject({ ok: true });
    return sent.filter((o) => (o as { op: string }).op === "reserve");
  }

  it("reserves from the judge share for a judge show, and from the public share for any other", async () => {
    const asJudge = await reserves(true);
    expect(asJudge.length).toBeGreaterThan(0);
    expect(asJudge.every((o) => (o as { judge: boolean }).judge === true)).toBe(true);
    const asPublic = await reserves(undefined);
    expect(asPublic.length).toBeGreaterThan(0);
    expect(asPublic.every((o) => (o as { judge: boolean }).judge === false)).toBe(true);
  });
});

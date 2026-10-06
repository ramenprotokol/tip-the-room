import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/agent/ids";
import { TURN_CALL_BUDGET } from "../../src/agent/policy";
import type { CampaignOp, CampaignReply } from "../../src/agent/dispatch";
import type { PayPalPort } from "../../src/agent/paypal-port";
import { ALARM_RETRY_MAX_MS, CampaignAgent } from "../../src/worker/do/campaign-agent";
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
  const storage: StorageLike & { setAlarm(t: number): Promise<void>; deleteAlarm(): Promise<void>; deleteAll(): Promise<void> } = {
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
    deleteAll: async () => undefined,
  };
  return { ctx: { storage } as unknown as DurableObjectState, state };
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
    expect(state.alarm).toBeLessThanOrEqual(LAUNCH + ALARM_RETRY_MAX_MS);
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

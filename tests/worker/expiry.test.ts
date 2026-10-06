import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/agent/ids";
import type { CampaignOp, CampaignReply } from "../../src/agent/dispatch";
import { UNSIGNED_TTL_MS } from "../../src/agent/policy";
import { CampaignAgent } from "../../src/worker/do/campaign-agent";
import type { StorageLike } from "../../src/worker/do/sql-adapter";
import type { Env } from "../../src/worker/env";
import { SIGN_TOKEN } from "../agent/harness";
import { FakePayPal } from "../agent/fake-paypal";
import { LAUNCH, SHOW, TestClock } from "../agent/fixtures";

/** ctx.storage fake with a deleteAll that really empties the database, like the platform's. */
function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  let open = false;
  const state = { alarm: null as number | null, deleted: 0 };
  const kv = new Map<string, unknown>();
  const storage: StorageLike & { setAlarm(t: number): Promise<void>; deleteAlarm(): Promise<void>; deleteAll(): Promise<void>; get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void>; delete(k: string): Promise<boolean> } = {
    get: async (k) => kv.get(k),
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
    deleteAll: async () => {
      state.deleted += 1;
      kv.clear();
      for (const t of ["meta", "events", "jobs", "agent_log"]) db.exec(`DROP TABLE IF EXISTS ${t}`);
    },
  };
  return { ctx: { storage } as unknown as DurableObjectState, state };
}

const ENV = { PAYPAL_CLIENT_ID: "test-id", PAYPAL_CLIENT_SECRET: "test-secret" } as unknown as Env;

function setup() {
  const { ctx, state } = fakeCtx();
  const clock = new TestClock(LAUNCH);
  const agent = new CampaignAgent(ctx, ENV, { clock, paypal: () => new FakePayPal(clock) });
  const send = async (op: CampaignOp) => (await (await agent.fetch(new Request("https://do/op", { method: "POST", body: JSON.stringify(op) }))).json()) as CampaignReply;
  return { agent, send, state, clock };
}

describe("the alarm deletes a show nobody signed after about 24 hours", () => {
  it("arms the alarm at creation, then deletes the storage and the alarm when it fires", async () => {
    const h = setup();
    expect((await h.send({ op: "init", showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) })).ok).toBe(true);
    expect(h.state.alarm).toBe(LAUNCH + UNSIGNED_TTL_MS);
    h.clock.t = LAUNCH + UNSIGNED_TTL_MS - 1000;
    await h.agent.alarm();
    expect(h.state.deleted).toBe(0);
    expect(h.state.alarm).toBe(LAUNCH + UNSIGNED_TTL_MS);
    h.clock.t = LAUNCH + UNSIGNED_TTL_MS;
    await h.agent.alarm();
    expect(h.state.deleted).toBe(1);
    expect(h.state.alarm).toBeNull();
    // The id now answers like a show that never existed.
    expect(await h.send({ op: "public" })).toMatchObject({ ok: false, status: 404 });
  });
});

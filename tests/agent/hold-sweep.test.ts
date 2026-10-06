import { describe, expect, it } from "vitest";
import { commit, drain, type ExecDeps } from "../../src/agent/executor";
import { sweepStuckHolds } from "../../src/agent/hold-runner";
import { SIM_CARD } from "../../src/agent/paypal-port";
import { SWEEP_BACKOFF_MS } from "../../src/agent/policy";
import { RUNNERS } from "../../src/agent/runners";
import { Store } from "../../src/agent/store";
import { PayPalError } from "../../src/paypal/errors";
import { FakePayPal } from "./fake-paypal";
import { DEADLINE, held, LAUNCH, signedEvent, SHOW, TestClock } from "./fixtures";
import { memoryDb } from "./sqlite";

const busy = () => new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
const orderOf = (captures: { id: string; status: string }[], auth: string) => () => ({ orderId: "O1", status: "COMPLETED", authorizations: [{ id: "A1", status: auth }], captures });

/** Four fans tip; A1's capture and reconcile both give up (PayPal keeps answering 503 / "captured, no capture"). */
async function stuck() {
  const store = new Store(memoryDb());
  store.migrate();
  const clock = new TestClock(LAUNCH + 1000);
  const paypal = new FakePayPal(clock);
  const d: ExecDeps = { store, paypal, clock, showId: SHOW, card: SIM_CARD };
  commit(store, clock.now(), await signedEvent());
  // A1's capture call always fails with a retryable error.
  for (let i = 0; i < 40; i++) paypal.script("captureHold", (a: string) => {
    if (a === "A1") throw busy();
    return { captureId: `C-${a}`, authorizationId: a, status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 };
  });
  for (let i = 1; i <= 4; i++) commit(store, clock.now(), held(i));
  return { store, clock, paypal, d };
}

/** Runs turns (jobs, then the sweep), moving the clock to the next wake-up, until `until` or no more work. */
async function run(h: Awaited<ReturnType<typeof stuck>>, hours: number) {
  const end = h.clock.t + hours * 3_600_000;
  for (let i = 0; i < 400; i++) {
    await drain(h.d, RUNNERS);
    await sweepStuckHolds(h.d);
    const job = h.store.nextJobAt();
    const times = [job === undefined ? undefined : Math.max(job, h.clock.t + 1), ...[...h.store.projection().pledges.values()].map((x) => Number(h.store.getMeta(`sweep:${x.authorizationId}`)?.split(":")[1] ?? NaN))].filter((t): t is number => t !== undefined && Number.isFinite(t) && t > h.clock.t);
    if (times.length === 0) return;
    const next = Math.min(...times);
    if (next > end) return;
    h.clock.t = next;
  }
}

describe("stuck held pledges (sweep)", () => {
  it("settles on what was captured after the cap: payouts proceed and the stuck hold is voided", async () => {
    const h = await stuck();
    // The order never shows a capture, and reconcile can't decide (the authorization reads CAPTURED).
    for (let i = 0; i < 80; i++) h.paypal.script("getOrderPayments", orderOf([], "CAPTURED"));
    h.clock.t = DEADLINE;
    commit(h.store, DEADLINE, { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE });
    expect(h.store.projection().campaign.state).toBe("paying_out");
    await run(h, 72);
    const p = h.store.projection();
    expect(p.pledges.get("p1")).toMatchObject({ status: "capture_failed", holdClosed: true });
    expect(p.campaign.state).toBe("settled");
    expect(p.payouts[0].lines.reduce((n, l) => n + l.amount, 0)).toBe(3 * 1412);
    expect(h.paypal.count("sendPayouts")).toBe(1);
    expect(h.paypal.effects.has("void:A1")).toBe(true);
    expect(h.paypal.effects.has("capture:A1")).toBe(false);
  });

  it("waits for the backoff before settling; early sweeps only ask PayPal again", async () => {
    const h = await stuck();
    for (let i = 0; i < 80; i++) h.paypal.script("getOrderPayments", orderOf([], "CAPTURED"));
    h.clock.t = DEADLINE;
    commit(h.store, DEADLINE, { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE });
    await run(h, 3);
    expect(h.store.projection().pledges.get("p1")?.status).toBe("held");
    expect(SWEEP_BACKOFF_MS.length).toBeGreaterThan(1);
  });

  it("never marks a pledge failed while PayPal shows a COMPLETED capture; it records the charge instead", async () => {
    const h = await stuck();
    for (let i = 0; i < 80; i++) h.paypal.script("getOrderPayments", orderOf([{ id: "C-A1", status: "COMPLETED" }], "CAPTURED"));
    h.clock.t = DEADLINE;
    commit(h.store, DEADLINE, { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE });
    await run(h, 72);
    const p = h.store.projection();
    expect(p.pledges.get("p1")?.status).toBe("charged");
    expect(h.store.events().some((e) => e.event.type === "capture_failed")).toBe(false);
    expect(p.campaign.state).toBe("settled");
  });
});

describe("failed-charge holds that PayPal already closed", () => {
  it("reconcile sets holdClosed for a capture_failed pledge whose hold is VOIDED or EXPIRED", async () => {
    for (const status of ["VOIDED", "EXPIRED"]) {
      const h = await stuck();
      commit(h.store, h.clock.now(), { type: "capture_failed", authorizationId: "A2", reason: "x" });
      h.paypal.script("getOrderPayments", () => ({ orderId: "O2", status: "COMPLETED", authorizations: [{ id: "A2", status }], captures: [] }));
      h.store.putJob({ key: "reconcile:A2", kind: "reconcile", target: "A2", nextAt: h.clock.now() }, h.clock.now());
      await drain(h.d, RUNNERS);
      expect(h.store.projection().pledges.get("p2")).toMatchObject({ status: "capture_failed", holdClosed: true });
    }
  });
});

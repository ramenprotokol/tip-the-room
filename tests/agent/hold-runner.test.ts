import { describe, expect, it } from "vitest";
import { commit, drain, type ExecDeps } from "../../src/agent/executor";
import { paypalPort } from "../../src/agent/paypal-port";
import type { PayPalHttp } from "../../src/paypal/http";
import { HOLD_RUNNERS, recordCharge } from "../../src/agent/hold-runner";
import { TURN_CALL_BUDGET, jobCost } from "../../src/agent/policy";
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
    h.paypal.script("getCapture", (c: string, a: string) => ({ captureId: c, authorizationId: a, status: "REFUNDED" }));
    await settle(h);
    expect(h.store.projection().pledges.get("p1")).toMatchObject({ status: "refunded", refundId: null });
  });

  it("keeps retrying a failing refund with backoff, then needs attention", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    for (let i = 0; i < 12; i++) {
      h.paypal.script("refundCharge", (c: string) => {
        if (c === "C-A1") throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
        return { refundId: `R-${c}`, captureId: c, status: "COMPLETED" };
      });
    }
    await settle(h, 30 * 24 * 60 * 60 * 1000);
    expect(h.store.job("refund:C-A1")?.status).toBe("failed");
    expect(h.store.projection().campaign.pledges.charged).toBe(1);
  });
});

describe("review requirements", () => {
  const order = (captures: { id: string; status: string }[], auth = "CAPTURED") => () => ({ orderId: "O1", status: "COMPLETED", authorizations: [{ id: "A1", status: auth }], captures });

  it("never records capture_failed when the order shows the capture actually succeeded", async () => {
    const h = await setup(3);
    h.paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "DECLINED" }));
    h.paypal.script("getOrderPayments", order([{ id: "C-A1", status: "COMPLETED" }]));
    await drain(h.d, HOLD_RUNNERS);
    expect(h.store.projection().pledges.get("p1")).toMatchObject({ status: "charged", captureId: "C-A1" });
    expect(h.store.events().some((e) => e.event.type === "capture_failed")).toBe(false);
  });

  it("does not record a failure when the order check itself fails; it reconciles later", async () => {
    const h = await setup(3);
    h.paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "DECLINED" }));
    h.paypal.script("getOrderPayments", () => {
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
    });
    await drain(h.d, HOLD_RUNNERS);
    expect(h.store.projection().pledges.get("p1")?.status).toBe("held");
    expect(h.store.job("reconcile:A1")?.status).toBe("pending");
  });

  it("when the hold is still open and nothing was captured, records the failure only on the second look", async () => {
    const h = await setup(3);
    h.paypal.script("captureHold", () => {
      throw unprocessable("INSTRUMENT_DECLINED");
    });
    h.paypal.script("getOrderPayments", order([], "CREATED"), order([], "CREATED"));
    await drain(h.d, HOLD_RUNNERS);
    expect(h.store.projection().pledges.get("p1")?.status).toBe("held");
    h.clock.t += 60_000;
    await drain(h.d, HOLD_RUNNERS);
    expect(h.store.projection().pledges.get("p1")?.status).toBe("capture_failed");
  });

  it("charges the current authorization when the job's hold was replaced; never the retired one", async () => {
    const h = await setup(3);
    h.store.jobs().forEach((j) => h.store.updateJob(j.key, { status: "done" }));
    commit(h.store, h.clock.now(), { type: "hold_replaced", pledgeId: "p1", newPaypalPledgeId: "p1-h1", orderId: "O1b", authorizationId: "A1b", oldOrderId: "O1", oldAuthorizationId: "A1", authorizedAt: LAUNCH, expiresAt: LAUNCH + 1e9 });
    h.store.updateJob("capture:A1", { status: "pending", nextAt: 0, attempts: 0 });
    await drain(h.d, HOLD_RUNNERS);
    expect(h.paypal.calls.filter((c) => c.op === "captureHold").map((c) => c.args[0])).toEqual(["A1b"]);
    expect(h.store.job("capture:A1")?.status).toBe("skipped");
    expect(h.store.projection().pledges.get("p1")).toMatchObject({ status: "charged", authorizationId: "A1b" });
  });

  it("skips a capture for a retired late hold and logs why", async () => {
    const h = await setup(3);
    commit(h.store, h.clock.now(), { type: "late_hold", pledgeId: "p9", orderId: "O9", authorizationId: "A9", amountCents: 1500 });
    h.store.putJob({ key: "capture:A9", kind: "capture", target: "A9", nextAt: 0 }, 0);
    await drain(h.d, HOLD_RUNNERS);
    expect(h.paypal.calls.some((c) => c.args[0] === "A9")).toBe(false);
    expect(h.store.job("capture:A9")?.status).toBe("skipped");
  });

  it("a PENDING refund is recorded without counting, never re-sent, and completes when the capture shows REFUNDED", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    h.paypal.script("refundCharge", (c: string) => ({ refundId: `R-${c}`, captureId: c, status: "PENDING" }));
    await drain(h.d, HOLD_RUNNERS);
    expect(h.store.projection().pledges.get("p1")).toMatchObject({ status: "charged" });
    expect(h.store.job("refund:C-A1")?.status).toBe("pending");
    h.paypal.script("getCapture", (c: string, a: string) => ({ captureId: c, authorizationId: a, status: "REFUNDED" }));
    await settle(h);
    expect(h.paypal.count("refundCharge")).toBe(3);
    expect(h.store.projection().pledges.get("p1")).toMatchObject({ status: "refunded", refundId: "R-C-A1" });
  });

  it("a refund PayPal answers FAILED is surfaced, not retried", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    h.paypal.script("refundCharge", (c: string) => ({ refundId: `R-${c}`, captureId: c, status: "FAILED" }));
    await settle(h, 30 * 24 * 60 * 60 * 1000);
    expect(h.paypal.calls.filter((c) => c.op === "refundCharge" && c.args[0] === "C-A1")).toHaveLength(1);
    expect(h.store.job("refund:C-A1")?.status).toBe("failed");
    expect(h.store.logs().some((l) => l.did.startsWith("Needs attention: PayPal couldn't finish Fan 01"))).toBe(true);
  });

  it("a refund stuck PENDING past the retry limit is surfaced", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    h.paypal.script("refundCharge", (c: string) => ({ refundId: `R-${c}`, captureId: c, status: "PENDING" }));
    for (let i = 0; i < 12; i++) h.paypal.script("getCapture", (c: string, a: string) => ({ captureId: c, authorizationId: a, status: c === "C-A1" ? "COMPLETED" : "REFUNDED" }));
    await settle(h, 30 * 24 * 60 * 60 * 1000);
    expect(h.store.job("refund:C-A1")?.status).toBe("failed");
    expect(h.store.logs().some((l) => l.did.startsWith("Needs attention:"))).toBe(true);
  });

  it("never puts PayPal error codes in user-facing log lines", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    for (let i = 0; i < 12; i++) h.paypal.script("refundCharge", () => {
      throw unprocessable("INSUFFICIENT_FUNDS");
    });
    await settle(h, 30 * 24 * 60 * 60 * 1000);
    const text = h.store.logs().map((l) => `${l.saw} ${l.did}`).join("\n");
    expect(text).not.toMatch(/INSUFFICIENT_FUNDS|UNPROCESSABLE|422/);
  });

  it("refuses a malformed show id before building payout ids", async () => {
    const port = paypalPort({} as PayPalHttp);
    await expect(port.sendPayouts("bad id!", [], false)).rejects.toThrow(RangeError);
  });
});

describe("per-turn PayPal call budget", () => {
  it("documents worst-case costs and a budget below the free plan's 50 subrequests", () => {
    expect(TURN_CALL_BUDGET).toBeLessThan(50);
    expect(jobCost("capture", 1)).toBe(3);
    expect(jobCost("capture", 2)).toBe(5);
    expect(jobCost("payout", 1)).toBeGreaterThanOrEqual(1);
  });

  it("stops starting capture jobs before the budget runs out; the rest run next drain", async () => {
    const h = await setup(30);
    h.paypal.fetchesPerCall = 3; // a token fetch plus a retry on every call
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await drain(h.d, HOLD_RUNNERS, 100);
      seen.push(h.paypal.meter.used);
      expect(r.ran).toBeLessThanOrEqual(12);
      if (i < 2) expect(r.more).toBe(true);
    }
    expect(Math.max(...seen)).toBeLessThanOrEqual(TURN_CALL_BUDGET);
    expect(h.store.projection().campaign.pledges.charged).toBe(30);
    expect(h.paypal.count("captureHold")).toBe(30);
  });

  it("counts payout jobs against the same budget", async () => {
    const h = await setup(0);
    h.paypal.fetchesPerCall = 20;
    for (let i = 1; i <= 3; i++) h.store.putJob({ key: `poll:B-${i}:1`, kind: "payout_poll", target: `B-${i}`, nextAt: 0 }, 0);
    const poll = async (d: ExecDeps, job: { key: string; target: string }) => {
      await d.paypal.getPayoutBatch(job.target);
      d.store.updateJob(job.key, { status: "done" });
    };
    const r = await drain(h.d, { payout_poll: poll }, 100);
    expect(r.ran).toBe(2);
    expect(r.more).toBe(true);
    expect(h.store.job("poll:B-3:1")?.status).toBe("pending");
    const r2 = await drain(h.d, { payout_poll: poll }, 100);
    expect(r2.ran).toBe(1);
  });
});

describe("fix round 1", () => {
  const order = (captures: { id: string; status: string }[], auth = "CAPTURED") => () => ({ orderId: "O1", status: "COMPLETED", authorizations: [{ id: "A1", status: auth }], captures });

  it("a benign duplicate capture_ok stays quiet; a genuine conflict still says Needs attention", async () => {
    const h = await setup(3);
    const stale = h.store.projection();
    const pledge = stale.pledges.get("p1")!;
    const charge = { captureId: "C-A1", authorizationId: "A1", status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 };
    expect(recordCharge(h.d, stale, pledge, charge)).toBe(true);
    const n = h.store.logs().length;
    expect(recordCharge(h.d, stale, pledge, charge)).toBe(true);
    expect(h.store.logs()).toHaveLength(n);

    const h2 = await setup(3);
    const stale2 = h2.store.projection();
    commit(h2.store, h2.clock.now(), { type: "capture_failed", authorizationId: "A1", reason: "x" });
    recordCharge(h2.d, stale2, stale2.pledges.get("p1")!, charge);
    expect(h2.store.logs().some((l) => l.did.startsWith("Needs attention:"))).toBe(true);
  });

  it("attempt 2 with a PENDING live capture reconciles instead of re-sending the capture", async () => {
    const h = await setup(1);
    h.store.putJob({ key: "capture:A1", kind: "capture", target: "A1", nextAt: 0, }, 0);
    h.store.updateJob("capture:A1", { attempts: 1 });
    h.paypal.script("getOrderPayments", order([{ id: "C-A1", status: "PENDING" }], "CAPTURED"));
    h.paypal.script("getCapture", (c: string, a: string) => ({ captureId: c, authorizationId: a, status: "PENDING" }));
    commit(h.store, h.clock.now(), held(2));
    commit(h.store, h.clock.now(), held(3));
    h.store.updateJob("capture:A1", { status: "pending", nextAt: 0, attempts: 1 });
    await drain(h.d, HOLD_RUNNERS);
    expect(h.paypal.calls.some((c) => c.op === "captureHold" && c.args[0] === "A1")).toBe(false);
    expect(h.store.job("reconcile:A1")?.status).toBe("pending");
  });

  it("a refund PayPal refuses outright fails fast", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    h.paypal.script("refundCharge", (c: string) => {
      if (c === "C-A1") throw unprocessable("INSUFFICIENT_FUNDS");
      return { refundId: `R-${c}`, captureId: c, status: "COMPLETED" };
    });
    await settle(h, 30 * 24 * 60 * 60 * 1000);
    expect(h.paypal.calls.filter((c) => c.op === "refundCharge" && c.args[0] === "C-A1")).toHaveLength(1);
    expect(h.store.job("refund:C-A1")?.status).toBe("failed");
  });

  it("an unusable (empty) refund answer still retries", async () => {
    const h = await setup(3);
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    h.paypal.script("refundCharge", () => {
      throw new PayPalError(502, "EMPTY_RESPONSE_BODY", "empty");
    });
    await settle(h);
    expect(h.store.projection().pledges.get("p1")?.status).toBe("refunded");
  });

  it("reconcile does not try to record a failed charge while the show is live; it needs attention instead", async () => {
    const h = await setup(1);
    expect(h.store.projection().campaign.state).toBe("live");
    h.store.putJob({ key: "reconcile:A1", kind: "reconcile", target: "A1", nextAt: 0 }, 0);
    h.paypal.script("getOrderPayments", order([], "VOIDED"));
    await drain(h.d, HOLD_RUNNERS);
    expect(h.store.job("reconcile:A1")?.status).toBe("failed");
    expect(h.store.projection().pledges.get("p1")?.status).toBe("held");
    expect(h.store.logs().some((l) => l.did.startsWith("Needs attention:"))).toBe(true);
  });

  /** PayPal did the thing, then the process died before recording; the lease expired and the job re-ran. */
  const crashThenRerun = async (h: Awaited<ReturnType<typeof setup>>, kind: "capture" | "void" | "refund", target: string, call: (d: ExecDeps) => Promise<unknown>) => {
    await drain(h.d, { [kind]: async (d: ExecDeps) => void (await call(d)) });
    expect(h.store.job(`${kind}:${target}`)?.status).toBe("pending");
    h.clock.t += 61_000;
    await drain(h.d, HOLD_RUNNERS);
  };
  const countEvents = (h: Awaited<ReturnType<typeof setup>>, type: string) => h.store.events().filter((e) => e.event.type === type).length;

  it("crash after PayPal captured: the re-run records it once and money moves once", async () => {
    const h = await setup(3);
    for (let i = 2; i <= 3; i++) h.store.updateJob(`capture:A${i}`, { status: "done" });
    h.paypal.script("getOrderPayments", order([{ id: "C-A1", status: "COMPLETED" }]));
    await crashThenRerun(h, "capture", "A1", (d) => d.paypal.captureHold("A1"));
    expect(h.store.projection().pledges.get("p1")).toMatchObject({ status: "charged", captureId: "C-A1" });
    expect(countEvents(h, "capture_ok")).toBe(1);
    expect(h.paypal.effects.size).toBe(1);
  });

  it("crash after PayPal voided: the re-run records it once and money moves once", async () => {
    const h = await setup(1);
    h.clock.t = DEADLINE;
    commit(h.store, DEADLINE, { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE });
    await crashThenRerun(h, "void", "A1", (d) => d.paypal.voidHold("A1"));
    expect(h.store.projection().campaign.pledges).toMatchObject({ held: 0, released: 1 });
    expect(countEvents(h, "void_ok")).toBe(1);
    expect(h.paypal.effects.size).toBe(1);
    expect(h.paypal.count("voidHold")).toBe(2);
  });

  it("crash after PayPal refunded: the re-run records it once and money moves once", async () => {
    const h = await setup(1);
    h.store.updateJob("capture:A1", { status: "done" });
    commit(h.store, h.clock.now(), held(2));
    commit(h.store, h.clock.now(), held(3));
    await drain(h.d, HOLD_RUNNERS);
    commit(h.store, h.clock.now(), { type: "show_cancelled" });
    h.paypal.effects.clear();
    for (const t of ["C-A2", "C-A3"]) h.store.updateJob(`refund:${t}`, { status: "done" });
    await crashThenRerun(h, "refund", "C-A1", (d) => d.paypal.refundCharge("C-A1"));
    expect(h.store.projection().pledges.get("p1")).toMatchObject({ status: "refunded" });
    expect(countEvents(h, "refund_ok")).toBe(1);
    expect(h.paypal.effects.size).toBe(1);
  });
});

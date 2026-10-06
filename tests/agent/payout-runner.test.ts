import { describe, expect, it } from "vitest";
import { splitPayout } from "../../src/core/split";
import { commit, drain, type ExecDeps } from "../../src/agent/executor";
import { SIM_CARD } from "../../src/agent/paypal-port";
import { retryLines } from "../../src/agent/payout-runner";
import { RUNNERS } from "../../src/agent/runners";
import { Store } from "../../src/agent/store";
import { PayPalError } from "../../src/paypal/errors";
import { payoutBatchId, payoutItemId } from "../../src/paypal/payouts";
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

  it("keeps polling while an item is UNCLAIMED or HELD, and never retries it", async () => {
    const h = await readyToPay((paypal) => {
      const mixed = (b: string) => ({ batchId: b, senderBatchId: "", status: "PROCESSING", items: [
        { senderItemId: payoutItemId(SHOW, "room"), status: "UNCLAIMED", amountCents: 2000 },
        { senderItemId: payoutItemId(SHOW, "artist"), status: "HELD", amountCents: 2236 },
      ] });
      paypal.script("getPayoutBatch", mixed, mixed);
    });
    await drain(h.d, RUNNERS);
    h.clock.t += 60_000;
    await drain(h.d, RUNNERS);
    expect(h.store.job("poll:B-1:2")).toMatchObject({ status: "pending" });
    h.clock.t += 120_000;
    await drain(h.d, RUNNERS);
    expect(h.store.job("poll:B-1:2")).toMatchObject({ status: "done" });
    expect(h.store.job("poll:B-1:3")).toMatchObject({ status: "pending" });
    expect(h.store.job(`payout_retry:${SHOW}`)).toBeUndefined();
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

  it("when a second run (lease expired) recorded ALREADY_SENT first, the first run's real batch id is still recorded so polling works", async () => {
    const h = await readyToPay();
    const lines = splitPayout(3 * 1412, parties).lines.filter((l) => l.amount > 0);
    h.paypal.script("sendPayouts", () => {
      commit(h.store, h.clock.now(), { type: "payout_sent", senderBatchId: payoutBatchId(SHOW), batchId: null, status: "ALREADY_SENT", lines, retry: false, recovered: true });
      return { batchId: "B-9", senderBatchId: payoutBatchId(SHOW), status: "PENDING", sentLines: lines };
    });
    await drain(h.d, RUNNERS);
    expect(h.store.projection().payouts[0]).toMatchObject({ batchId: "B-9", recovered: true });
    expect(h.store.job("poll:B-9:1")?.status).toBe("pending");
    await settle(h);
    expect(h.store.logs().some((l) => l.did.includes("isn't part") || l.did.includes("Needs attention: this payout check"))).toBe(false);
    expect(h.store.job("poll:B-9:1")?.status).toBe("done");
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

  it("keeps its poll number after a failed read, so the next poll is queued and the limit still holds", async () => {
    const mixed = (b: string) => ({ batchId: b, senderBatchId: "", status: "PROCESSING", items: [
      { senderItemId: payoutItemId(SHOW, "room"), status: "UNCLAIMED", amountCents: 2000 },
      { senderItemId: payoutItemId(SHOW, "artist"), status: "HELD", amountCents: 2236 },
    ] });
    const h = await readyToPay((paypal) => {
      paypal.script("getPayoutBatch", mixed, () => {
        throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
      });
      for (let i = 0; i < 20; i++) paypal.script("getPayoutBatch", mixed);
    });
    await settle(h);
    expect(h.store.job("poll:B-1:2")).toMatchObject({ status: "done" });
    expect(h.store.job("poll:B-1:3")).toBeDefined();
    expect(h.store.job("poll:B-1:8")).toMatchObject({ status: "done" });
    expect(h.store.job("poll:B-1:9")).toBeUndefined();
    expect(h.store.logs().some((l) => l.did.startsWith("Needs attention: some payouts are still unconfirmed"))).toBe(true);
  });

  it("refuses to send when the worker's show id is not the signed show's", async () => {
    const h = await readyToPay();
    const other: ExecDeps = { ...h.d, showId: "sshowothrbb" };
    await drain(other, RUNNERS);
    expect(h.paypal.count("sendPayouts")).toBe(0);
    expect(h.store.job(`payout:${SHOW}`)?.status).toBe("failed");
    expect(h.store.logs().some((l) => l.did.startsWith("Needs attention:"))).toBe(true);
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

  it("does not send a retry batch when the worker's show id is not the signed show's", async () => {
    const h = await readyToPay((paypal) => paypal.script("getPayoutBatch", roomFailed));
    await drain(h.d, RUNNERS);
    expect(h.paypal.count("sendPayouts")).toBe(1);
    const other: ExecDeps = { ...h.d, showId: "sshowothrbb" };
    h.store.putJob({ key: `payout_retry:${SHOW}`, kind: "payout_retry", target: SHOW, nextAt: 0 }, 0);
    await drain(other, RUNNERS);
    expect(h.paypal.count("sendPayouts")).toBe(1);
    expect(h.store.job(`payout_retry:${SHOW}`)?.status).toBe("failed");
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

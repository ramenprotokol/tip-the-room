import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/holds";
import { dispatch } from "../../src/agent/dispatch";
import { PayPalError } from "../../src/paypal/errors";
import type { PayPalLedgerEvent } from "../../src/paypal/webhooks";
import { FakeAi, fakeBudget, json } from "./fake-ai";
import { DEADLINE, LAUNCH, SHOW } from "./fixtures";
import { pledge, signedService } from "./harness";
import type { AiPort } from "../../src/agent/ai";

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

describe("leftover holds on a real (non-demo) show", () => {
  it("releases the hold of a failed charge once the show is over", async () => {
    const h = await signedService();
    h.paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "DECLINED" }));
    for (const i of ["AA", "BB", "CC"]) await pledge(h.svc, i);
    await h.svc.tick();
    const failed = [...h.svc.project().pledges.values()].find((x) => x.status === "capture_failed");
    expect(failed).toBeDefined();
    expect(h.svc.kind()).not.toBe("demo");
    await h.svc.callOff();
    await h.svc.tick();
    expect(h.svc.nextWakeAt()).not.toBeNull();
    await h.svc.tick();
    expect(h.paypal.effects.has(`void:${failed?.authorizationId}`)).toBe(true);
    expect([...h.svc.project().pledges.values()].find((x) => x.pledgeId === failed?.pledgeId)?.holdClosed).toBe(true);
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
    // Notes wait until PayPal has confirmed the payout, so nobody is told "paid" too early.
    expect(p.notes).toBeNull();
    expect(h.svc.nextWakeAt()).toBe(DEADLINE + 60_000);
    h.clock.t = DEADLINE + 60_000;
    await h.svc.tick();
    p = h.svc.project();
    expect(p.payouts[0].items[`${SHOW}-room`]?.status).toBe("SUCCESS");
    expect(p.notes?.[0]).toEqual({ role: "room", label: "Lucky's Café", source: "template", text: "Acoustic Set happened. 3 fans paid $15.00 each, and Lucky's Café was paid $20.00 under the money rules the artist signed." });
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

describe("task 7 hardening", () => {
  it("a charged webhook's gross amount never becomes collected money", async () => {
    const h = await signedService();
    const ids: string[] = [];
    for (const i of ["AA", "BB", "CC"]) ids.push((await pledge(h.svc, i)).pledgeId);
    await h.svc.tick();
    const before = h.svc.project().collectedNet;
    expect(before).toBe(3 * 1412);
    await h.svc.ingestWebhook(hook({ eventId: "WH-g", kind: "charged", ref: `C-A-${ids[0]}`, customId: `${SHOW}:${ids[0]}`, amountCents: 1500 }));
    expect(h.svc.project().collectedNet).toBe(before);
  });

  it("consumes payout_item_pending: records it, polls the batch and says the payout is waiting", async () => {
    const h = await signedService();
    for (const i of ["AA", "BB", "CC"]) await pledge(h.svc, i);
    await h.svc.tick();
    h.clock.t = DEADLINE;
    await h.svc.tick();
    const batchId = h.svc.project().payouts[0].batchId!;
    await h.svc.ingestWebhook(hook({ eventId: "WH-p", kind: "payout_item_pending", ref: "ITEM1", customId: `${SHOW}-room` }));
    expect(h.store.job(`poll:${batchId}:hook-WH-p`)?.status).toBe("pending");
    expect(h.store.logs().at(-1)?.did).toMatch(/waiting/);
  });

  it("logs a known PayPal event type that could not be read, and ignores unknown types", async () => {
    const h = await signedService();
    expect(await dispatch(h.svc, { op: "webhook_unreadable", eventType: "PAYMENT.CAPTURE.COMPLETED" })).toEqual({ ok: true, data: { recorded: true } });
    expect(h.store.logs().at(-1)).toMatchObject({ saw: "PayPal sent a notice about a charge that we couldn't read.", did: "Ignored it. Nothing was changed." });
    const n = h.store.logs().length;
    expect(await dispatch(h.svc, { op: "webhook_unreadable", eventType: "SOMETHING.ELSE" })).toEqual({ ok: true, data: { recorded: false } });
    expect(h.store.logs()).toHaveLength(n);
  });

  it("shows a chargeback in the manage view's attention list", async () => {
    const h = await signedService();
    await h.svc.ingestWebhook(hook({ kind: "charge_reversed", ref: "C-1", customId: `${SHOW}:p1` }));
    expect(h.svc.manageView().attention).toEqual(["PayPal reported a charge reversed (a chargeback). Nothing was changed automatically, so please check your PayPal account."]);
  });

  it("does not fill a recovered batch id twice, and ignores a different batch id", async () => {
    const h = await signedService();
    for (const i of ["AA", "BB", "CC"]) await pledge(h.svc, i);
    await h.svc.tick();
    h.paypal.script("sendPayouts", () => {
      throw new PayPalError(400, "USER_BUSINESS_ERROR", "dup", undefined, [{ field: "SENDER_BATCH_ID", issue: "Batch with given sender_batch_id already exists" }]);
    });
    h.clock.t = DEADLINE;
    await h.svc.tick();
    await h.svc.ingestWebhook(hook({ eventId: "WH-1", kind: "payout_batch_done", ref: "BATCH9", customId: `payout-${SHOW}` }));
    await h.svc.ingestWebhook(hook({ eventId: "WH-2", kind: "payout_batch_done", ref: "OTHER7", customId: `payout-${SHOW}` }));
    expect(h.svc.project().payouts[0].batchId).toBe("BATCH9");
    expect(h.store.job("poll:OTHER7:hook-WH-2")).toBeUndefined();
  });

  it("an approved 'pay what came in' unblocks the payout once", async () => {
    const h = await signedService();
    for (const i of ["AA", "BB", "CC"]) await pledge(h.svc, i);
    for (let i = 0; i < 3; i++) h.paypal.script("captureHold", (a: string) => ({ captureId: `C-${a}`, authorizationId: a, status: "COMPLETED", grossCents: 1500, feeCents: 1000, netCents: 500 }));
    await h.svc.tick();
    h.clock.t = DEADLINE;
    await h.svc.tick();
    const proposal = [...h.svc.project().proposals.values()].find((x) => x.options[0].id === "pay_short");
    expect(proposal).toBeDefined();
    expect(h.paypal.count("sendPayouts")).toBe(0);
    await h.svc.approve(proposal!.proposalId, { option: "pay_short" });
    await h.svc.tick();
    expect(h.paypal.count("sendPayouts")).toBe(1);
    expect(h.svc.project().campaign.state).toBe("settled");
  });

  it("holds the notes back until payouts are confirmed, and never says 'paid' for a failed one", async () => {
    const h = await signedService();
    for (const i of ["AA", "BB", "CC"]) await pledge(h.svc, i);
    await h.svc.tick();
    h.paypal.script("sendPayouts", (_show: string, lines: { role: string; amount: number }[]) => ({ batchId: "B-1", senderBatchId: `payout-${SHOW}`, status: "PENDING", sentLines: lines.filter((l) => l.amount > 0) }), () => {
      throw new PayPalError(400, "INVALID_REQUEST", "refused");
    });
    h.paypal.script("getPayoutBatch", (batchId: string) => ({ batchId, senderBatchId: "", status: "SUCCESS", items: [{ senderItemId: `${SHOW}-room`, status: "BLOCKED", amountCents: 2000 }, { senderItemId: `${SHOW}-artist`, status: "SUCCESS", amountCents: 2236 }] }));
    h.clock.t = DEADLINE;
    await h.svc.tick();
    expect(h.svc.project().notes).toBeNull();
    h.clock.t = DEADLINE + 60_000;
    await h.svc.tick();
    const notes = h.svc.project().notes;
    expect(notes?.find((n) => n.role === "room")?.text).toBe("Lucky's Café's payout of $20.00 didn't go through, so it is not counted as paid. Check the PayPal email.");
    expect(notes?.find((n) => n.role === "artist")?.text).toMatch(/was paid \$22\.36/);
  });

  it("a pace-check proposal is dropped when the options changed while the model wrote", async () => {
    let svcRef: Awaited<ReturnType<typeof signedService>> | null = null;
    const ai: AiPort = {
      run: async () => {
        await pledge(svcRef!.svc, "BB");
        return json({ text: "You have 1 of 3 fans with 4 days left. Extending 7 days gives fans time.", recommend: "extend" });
      },
    };
    const h = await signedService({ ai: { ai, budget: fakeBudget().port } });
    svcRef = h;
    await pledge(h.svc);
    h.clock.t = HALF;
    await h.svc.tick();
    expect(h.svc.project().proposals.size).toBe(0);
    expect(h.svc.project().paceChecks.has(1)).toBe(false);
  });
});

describe("pace option comparison", () => {
  it("keeps a valid model answer when only the lowered target drifted during the model call", async () => {
    let ref: Awaited<ReturnType<typeof signedService>> | null = null;
    const ai: AiPort = {
      run: async () => {
        ref!.clock.t = HALF + 2 * DAY_MS; // projected fans fall from 2 to 1, so the "lower" target moves
        return json({ text: "You have 1 of 3 fans with 4 days left. Extending 7 days gives fans time.", recommend: "extend" });
      },
    };
    const h = await signedService({ ai: { ai, budget: fakeBudget().port } });
    ref = h;
    await pledge(h.svc);
    h.clock.t = HALF;
    await h.svc.tick();
    const proposal = h.svc.project().proposals.get("pace1");
    expect(proposal?.source).toBe("model");
    expect(proposal?.options.map((o) => o.id)).toEqual(["extend", "lower"]);
  });
});

describe("recovered payout batch with no id", () => {
  const SIX = 6 * 60 * 60 * 1000;
  async function recovered() {
    const h = await signedService();
    for (const i of ["AA", "BB", "CC"]) await pledge(h.svc, i);
    await h.svc.tick();
    h.paypal.script("sendPayouts", () => {
      throw new PayPalError(400, "USER_BUSINESS_ERROR", "dup", undefined, [{ field: "SENDER_BATCH_ID", issue: "Batch with given sender_batch_id already exists" }]);
    });
    h.clock.t = DEADLINE;
    await h.svc.tick();
    expect(h.svc.project().payouts[0]).toMatchObject({ recovered: true, batchId: null });
    return h;
  }
  const LINE = "A payout PayPal already had still isn't confirmed. Please check your PayPal account.";

  it("shows no line before 6 hours", async () => {
    const h = await recovered();
    h.clock.t = DEADLINE + SIX - 1000;
    await h.svc.tick();
    expect(h.svc.manageView().attention).not.toContain(LINE);
    expect(h.store.logs().filter((l) => l.did === LINE)).toHaveLength(0);
  });

  it("after 6 hours shows the line and logs it exactly once across ticks", async () => {
    const h = await recovered();
    expect(h.svc.nextWakeAt()).toBe(DEADLINE + SIX + 1);
    h.clock.t = DEADLINE + SIX + 1;
    await h.svc.tick();
    await h.svc.tick();
    h.clock.t = DEADLINE + 2 * SIX;
    await h.svc.tick();
    expect(h.svc.manageView().attention).toContain(LINE);
    expect(h.store.logs().filter((l) => l.did === LINE)).toHaveLength(1);
    expect(h.svc.nextWakeAt()).toBeNull();
  });

  it("shows no line once a batch id arrives", async () => {
    const h = await recovered();
    await h.svc.ingestWebhook(hook({ eventId: "WH-9", kind: "payout_batch_done", ref: "BATCH9", customId: `payout-${SHOW}` }));
    h.clock.t = DEADLINE + 2 * SIX;
    await h.svc.tick();
    expect(h.svc.manageView().attention).not.toContain(LINE);
  });
});

describe("turn budget", () => {
  it("counts a pace check's model call (budget reservation plus AI call) on the turn's meter", async () => {
    const ai = new FakeAi([json({ text: "You have 1 of 3 fans with 4 days left. Extending 7 days gives fans time.", recommend: "extend" })]);
    const h = await signedService({ ai: { ai, budget: fakeBudget().port } });
    await pledge(h.svc);
    h.clock.t = HALF;
    await h.svc.tick();
    expect(ai.calls).toHaveLength(1);
    expect(h.paypal.meter.used).toBe(2);
  });

  it("falls back to templates for notes when the turn has no subrequests left", async () => {
    const ai = new FakeAi([]);
    const h = await signedService({ ai: { ai, budget: fakeBudget().port } });
    h.paypal.fetchesPerCall = 37;
    await pledge(h.svc);
    h.clock.t = DEADLINE;
    await h.svc.tick();
    expect(h.svc.project().campaign.state).toBe("missed");
    expect(ai.calls).toHaveLength(0);
    expect(h.svc.project().notes?.every((n) => n.source === "template")).toBe(true);
  });

  it("uses the model for notes when the turn has room", async () => {
    const ai = new FakeAi([]);
    const h = await signedService({ ai: { ai, budget: fakeBudget().port } });
    await pledge(h.svc);
    h.clock.t = DEADLINE;
    await h.svc.tick();
    expect(ai.calls.length).toBe(2);
    expect(h.paypal.meter.used).toBeLessThanOrEqual(38);
  });
});

import { describe, expect, it } from "vitest";
import { fansCommitted, IllegalTransition, initialCampaign, reduce, type Campaign, type CampaignEvent } from "../../src/core/campaign";

const DEADLINE = Date.UTC(2026, 10, 19, 2, 0, 0);

function run(events: CampaignEvent[], start: Campaign = initialCampaign()) {
  let c = start;
  const effects: string[] = [];
  for (const e of events) {
    const step = reduce(c, e);
    c = step.campaign;
    effects.push(...step.effects.map((x) => x.type));
  }
  return { c, effects };
}

const signed: CampaignEvent = { type: "mandate_signed", threshold: 3, deadline: DEADLINE };
const held: CampaignEvent = { type: "pledge_held" };

describe("campaign reducer", () => {
  it("goes live when the mandate is signed", () => {
    expect(run([signed]).c.state).toBe("live");
  });
  it("tips on the pledge that reaches the target and asks to capture every hold", () => {
    const { c, effects } = run([signed, held, held, held]);
    expect(c.state).toBe("tipped");
    expect(c.pledges.held).toBe(3);
    expect(effects).toEqual(["capture_all_held"]);
  });
  it("captures late pledges on arrival once tipped", () => {
    const { effects } = run([signed, held, held, held, held]);
    expect(effects).toEqual(["capture_all_held", "capture_new_pledge"]);
  });
  it("moves held to charged as captures succeed", () => {
    const { c } = run([signed, held, held, held, { type: "pledge_charged" }, { type: "pledge_charged" }]);
    expect(c.pledges).toEqual({ held: 1, charged: 2, released: 0, refunded: 0, failed: 0 });
    expect(fansCommitted(c)).toBe(3);
  });
  it("misses at the deadline below target, voids every hold, and is idempotent", () => {
    const { c, effects } = run([signed, held, { type: "deadline_reached", now: DEADLINE }, { type: "deadline_reached", now: DEADLINE + 1 }]);
    expect(c.state).toBe("missed");
    expect(effects).toEqual(["void_all_held"]);
    const after = reduce(c, { type: "holds_released", count: 1 }).campaign;
    expect(after.pledges).toEqual({ held: 0, charged: 0, released: 1, refunded: 0, failed: 0 });
  });
  it("pays out at the deadline after tipping, then settles", () => {
    const { c, effects } = run([signed, held, held, held, { type: "deadline_reached", now: DEADLINE }, { type: "pledge_charged" }, { type: "pledge_charged" }, { type: "pledge_capture_failed" }, { type: "payouts_sent" }]);
    expect(effects).toEqual(["capture_all_held", "send_payouts"]);
    expect(c.state).toBe("settled");
  });
  it("allows exactly one extension, only while live", () => {
    const once = run([signed, { type: "deadline_extended", newDeadline: DEADLINE + 1000 }]).c;
    expect(once.deadline).toBe(DEADLINE + 1000);
    expect(once.extensionsUsed).toBe(1);
    expect(() => reduce(once, { type: "deadline_extended", newDeadline: DEADLINE + 2000 })).toThrow(IllegalTransition);
    expect(() => reduce(once, { type: "deadline_extended", newDeadline: DEADLINE })).toThrow(IllegalTransition);
  });
  it("cancelling after tipping voids open holds and refunds charges", () => {
    const { c, effects } = run([signed, held, held, held, { type: "show_cancelled" }]);
    expect(c.state).toBe("cancelled");
    expect(effects).toEqual(["capture_all_held", "void_all_held", "refund_all_charged"]);
  });
  it("rejects pledges after the deadline and charges with nothing held", () => {
    const missed = run([signed, { type: "deadline_reached", now: DEADLINE }]).c;
    expect(() => reduce(missed, held)).toThrow(IllegalTransition);
    expect(() => reduce(run([signed]).c, { type: "pledge_charged" })).toThrow(IllegalTransition);
    expect(() => reduce(initialCampaign(), held)).toThrow(IllegalTransition);
  });
});

const charged: CampaignEvent = { type: "pledge_charged" };
const failed: CampaignEvent = { type: "pledge_capture_failed" };
const deadline: CampaignEvent = { type: "deadline_reached", now: DEADLINE };
const tippedStart = () => run([signed, held, held, held]).c;
const cancelledStart = () => run([signed, held, held, held, charged, { type: "show_cancelled" }]).c;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe("campaign reducer: draft deadline", () => {
  it("ignores deadline_reached on a draft with no effects", () => {
    const draft = initialCampaign();
    const step = reduce(draft, { type: "deadline_reached", now: DEADLINE + 1 });
    expect(step.campaign).toEqual(draft);
    expect(step.effects).toEqual([]);
  });
});

describe("campaign reducer: money paths", () => {
  it("ignores an early deadline event on a live show", () => {
    const live = run([signed, held]).c;
    const step = reduce(live, { type: "deadline_reached", now: DEADLINE - 1 });
    expect(step.campaign).toEqual(live);
    expect(step.effects).toEqual([]);
  });
  it("ignores a deadline event that predates an extended deadline", () => {
    const extended = run([signed, held, { type: "deadline_extended", newDeadline: DEADLINE + 1000 }]).c;
    const step = reduce(extended, deadline);
    expect(step.campaign).toEqual(extended);
    expect(step.campaign.state).toBe("live");
    expect(step.effects).toEqual([]);
  });
  it("does not pay out a tipped show on an early deadline event", () => {
    const tipped = tippedStart();
    const step = reduce(tipped, { type: "deadline_reached", now: DEADLINE - 1 });
    expect(step.campaign.state).toBe("tipped");
    expect(step.effects).toEqual([]);
  });
  it("treats the deadline as idempotent in paying_out, settled and cancelled", () => {
    const paying = run([signed, held, held, held, deadline]).c;
    expect(paying.state).toBe("paying_out");
    const settled = run([charged, charged, charged, { type: "payouts_sent" }], paying).c;
    expect(settled.state).toBe("settled");
    for (const c of [paying, settled, cancelledStart()]) {
      const step = reduce(c, { type: "deadline_reached", now: DEADLINE + 5 });
      expect(step.campaign).toEqual(c);
      expect(step.effects).toEqual([]);
    }
  });

  it("marks a refund after cancellation: charged moves to refunded", () => {
    const c = cancelledStart();
    expect(c.pledges).toEqual({ held: 2, charged: 1, released: 0, refunded: 0, failed: 0 });
    const after = reduce(c, { type: "refunds_sent", count: 1 }).campaign;
    expect(after.pledges).toEqual({ held: 2, charged: 0, released: 0, refunded: 1, failed: 0 });
  });
  it("rejects out-of-range and fractional refund counts", () => {
    const c = cancelledStart();
    expect(() => reduce(c, { type: "refunds_sent", count: 2 })).toThrow(IllegalTransition);
    expect(() => reduce(c, { type: "refunds_sent", count: -1 })).toThrow(IllegalTransition);
    expect(() => reduce(c, { type: "refunds_sent", count: 0.5 })).toThrow(IllegalTransition);
    expect(() => reduce(c, { type: "refunds_sent", count: NaN })).toThrow(IllegalTransition);
    expect(() => reduce(tippedStart(), { type: "refunds_sent", count: 0 })).toThrow(IllegalTransition);
  });
  it("releases holds in a cancelled show and rejects bad counts", () => {
    const c = cancelledStart();
    const after = reduce(c, { type: "holds_released", count: 2 }).campaign;
    expect(after.pledges).toEqual({ held: 0, charged: 1, released: 2, refunded: 0, failed: 0 });
    for (const count of [NaN, 0.5, 3, -1]) {
      expect(() => reduce(c, { type: "holds_released", count })).toThrow(IllegalTransition);
    }
  });

  it("rejects an extension that does not move a fresh live deadline later", () => {
    const fresh = run([signed]).c;
    expect(() => reduce(fresh, { type: "deadline_extended", newDeadline: DEADLINE })).toThrow(IllegalTransition);
    expect(() => reduce(fresh, { type: "deadline_extended", newDeadline: DEADLINE - 1 })).toThrow(IllegalTransition);
    expect(fresh.extensionsUsed).toBe(0);
  });
  it("rejects an extension once tipped", () => {
    expect(() => reduce(tippedStart(), { type: "deadline_extended", newDeadline: DEADLINE + 1000 })).toThrow(IllegalTransition);
  });

  it("accepts charges in paying_out, rejects them while live", () => {
    const paying = run([signed, held, held, held, deadline]).c;
    const after = reduce(paying, charged).campaign;
    expect(after.pledges.held).toBe(2);
    expect(after.pledges.charged).toBe(1);
    expect(() => reduce(run([signed, held]).c, charged)).toThrow(IllegalTransition);
  });
  it("records a late capture in a cancelled show and asks for it to be refunded", () => {
    const step = reduce(cancelledStart(), charged);
    expect(step.campaign.pledges).toEqual({ held: 1, charged: 2, released: 0, refunded: 0, failed: 0 });
    expect(step.effects).toEqual([{ type: "refund_all_charged" }]);
  });

  it("moves held to failed when a capture fails", () => {
    const after = reduce(tippedStart(), failed);
    expect(after.campaign.pledges).toEqual({ held: 2, charged: 0, released: 0, refunded: 0, failed: 1 });
    expect(after.effects).toEqual([]);
    const paying = run([deadline], tippedStart()).c;
    expect(reduce(paying, failed).campaign.pledges.failed).toBe(1);
    expect(reduce(cancelledStart(), failed).campaign.pledges.failed).toBe(1);
  });
  it("rejects a failed capture with nothing held or outside tipped/paying_out/cancelled", () => {
    expect(() => reduce(run([signed, held]).c, failed)).toThrow(IllegalTransition);
    expect(() => reduce(run([signed]).c, failed)).toThrow(IllegalTransition);
    const noHeld = run([charged, charged, charged], tippedStart()).c;
    expect(() => reduce(noHeld, failed)).toThrow(IllegalTransition);
  });
  it("blocks payouts_sent while captures are pending, allows it once resolved", () => {
    const paying = run([deadline], tippedStart()).c;
    expect(() => reduce(paying, { type: "payouts_sent" })).toThrow(/captures are still pending/);
    const resolved = run([charged, failed, charged], paying).c;
    expect(resolved.pledges.held).toBe(0);
    expect(reduce(resolved, { type: "payouts_sent" }).campaign.state).toBe("settled");
  });

  it("rejects a charge with nothing held in a legal state", () => {
    const noHeld = run([charged, charged, charged], tippedStart()).c;
    expect(noHeld.pledges.held).toBe(0);
    expect(() => reduce(noHeld, charged)).toThrow(/no hold to charge/);
    const payingNoHeld = run([deadline], noHeld).c;
    expect(payingNoHeld.state).toBe("paying_out");
    expect(() => reduce(payingNoHeld, charged)).toThrow(IllegalTransition);
    const allFailed = run([failed, failed, failed, deadline], tippedStart()).c;
    expect(() => reduce(allFailed, charged)).toThrow(IllegalTransition);
  });

  it("rejects non-finite extension deadlines", () => {
    const live = run([signed]).c;
    expect(() => reduce(live, { type: "deadline_extended", newDeadline: Infinity })).toThrow(IllegalTransition);
    expect(() => reduce(live, { type: "deadline_extended", newDeadline: NaN })).toThrow(IllegalTransition);
    expect(live.extensionsUsed).toBe(0);
  });
  it("rejects a deadline event with a non-finite time", () => {
    const live = run([signed]).c;
    expect(() => reduce(live, { type: "deadline_reached", now: NaN })).toThrow(IllegalTransition);
    expect(() => reduce(tippedStart(), { type: "deadline_reached", now: NaN })).toThrow(IllegalTransition);
  });

  it("holds payouts at the deadline while captures are pending, then sends them once on the last capture", () => {
    const step = reduce(tippedStart(), deadline);
    expect(step.campaign.state).toBe("paying_out");
    expect(step.campaign.pledges.held).toBe(3);
    expect(step.effects).toEqual([]);
    let c = step.campaign;
    const sends: number[] = [];
    [charged, failed, charged].forEach((e, i) => {
      const r = reduce(c, e);
      c = r.campaign;
      if (r.effects.some((x) => x.type === "send_payouts")) sends.push(i);
      expect(r.effects).toEqual(i === 2 ? [{ type: "send_payouts" }] : []);
    });
    expect(c.pledges.held).toBe(0);
    expect(sends).toEqual([2]);
  });
  it("sends payouts when the last pending capture fails", () => {
    const paying = run([deadline, charged, charged], tippedStart()).c;
    expect(reduce(paying, failed).effects).toEqual([{ type: "send_payouts" }]);
  });
  it("sends payouts at the deadline straight away when nothing is held", () => {
    const settledCaptures = run([charged, failed, charged], tippedStart()).c;
    const step = reduce(settledCaptures, deadline);
    expect(step.campaign.state).toBe("paying_out");
    expect(step.effects).toEqual([{ type: "send_payouts" }]);
  });

  it("rejects a mandate with a bad threshold or deadline", () => {
    const start = initialCampaign();
    expect(() => reduce(start, { type: "mandate_signed", threshold: 0, deadline: DEADLINE })).toThrow(IllegalTransition);
    expect(() => reduce(start, { type: "mandate_signed", threshold: 2.5, deadline: DEADLINE })).toThrow(IllegalTransition);
    expect(() => reduce(start, { type: "mandate_signed", threshold: 3, deadline: NaN })).toThrow(IllegalTransition);
    expect(() => reduce(start, { type: "mandate_signed", threshold: 3, deadline: Infinity })).toThrow(IllegalTransition);
  });

  it("never mutates the campaign it is given", () => {
    const events: CampaignEvent[] = [
      signed, held, held, held, charged, failed, charged, deadline, { type: "payouts_sent" },
    ];
    const check = (start: Campaign, evs: CampaignEvent[]) => {
      let c = start;
      for (const e of evs) {
        const frozen = deepFreeze(structuredClone(c));
        const snapshot = structuredClone(c);
        const step = reduce(frozen, e);
        expect(frozen).toEqual(snapshot);
        c = step.campaign;
      }
      return c;
    };
    check(initialCampaign(), events);
    // deadline_extended, show_cancelled, holds_released, refunds_sent
    check(initialCampaign(), [signed, { type: "deadline_extended", newDeadline: DEADLINE + 1000 }]);
    check(initialCampaign(), [signed, held, held, held, charged, { type: "show_cancelled" }, { type: "holds_released", count: 2 }, { type: "refunds_sent", count: 1 }]);
    check(initialCampaign(), [{ type: "mandate_signed", threshold: 5, deadline: DEADLINE }, held, held, { type: "threshold_lowered", newThreshold: 4 }, { type: "threshold_lowered", newThreshold: 2 }]);
    // pending-capture deadline and the capture that triggers send_payouts
    check(initialCampaign(), [signed, held, held, held, deadline, charged, failed, charged]);
    const cancelled = deepFreeze(cancelledStart());
    expect(() => reduce(cancelled, charged)).not.toThrow();
  });

  it("lowers the target while live without tipping when still short", () => {
    const { c, effects } = run([{ type: "mandate_signed", threshold: 5, deadline: DEADLINE }, held, { type: "threshold_lowered", newThreshold: 3 }]);
    expect(c.state).toBe("live");
    expect(c.threshold).toBe(3);
    expect(effects).toEqual([]);
  });
  it("tips at once when the lowered target is already met, and captures every hold", () => {
    const { c, effects } = run([{ type: "mandate_signed", threshold: 5, deadline: DEADLINE }, held, held, held, { type: "threshold_lowered", newThreshold: 3 }]);
    expect(c.state).toBe("tipped");
    expect(c.threshold).toBe(3);
    expect(effects).toEqual(["capture_all_held"]);
  });
  it("rejects a lowered target that is not a whole number, below 1, or not lower", () => {
    const live = run([{ type: "mandate_signed", threshold: 5, deadline: DEADLINE }]).c;
    for (const newThreshold of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 5, 6]) {
      expect(() => reduce(live, { type: "threshold_lowered", newThreshold })).toThrow(IllegalTransition);
    }
  });
  it("rejects lowering the target outside live", () => {
    const tipped = run([signed, held, held, held]).c;
    expect(() => reduce(tipped, { type: "threshold_lowered", newThreshold: 2 })).toThrow(IllegalTransition);
    expect(() => reduce(initialCampaign(), { type: "threshold_lowered", newThreshold: 2 })).toThrow(IllegalTransition);
  });

  it("throws on an unknown event type", () => {
    const bad = { type: "pledge_teleported" } as unknown as CampaignEvent;
    expect(() => reduce(run([signed]).c, bad)).toThrow(IllegalTransition);
  });
});

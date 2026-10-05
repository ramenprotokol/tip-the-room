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
    expect(c.pledges).toEqual({ held: 1, charged: 2, released: 0, refunded: 0 });
    expect(fansCommitted(c)).toBe(3);
  });
  it("misses at the deadline below target, voids every hold, and is idempotent", () => {
    const { c, effects } = run([signed, held, { type: "deadline_reached", now: DEADLINE }, { type: "deadline_reached", now: DEADLINE + 1 }]);
    expect(c.state).toBe("missed");
    expect(effects).toEqual(["void_all_held"]);
    const after = reduce(c, { type: "holds_released", count: 1 }).campaign;
    expect(after.pledges).toEqual({ held: 0, charged: 0, released: 1, refunded: 0 });
  });
  it("pays out at the deadline after tipping, then settles", () => {
    const { c, effects } = run([signed, held, held, held, { type: "deadline_reached", now: DEADLINE }, { type: "payouts_sent" }]);
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

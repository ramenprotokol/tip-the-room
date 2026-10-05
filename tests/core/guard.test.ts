import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildMandate, type MandateDraft } from "../../src/core/mandate";
import { initialCampaign, reduce, type Campaign } from "../../src/core/campaign";
import { splitPayout } from "../../src/core/split";
import { approvalKeyFor, guard, RULES, type AgentAction, type GuardContext } from "../../src/core/guard";
import { DAY_MS } from "../../src/core/holds";

const draft: MandateDraft = {
  showId: "s1", showName: "Juniper Vale", roomName: "Spindle Records", showDate: "2026-11-20",
  ticketPrice: 1500, feeBufferBps: 500,
  parties: [
    { role: "room", label: "Spindle Records", paypalEmail: "room@example.com", fixed: 8000 },
    { role: "opener", label: "The Low Tides", paypalEmail: "opener@example.com", fixed: 10000 },
    { role: "artist", label: "Juniper Vale", paypalEmail: "artist@example.com", minimum: 30000 },
  ],
  launchedAt: "2026-11-04T18:00:00.000Z", deadline: "2026-11-19T02:00:00.000Z",
};
const mandate = buildMandate(draft);
const deadline = Date.parse(draft.deadline);
const launched = Date.parse(draft.launchedAt);

function campaignIn(state: Campaign["state"], held = 0, charged = 0): Campaign {
  const base = reduce(initialCampaign(), { type: "mandate_signed", threshold: mandate.threshold, deadline }).campaign;
  return { ...base, state, pledges: { held, charged, released: 0, refunded: 0, failed: 0 } };
}
const ctx = (campaign: Campaign, extra: Partial<GuardContext> = {}): GuardContext => ({ mandate, campaign, approvals: new Set(), collectedNet: 0, ...extra });

describe("RULES", () => {
  it("has five plain-English rules", () => {
    expect(Object.values(RULES).map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);
    expect(RULES["rule-2-capture-at-tip"].title).toBe("When the target is reached, charge every hold.");
  });
});

describe("guard", () => {
  it("only captures once the show has tipped", () => {
    expect(guard({ kind: "capture_all_held" }, ctx(campaignIn("live", 20))).allowed).toBe(false);
    const ok = guard({ kind: "capture_all_held" }, ctx(campaignIn("tipped", 34)));
    expect(ok).toMatchObject({ allowed: true, needsApproval: false, rule: "rule-2-capture-at-tip" });
  });
  it("only voids after a miss or a cancellation", () => {
    expect(guard({ kind: "void_all_held" }, ctx(campaignIn("live", 20))).allowed).toBe(false);
    expect(guard({ kind: "void_all_held" }, ctx(campaignIn("missed", 20))).rule).toBe("rule-3-void-on-miss");
    expect(guard({ kind: "void_all_held" }, ctx(campaignIn("missed", 20))).allowed).toBe(true);
  });
  it("pays out only the exact signed split, only while paying out", () => {
    const collectedNet = 51000;
    const lines = splitPayout(collectedNet, mandate.parties).lines;
    expect(guard({ kind: "send_payouts", lines }, ctx(campaignIn("paying_out", 0, 34), { collectedNet })).allowed).toBe(true);
    const greedy = lines.map((l) => (l.role === "artist" ? { ...l, amount: l.amount + 1 } : l));
    const d = guard({ kind: "send_payouts", lines: greedy }, ctx(campaignIn("paying_out", 0, 34), { collectedNet }));
    expect(d).toMatchObject({ allowed: false, rule: "rule-4-pay-the-split" });
    expect(guard({ kind: "send_payouts", lines }, ctx(campaignIn("tipped", 34), { collectedNet })).allowed).toBe(false);
  });
  it("asks first when the money falls short of the signed minimums", () => {
    const collectedNet = 40000;
    const lines = splitPayout(collectedNet, mandate.parties).lines;
    const d = guard({ kind: "send_payouts", lines }, ctx(campaignIn("paying_out", 0, 34), { collectedNet }));
    expect(d).toMatchObject({ allowed: false, needsApproval: true, rule: "rule-5-ask-first", approvalKey: "payout-shortfall" });
    const approved = guard({ kind: "send_payouts", lines }, ctx(campaignIn("paying_out", 0, 34), { collectedNet, approvals: new Set(["payout-shortfall"]) }));
    expect(approved.allowed).toBe(true);
  });
  it("needs approval to extend, then allows one extension within 7 days and the 21-day window", () => {
    const action: AgentAction = { kind: "extend_deadline", newDeadline: deadline + 4 * DAY_MS };
    const key = approvalKeyFor(action) as string;
    expect(guard(action, ctx(campaignIn("live", 19)))).toMatchObject({ allowed: false, needsApproval: true, approvalKey: key });
    expect(guard(action, ctx(campaignIn("live", 19), { approvals: new Set([key]) })).allowed).toBe(true);
    const tooFar: AgentAction = { kind: "extend_deadline", newDeadline: deadline + 8 * DAY_MS };
    expect(guard(tooFar, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(tooFar) as string]) })).allowed).toBe(false);
    const pastWindow: AgentAction = { kind: "extend_deadline", newDeadline: launched + 22 * DAY_MS };
    expect(guard(pastWindow, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(pastWindow) as string]) })).allowed).toBe(false);
  });
  it("needs approval to lower the target and never below what covers fixed costs", () => {
    const ok: AgentAction = { kind: "lower_threshold", newThreshold: 30 };
    expect(guard(ok, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(ok) as string]) })).allowed).toBe(true);
    const tooLow: AgentAction = { kind: "lower_threshold", newThreshold: 11 };
    expect(guard(tooLow, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(tooLow) as string]) })).allowed).toBe(false);
  });
  it("reauthorizes holds without asking while a show is open", () => {
    expect(guard({ kind: "reauthorize" }, ctx(campaignIn("tipped", 34))).allowed).toBe(true);
    expect(guard({ kind: "reauthorize" }, ctx(campaignIn("missed", 3))).allowed).toBe(false);
  });
  it("never allows a capture before the target or a void before a miss (property)", () => {
    const states: Campaign["state"][] = ["draft", "live", "tipped", "paying_out", "settled", "missed", "cancelled"];
    fc.assert(
      fc.property(fc.constantFrom(...states), fc.integer({ min: 0, max: 80 }), (state, held) => {
        const c = campaignIn(state, held);
        if (guard({ kind: "capture_all_held" }, ctx(c)).allowed) expect(c.state).toBe("tipped");
        if (guard({ kind: "capture_new_pledge" }, ctx(c)).allowed) expect(c.state).toBe("tipped");
        if (guard({ kind: "void_all_held" }, ctx(c)).allowed) expect(["missed", "cancelled"]).toContain(c.state);
      }),
    );
  });
});

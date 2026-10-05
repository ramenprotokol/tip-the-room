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

const allKinds = ["capture_all_held", "capture_new_pledge", "void_all_held", "reauthorize", "send_payouts", "extend_deadline", "lower_threshold", "refund_all_charged"] as const;
const states: Campaign["state"][] = ["draft", "live", "tipped", "paying_out", "settled", "missed", "cancelled"];

describe("guard", () => {
  it("only captures once the show has tipped", () => {
    expect(guard({ kind: "capture_all_held" }, ctx(campaignIn("live", 20))).allowed).toBe(false);
    const ok = guard({ kind: "capture_all_held" }, ctx(campaignIn("tipped", 34)));
    expect(ok).toMatchObject({ allowed: true, needsApproval: false, rule: "rule-2-capture-at-tip" });
  });
  it("lets captures finish after the deadline while holds remain, and not otherwise", () => {
    for (const kind of ["capture_all_held", "capture_new_pledge"] as const) {
      expect(guard({ kind }, ctx(campaignIn("tipped", 1)))).toMatchObject({ allowed: true, rule: "rule-2-capture-at-tip" });
      expect(guard({ kind }, ctx(campaignIn("paying_out", 2, 32)))).toMatchObject({ allowed: true, rule: "rule-2-capture-at-tip" });
      expect(guard({ kind }, ctx(campaignIn("paying_out", 0, 34))).allowed).toBe(false);
      expect(guard({ kind }, ctx(campaignIn("cancelled", 2, 32))).allowed).toBe(false);
      expect(guard({ kind }, ctx(campaignIn("missed", 2))).allowed).toBe(false);
      expect(guard({ kind }, ctx(campaignIn("settled", 0, 34))).allowed).toBe(false);
    }
  });
  it("allows capturing a new pledge once tipped", () => {
    expect(guard({ kind: "capture_new_pledge" }, ctx(campaignIn("tipped", 1, 34))).allowed).toBe(true);
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
  it("holds payouts back while captures are still pending", () => {
    const collectedNet = 51000;
    const lines = splitPayout(collectedNet, mandate.parties).lines;
    const d = guard({ kind: "send_payouts", lines }, ctx(campaignIn("paying_out", 2, 32), { collectedNet }));
    expect(d).toMatchObject({ allowed: false, needsApproval: false, rule: "rule-4-pay-the-split" });
  });
  it("denies payouts whose lines are reordered or point to a changed email", () => {
    const collectedNet = 51000;
    const lines = splitPayout(collectedNet, mandate.parties).lines;
    const paying = campaignIn("paying_out", 0, 34);
    expect(guard({ kind: "send_payouts", lines: [...lines].reverse() }, ctx(paying, { collectedNet })).allowed).toBe(false);
    const swapped = lines.map((l) => (l.role === "artist" ? { ...l, paypalEmail: "someone-else@example.com" } : l));
    expect(guard({ kind: "send_payouts", lines: swapped }, ctx(paying, { collectedNet }))).toMatchObject({ allowed: false, rule: "rule-4-pay-the-split" });
  });
  it("denies payouts for money the show could not have collected, without throwing", () => {
    const paying = campaignIn("paying_out", 0, 34);
    const lines = splitPayout(51000, mandate.parties).lines;
    for (const collectedNet of [Number.NaN, -1, 100.5, Number.POSITIVE_INFINITY, 51001]) {
      let d: ReturnType<typeof guard> | undefined;
      expect(() => { d = guard({ kind: "send_payouts", lines }, ctx(paying, { collectedNet })); }).not.toThrow();
      expect(d).toMatchObject({ allowed: false, needsApproval: false, rule: "rule-4-pay-the-split" });
      expect(d?.reason.length).toBeGreaterThan(0);
    }
  });
  it("asks first when the money falls short of the signed minimums, tied to that amount", () => {
    const collectedNet = 40000;
    const lines = splitPayout(collectedNet, mandate.parties).lines;
    const key = `payout-shortfall:${collectedNet}`;
    const d = guard({ kind: "send_payouts", lines }, ctx(campaignIn("paying_out", 0, 34), { collectedNet }));
    expect(d).toMatchObject({ allowed: false, needsApproval: true, rule: "rule-5-ask-first", approvalKey: key });
    const approved = guard({ kind: "send_payouts", lines }, ctx(campaignIn("paying_out", 0, 34), { collectedNet, approvals: new Set([key]) }));
    expect(approved.allowed).toBe(true);
  });
  it("does not accept a shortfall approval given for a different amount", () => {
    const collectedNet = 40000;
    const lines = splitPayout(collectedNet, mandate.parties).lines;
    const d = guard({ kind: "send_payouts", lines }, ctx(campaignIn("paying_out", 0, 34), { collectedNet, approvals: new Set(["payout-shortfall:45000", "payout-shortfall"]) }));
    expect(d).toMatchObject({ allowed: false, needsApproval: true, approvalKey: "payout-shortfall:40000" });
  });
  it("needs approval to extend, then allows one extension within 7 days and the 21-day window", () => {
    const action: AgentAction = { kind: "extend_deadline", newDeadline: deadline + 4 * DAY_MS };
    const key = approvalKeyFor(action) as string;
    expect(guard(action, ctx(campaignIn("live", 19)))).toMatchObject({ allowed: false, needsApproval: true, approvalKey: key });
    expect(guard(action, ctx(campaignIn("live", 19), { approvals: new Set([key]) })).allowed).toBe(true);
  });
  it("denies an extension of more than 7 days, even if approved", () => {
    const tooFar: AgentAction = { kind: "extend_deadline", newDeadline: deadline + 8 * DAY_MS };
    const d = guard(tooFar, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(tooFar) as string]) }));
    expect(d).toMatchObject({ allowed: false, needsApproval: false });
    expect(d.reason).toContain("7 days");
  });
  it("denies an extension that passes the 7-day check but runs past the 21-day window", () => {
    const pastWindow: AgentAction = { kind: "extend_deadline", newDeadline: deadline + 7 * DAY_MS };
    expect(pastWindow.newDeadline - launched).toBeGreaterThan(21 * DAY_MS);
    const d = guard(pastWindow, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(pastWindow) as string]) }));
    expect(d).toMatchObject({ allowed: false, needsApproval: false });
    expect(d.reason).toContain("21 days");
  });
  it("denies a second extension and extensions outside a live show", () => {
    const action: AgentAction = { kind: "extend_deadline", newDeadline: deadline + 4 * DAY_MS };
    const approvals = new Set([approvalKeyFor(action) as string]);
    expect(guard(action, ctx({ ...campaignIn("live", 19), extensionsUsed: 1 }, { approvals })).allowed).toBe(false);
    for (const state of states.filter((x) => x !== "live")) {
      expect(guard(action, ctx(campaignIn(state, 19), { approvals })).allowed).toBe(false);
    }
  });
  it("denies an extension to a time that is not a real time, without throwing", () => {
    for (const newDeadline of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const action: AgentAction = { kind: "extend_deadline", newDeadline };
      let d: ReturnType<typeof guard> | undefined;
      expect(() => { d = guard(action, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(action) as string]) })); }).not.toThrow();
      expect(d).toMatchObject({ allowed: false, needsApproval: false });
    }
  });
  it("needs approval to lower the target and never below what covers fixed costs plus fees", () => {
    // Fixture: $180 of fixed costs plus a 5% fee buffer at $15 a fan needs 13 fans.
    const ok: AgentAction = { kind: "lower_threshold", newThreshold: 13 };
    expect(guard(ok, ctx(campaignIn("live", 19)))).toMatchObject({ allowed: false, needsApproval: true, approvalKey: "lower:13" });
    expect(guard(ok, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(ok) as string]) })).allowed).toBe(true);
    const tooLow: AgentAction = { kind: "lower_threshold", newThreshold: 12 };
    const d = guard(tooLow, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(tooLow) as string]) }));
    expect(d).toMatchObject({ allowed: false, needsApproval: false });
    expect(d.reason).toContain("fixed costs");
  });
  it("denies lowering the target to a value that is not lower, not whole, or outside a live show", () => {
    const approvals = (a: AgentAction) => new Set([approvalKeyFor(a) as string]);
    for (const newThreshold of [mandate.threshold, mandate.threshold + 1, 0, 20.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const a: AgentAction = { kind: "lower_threshold", newThreshold };
      let d: ReturnType<typeof guard> | undefined;
      expect(() => { d = guard(a, ctx(campaignIn("live", 19), { approvals: approvals(a) })); }).not.toThrow();
      expect(d).toMatchObject({ allowed: false, needsApproval: false });
    }
    const a: AgentAction = { kind: "lower_threshold", newThreshold: 30 };
    for (const state of states.filter((x) => x !== "live")) {
      expect(guard(a, ctx(campaignIn(state, 19), { approvals: approvals(a) })).allowed).toBe(false);
    }
  });
  it("refunds only after a cancellation, and only with the artist's OK", () => {
    const a: AgentAction = { kind: "refund_all_charged" };
    for (const state of states.filter((x) => x !== "cancelled")) {
      expect(guard(a, ctx(campaignIn(state, 0, 34), { approvals: new Set(["refund"]) })).allowed).toBe(false);
    }
    expect(guard(a, ctx(campaignIn("cancelled", 0, 34)))).toMatchObject({ allowed: false, needsApproval: true, approvalKey: "refund" });
    expect(guard(a, ctx(campaignIn("cancelled", 0, 34), { approvals: new Set(["refund"]) })).allowed).toBe(true);
  });
  it("reauthorizes holds without asking while a show is open", () => {
    expect(guard({ kind: "reauthorize" }, ctx(campaignIn("tipped", 34))).allowed).toBe(true);
    expect(guard({ kind: "reauthorize" }, ctx(campaignIn("missed", 3))).allowed).toBe(false);
    expect(guard({ kind: "reauthorize" }, ctx(campaignIn("cancelled", 3))).allowed).toBe(false);
  });
  it("agrees with the reducer on every money action in every state (property)", () => {
    const collectedNet = 34 * mandate.ticketPrice;
    const lines = splitPayout(collectedNet, mandate.parties).lines;
    const actionFor = (kind: (typeof allKinds)[number]): AgentAction => {
      switch (kind) {
        case "send_payouts": return { kind, lines };
        case "extend_deadline": return { kind, newDeadline: deadline + 4 * DAY_MS };
        case "lower_threshold": return { kind, newThreshold: 30 };
        default: return { kind };
      }
    };
    fc.assert(
      fc.property(fc.constantFrom(...states), fc.constantFrom(...allKinds), fc.integer({ min: 0, max: 80 }), (state, kind, held) => {
        const c = campaignIn(state, held, 34);
        const action = actionFor(kind);
        const approvals = new Set(["refund", `payout-shortfall:${collectedNet}`, approvalKeyFor(action) ?? "none"]);
        const allowed = guard(action, ctx(c, { approvals, collectedNet })).allowed;
        const reducerWaits = {
          capture_all_held: state === "tipped" || (state === "paying_out" && held > 0),
          capture_new_pledge: state === "tipped" || (state === "paying_out" && held > 0),
          void_all_held: state === "missed" || state === "cancelled",
          reauthorize: undefined,
          send_payouts: state === "paying_out" && held === 0,
          refund_all_charged: state === "cancelled",
          extend_deadline: state === "live",
          lower_threshold: state === "live",
        }[kind];
        // Money-moving actions are allowed exactly where the reducer can record them.
        if (reducerWaits !== undefined) expect(allowed).toBe(reducerWaits);
      }),
    );
  });
});

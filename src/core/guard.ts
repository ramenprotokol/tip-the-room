import type { Cents } from "./money";
import type { Mandate } from "./mandate";
import type { Campaign } from "./campaign";
import { DAY_MS, MAX_CAMPAIGN_DAYS, MAX_EXTENSION_DAYS } from "./holds";
import { splitPayout, type PayoutLine } from "./split";
import { thresholdPledges } from "./threshold";
import type { RuleId } from "./rules";

export { RULES, type RuleId } from "./rules";

export type AgentAction =
  | { kind: "capture_all_held" }
  | { kind: "capture_new_pledge" }
  | { kind: "void_all_held" }
  | { kind: "reauthorize" }
  | { kind: "send_payouts"; lines: PayoutLine[] }
  | { kind: "extend_deadline"; newDeadline: number }
  | { kind: "lower_threshold"; newThreshold: number }
  | { kind: "refund_all_charged" };

export interface GuardContext {
  mandate: Mandate;
  campaign: Campaign;
  /** Approval keys the artist has granted: keys from approvalKeyFor, or a decision's approvalKey. */
  approvals: ReadonlySet<string>;
  /** Money actually received after PayPal fees, in cents. */
  collectedNet: Cents;
}

export interface GuardDecision {
  allowed: boolean;
  needsApproval: boolean;
  rule: RuleId;
  reason: string;
  approvalKey?: string;
}

export function approvalKeyFor(action: AgentAction): string | undefined {
  switch (action.kind) {
    case "extend_deadline":
      return `extend:${action.newDeadline}`;
    case "lower_threshold":
      return `lower:${action.newThreshold}`;
    case "refund_all_charged":
      return "refund";
    default:
      return undefined;
  }
}

const allow = (rule: RuleId, reason: string): GuardDecision => ({ allowed: true, needsApproval: false, rule, reason });
const deny = (rule: RuleId, reason: string): GuardDecision => ({ allowed: false, needsApproval: false, rule, reason });
const ask = (key: string, reason: string): GuardDecision => ({ allowed: false, needsApproval: true, rule: "rule-5-ask-first", reason, approvalKey: key });

function sameLines(a: PayoutLine[], b: PayoutLine[]): boolean {
  return a.length === b.length && a.every((l, i) => l.role === b[i].role && l.paypalEmail === b[i].paypalEmail && l.amount === b[i].amount);
}

/**
 * Decides whether the agent may take an action.
 * Callers must evaluate an effect against the campaign returned by `reduce` (after the event), not the one before it.
 */
export function guard(action: AgentAction, ctx: GuardContext): GuardDecision {
  const { campaign: c, mandate: m, approvals } = ctx;
  switch (action.kind) {
    case "capture_all_held":
    case "capture_new_pledge":
      // Captures may finish after the deadline, while any hold is still waiting.
      if (c.state === "tipped" || (c.state === "paying_out" && c.pledges.held > 0)) {
        return allow("rule-2-capture-at-tip", "The target is reached, so every hold is charged.");
      }
      return c.state === "live" || c.state === "draft"
        ? deny("rule-1-hold-only", "The target isn't reached, so fans stay on hold.")
        : deny("rule-1-hold-only", "There are no open holds to charge right now.");

    case "void_all_held":
      return c.state === "missed" || c.state === "cancelled"
        ? allow("rule-3-void-on-miss", "The show didn't happen, so every hold is cancelled.")
        : deny("rule-3-void-on-miss", "Holds are only cancelled after a miss or a cancellation.");

    case "reauthorize":
      return ["live", "tipped", "paying_out"].includes(c.state)
        ? allow("rule-1-hold-only", "Refreshing holds keeps them valid; nobody is charged.")
        : deny("rule-1-hold-only", "This show has no open holds to refresh.");

    case "send_payouts": {
      if (c.state !== "paying_out") return deny("rule-4-pay-the-split", "Payouts happen only after the deadline of a show that tipped.");
      if (c.pledges.held !== 0) return deny("rule-4-pay-the-split", "Some fans' charges are still going through, so payouts wait until they settle.");
      if (!Number.isInteger(ctx.collectedNet) || ctx.collectedNet < 0 || ctx.collectedNet > c.pledges.charged * m.ticketPrice) {
        return deny("rule-4-pay-the-split", "That payout amount doesn't match what the fans actually paid.");
      }
      const expected = splitPayout(ctx.collectedNet, m.parties);
      if (!sameLines(action.lines, expected.lines)) return deny("rule-4-pay-the-split", "These payouts don't match the signed split.");
      if (expected.shortfall > 0) {
        const key = `payout-shortfall:${ctx.collectedNet}`;
        if (!approvals.has(key)) return ask(key, "The money is short of the signed amounts, so the artist decides.");
      }
      return allow("rule-4-pay-the-split", "Paying everyone the split the artist signed.");
    }

    case "extend_deadline": {
      const key = approvalKeyFor(action) as string;
      if (c.state !== "live") return deny("rule-5-ask-first", "Only an open show can be extended.");
      if (c.extensionsUsed >= m.maxExtensions) return deny("rule-5-ask-first", "The one allowed extension is already used.");
      if (!Number.isFinite(action.newDeadline)) return deny("rule-5-ask-first", "That isn't a real deadline.");
      if (action.newDeadline <= c.deadline) return deny("rule-5-ask-first", "An extension must move the deadline later.");
      if (action.newDeadline - c.deadline > MAX_EXTENSION_DAYS * DAY_MS) return deny("rule-5-ask-first", `An extension can add at most ${MAX_EXTENSION_DAYS} days.`);
      if (action.newDeadline - Date.parse(m.launchedAt) > MAX_CAMPAIGN_DAYS * DAY_MS) {
        return deny("rule-5-ask-first", `Holds can't be kept longer than ${MAX_CAMPAIGN_DAYS} days in total.`);
      }
      return approvals.has(key) ? allow("rule-5-ask-first", "The artist approved this extension.") : ask(key, "Extending the deadline needs the artist's OK.");
    }

    case "lower_threshold": {
      const key = approvalKeyFor(action) as string;
      if (c.state !== "live") return deny("rule-5-ask-first", "Only an open show's target can change.");
      if (!Number.isInteger(action.newThreshold) || action.newThreshold >= c.threshold || action.newThreshold < 1) {
        return deny("rule-5-ask-first", "A new target must be a whole number, lower than now, and at least 1.");
      }
      const floor = thresholdPledges({
        fixedCosts: m.parties.filter((p) => p.role !== "artist").map((p) => p.fixed ?? 0),
        artistMinimum: 0,
        ticketPrice: m.ticketPrice,
        feeBufferBps: m.feeBufferBps,
      });
      if (action.newThreshold < floor) {
        return deny("rule-5-ask-first", "That target wouldn't cover the room and the other fixed costs.");
      }
      return approvals.has(key) ? allow("rule-5-ask-first", "The artist approved the lower target.") : ask(key, "Lowering the target needs the artist's OK.");
    }

    case "refund_all_charged": {
      if (c.state !== "cancelled") return deny("rule-5-ask-first", "Refunds happen only when a show is called off.");
      return approvals.has("refund") ? allow("rule-5-ask-first", "The artist called the show off, so everyone is refunded.") : ask("refund", "Refunding needs the artist's OK.");
    }

    default: {
      const unknownAction: never = action;
      void unknownAction;
      return deny("rule-1-hold-only", "That isn't an action the agent is allowed to take.");
    }
  }
}

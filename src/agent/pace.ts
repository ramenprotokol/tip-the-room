import { fansCommitted, type Campaign } from "../core/campaign";
import { guard } from "../core/guard";
import { DAY_MS, MAX_CAMPAIGN_DAYS, MAX_EXTENSION_DAYS } from "../core/holds";
import type { Mandate } from "../core/mandate";
import type { Cents } from "../core/money";
import { thresholdPledges } from "../core/threshold";
import type { ProposalOption } from "./events";
import { PACE_LATE_MS } from "./policy";

export interface PaceNumbers {
  committed: number;
  threshold: number;
  daysLeft: number;
  projected: number;
  percentElapsed: number;
}

/** Spec 3.4: at 50% of the window, and 72 hours before the deadline (dropped if that is before launch). */
export function paceCheckTimes(m: Mandate, c: Campaign): [number, number | null] {
  const launched = Date.parse(m.launchedAt);
  const half = launched + Math.floor((c.deadline - launched) / 2);
  const late = c.deadline - PACE_LATE_MS;
  return [half, late > launched ? late : null];
}

/** Which check to run now (the latest due one) and which earlier unchecked ones to just mark done. */
export function duePaceCheck(m: Mandate, c: Campaign, checked: ReadonlySet<number>, now: number): { run: 1 | 2 | null; mark: (1 | 2)[] } {
  if (c.state !== "live" || now >= c.deadline) return { run: null, mark: [] };
  const [half, late] = paceCheckTimes(m, c);
  const due: { n: 1 | 2; at: number }[] = [];
  if (now >= half) due.push({ n: 1, at: half });
  if (late !== null && now >= late) due.push({ n: 2, at: late });
  due.sort((a, b) => a.at - b.at);
  const last = due[due.length - 1];
  const run = last && !checked.has(last.n) ? last.n : null;
  const mark = due.filter((x) => x.n !== run && !checked.has(x.n)).map((x) => x.n);
  return { run, mark };
}

/** Code, not the model, computes the numbers. */
export function paceNumbers(m: Mandate, c: Campaign, now: number): PaceNumbers {
  const launched = Date.parse(m.launchedAt);
  const span = Math.max(1, c.deadline - launched);
  const elapsed = Math.min(1, Math.max(0, (now - launched) / span));
  const committed = fansCommitted(c);
  return {
    committed,
    threshold: c.threshold,
    daysLeft: Math.max(0, Math.ceil((c.deadline - now) / DAY_MS)),
    projected: elapsed > 0 ? Math.round(committed / elapsed) : committed,
    percentElapsed: Math.round(elapsed * 100),
  };
}

/** Options the artist may approve. Each is kept only when the guard answers "needs approval". */
export function paceOptions(m: Mandate, c: Campaign, approvals: ReadonlySet<string>, collectedNet: Cents, n: PaceNumbers): ProposalOption[] {
  const ctx = { mandate: m, campaign: c, approvals, collectedNet };
  const options: ProposalOption[] = [];
  if (c.extensionsUsed < m.maxExtensions) {
    const newDeadline = Math.min(c.deadline + MAX_EXTENSION_DAYS * DAY_MS, Date.parse(m.launchedAt) + MAX_CAMPAIGN_DAYS * DAY_MS);
    if (newDeadline > c.deadline) {
      const d = guard({ kind: "extend_deadline", newDeadline }, ctx);
      if (d.needsApproval && d.approvalKey) {
        const days = Math.ceil((newDeadline - c.deadline) / DAY_MS);
        options.push({ id: "extend", approvalKey: d.approvalKey, label: `Extend ${days} day${days === 1 ? "" : "s"}`, newDeadline });
      }
    }
  }
  const floor = thresholdPledges({ fixedCosts: m.parties.filter((x) => x.role !== "artist").map((x) => x.fixed ?? 0), artistMinimum: 0, ticketPrice: m.ticketPrice, feeBufferBps: m.feeBufferBps });
  const target = Math.max(n.projected, floor, 1);
  if (target < c.threshold) {
    const d = guard({ kind: "lower_threshold", newThreshold: target }, ctx);
    if (d.needsApproval && d.approvalKey) options.push({ id: "lower", approvalKey: d.approvalKey, label: `Lower the target to ${target}`, newThreshold: target });
  }
  return options;
}

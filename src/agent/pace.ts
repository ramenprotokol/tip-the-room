import { fansCommitted, type Campaign } from "../core/campaign";
import { guard } from "../core/guard";
import { DAY_MS, MAX_CAMPAIGN_DAYS, MAX_EXTENSION_DAYS } from "../core/holds";
import type { Mandate } from "../core/mandate";
import type { Cents } from "../core/money";
import { thresholdPledges } from "../core/threshold";
import type { ProposalOption } from "./events";
import { PACE_LATE_MS } from "./policy";

const HOUR_MS = 3_600_000;

export interface PaceNumbers {
  committed: number;
  threshold: number;
  /** Whole days, rounded down like the page countdown. */
  daysLeft: number;
  /** Whole hours, rounded down. The figure to speak in once under one day. */
  hoursLeft: number;
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
    daysLeft: Math.max(0, Math.floor((c.deadline - now) / DAY_MS)),
    hoursLeft: Math.max(0, Math.floor((c.deadline - now) / HOUR_MS)),
    projected: elapsed > 0 ? Math.round(committed / elapsed) : committed,
    percentElapsed: Math.round(elapsed * 100),
  };
}

/** The calendar day of an instant in the show's time zone, as YYYY-MM-DD (the same reading src/core/mandate.ts uses for "the show is on or after the deadline"). */
function dayIn(zone: string, at: number): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/**
 * An extension never lands on or after the show: the new deadline's day must be before the show's day. A candidate that
 * is already early enough is kept as is; otherwise the deadline moves by the most whole days that still fit (the
 * current deadline when none do, so no extension is offered).
 */
function beforeShow(m: Mandate, deadline: number, candidate: number): number {
  const zone = m.timeZone ?? "UTC";
  if (dayIn(zone, candidate) < m.showDate) return candidate;
  for (let days = Math.floor((candidate - deadline) / DAY_MS); days >= 1; days--) {
    if (dayIn(zone, deadline + days * DAY_MS) < m.showDate) return deadline + days * DAY_MS;
  }
  return deadline;
}

/** Options the artist may approve. Each is kept only when the guard answers "needs approval". */
export function paceOptions(m: Mandate, c: Campaign, approvals: ReadonlySet<string>, collectedNet: Cents, n: PaceNumbers): ProposalOption[] {
  const ctx = { mandate: m, campaign: c, approvals, collectedNet };
  const options: ProposalOption[] = [];
  if (c.extensionsUsed < m.maxExtensions) {
    const newDeadline = beforeShow(m, c.deadline, Math.min(c.deadline + MAX_EXTENSION_DAYS * DAY_MS, Date.parse(m.launchedAt) + MAX_CAMPAIGN_DAYS * DAY_MS));
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

import { fansCommitted, type CampaignState } from "../core/campaign";
import type { Mandate } from "../core/mandate";
import { RULES } from "../core/rules";
import { payoutItemId } from "../paypal/payouts";
import type { AgentLogDto, BulbStatus, LedgerRowDto, LedgerStatus, ManageParty, ProposalDto, PublicShow, StatusWords } from "../worker/api-types";
import type { PayoutItemStatus } from "./events";
import { PAYOUT_FAILED } from "./payout-runner";
import { RECOVERED_BATCH_ATTENTION_MS } from "./policy";
import type { PayoutView, PledgeStatus, PledgeView, Projection } from "./project";
import type { Job, LoggedEntry, StoredEvent } from "./store";
import type { Role } from "../core/split";
import { fanName } from "./words";

export function statusWords(s: CampaignState): StatusWords {
  switch (s) {
    case "draft":
      return "Draft";
    case "live":
      return "Waiting for fans";
    case "tipped":
      return "It's on!";
    case "paying_out":
      return "Paying everyone";
    case "settled":
      return "Everyone's paid";
    case "missed":
      return "Called off · nobody paid";
    case "cancelled":
      return "Called off · refunding";
  }
}

const BULB: Record<PledgeStatus, BulbStatus> = { held: "held", charged: "charged", capture_failed: "failed", released: "released", refunded: "refunded" };
const HOLD_ROW: Record<PledgeStatus, LedgerStatus> = { held: "On hold", charged: "Charged", capture_failed: "Failed", released: "Cancelled", refunded: "Refunded" };

export function publicShow(p: Projection, m: Mandate, mandateHash: string, o: { demo: boolean; paypalClientId: string; now: number; version: string }): PublicShow {
  const c = p.campaign;
  const committed = fansCommitted(c);
  const pledges = [...p.pledges.values()];
  return {
    showId: m.showId,
    demo: o.demo,
    state: c.state,
    status: statusWords(c.state),
    showName: m.showName,
    roomName: m.roomName,
    showDate: m.showDate,
    timeZone: m.timeZone ?? "UTC",
    ticketPriceCents: m.ticketPrice,
    threshold: c.threshold,
    deadline: new Date(c.deadline).toISOString(),
    launchedAt: m.launchedAt,
    fans: { committed, held: c.pledges.held, charged: c.pledges.charged, released: c.pledges.released, refunded: c.pledges.refunded, failed: c.pledges.failed, more: Math.max(0, c.threshold - committed) },
    money: {
      heldCents: pledges.filter((x) => x.status === "held").reduce((s, x) => s + x.amountCents, 0),
      chargedCents: pledges.filter((x) => x.status === "charged").reduce((s, x) => s + (x.grossCents ?? x.amountCents), 0),
    },
    bulbs: pledges.map((x) => ({ initials: x.initials, status: BULB[x.status] })),
    split: m.parties.map((x) => ({ role: x.role, label: x.label, fixedCents: x.fixed ?? null, minimumCents: x.minimum ?? null })),
    mandateHash,
    paypalClientId: o.paypalClientId,
    now: o.now,
    version: o.version,
  };
}

function itemStatus(item: PayoutItemStatus | undefined): LedgerStatus {
  if (!item) return "Pending";
  if (item.status === "SUCCESS") return "Paid";
  return PAYOUT_FAILED.has(item.status) ? "Failed" : "Pending";
}

/** The settlement sheet, newest first. Every row is plain words plus the PayPal ref. */
export function ledgerRows(events: StoredEvent[], p: Projection, showId: string): LedgerRowDto[] {
  const rows: LedgerRowDto[] = [];
  const byAuth = (auth: string): PledgeView | undefined => {
    const id = p.pledgeByAuth.get(auth);
    return id ? p.pledges.get(id) : undefined;
  };
  const byCapture = (captureId: string): PledgeView | undefined => {
    const id = p.pledgeByCapture.get(captureId);
    return id ? p.pledges.get(id) : undefined;
  };
  for (const s of events) {
    const e = s.event;
    const base = { seq: s.seq, at: s.at };
    switch (e.type) {
      case "pledge_held": {
        const pl = p.pledges.get(e.pledgeId);
        if (pl) rows.push({ ...base, what: e.simulated ? "Simulated fan held a spot" : "Fan held a spot", who: fanName(pl), amountCents: e.amountCents, ref: e.authorizationId, status: HOLD_ROW[pl.status] });
        break;
      }
      case "capture_ok": {
        const pl = byCapture(e.captureId);
        rows.push({ ...base, what: "Charged", who: pl ? fanName(pl) : "A fan", amountCents: e.grossCents, ref: e.captureId, status: pl?.status === "refunded" ? "Refunded" : "Charged" });
        break;
      }
      case "capture_failed": {
        const pl = byAuth(e.authorizationId);
        rows.push({ ...base, what: "Charge didn't go through · PayPal shows no payment", who: pl ? fanName(pl) : "A fan", amountCents: null, ref: e.authorizationId, status: "Failed" });
        break;
      }
      case "void_ok": {
        const pl = byAuth(e.authorizationId);
        rows.push({ ...base, what: pl ? "Hold cancelled · nobody charged" : "Extra hold cancelled · nobody charged", who: pl ? fanName(pl) : "Not counted", amountCents: null, ref: e.authorizationId, status: "Cancelled" });
        break;
      }
      case "refund_ok": {
        const pl = byCapture(e.captureId);
        rows.push({ ...base, what: "Refunded", who: pl ? fanName(pl) : "A fan", amountCents: pl?.grossCents ?? null, ref: e.refundId, status: "Refunded" });
        break;
      }
      case "late_hold":
        rows.push({ ...base, what: "Hold arrived after pledging closed", who: "Not counted", amountCents: e.amountCents, ref: e.authorizationId, status: p.retired.get(e.authorizationId)?.voided ? "Cancelled" : "Pending" });
        break;
      case "pledge_rejected":
        rows.push({ ...base, what: "Hold refused", who: "Not counted", amountCents: null, ref: e.authorizationId, status: "Failed" });
        break;
      case "hold_replaced": {
        const pl = p.pledges.get(e.pledgeId);
        rows.push({ ...base, what: "Hold renewed before it expired", who: pl ? fanName(pl) : "A fan", amountCents: null, ref: e.authorizationId, status: "Info" });
        break;
      }
      case "payout_sent": {
        const payout = p.payouts.find((x) => x.senderBatchId === e.senderBatchId);
        if (e.lines.length === 0) {
          rows.push({ ...base, what: "Nothing to pay out", who: "Everyone", amountCents: 0, ref: null, status: "Info" });
          break;
        }
        for (const l of e.lines) {
          rows.push({ ...base, what: e.retry ? `Paid ${l.label} (second try)` : `Paid ${l.label}`, who: l.label, amountCents: l.amount, ref: payout?.batchId ?? e.senderBatchId, status: itemStatus(payout?.items[payoutItemId(showId, l.role, e.retry)]) });
        }
        break;
      }
      case "deadline_reached":
        rows.push({ ...base, what: "Deadline reached", who: "Everyone", amountCents: null, ref: null, status: "Info" });
        break;
      case "show_cancelled":
        rows.push({ ...base, what: "The artist called the show off", who: "Everyone", amountCents: null, ref: null, status: "Info" });
        break;
      case "deadline_extended":
        rows.push({ ...base, what: `Deadline moved to ${new Date(e.newDeadline).toUTCString()}`, who: "Everyone", amountCents: null, ref: null, status: "Info" });
        break;
      case "threshold_lowered":
        rows.push({ ...base, what: `Target lowered to ${e.newThreshold} fans`, who: "Everyone", amountCents: null, ref: null, status: "Info" });
        break;
      default:
        break;
    }
  }
  return rows.reverse();
}

export function logRows(entries: LoggedEntry[]): AgentLogDto[] {
  return entries.map((e) => ({ ...e, ruleTitle: e.rule ? RULES[e.rule].title : null })).reverse();
}

export function proposalRows(p: Projection): ProposalDto[] {
  return [...p.proposals.values()]
    .map((x) => ({ proposalId: x.proposalId, explanation: x.explanation, recommend: x.recommend, source: x.source, options: x.options.map((o) => ({ id: o.id, label: o.label })), approved: x.approved?.option ?? null, madeAt: x.madeAt }))
    .reverse();
}

/** Where one party's payout stands: the retry batch's answer wins over the first batch's. */
export function payoutStateOf(p: Projection, showId: string, role: Role): "none" | "pending" | "paid" | "failed" {
  const first = p.payouts.find((x) => !x.retry);
  if (!first || !first.lines.some((l) => l.role === role && l.amount > 0)) return "none";
  const retry = p.payouts.find((x) => x.retry);
  const s = retry?.items[payoutItemId(showId, role, true)]?.status ?? first.items[payoutItemId(showId, role)]?.status;
  if (s === "SUCCESS") return "paid";
  if (s && PAYOUT_FAILED.has(s)) return "failed";
  return "pending";
}

/** Chargebacks PayPal told us about. We never change money on a webhook, so the artist is told to look. */
export function reversalLines(events: StoredEvent[]): string[] {
  const n = events.filter((s) => s.event.type === "webhook_received" && s.event.kind === "charge_reversed").length;
  return n === 0 ? [] : [`PayPal reported ${n === 1 ? "a charge" : `${n} charges`} reversed (a chargeback). Nothing was changed automatically, so please check your PayPal account.`];
}

export const UNCONFIRMED_PAYOUT_LINE = "A payout PayPal already had still isn't confirmed. Please check your PayPal account.";

/** Payouts PayPal already had (recovered) whose batch id never arrived, and that have waited too long. */
export function unconfirmedPayouts(p: Projection, now: number): PayoutView[] {
  return p.payouts.filter((x) => x.recovered && x.batchId === null && now - x.sentAt > RECOVERED_BATCH_ATTENTION_MS);
}

export function unconfirmedPayoutLines(p: Projection, now: number): string[] {
  return unconfirmedPayouts(p, now).map(() => UNCONFIRMED_PAYOUT_LINE);
}

export function manageParties(p: Projection, showId: string): ManageParty[] {
  const m = p.mandate;
  if (!m) return [];
  const first = p.payouts.find((x) => !x.retry);
  return m.parties.map((x) => {
    const line = first?.lines.find((l) => l.role === x.role);
    const payoutStatus = ((): ManageParty["payoutStatus"] => {
      if (!first) return "planned";
      if (!line) return "none";
      return payoutStateOf(p, showId, x.role);
    })();
    return { role: x.role, label: x.label, fixedCents: x.fixed ?? null, minimumCents: x.minimum ?? null, paypalEmail: x.paypalEmail, payoutCents: line?.amount ?? null, payoutStatus };
  });
}

const WHAT: Record<Job["kind"], { one: string; many: string }> = {
  capture: { one: "A fan's charge didn't go through.", many: "charges didn't go through." },
  void: { one: "A hold couldn't be cancelled yet.", many: "holds couldn't be cancelled yet." },
  refund: { one: "A refund couldn't be finished.", many: "refunds couldn't be finished." },
  reconcile: { one: "A check with PayPal couldn't be finished.", many: "checks with PayPal couldn't be finished." },
  payout: { one: "The payout couldn't be sent.", many: "payouts couldn't be sent." },
  payout_retry: { one: "The second payout try couldn't be sent.", many: "second payout tries couldn't be sent." },
  payout_poll: { one: "We couldn't confirm the payout.", many: "We couldn't confirm some payouts." },
  sim_hold: { one: "A practice fan couldn't be added.", many: "practice fans couldn't be added." },
  rehold: { one: "A practice hold couldn't be renewed.", many: "practice holds couldn't be renewed." },
};

/**
 * Plain-English "needs the artist" lines. Built from the job's kind and status only: a job's `note`
 * is internal (it can hold PayPal error names) and must never reach a user.
 */
export function attentionLines(jobs: Job[]): string[] {
  const counts = new Map<string, number>();
  for (const j of jobs) {
    if (j.status !== "failed" && j.status !== "blocked") continue;
    const key = `${j.kind}:${j.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines: string[] = [];
  for (const [key, n] of counts) {
    const [kind, status] = key.split(":") as [Job["kind"], string];
    const w = WHAT[kind];
    const what = n === 1 ? w.one : kind === "payout_poll" ? w.many : `${n} ${w.many}`;
    lines.push(status === "blocked" ? `${what} It's waiting for your OK.` : `${what} We stopped trying, so it needs a look.`);
  }
  return lines;
}

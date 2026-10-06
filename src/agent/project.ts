import { initialCampaign, reduce, type Campaign, type CampaignEvent } from "../core/campaign";
import { mandateSignedEvent, type Mandate } from "../core/mandate";
import type { Cents } from "../core/money";
import type { PayoutLine } from "../core/split";
import type { AiSource, LedgerEvent, PayoutItemStatus, ProposalOption, ProposalOptionId, SettlementNote } from "./events";
import type { StoredEvent } from "./store";

export type PledgeStatus = "held" | "charged" | "capture_failed" | "released" | "refunded";

export interface PledgeView {
  pledgeId: string;
  /** 1-based order of arrival, for "Fan 03". */
  number: number;
  /** The pledge id PayPal knows (changes when a simulated hold is renewed: "<pledgeId>-h1"). */
  paypalPledgeId: string;
  orderId: string;
  authorizationId: string;
  amountCents: Cents;
  initials: string;
  simulated: boolean;
  authorizedAt: number;
  expiresAt: number;
  heldAt: number;
  status: PledgeStatus;
  captureId?: string;
  grossCents?: Cents;
  feeCents?: Cents;
  netCents?: Cents;
  refundId?: string | null;
}

export interface OrderView {
  orderId: string;
  pledgeId: string;
  amountCents: Cents;
  initials: string;
  createdAt: number;
  /** True once the order became a pledge, was refused, or arrived late. It is never authorized again. */
  resolved: boolean;
}

/** A hold that is not (or no longer) counted: it only ever gets voided. */
export interface RetiredHold {
  authorizationId: string;
  orderId: string | null;
  pledgeId: string;
  why: "late" | "rejected" | "replaced";
  voided: boolean;
}

export interface PayoutView {
  senderBatchId: string;
  batchId: string | null;
  status: string;
  lines: PayoutLine[];
  retry: boolean;
  recovered: boolean;
  sentAt: number;
  /** Latest status per sender_item_id. */
  items: Record<string, PayoutItemStatus>;
}

export interface ProposalView {
  proposalId: string;
  options: ProposalOption[];
  explanation: string;
  recommend: ProposalOptionId | "wait";
  source: AiSource;
  madeAt: number;
  approved: { option: ProposalOptionId; at: number } | null;
}

export interface Projection {
  campaign: Campaign;
  mandate: Mandate | null;
  mandateHash: string | null;
  signedAt: string | null;
  orders: Map<string, OrderView>;
  /** By our pledge id, in arrival order. */
  pledges: Map<string, PledgeView>;
  /** Current authorization id → pledge id (a renewed hold's old id moves to `retired`). */
  pledgeByAuth: Map<string, string>;
  pledgeByCapture: Map<string, string>;
  retired: Map<string, RetiredHold>;
  approvals: Set<string>;
  proposals: Map<string, ProposalView>;
  /** Sum of netCents from capture responses only. Never a model's number, never a webhook's (gross) amount. */
  collectedNet: Cents;
  collectedGross: Cents;
  payouts: PayoutView[];
  paceChecks: Set<number>;
  notes: SettlementNote[] | null;
  rejected: number;
}

export class LedgerCorrupt extends Error {
  constructor(seq: number, why: string) {
    super(`Ledger event ${seq} cannot be replayed: ${why}`);
    this.name = "LedgerCorrupt";
  }
}

export function emptyProjection(): Projection {
  return {
    campaign: initialCampaign(),
    mandate: null,
    mandateHash: null,
    signedAt: null,
    orders: new Map(),
    pledges: new Map(),
    pledgeByAuth: new Map(),
    pledgeByCapture: new Map(),
    retired: new Map(),
    approvals: new Set(),
    proposals: new Map(),
    collectedNet: 0,
    collectedGross: 0,
    payouts: [],
    paceChecks: new Set(),
    notes: null,
    rejected: 0,
  };
}

function pledgeOf(p: Projection, authorizationId: string): PledgeView | undefined {
  const id = p.pledgeByAuth.get(authorizationId);
  return id ? p.pledges.get(id) : undefined;
}

/** The reducer event a ledger event stands for, judged against the state BEFORE the event. Null = no state change. */
export function campaignEventFor(e: LedgerEvent, p: Projection): CampaignEvent | null {
  switch (e.type) {
    case "mandate_signed":
      return mandateSignedEvent(e.mandate);
    case "pledge_held":
      return { type: "pledge_held" };
    case "capture_ok":
      return pledgeOf(p, e.authorizationId)?.status === "held" ? { type: "pledge_charged" } : null;
    case "capture_failed":
      return pledgeOf(p, e.authorizationId)?.status === "held" ? { type: "pledge_capture_failed" } : null;
    case "void_ok":
      return pledgeOf(p, e.authorizationId)?.status === "held" ? { type: "holds_released", count: 1 } : null;
    case "refund_ok": {
      const id = p.pledgeByCapture.get(e.captureId);
      return id && p.pledges.get(id)?.status === "charged" ? { type: "refunds_sent", count: 1 } : null;
    }
    case "deadline_reached":
      return { type: "deadline_reached", now: e.now };
    case "payout_sent":
      return e.retry ? null : { type: "payouts_sent" };
    case "deadline_extended":
      return { type: "deadline_extended", newDeadline: e.newDeadline };
    case "threshold_lowered":
      return { type: "threshold_lowered", newThreshold: e.newThreshold };
    case "show_cancelled":
      return { type: "show_cancelled" };
    default:
      return null;
  }
}

/** Applies one stored event: first the reducer (effects are ignored: replay never executes anything), then the views. */
export function applyEvent(p: Projection, s: StoredEvent): void {
  const e = s.event;
  const ce = campaignEventFor(e, p);
  if (ce) {
    try {
      p.campaign = reduce(p.campaign, ce).campaign;
    } catch (err) {
      throw new LedgerCorrupt(s.seq, err instanceof Error ? err.message : String(err));
    }
  }
  switch (e.type) {
    case "mandate_signed":
      p.mandate = e.mandate;
      p.mandateHash = e.hash;
      p.signedAt = e.signedAt;
      break;
    case "order_created":
      p.orders.set(e.orderId, { orderId: e.orderId, pledgeId: e.pledgeId, amountCents: e.amountCents, initials: e.initials, createdAt: s.at, resolved: false });
      break;
    case "pledge_held": {
      p.pledges.set(e.pledgeId, {
        pledgeId: e.pledgeId,
        number: p.pledges.size + 1,
        paypalPledgeId: e.pledgeId,
        orderId: e.orderId,
        authorizationId: e.authorizationId,
        amountCents: e.amountCents,
        initials: e.initials,
        simulated: e.simulated,
        authorizedAt: e.authorizedAt,
        expiresAt: e.expiresAt,
        heldAt: s.at,
        status: "held",
      });
      p.pledgeByAuth.set(e.authorizationId, e.pledgeId);
      const order = p.orders.get(e.orderId);
      if (order) order.resolved = true;
      break;
    }
    case "pledge_rejected": {
      p.rejected += 1;
      const order = e.orderId ? p.orders.get(e.orderId) : undefined;
      if (order) order.resolved = true;
      if (e.authorizationId) p.retired.set(e.authorizationId, { authorizationId: e.authorizationId, orderId: e.orderId, pledgeId: e.pledgeId, why: "rejected", voided: false });
      break;
    }
    case "late_hold": {
      const order = p.orders.get(e.orderId);
      if (order) order.resolved = true;
      p.retired.set(e.authorizationId, { authorizationId: e.authorizationId, orderId: e.orderId, pledgeId: e.pledgeId, why: "late", voided: false });
      break;
    }
    case "hold_replaced": {
      const pledge = p.pledges.get(e.pledgeId);
      if (!pledge) break;
      p.retired.set(e.oldAuthorizationId, { authorizationId: e.oldAuthorizationId, orderId: e.oldOrderId, pledgeId: e.pledgeId, why: "replaced", voided: false });
      p.pledgeByAuth.delete(e.oldAuthorizationId);
      pledge.authorizationId = e.authorizationId;
      pledge.orderId = e.orderId;
      pledge.paypalPledgeId = e.newPaypalPledgeId;
      pledge.authorizedAt = e.authorizedAt;
      pledge.expiresAt = e.expiresAt;
      p.pledgeByAuth.set(e.authorizationId, e.pledgeId);
      break;
    }
    case "capture_ok": {
      const pledge = pledgeOf(p, e.authorizationId);
      if (!pledge || pledge.status !== "held") break;
      pledge.status = "charged";
      pledge.captureId = e.captureId;
      pledge.grossCents = e.grossCents;
      pledge.feeCents = e.feeCents;
      pledge.netCents = e.netCents;
      p.pledgeByCapture.set(e.captureId, pledge.pledgeId);
      p.collectedNet += e.netCents;
      p.collectedGross += e.grossCents;
      break;
    }
    case "capture_failed": {
      const pledge = pledgeOf(p, e.authorizationId);
      if (pledge && pledge.status === "held") pledge.status = "capture_failed";
      break;
    }
    case "void_ok": {
      const pledge = pledgeOf(p, e.authorizationId);
      if (pledge && pledge.status === "held") pledge.status = "released";
      const retired = p.retired.get(e.authorizationId);
      if (retired) retired.voided = true;
      break;
    }
    case "refund_ok": {
      const id = p.pledgeByCapture.get(e.captureId);
      const pledge = id ? p.pledges.get(id) : undefined;
      if (pledge && pledge.status === "charged") {
        pledge.status = "refunded";
        pledge.refundId = e.refundId;
      }
      break;
    }
    case "payout_sent":
      p.payouts.push({ senderBatchId: e.senderBatchId, batchId: e.batchId, status: e.status, lines: e.lines, retry: e.retry, recovered: e.recovered, sentAt: s.at, items: {} });
      break;
    case "payout_items": {
      const payout = p.payouts.find((x) => x.batchId === e.batchId);
      if (payout) for (const item of e.items) payout.items[item.senderItemId] = item;
      break;
    }
    case "payout_batch_seen": {
      const payout = p.payouts.find((x) => x.senderBatchId === e.senderBatchId);
      if (payout && payout.batchId === null) payout.batchId = e.batchId;
      break;
    }
    case "proposal_made":
      p.proposals.set(e.proposalId, { proposalId: e.proposalId, options: e.options, explanation: e.explanation, recommend: e.recommend, source: e.source, madeAt: s.at, approved: null });
      break;
    case "proposal_approved": {
      const proposal = p.proposals.get(e.proposalId);
      if (proposal) proposal.approved = { option: e.option, at: s.at };
      p.approvals.add(e.approvalKey);
      break;
    }
    case "show_cancelled":
      // The artist calling the show off IS the refund approval (spec 3.7, guard key "refund").
      p.approvals.add("refund");
      break;
    case "pace_checked":
      p.paceChecks.add(e.check);
      break;
    case "notes_written":
      p.notes = e.notes;
      break;
    default:
      break;
  }
}

export function project(events: StoredEvent[]): Projection {
  const p = emptyProjection();
  for (const s of events) applyEvent(p, s);
  return p;
}

export function heldPledges(p: Projection): PledgeView[] {
  return [...p.pledges.values()].filter((x) => x.status === "held");
}

export function chargedPledges(p: Projection): PledgeView[] {
  return [...p.pledges.values()].filter((x) => x.status === "charged");
}

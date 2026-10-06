import type { Cents } from "../core/money";
import type { Mandate } from "../core/mandate";
import type { PayoutLine, Role } from "../core/split";
import type { LedgerKind } from "../paypal/webhooks";

/** Who wrote a piece of text: the model, a fixed template, or a template because the daily AI budget is spent. */
export type AiSource = "model" | "template" | "resting";

export type ProposalOptionId = "extend" | "lower" | "pay_short";

export interface ProposalOption {
  id: ProposalOptionId;
  /** The guard approval key this option grants, e.g. "extend:1794000000000" or "payout-shortfall:2824". */
  approvalKey: string;
  /** Plain words for the button, e.g. "Extend 4 days". */
  label: string;
  newDeadline?: number;
  newThreshold?: number;
  collectedNet?: Cents;
}

export interface SettlementNote {
  role: Role;
  label: string;
  text: string;
  source: AiSource;
}

export interface PayoutItemStatus {
  senderItemId: string;
  status: string;
  transactionId?: string;
  amountCents: Cents;
}

/**
 * Append-only ledger events. Money facts come only from PayPal API responses we fetched ourselves.
 * Each event has ONE deterministic key (eventKey), so it can be written at most once.
 */
export type LedgerEvent =
  | { type: "mandate_signed"; mandate: Mandate; hash: string; signedAt: string }
  | { type: "order_created"; orderId: string; pledgeId: string; amountCents: Cents; initials: string }
  | { type: "pledge_held"; pledgeId: string; orderId: string; authorizationId: string; amountCents: Cents; authorizedAt: number; expiresAt: number; initials: string; simulated: boolean }
  | { type: "pledge_rejected"; pledgeId: string; orderId: string | null; authorizationId: string | null; reason: string }
  | { type: "late_hold"; pledgeId: string; orderId: string; authorizationId: string; amountCents: Cents }
  | { type: "hold_replaced"; pledgeId: string; newPaypalPledgeId: string; orderId: string; authorizationId: string; oldOrderId: string; oldAuthorizationId: string; authorizedAt: number; expiresAt: number }
  | { type: "capture_ok"; authorizationId: string; captureId: string; grossCents: Cents; feeCents: Cents; netCents: Cents }
  | { type: "capture_failed"; authorizationId: string; reason: string }
  | { type: "void_ok"; authorizationId: string }
  /**
   * A refund PayPal answered. Only status "COMPLETED" counts as refunded; a PENDING answer is recorded
   * but changes nothing. The key includes the status, so a PENDING refund can still become COMPLETED later.
   */
  | { type: "refund_ok"; captureId: string; refundId: string | null; status: string }
  | { type: "deadline_reached"; now: number; deadline: number }
  | { type: "payout_sent"; senderBatchId: string; batchId: string | null; status: string; lines: PayoutLine[]; retry: boolean; recovered: boolean }
  | { type: "payout_items"; batchId: string; items: PayoutItemStatus[] }
  | { type: "payout_batch_seen"; senderBatchId: string; batchId: string }
  | { type: "proposal_made"; proposalId: string; options: ProposalOption[]; explanation: string; recommend: ProposalOptionId | "wait"; source: AiSource }
  | { type: "proposal_approved"; proposalId: string; option: ProposalOptionId; approvalKey: string }
  | { type: "deadline_extended"; newDeadline: number }
  | { type: "threshold_lowered"; newThreshold: number }
  | { type: "show_cancelled" }
  | { type: "pace_checked"; check: 1 | 2 }
  | { type: "webhook_received"; eventId: string; kind: LedgerKind; ref: string; amountCents: Cents | null; customId: string | null }
  | { type: "notes_written"; notes: SettlementNote[] };

/**
 * The deterministic key that makes the ledger idempotent.
 * A pledge has exactly one outcome (held | rejected | late), an authorization exactly one capture outcome (ok | failed).
 */
export function eventKey(e: LedgerEvent): string {
  switch (e.type) {
    case "mandate_signed":
      return "mandate";
    case "order_created":
      return `order:${e.orderId}`;
    case "pledge_held":
    case "pledge_rejected":
    case "late_hold":
      return `pledge:${e.pledgeId}`;
    case "hold_replaced":
      return `replaced:${e.oldAuthorizationId}`;
    case "capture_ok":
    case "capture_failed":
      return `capture:${e.authorizationId}`;
    case "void_ok":
      return `void:${e.authorizationId}`;
    case "refund_ok":
      return `refund:${e.captureId}:${e.status}`;
    case "deadline_reached":
      return `deadline:${e.deadline}`;
    case "payout_sent":
      return `payout:${e.senderBatchId}`;
    case "payout_items":
      return `items:${e.batchId}:${e.items.map((i) => `${i.senderItemId}=${i.status}`).sort().join(",")}`;
    case "payout_batch_seen":
      return `batch:${e.senderBatchId}`;
    case "proposal_made":
      return `proposal:${e.proposalId}`;
    case "proposal_approved":
      return `approved:${e.proposalId}`;
    case "deadline_extended":
      return "extended";
    case "threshold_lowered":
      return `lowered:${e.newThreshold}`;
    case "show_cancelled":
      return "cancelled";
    case "pace_checked":
      return `pace:${e.check}`;
    case "webhook_received":
      return `webhook:${e.eventId}`;
    case "notes_written":
      return "notes";
  }
}

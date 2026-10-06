import type { Cents } from "../core/money";
import type { PayoutLine } from "../core/split";
import { centsToValue, valueToCents } from "./amount";
import { PayPalError } from "./errors";
import type { PayPalHttp } from "./http";

export interface SentBatch {
  batchId: string;
  senderBatchId: string;
  status: string;
  sentLines: PayoutLine[];
}

export interface PayoutItem {
  senderItemId: string;
  status: string;
  transactionId?: string;
  amountCents: Cents;
}

export interface PayoutBatch {
  batchId: string;
  senderBatchId: string;
  status: string;
  items: PayoutItem[];
}

/** One batch per show, ever: PayPal refuses a second batch with the same sender_batch_id. */
export function payoutBatchId(showId: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(showId)) throw new RangeError("showId must be 1-100 letters, digits or dashes");
  return `payout-${showId}`;
}

/** Sends exactly these lines (the guard-approved split), minus any $0 line. */
export async function sendPayouts(http: PayPalHttp, showId: string, lines: PayoutLine[]): Promise<SentBatch> {
  const senderBatchId = payoutBatchId(showId);
  const seen = new Set<string>();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount) || l.amount < 0) throw new RangeError(`${l.label}: payout must be a non-negative whole number of cents`);
    if (seen.has(l.role)) throw new Error(`${l.role} appears twice in the payout`);
    seen.add(l.role);
  }
  const sentLines = lines.filter((l) => l.amount > 0);
  if (sentLines.length === 0) throw new Error("Nothing to pay: every payout line is $0");
  const res = await http.request<{ batch_header: { payout_batch_id: string; batch_status: string } }>({
    method: "POST",
    path: "/v1/payments/payouts",
    requestId: senderBatchId,
    body: {
      sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "Your share from Tip the Room", recipient_type: "EMAIL" },
      items: sentLines.map((l) => ({
        recipient_type: "EMAIL",
        receiver: l.paypalEmail,
        amount: { value: centsToValue(l.amount), currency: "USD" },
        sender_item_id: `${showId}-${l.role}`,
        note: `${l.label}: your share of the show`,
      })),
    },
  });
  return { batchId: res!.batch_header.payout_batch_id, senderBatchId, status: res!.batch_header.batch_status, sentLines };
}

interface BatchBody {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header?: { sender_batch_id?: string } };
  items?: { transaction_id?: string; transaction_status?: string; payout_item?: { sender_item_id?: string; amount?: { value: string; currency: string } } }[];
}

/** Payout amounts use `currency` (not `currency_code`). Never trust a bare number. */
function usdCents(a: { value: string; currency: string } | undefined, field: string): Cents {
  if (!a) throw new Error(`${field} is missing from the payout item`);
  if (a.currency !== "USD") throw new PayPalError(502, "UNEXPECTED_CURRENCY", `${field} came back in ${a.currency}, expected USD`);
  return valueToCents(a.value);
}

export async function getPayoutBatch(http: PayPalHttp, batchId: string): Promise<PayoutBatch> {
  const b = (await http.request<BatchBody>({ method: "GET", path: `/v1/payments/payouts/${encodeURIComponent(batchId)}` }))!;
  return {
    batchId: b.batch_header.payout_batch_id,
    senderBatchId: b.batch_header.sender_batch_header?.sender_batch_id ?? "",
    status: b.batch_header.batch_status,
    items: (b.items ?? []).map((i) => ({
      senderItemId: i.payout_item?.sender_item_id ?? "",
      status: i.transaction_status ?? "UNKNOWN",
      transactionId: i.transaction_id,
      amountCents: usdCents(i.payout_item?.amount, "payout item amount"),
    })),
  };
}

/**
 * True when PayPal refused the batch because this sender_batch_id was already used.
 * Shape recorded in tests/paypal/fixtures/payout-duplicate.json. USER_BUSINESS_ERROR is generic, so it is never matched alone.
 */
export function isDuplicateBatch(e: unknown): boolean {
  if (!(e instanceof PayPalError)) return false;
  if (e.status !== 400 || e.paypalName !== "USER_BUSINESS_ERROR") return false;
  return e.issues.some((i) => i.field === "SENDER_BATCH_ID" || i.issue.toLowerCase().includes("sender_batch_id already exists"));
}

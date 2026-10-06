import type { Cents } from "../core/money";
import type { PayoutLine } from "../core/split";
import { assertPayPalId, centsToValue, valueToCents } from "./amount";
import { PayPalError, requireBody } from "./errors";
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

export interface SendOptions {
  /** The one allowed retry batch: ids end in "-r1". */
  retry?: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** PayPal's sender_item_id cap is unverified (about 63); our ids stay well under it. */
const MAX_ITEM_ID = 63;

/** One batch per show (plus at most one "-r1" retry batch): PayPal refuses a second batch with the same sender_batch_id. */
export function payoutBatchId(showId: string, retry = false): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(showId)) throw new RangeError("showId must be 1-100 letters, digits or dashes");
  return retry ? `payout-${showId}-r1` : `payout-${showId}`;
}

/** sender_item_id: "<show>-<role>", or "<show>-<role>-r1" in the retry batch. */
export function payoutItemId(showId: string, role: string, retry = false): string {
  const id = `${showId}-${role}${retry ? "-r1" : ""}`;
  if (id.length > MAX_ITEM_ID) throw new RangeError(`payout item id must be at most ${MAX_ITEM_ID} characters`);
  return id;
}

/** Sends exactly these lines (the guard-approved split), minus any $0 line. */
export async function sendPayouts(http: PayPalHttp, showId: string, lines: PayoutLine[], opts: SendOptions = {}): Promise<SentBatch> {
  const retry = opts.retry === true;
  const senderBatchId = payoutBatchId(showId, retry);
  const seen = new Set<string>();
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount) || l.amount < 0) throw new RangeError(`${l.label}: payout must be a non-negative whole number of cents`);
    if (seen.has(l.role)) throw new Error(`${l.role} appears twice in the payout`);
    seen.add(l.role);
  }
  const sentLines = lines.filter((l) => l.amount > 0);
  if (sentLines.length === 0) throw new Error("Nothing to pay: every payout line is $0");
  for (const l of sentLines) {
    if (typeof l.paypalEmail !== "string" || !EMAIL.test(l.paypalEmail)) throw new RangeError(`${l.label}: needs a valid PayPal email`);
  }
  const res = requireBody(
    await http.request<{ batch_header?: { payout_batch_id?: string; batch_status?: string } }>({
      method: "POST",
      path: "/v1/payments/payouts",
      requestId: senderBatchId,
      body: {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "Your share from Tip the Room", recipient_type: "EMAIL" },
        items: sentLines.map((l) => ({
          recipient_type: "EMAIL",
          receiver: l.paypalEmail,
          amount: { value: centsToValue(l.amount), currency: "USD" },
          sender_item_id: payoutItemId(showId, l.role, retry),
          note: `${l.label}: your share of the show`,
        })),
      },
    }),
    "payout batch",
  );
  const batchId = res.batch_header?.payout_batch_id;
  if (typeof batchId !== "string" || batchId.length === 0) throw new PayPalError(502, "BAD_RESPONSE_BODY", "PayPal's payout answer had no payout_batch_id");
  return { batchId, senderBatchId, status: res.batch_header?.batch_status ?? "UNKNOWN", sentLines };
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
  assertPayPalId(batchId, "batch id");
  const b = requireBody(await http.request<BatchBody>({ method: "GET", path: `/v1/payments/payouts/${batchId}` }), "payout batch");
  const gotId = b.batch_header?.payout_batch_id;
  if (gotId !== batchId) throw new PayPalError(502, "BAD_RESPONSE_BODY", `asked for payout batch ${batchId} but PayPal answered with ${gotId === undefined ? "no batch id" : `batch ${gotId}`}`);
  const senderBatchId = b.batch_header.sender_batch_header?.sender_batch_id;
  if (!senderBatchId) throw new PayPalError(502, "BAD_RESPONSE_BODY", `payout batch ${batchId} came back without its sender_batch_id`);
  return {
    batchId: gotId,
    senderBatchId,
    status: b.batch_header.batch_status,
    items: (b.items ?? []).map((i) => {
      const senderItemId = i.payout_item?.sender_item_id;
      if (!senderItemId) throw new PayPalError(502, "BAD_RESPONSE_BODY", "a payout item came back without its sender_item_id");
      return { senderItemId, status: i.transaction_status ?? "UNKNOWN", transactionId: i.transaction_id, amountCents: usdCents(i.payout_item?.amount, "payout item amount") };
    }),
  };
}

/**
 * True when PayPal refused a payout batch because the business account can't cover it (422 INSUFFICIENT_FUNDS).
 * The name or an issue code carries it. A refused batch is never created, so the same sender_batch_id may be sent again later.
 */
export function isInsufficientFunds(e: unknown): boolean {
  if (!(e instanceof PayPalError)) return false;
  if (e.status !== 422 && e.status !== 400) return false;
  const code = "INSUFFICIENT_FUNDS";
  return e.paypalName === code || e.issues.some((i) => typeof i.issue === "string" && i.issue.toUpperCase() === code);
}

/**
 * True when PayPal refused the batch because this sender_batch_id was already used.
 * Shape recorded in tests/paypal/fixtures/payout-duplicate.json. USER_BUSINESS_ERROR is generic, so it is never matched alone.
 * Payouts do NOT replay by PayPal-Request-Id: after a lost response, a resend gets this error, which means "already sent".
 */
export function isDuplicateBatch(e: unknown): boolean {
  if (!(e instanceof PayPalError)) return false;
  if (e.status !== 400 || e.paypalName !== "USER_BUSINESS_ERROR") return false;
  return e.issues.some((i) => i.field === "SENDER_BATCH_ID" || (typeof i.issue === "string" && i.issue.toLowerCase().includes("sender_batch_id already exists")));
}

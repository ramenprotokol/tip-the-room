import type { Cents } from "../core/money";
import { valueToCents } from "./amount";
import { PayPalError } from "./errors";
import type { PayPalHttp } from "./http";

export interface WebhookEvent {
  id: string;
  event_type: string;
  create_time: string;
  resource: Record<string, unknown>;
}

export type LedgerKind =
  | "hold_created"
  | "hold_voided"
  | "charged"
  | "charge_failed"
  | "refunded"
  | "payout_batch_done"
  | "payout_batch_failed"
  | "payout_item_paid"
  | "payout_item_failed"
  | "payout_item_pending"
  | "charge_reversed";

export interface PayPalLedgerEvent {
  /** PayPal's event id: duplicates are dropped by this key. Events without one are not mapped. */
  eventId: string;
  /**
   * payout_item_failed is final (FAILED, RETURNED, BLOCKED, DENIED, CANCELED, REFUNDED).
   * payout_item_pending is not final (HELD, UNCLAIMED): the money may still move or come back.
   * charge_reversed is a chargeback (PAYMENT.CAPTURE.REVERSED).
   */
  kind: LedgerKind;
  /** The PayPal id the event is about (authorization, capture, refund, batch or item). */
  ref: string;
  amountCents?: Cents;
  /** Our custom_id ("show:pledge") or sender_item_id ("show-role"). */
  customId?: string;
  at: number;
}

const SIG_HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"] as const;

function isPayPalCertUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

/** Asks PayPal whether this delivery is genuine. Bad input means false; a failed verify call (network, 5xx) throws so the caller can answer 5xx and PayPal redelivers. */
export async function verifyWebhook(http: PayPalHttp, headers: Headers, rawBody: string, webhookId: string): Promise<boolean> {
  const h = SIG_HEADERS.map((k) => headers.get(k));
  if (h.some((v) => !v)) return false;
  if (!isPayPalCertUrl(h[1]!)) return false;
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const res = await http.request<{ verification_status: string }>({
    method: "POST",
    path: "/v1/notifications/verify-webhook-signature",
    body: { auth_algo: h[0], cert_url: h[1], transmission_id: h[2], transmission_sig: h[3], transmission_time: h[4], webhook_id: webhookId, webhook_event: event },
  });
  return res?.verification_status === "SUCCESS";
}

const KINDS: Record<string, LedgerKind> = {
  "PAYMENT.AUTHORIZATION.CREATED": "hold_created",
  "PAYMENT.AUTHORIZATION.VOIDED": "hold_voided",
  "PAYMENT.CAPTURE.COMPLETED": "charged",
  "PAYMENT.CAPTURE.DENIED": "charge_failed",
  "PAYMENT.CAPTURE.DECLINED": "charge_failed",
  "PAYMENT.CAPTURE.REFUNDED": "refunded",
  "PAYMENT.PAYOUTSBATCH.SUCCESS": "payout_batch_done",
  "PAYMENT.PAYOUTSBATCH.DENIED": "payout_batch_failed",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": "payout_item_paid",
  "PAYMENT.PAYOUTS-ITEM.FAILED": "payout_item_failed",
  "PAYMENT.PAYOUTS-ITEM.RETURNED": "payout_item_failed",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED": "payout_item_failed",
  "PAYMENT.PAYOUTS-ITEM.DENIED": "payout_item_failed",
  "PAYMENT.PAYOUTS-ITEM.CANCELED": "payout_item_failed",
  "PAYMENT.PAYOUTS-ITEM.REFUNDED": "payout_item_failed",
  "PAYMENT.PAYOUTS-ITEM.HELD": "payout_item_pending",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED": "payout_item_pending",
  "PAYMENT.CAPTURE.REVERSED": "charge_reversed",
};

type R = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as R) : undefined);

/** Returns the amount value, refusing any currency other than USD. No currency means accept. No amount object means undefined; an amount object with no value throws. */
function usdValue(event: WebhookEvent, amount: R | undefined, currencyKey: string): string | undefined {
  if (amount === undefined) return undefined;
  const currency = str(amount?.[currencyKey]);
  if (currency !== undefined && currency !== "USD") {
    throw new PayPalError(502, "UNEXPECTED_CURRENCY", `${event.event_type} carried ${currency}, expected USD`);
  }
  const value = str(amount.value);
  if (value === undefined) throw new PayPalError(502, "BAD_AMOUNT", `${event.event_type} carried an amount with no value`);
  return value;
}

export function mapWebhookEvent(event: WebhookEvent): PayPalLedgerEvent | null {
  const kind = KINDS[event.event_type];
  if (!kind) return null;
  if (!str(event.id)) return null;
  const r = event.resource ?? {};
  let ref: string | undefined;
  let amount: string | undefined;
  let customId: string | undefined;
  if (kind.startsWith("payout_batch")) {
    ref = str(obj(r.batch_header)?.payout_batch_id);
  } else if (kind.startsWith("payout_item")) {
    const item = obj(r.payout_item);
    ref = str(r.payout_item_id);
    amount = usdValue(event, obj(item?.amount), "currency");
    customId = str(item?.sender_item_id);
  } else {
    ref = str(r.id);
    amount = usdValue(event, obj(r.amount), "currency_code");
    customId = str(r.custom_id);
  }
  if (!ref) return null;
  const at = Date.parse(event.create_time);
  if (Number.isNaN(at)) return null;
  const out: PayPalLedgerEvent = { eventId: event.id, kind, ref, at };
  if (amount !== undefined) out.amountCents = valueToCents(amount);
  if (customId !== undefined) out.customId = customId;
  return out;
}

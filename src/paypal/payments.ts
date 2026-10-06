import type { Cents } from "../core/money";
import { assertPayPalId, centsToValue, valueToCents } from "./amount";
import { PayPalError } from "./errors";
import type { PayPalHttp } from "./http";

export interface PledgeRef {
  showId: string;
  pledgeId: string;
  amountCents: Cents;
  /** Shown to the fan in PayPal, e.g. "Hold for Lucky's Café show". */
  description: string;
}

/** A sandbox test card, used only for simulated fans. */
export interface TestCard {
  number: string;
  /** "YYYY-MM". */
  expiry: string;
  securityCode: string;
  name: string;
}

export interface Hold {
  authorizationId: string;
  orderId: string;
  amountCents: Cents;
  status: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  expiresAt: number;
}

export interface Charge {
  captureId: string;
  authorizationId: string;
  status: string;
  grossCents?: Cents;
  feeCents?: Cents;
  /** What actually arrived after PayPal's fee. collectedNet sums this, never a model's number. */
  netCents?: Cents;
}

export interface Refund {
  refundId: string;
  captureId: string;
  status: string;
}

/** Deterministic PayPal-Request-Ids: replaying the same step can never move money twice. */
export const requestIds = {
  order: (showId: string, pledgeId: string) => `order:${showId}:${pledgeId}`,
  hold: (showId: string, pledgeId: string) => `hold:${showId}:${pledgeId}`,
  authorize: (orderId: string) => `authorize:${orderId}`,
  capture: (authorizationId: string) => `capture:${authorizationId}`,
  void: (authorizationId: string) => `void:${authorizationId}`,
  reauthorize: (authorizationId: string) => `reauth:${authorizationId}`,
  refund: (captureId: string) => `refund:${captureId}`,
};

interface Money {
  currency_code: string;
  value: string;
}
interface AuthBody {
  id: string;
  status: string;
  amount?: Money;
  create_time?: string;
  expiration_time?: string;
}
interface OrderBody {
  id: string;
  status: string;
  purchase_units?: { payments?: { authorizations?: AuthBody[] } }[];
}
interface CaptureBody {
  id: string;
  status: string;
  seller_receivable_breakdown?: { gross_amount: Money; paypal_fee?: Money; net_amount: Money };
}

function purchaseUnit(p: PledgeRef) {
  return { reference_id: p.showId, custom_id: `${p.showId}:${p.pledgeId}`, description: p.description, amount: { currency_code: "USD", value: centsToValue(p.amountCents) } };
}

/** Every amount must be USD. A CAD sandbox account once returned net in CAD, so never trust a bare number. */
function usdCents(m: Money, field: string): Cents {
  if (m.currency_code !== "USD") throw new PayPalError(502, "UNEXPECTED_CURRENCY", `${field} came back in ${m.currency_code}, expected USD`);
  return valueToCents(m.value);
}

function toHold(orderId: string, a: AuthBody, fallbackCents?: Cents): Hold {
  const createdAt = Date.parse(a.create_time ?? "");
  const expiresAt = Date.parse(a.expiration_time ?? "");
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw new Error(`authorization ${a.id} is missing its create or expiration time`);
  const amountCents = a.amount ? usdCents(a.amount, "authorization amount") : fallbackCents;
  if (amountCents === undefined) throw new Error(`authorization ${a.id} has no amount`);
  return { authorizationId: a.id, orderId, amountCents, status: a.status, createdAt, expiresAt };
}

function firstAuth(o: OrderBody | undefined): AuthBody | undefined {
  return o?.purchase_units?.[0]?.payments?.authorizations?.[0];
}

/** For the JS SDK button: the browser approves this order, then the server calls authorizeOrder. */
export async function createPledgeOrder(http: PayPalHttp, p: PledgeRef): Promise<{ orderId: string }> {
  const o = await http.request<OrderBody>({ method: "POST", path: "/v2/checkout/orders", requestId: requestIds.order(p.showId, p.pledgeId), body: { intent: "AUTHORIZE", purchase_units: [purchaseUnit(p)] } });
  return { orderId: o!.id };
}

export async function authorizeOrder(http: PayPalHttp, orderId: string): Promise<Hold> {
  assertPayPalId(orderId, "order id");
  const o = await http.request<OrderBody>({ method: "POST", path: `/v2/checkout/orders/${orderId}/authorize`, requestId: requestIds.authorize(orderId), prefer: "return=representation", body: {} });
  const a = firstAuth(o);
  if (!a) throw new Error(`order ${orderId} (${o?.status}) was not authorized`);
  return toHold(orderId, a);
}

/** Simulated fan: a real sandbox hold on a test card, with no buyer login. */
export async function createCardHold(http: PayPalHttp, p: PledgeRef, card: TestCard): Promise<Hold> {
  const o = await http.request<OrderBody>({
    method: "POST",
    path: "/v2/checkout/orders",
    requestId: requestIds.hold(p.showId, p.pledgeId),
    prefer: "return=representation",
    body: { intent: "AUTHORIZE", purchase_units: [purchaseUnit(p)], payment_source: { card: { number: card.number, expiry: card.expiry, security_code: card.securityCode, name: card.name } } },
  });
  const a = firstAuth(o);
  if (a) return toHold(o!.id, a, p.amountCents);
  return authorizeOrder(http, o!.id);
}

export async function captureHold(http: PayPalHttp, authorizationId: string): Promise<Charge> {
  assertPayPalId(authorizationId, "authorization id");
  const c = (await http.request<CaptureBody>({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/capture`, requestId: requestIds.capture(authorizationId), prefer: "return=representation", body: { final_capture: true } }))!;
  const b = c.seller_receivable_breakdown;
  const grossCents = b ? usdCents(b.gross_amount, "gross_amount") : undefined;
  const netCents = b ? usdCents(b.net_amount, "net_amount") : undefined;
  const paypalFee = b?.paypal_fee ? usdCents(b.paypal_fee, "paypal_fee") : undefined;
  const feeCents = b ? (paypalFee ?? grossCents! - netCents!) : undefined;
  return { captureId: c.id, authorizationId, status: c.status, grossCents, feeCents, netCents };
}

export async function voidHold(http: PayPalHttp, authorizationId: string): Promise<void> {
  assertPayPalId(authorizationId, "authorization id");
  await http.request({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/void`, requestId: requestIds.void(authorizationId) });
}

/**
 * Returns the NEW authorization. `orderId` is "" because PayPal's reauthorize response does not carry the order;
 * the caller (Plan 4) copies it over from the old hold. PayPal allows this only after the 3-day honor period (see spike findings).
 */
export async function reauthorizeHold(http: PayPalHttp, authorizationId: string, amountCents: Cents): Promise<Hold> {
  assertPayPalId(authorizationId, "authorization id");
  const a = (await http.request<AuthBody>({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/reauthorize`, requestId: requestIds.reauthorize(authorizationId), prefer: "return=representation", body: { amount: { currency_code: "USD", value: centsToValue(amountCents) } } }))!;
  return toHold("", a, amountCents);
}

export async function refundCharge(http: PayPalHttp, captureId: string): Promise<Refund> {
  assertPayPalId(captureId, "capture id");
  const r = (await http.request<{ id: string; status: string }>({ method: "POST", path: `/v2/payments/captures/${captureId}/refund`, requestId: requestIds.refund(captureId), prefer: "return=representation", body: {} }))!;
  return { refundId: r.id, captureId, status: r.status };
}

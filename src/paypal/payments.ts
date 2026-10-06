import type { Cents } from "../core/money";
import { assertPayPalId, centsToValue, valueToCents } from "./amount";
import { PayPalError, requireBody } from "./errors";
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
  /** The custom_id PayPal echoed back ("show:pledge"), when it sent one. */
  customId?: string;
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

/** What PayPal says happened to an order: used to reconcile when an answer was lost or refused. */
export interface OrderPayments {
  orderId: string;
  status: string;
  customId?: string;
  authorizations: { id: string; status: string }[];
  captures: { id: string; status: string }[];
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
  custom_id?: string;
}
interface OrderBody {
  id: string;
  status: string;
  purchase_units?: { custom_id?: string; payments?: { authorizations?: AuthBody[]; captures?: { id: string; status: string }[] } }[];
}
interface CaptureBody {
  id: string;
  status: string;
  seller_receivable_breakdown?: { gross_amount: Money; paypal_fee?: Money; net_amount: Money };
  links?: { href?: string; rel?: string }[];
}

function purchaseUnit(p: PledgeRef) {
  return { reference_id: p.showId, custom_id: `${p.showId}:${p.pledgeId}`, description: p.description, amount: { currency_code: "USD", value: centsToValue(p.amountCents) } };
}

/** Every amount must be USD. A CAD sandbox account once returned net in CAD, so never trust a bare number. */
function usdCents(m: Money, field: string): Cents {
  if (m.currency_code !== "USD") throw new PayPalError(502, "UNEXPECTED_CURRENCY", `${field} came back in ${m.currency_code}, expected USD`);
  return valueToCents(m.value);
}

function toHold(orderId: string, a: AuthBody, fallbackCents?: Cents, unitCustomId?: string): Hold {
  const createdAt = Date.parse(a.create_time ?? "");
  const expiresAt = Date.parse(a.expiration_time ?? "");
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw new Error(`authorization ${a.id} is missing its create or expiration time`);
  const amountCents = a.amount ? usdCents(a.amount, "authorization amount") : fallbackCents;
  if (amountCents === undefined) throw new Error(`authorization ${a.id} has no amount`);
  const hold: Hold = { authorizationId: a.id, orderId, amountCents, status: a.status, createdAt, expiresAt };
  const customId = a.custom_id ?? unitCustomId;
  if (customId !== undefined) hold.customId = customId;
  return hold;
}

function firstUnit(o: OrderBody | undefined) {
  return o?.purchase_units?.[0];
}

function firstAuth(o: OrderBody | undefined): AuthBody | undefined {
  return firstUnit(o)?.payments?.authorizations?.[0];
}

function toCharge(c: CaptureBody, authorizationId: string): Charge {
  const b = c.seller_receivable_breakdown;
  const grossCents = b ? usdCents(b.gross_amount, "gross_amount") : undefined;
  const netCents = b ? usdCents(b.net_amount, "net_amount") : undefined;
  const paypalFee = b?.paypal_fee ? usdCents(b.paypal_fee, "paypal_fee") : undefined;
  const feeCents = b ? (paypalFee ?? grossCents! - netCents!) : undefined;
  return { captureId: c.id, authorizationId, status: c.status, grossCents, feeCents, netCents };
}

/** For the JS SDK button: the browser approves this order, then the server calls authorizeOrder. */
export async function createPledgeOrder(http: PayPalHttp, p: PledgeRef): Promise<{ orderId: string }> {
  const o = requireBody(await http.request<OrderBody>({ method: "POST", path: "/v2/checkout/orders", requestId: requestIds.order(p.showId, p.pledgeId), body: { intent: "AUTHORIZE", purchase_units: [purchaseUnit(p)] } }), "order");
  return { orderId: o.id };
}

export async function authorizeOrder(http: PayPalHttp, orderId: string): Promise<Hold> {
  assertPayPalId(orderId, "order id");
  const o = requireBody(await http.request<OrderBody>({ method: "POST", path: `/v2/checkout/orders/${orderId}/authorize`, requestId: requestIds.authorize(orderId), prefer: "return=representation", body: {} }), "order");
  const a = firstAuth(o);
  if (!a) throw new PayPalError(502, "BAD_RESPONSE_BODY", `order ${orderId} (${o.status}) came back without an authorization`);
  return toHold(orderId, a, undefined, firstUnit(o)?.custom_id);
}

/** Simulated fan: a real sandbox hold on a test card, with no buyer login. Callers MUST check `status === "CREATED"`. */
export async function createCardHold(http: PayPalHttp, p: PledgeRef, card: TestCard): Promise<Hold> {
  const o = requireBody(
    await http.request<OrderBody>({
      method: "POST",
      path: "/v2/checkout/orders",
      requestId: requestIds.hold(p.showId, p.pledgeId),
      prefer: "return=representation",
      body: { intent: "AUTHORIZE", purchase_units: [purchaseUnit(p)], payment_source: { card: { number: card.number, expiry: card.expiry, security_code: card.securityCode, name: card.name } } },
    }),
    "order",
  );
  try {
    const a = firstAuth(o);
    if (a) return toHold(o.id, a, p.amountCents, firstUnit(o)?.custom_id);
    return await authorizeOrder(http, o.id);
  } catch (e) {
    // The order exists now. Whatever went wrong, tell the caller which order to look up.
    const err = e instanceof PayPalError ? e : new PayPalError(502, "BAD_RESPONSE_BODY", e instanceof Error ? e.message : "unreadable answer");
    if (typeof o.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(o.id)) err.orderId = o.id;
    throw err;
  }
}

export async function captureHold(http: PayPalHttp, authorizationId: string): Promise<Charge> {
  assertPayPalId(authorizationId, "authorization id");
  const c = requireBody(await http.request<CaptureBody>({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/capture`, requestId: requestIds.capture(authorizationId), prefer: "return=representation", body: { final_capture: true } }), "capture");
  return toCharge(c, authorizationId);
}

/** Reads a capture, e.g. to learn its net after a lost or PENDING answer. */
export async function getCapture(http: PayPalHttp, captureId: string, authorizationId: string): Promise<Charge> {
  assertPayPalId(captureId, "capture id");
  assertPayPalId(authorizationId, "authorization id");
  const c = requireBody(await http.request<CaptureBody>({ method: "GET", path: `/v2/payments/captures/${captureId}` }), "capture");
  const up = c.links?.find((l) => l.rel === "up")?.href;
  const upId = up?.match(/\/authorizations\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  if (upId !== undefined && upId !== authorizationId) throw new PayPalError(502, "BAD_RESPONSE_BODY", `capture ${captureId} belongs to authorization ${upId}, not ${authorizationId}`);
  return toCharge(c, authorizationId);
}

/** Reads an order's authorizations and captures (reconcile before re-trying a money call). */
export async function getOrderPayments(http: PayPalHttp, orderId: string): Promise<OrderPayments> {
  assertPayPalId(orderId, "order id");
  const o = requireBody(await http.request<OrderBody>({ method: "GET", path: `/v2/checkout/orders/${orderId}` }), "order");
  if (o.id !== orderId) throw new PayPalError(502, "BAD_RESPONSE_BODY", `asked for order ${orderId} but PayPal answered with ${o.id === undefined ? "no id" : `order ${o.id}`}`);
  const unit = firstUnit(o);
  const out: OrderPayments = {
    orderId: o.id,
    status: o.status,
    authorizations: (unit?.payments?.authorizations ?? []).map((a) => ({ id: a.id, status: a.status })),
    captures: (unit?.payments?.captures ?? []).map((c) => ({ id: c.id, status: c.status })),
  };
  if (unit?.custom_id !== undefined) out.customId = unit.custom_id;
  return out;
}

export async function voidHold(http: PayPalHttp, authorizationId: string): Promise<void> {
  assertPayPalId(authorizationId, "authorization id");
  await http.request({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/void`, requestId: requestIds.void(authorizationId) });
}

/**
 * Returns the NEW authorization. `orderId` is "" because PayPal's reauthorize response does not carry the order.
 * Plan 4 never relies on this (spike decision 4); kept for the sandbox check.
 */
export async function reauthorizeHold(http: PayPalHttp, authorizationId: string, amountCents: Cents): Promise<Hold> {
  assertPayPalId(authorizationId, "authorization id");
  const a = requireBody(await http.request<AuthBody>({ method: "POST", path: `/v2/payments/authorizations/${authorizationId}/reauthorize`, requestId: requestIds.reauthorize(authorizationId), prefer: "return=representation", body: { amount: { currency_code: "USD", value: centsToValue(amountCents) } } }), "authorization");
  return toHold("", a, amountCents);
}

export async function refundCharge(http: PayPalHttp, captureId: string): Promise<Refund> {
  assertPayPalId(captureId, "capture id");
  const r = requireBody(await http.request<{ id: string; status: string }>({ method: "POST", path: `/v2/payments/captures/${captureId}/refund`, requestId: requestIds.refund(captureId), prefer: "return=representation", body: {} }), "refund");
  return { refundId: r.id, captureId, status: r.status };
}

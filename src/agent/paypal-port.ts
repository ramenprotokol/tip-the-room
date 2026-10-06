import type { PayoutLine } from "../core/split";
import type { PayPalHttp } from "../paypal/http";
import {
  authorizeOrder,
  captureHold,
  createCardHold,
  createPledgeOrder,
  getCapture,
  getOrderPayments,
  refundCharge,
  voidHold,
  type Charge,
  type Hold,
  type OrderPayments,
  type PledgeRef,
  type Refund,
  type TestCard,
} from "../paypal/payments";
import { getPayoutBatch, sendPayouts, type PayoutBatch, type SentBatch } from "../paypal/payouts";
import { isShowId } from "./ids";

/** Every PayPal call the runtime makes. The Durable Object wires it to src/paypal; tests use a fake. */
export interface PayPalPort {
  createPledgeOrder(p: PledgeRef): Promise<{ orderId: string }>;
  authorizeOrder(orderId: string): Promise<Hold>;
  createCardHold(p: PledgeRef, card: TestCard): Promise<Hold>;
  captureHold(authorizationId: string): Promise<Charge>;
  voidHold(authorizationId: string): Promise<void>;
  refundCharge(captureId: string): Promise<Refund>;
  getOrderPayments(orderId: string): Promise<OrderPayments>;
  getCapture(captureId: string, authorizationId: string): Promise<Charge>;
  sendPayouts(showId: string, lines: PayoutLine[], retry: boolean): Promise<SentBatch>;
  getPayoutBatch(batchId: string): Promise<PayoutBatch>;
}

export function paypalPort(http: PayPalHttp): PayPalPort {
  return {
    createPledgeOrder: (p) => createPledgeOrder(http, p),
    authorizeOrder: (orderId) => authorizeOrder(http, orderId),
    createCardHold: (p, card) => createCardHold(http, p, card),
    captureHold: (id) => captureHold(http, id),
    voidHold: (id) => voidHold(http, id),
    refundCharge: (id) => refundCharge(http, id),
    getOrderPayments: (id) => getOrderPayments(http, id),
    getCapture: (captureId, authorizationId) => getCapture(http, captureId, authorizationId),
    sendPayouts: async (showId, lines, retry) => {
      // The payout id helpers only check length and characters; our own show-id shape is checked first.
      if (!isShowId(showId)) throw new RangeError("not a valid show id");
      return sendPayouts(http, showId, lines, { retry });
    },
    getPayoutBatch: (id) => getPayoutBatch(http, id),
  };
}

/** The public sandbox Visa test card used for simulated fans (spike decision 1). Not a secret. */
export const SIM_CARD: TestCard = { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Simulated Fan" };

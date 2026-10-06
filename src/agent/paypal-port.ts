import type { PayoutLine } from "../core/split";
import type { PayPalConfig } from "../paypal/config";
import { PayPalHttp, type ClientOptions, type FetchLike } from "../paypal/http";
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

/** Counts outbound PayPal fetches in the current turn (token fetches and retries included). */
export class CallMeter {
  used = 0;
  reset(): void {
    this.used = 0;
  }
  add(n = 1): void {
    this.used += n;
  }
}

/** Wraps a fetch so every outbound call is counted. */
export function meteredFetch(inner: FetchLike, meter: CallMeter): FetchLike {
  return (input, init) => {
    meter.add();
    return inner(input, init);
  };
}

/** Builds the PayPal client with a counting fetch, and the port that shares its meter. */
export function meteredPayPal(config: PayPalConfig, opts: ClientOptions = {}): { http: PayPalHttp; port: PayPalPort; meter: CallMeter } {
  const meter = new CallMeter();
  const inner: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const http = new PayPalHttp(config, { ...opts, fetch: meteredFetch(inner, meter) });
  return { http, port: paypalPort(http, meter), meter };
}

/** Every PayPal call the runtime makes. The Durable Object wires it to src/paypal; tests use a fake. */
export interface PayPalPort {
  /** Fetches made this turn. drain resets it and stops starting jobs that would not fit the budget. */
  readonly meter: CallMeter;
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

/** `meter` must be the one counting `http`'s fetches (see meteredPayPal); otherwise the budget is blind. */
export function paypalPort(http: PayPalHttp, meter: CallMeter = new CallMeter()): PayPalPort {
  return {
    meter,
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

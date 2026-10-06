import { DAY_MS } from "../../src/core/holds";
import type { PayoutLine } from "../../src/core/split";
import { isShowId, type Clock } from "../../src/agent/ids";
import { CallMeter, type PayPalPort } from "../../src/agent/paypal-port";
import type { Charge, Hold, OrderPayments, PledgeRef, Refund, TestCard } from "../../src/paypal/payments";
import { payoutBatchId, payoutItemId, type PayoutBatch, type PayoutItem, type SentBatch } from "../../src/paypal/payouts";

type Op = keyof PayPalPort;
type Answer = (...args: never[]) => unknown;

/**
 * Records every call. Each op answers with a scripted function (used once, in order) or a sensible default.
 * Ids are obviously fake: A-<pledge>, O-<pledge>, C-<auth>, R-<capture>, B-1.
 */
export class FakePayPal implements PayPalPort {
  readonly calls: { op: Op; args: unknown[] }[] = [];
  readonly meter = new CallMeter();
  /** Money-moving effects that really happened (a replayed request id does not add one). */
  readonly effects = new Set<string>();
  /** Fetches each call is counted as (3 simulates a token fetch plus one retry). */
  fetchesPerCall = 1;
  private readonly scripted = new Map<Op, Answer[]>();
  private readonly orders = new Map<string, PledgeRef>();
  private readonly batches = new Map<string, PayoutItem[]>();
  private batchCount = 0;

  constructor(private readonly clock: Clock = { now: () => 0 }) {}

  /** Queue answers for an op. An answer may throw (e.g. a PayPalError). */
  script(op: Op, ...answers: Answer[]): this {
    this.scripted.set(op, [...(this.scripted.get(op) ?? []), ...answers]);
    return this;
  }

  count(op: Op): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  private async answer<T>(op: Op, args: unknown[], fallback: () => T): Promise<T> {
    this.calls.push({ op, args });
    this.meter.add(this.fetchesPerCall);
    const next = this.scripted.get(op)?.shift();
    return (next ? (next as (...a: unknown[]) => T)(...args) : fallback()) as T;
  }

  private hold(p: PledgeRef, orderId: string): Hold {
    const t = this.clock.now();
    return { authorizationId: `A-${p.pledgeId}`, orderId, amountCents: p.amountCents, status: "CREATED", createdAt: t, expiresAt: t + 29 * DAY_MS, customId: `${p.showId}:${p.pledgeId}` };
  }

  createPledgeOrder(p: PledgeRef): Promise<{ orderId: string }> {
    return this.answer("createPledgeOrder", [p], () => {
      const orderId = `O-${p.pledgeId}`;
      this.orders.set(orderId, p);
      return { orderId };
    });
  }

  authorizeOrder(orderId: string): Promise<Hold> {
    return this.answer("authorizeOrder", [orderId], () => {
      const p = this.orders.get(orderId);
      if (!p) throw new Error(`fake: unknown order ${orderId}`);
      return this.hold(p, orderId);
    });
  }

  createCardHold(p: PledgeRef, card: TestCard): Promise<Hold> {
    return this.answer("createCardHold", [p, card], () => this.hold(p, `O-${p.pledgeId}`));
  }

  captureHold(authorizationId: string): Promise<Charge> {
    return this.answer("captureHold", [authorizationId], () => (this.effects.add(`capture:${authorizationId}`), { captureId: `C-${authorizationId}`, authorizationId, status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 }));
  }

  voidHold(authorizationId: string): Promise<void> {
    return this.answer("voidHold", [authorizationId], () => void this.effects.add(`void:${authorizationId}`));
  }

  refundCharge(captureId: string): Promise<Refund> {
    return this.answer("refundCharge", [captureId], () => (this.effects.add(`refund:${captureId}`), { refundId: `R-${captureId}`, captureId, status: "COMPLETED" }));
  }

  getOrderPayments(orderId: string): Promise<OrderPayments> {
    return this.answer("getOrderPayments", [orderId], () => ({ orderId, status: "COMPLETED", authorizations: [], captures: [] }));
  }

  getAuthorization(authorizationId: string, orderId: string): Promise<Hold> {
    return this.answer("getAuthorization", [authorizationId, orderId], () => {
      const p = this.orders.get(orderId);
      if (!p) throw new Error(`fake: unknown order ${orderId}`);
      return { ...this.hold(p, orderId), authorizationId };
    });
  }

  getCapture(captureId: string, authorizationId: string): Promise<Charge> {
    return this.answer("getCapture", [captureId, authorizationId], () => ({ captureId, authorizationId, status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 }));
  }

  sendPayouts(showId: string, lines: PayoutLine[], retry: boolean): Promise<SentBatch> {
    return this.answer("sendPayouts", [showId, lines, retry], () => {
      if (!isShowId(showId)) throw new RangeError("not a valid show id");
      this.batchCount += 1;
      const batchId = `B-${this.batchCount}`;
      const sentLines = lines.filter((l) => l.amount > 0);
      this.batches.set(batchId, sentLines.map((l) => ({ senderItemId: payoutItemId(showId, l.role, retry), status: "SUCCESS", amountCents: l.amount })));
      return { batchId, senderBatchId: payoutBatchId(showId, retry), status: "PENDING", sentLines };
    });
  }

  getPayoutBatch(batchId: string): Promise<PayoutBatch> {
    return this.answer("getPayoutBatch", [batchId], () => ({ batchId, senderBatchId: "", status: "SUCCESS", items: this.batches.get(batchId) ?? [] }));
  }
}

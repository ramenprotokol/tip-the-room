import { fansCommitted, IllegalTransition, reduce } from "../core/campaign";
import { buildMandate, MandateDraftError, signMandate, type Mandate } from "../core/mandate";
import { formatUSD } from "../core/money";
import { assertPayPalId } from "../paypal/amount";
import { PayPalError } from "../paypal/errors";
import { requestIds, type Hold, type TestCard } from "../paypal/payments";
import type { AuthorizeResponse, CreateOrderRequest, CreateOrderResponse, ManageView, PublicShow, SignRequest, SignResponse } from "../worker/api-types";
import type { AiDeps } from "./ai";
import { toMandateDraft } from "./draft";
import { ServiceError } from "./errors";
import { commit, logStep, queueVoid, type ExecDeps } from "./executor";
import { customIdFor, newId, newSecret, sameHex, sha256Hex, type Clock, type Random } from "./ids";
import type { PayPalPort } from "./paypal-port";
import { MAX_ORDERS_PER_SHOW } from "./policy";
import type { OrderView, Projection } from "./project";
import type { Store } from "./store";
import { attentionLines, ledgerRows, logRows, manageParties, proposalRows, publicShow } from "./views";
import { fanName, holdDescription, sawCounts } from "./words";

export interface ServiceDeps {
  store: Store;
  paypal: PayPalPort;
  /** Real time. A demo copy adds its stored clock offset on top. */
  clock: Clock;
  ai: AiDeps;
  random: Random;
  paypalClientId: string;
  card: TestCard;
}

type LogInput = Parameters<typeof logStep>[1];
/** Answers PayPal gave that our own checks refused: the hold may exist even though we can't read it. */
const UNREADABLE = new Set(["EMPTY_RESPONSE_BODY", "BAD_RESPONSE_BODY", "UNEXPECTED_CURRENCY", "BAD_AMOUNT"]);
const INITIALS = /^[A-Za-z]{1,3}$/;

/** Why PayPal's hold can't be counted for this order, or null when it matches exactly. */
function holdProblem(h: Hold, orderId: string, order: OrderView, m: Mandate): string | null {
  if (h.orderId !== orderId) return "PayPal answered for a different order";
  if (h.status !== "CREATED") return "PayPal did not place the hold";
  if (h.amountCents !== order.amountCents || h.amountCents !== m.ticketPrice) return `PayPal held ${formatUSD(h.amountCents)} instead of ${formatUSD(m.ticketPrice)}`;
  if (h.customId !== undefined && h.customId !== customIdFor(m.showId, order.pledgeId)) return "PayPal's hold belongs to a different pledge";
  return null;
}

/** One campaign. Every public method is safe to call again (deterministic keys, deadline applied first). */
export class CampaignService {
  constructor(private readonly deps: ServiceDeps) {}

  ensureSchema(): void {
    this.deps.store.migrate();
  }

  exists(): boolean {
    return this.deps.store.exists();
  }

  clockOffset(): number {
    const v = Number(this.deps.store.getMeta("clock_offset") ?? "0");
    return Number.isFinite(v) ? v : 0;
  }

  /** Campaign time. */
  now(): number {
    return this.deps.clock.now() + this.clockOffset();
  }

  showId(): string {
    const id = this.deps.store.getMeta("show_id");
    if (!id) throw new ServiceError(404, "not_found", "There's no show here.");
    return id;
  }

  kind(): "real" | "demo" {
    return this.deps.store.getMeta("kind") === "demo" ? "demo" : "real";
  }

  exec(): ExecDeps {
    return { store: this.deps.store, paypal: this.deps.paypal, clock: { now: () => this.now() }, showId: this.showId(), card: this.deps.card };
  }

  project(): Projection {
    return this.deps.store.projection();
  }

  private log(s: LogInput): void {
    logStep(this.exec(), s);
  }

  private requireMandate(p: Projection): Mandate {
    if (!p.mandate) throw new ServiceError(404, "not_found", "This show isn't live yet.");
    return p.mandate;
  }

  init(input: { showId: string; signTokenHash: string }): { showId: string } {
    const store = this.deps.store;
    if (store.getMeta("show_id")) throw new ServiceError(409, "conflict", "That show already exists.");
    store.transaction(() => {
      store.setMeta("show_id", input.showId);
      store.setMeta("kind", "real");
      store.setMeta("sign_token_hash", input.signTokenHash);
      store.setMeta("created_at", String(this.deps.clock.now()));
    });
    return { showId: input.showId };
  }

  async sign(req: SignRequest): Promise<SignResponse> {
    const store = this.deps.store;
    const showId = this.showId();
    const now = this.now();
    const at = new Date(now).toISOString();
    if (typeof req?.signToken !== "string" || req.signToken.length === 0 || req.signToken.length > 200) throw new ServiceError(403, "forbidden", "This sign link isn't valid.");
    if (this.project().mandate) throw new ServiceError(409, "conflict", "This show is already signed.");
    const stored0 = store.getMeta("sign_token_hash");
    if (!stored0 || !sameHex(await sha256Hex(req.signToken), stored0)) throw new ServiceError(403, "forbidden", "This sign link isn't valid.");
    const draft = toMandateDraft(showId, req.draft, at);
    let mandate: Mandate;
    try {
      mandate = buildMandate(draft);
    } catch (e) {
      if (e instanceof MandateDraftError) throw new ServiceError(422, "invalid", "Some details need fixing.", e.problems);
      throw e;
    }
    const [tokenHash, signed] = await Promise.all([sha256Hex(req.signToken), signMandate(mandate, at)]);
    const manageKey = newSecret(this.deps.random);
    const keyHash = await sha256Hex(manageKey);
    // No awaits from here on: the checks and the writes happen together, so two signs can't both win.
    if (this.project().mandate) throw new ServiceError(409, "conflict", "This show is already signed.");
    const stored = store.getMeta("sign_token_hash");
    if (!stored || !sameHex(tokenHash, stored)) throw new ServiceError(403, "forbidden", "This sign link isn't valid.");
    store.transaction(() => {
      store.setMeta("manage_key_hash", keyHash);
      store.deleteMeta("sign_token_hash");
    });
    const { projection } = commit(store, now, { type: "mandate_signed", mandate: signed.mandate, hash: signed.hash, signedAt: signed.signedAt });
    this.log({ saw: "The artist read the money rules and held to sign.", did: `Opened pledging: ${mandate.threshold} fans by ${new Date(Date.parse(mandate.deadline)).toUTCString()}.`, rule: null, resultId: signed.hash.slice(0, 12) });
    return { showId, manageKey, mandateHash: signed.hash, threshold: mandate.threshold, deadline: mandate.deadline, sharePath: `/s/${showId}`, managePath: `/s/${showId}/manage`, show: this.publicView(projection) };
  }

  publicView(p: Projection = this.project()): PublicShow {
    if (!p.mandate || !p.mandateHash) throw new ServiceError(404, "not_found", "This show isn't live yet.");
    return publicShow(p, p.mandate, p.mandateHash, { demo: this.kind() === "demo", paypalClientId: this.deps.paypalClientId });
  }

  async checkKey(key: string | null): Promise<void> {
    const hash = this.deps.store.getMeta("manage_key_hash");
    const ok = !!hash && typeof key === "string" && key.length >= 20 && key.length <= 200 && sameHex(await sha256Hex(key), hash);
    if (!ok) throw new ServiceError(403, "forbidden", "That manage link isn't valid.");
  }

  /** Applies deadline_reached(now) when it changes the state. Called before anything is decided. */
  applyDeadline(): Projection {
    const p = this.project();
    if (!p.mandate) return p;
    const now = this.now();
    const before = p.campaign.state;
    const deadline = p.campaign.deadline;
    if (reduce(p.campaign, { type: "deadline_reached", now }).campaign.state === before) return p;
    const r = commit(this.deps.store, now, { type: "deadline_reached", now, deadline });
    const after = r.projection.campaign;
    if (after.state === "missed") {
      this.log({ saw: sawCounts(r.projection), did: `The deadline passed at ${fansCommitted(after)} of ${after.threshold} fans. Cancelling every hold; nobody pays.`, rule: "rule-3-void-on-miss" });
    } else if (after.state === "paying_out") {
      this.log({ saw: sawCounts(r.projection), did: "The deadline passed. Payouts go out once every charge has settled.", rule: "rule-4-pay-the-split" });
    }
    return r.projection;
  }

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResponse> {
    const raw = req?.initials;
    if (typeof raw !== "string" || !INITIALS.test(raw.trim())) throw new ServiceError(422, "invalid", "Initials must be 1 to 3 letters.");
    const initials = raw.trim().toUpperCase();
    const p = this.applyDeadline();
    const m = this.requireMandate(p);
    if (p.campaign.state !== "live" && p.campaign.state !== "tipped") throw new ServiceError(409, "conflict", "Pledging has closed for this show.");
    if (p.orders.size >= MAX_ORDERS_PER_SHOW) throw new ServiceError(409, "conflict", "This show has taken as many pledges as it can.");
    const pledgeId = newId("p", this.deps.random);
    let orderId: string;
    try {
      ({ orderId } = await this.deps.paypal.createPledgeOrder({ showId: m.showId, pledgeId, amountCents: m.ticketPrice, description: holdDescription(m) }));
      assertPayPalId(orderId, "order id");
    } catch (e) {
      if (e instanceof RangeError) throw new ServiceError(502, "paypal_error", "PayPal's answer didn't look right. Nothing was held or charged; please try again.");
      if (e instanceof PayPalError) throw new ServiceError(502, "paypal_error", "PayPal is having trouble. Nothing was held or charged; please try again.");
      throw e;
    }
    commit(this.deps.store, this.now(), { type: "order_created", orderId, pledgeId, amountCents: m.ticketPrice, initials });
    return { orderId, pledgeId, amountCents: m.ticketPrice };
  }

  /** The browser says "PayPal approved order X". We only act on an order this show created. */
  async authorize(orderIdRaw: string): Promise<AuthorizeResponse> {
    let orderId: string;
    try {
      orderId = assertPayPalId(orderIdRaw, "order id");
    } catch {
      throw new ServiceError(400, "bad_request", "That isn't a PayPal order id.");
    }
    const store = this.deps.store;
    let p = this.applyDeadline();
    const m = this.requireMandate(p);
    const order = p.orders.get(orderId);
    if (!order) throw new ServiceError(404, "not_found", "We didn't create that order for this show.");
    if (order.resolved) {
      const existing = p.pledges.get(order.pledgeId);
      if (!existing) throw new ServiceError(409, "conflict", "This order was already used and didn't become a pledge.");
      return { pledgeId: existing.pledgeId, status: "held", tipped: p.campaign.state !== "live", show: this.publicView(p) };
    }
    if (p.campaign.state !== "live" && p.campaign.state !== "tipped") throw new ServiceError(409, "conflict", "Pledging has closed for this show. Nothing was held or charged.");
    let hold: Hold;
    try {
      hold = await this.deps.paypal.authorizeOrder(orderId);
    } catch (e) {
      if (e instanceof PayPalError && UNREADABLE.has(e.paypalName)) {
        await this.recoverUnreadable(orderId, order);
        throw new ServiceError(502, "paypal_error", "PayPal's answer wasn't clear. Nothing was charged; any hold is being cancelled.");
      }
      if (e instanceof PayPalError && !e.retryable) throw new ServiceError(409, "conflict", "PayPal didn't place the hold. Nothing was charged.");
      throw new ServiceError(502, "paypal_error", "PayPal is having trouble. Nothing was charged; please try again.");
    }
    p = this.applyDeadline(); // the deadline may have passed while PayPal answered
    const now = this.now();
    const problem = holdProblem(hold, orderId, order, m);
    if (problem) {
      commit(store, now, { type: "pledge_rejected", pledgeId: order.pledgeId, orderId, authorizationId: hold.authorizationId || null, reason: problem });
      if (hold.authorizationId && (hold.status === "CREATED" || hold.status === "PENDING")) queueVoid(store, hold.authorizationId, now);
      this.log({ saw: `PayPal answered for order ${orderId}: ${problem}.`, did: "Refused this hold and queued it to be cancelled. Nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: hold.authorizationId || null });
      throw new ServiceError(422, "invalid", "PayPal didn't hold the right amount, so that hold is being cancelled. Nothing was charged.");
    }
    const wasLive = p.campaign.state === "live";
    try {
      p = commit(store, now, { type: "pledge_held", pledgeId: order.pledgeId, orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents, authorizedAt: hold.createdAt, expiresAt: hold.expiresAt, initials: order.initials, simulated: false }).projection;
    } catch (e) {
      if (!(e instanceof IllegalTransition)) throw e;
      commit(store, now, { type: "late_hold", pledgeId: order.pledgeId, orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents });
      queueVoid(store, hold.authorizationId, now);
      this.log({ saw: sawCounts(this.project()), did: "A hold arrived after pledging closed. Cancelling it; nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: hold.authorizationId });
      throw new ServiceError(409, "conflict", "Pledging closed before your hold arrived, so it is being cancelled. Nothing was charged.");
    }
    const pledge = p.pledges.get(order.pledgeId)!;
    this.log({ saw: sawCounts(p), did: `${fanName(pledge)} held a spot. PayPal is holding ${formatUSD(hold.amountCents)}; nobody is charged yet.`, rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: hold.authorizationId });
    if (wasLive && p.campaign.state === "tipped") this.log({ saw: sawCounts(p), did: "The show reached its target. Charging every hold now.", rule: "rule-2-capture-at-tip" });
    return { pledgeId: pledge.pledgeId, status: "held", tipped: p.campaign.state !== "live", show: this.publicView(p) };
  }

  /**
   * PayPal answered, but not in a form we trust, so a hold may exist that we never recorded. Ask PayPal
   * (GET) what the order holds; any live hold found is retired and queued to be cancelled, and the order
   * is closed so it can't be counted later. If PayPal can't say, the order stays open and the fan can retry.
   */
  private async recoverUnreadable(orderId: string, order: OrderView): Promise<void> {
    try {
      const found = await this.deps.paypal.getOrderPayments(orderId);
      const live = found.authorizations.find((a) => (a.status === "CREATED" || a.status === "PENDING") && /^[A-Za-z0-9-]{1,64}$/.test(a.id));
      if (!live) return;
      const now = this.now();
      commit(this.deps.store, now, { type: "pledge_rejected", pledgeId: order.pledgeId, orderId, authorizationId: live.id, reason: "PayPal's answer could not be read" });
      queueVoid(this.deps.store, live.id, now);
      this.log({ saw: `PayPal's answer for order ${orderId} couldn't be read, but a hold exists.`, did: "Refused it and queued it to be cancelled. Nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: live.id });
    } catch {
      // Leave the order open: nothing was recorded, and the fan can try again.
    }
  }

  manageView(): ManageView {
    const p = this.applyDeadline();
    const showId = this.showId();
    return {
      show: this.publicView(p),
      ledger: ledgerRows(this.deps.store.events(), p, showId),
      log: logRows(this.deps.store.logs()),
      proposals: proposalRows(p),
      parties: manageParties(p, showId),
      notes: (p.notes ?? []).map((n) => ({ role: n.role, label: n.label, text: n.text, source: n.source })),
      attention: attentionLines(this.deps.store.jobs()),
      collectedNetCents: p.collectedNet,
    };
  }
}

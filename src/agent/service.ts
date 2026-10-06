import { fansCommitted, IllegalTransition, reduce } from "../core/campaign";
import { DAY_MS } from "../core/holds";
import { guard, type AgentAction } from "../core/guard";
import { buildMandate, MandateDraftError, signMandate, type Mandate } from "../core/mandate";
import { formatUSD } from "../core/money";
import { splitPayout } from "../core/split";
import { assertPayPalId } from "../paypal/amount";
import { PayPalError } from "../paypal/errors";
import { requestIds, type Hold, type TestCard } from "../paypal/payments";
import { isKnownEventType, type PayPalLedgerEvent } from "../paypal/webhooks";
import type { ApproveRequest, ApproveResponse, AuthorizeResponse, CallOffResponse, CreateOrderRequest, CreateOrderResponse, DeclineResponse, DemoFansResponse, ManageView, PublicShow, SignRequest, SignResponse } from "../worker/api-types";
import type { AiDeps } from "./ai";
import { paceNote, settlementNote, type PaceFacts } from "./ai-jobs";
import type { DemoSeed } from "./demo";
import { toMandateDraft } from "./draft";
import { ServiceError } from "./errors";
import type { ProposalOption, SettlementNote } from "./events";
import { commit, drain, logStep, queueVoid, requestReconcile, type ExecDeps } from "./executor";
import { sweepStuckHolds, sweepWakes } from "./hold-runner";
import { customIdFor, newId, newSecret, pledgeIdFromCustomId, sameHex, sha256Hex, type Clock, type Random } from "./ids";
import { duePaceCheck, paceCheckTimes, paceNumbers, paceOptions } from "./pace";
import type { PayPalPort } from "./paypal-port";
import { DEMO_GRACE_MS, DEMO_PACE_POINT, DEMO_GRACE_TOTAL_MAX_MS, DEMO_TOP_UP_EXTRA, demoGraceMs, DEMO_TTL_MS, MAX_JOBS_PER_TURN, MAX_ORDERS_PER_SHOW, MODEL_CALL_COST, MONEY_JOBS, ORDER_OPEN_MS, RECOVERED_BATCH_ATTENTION_MS, REHOLD_MARGIN_MS, SIM_ADD_MAX, SIM_CAP_PER_SHOW, TURN_CALL_BUDGET, UNSIGNED_TTL_MS } from "./policy";
import type { OrderView, PledgeView, Projection } from "./project";
import { RUNNERS } from "./runners";
import { SIM_INITIALS } from "./sim-runner";
import type { Store } from "./store";
import { attentionLines, ledgerRows, logRows, manageParties, payoutStateOf, proposalRows, publicShow, reversalLines, UNCONFIRMED_PAYOUT_LINE, unconfirmedPayoutLines, unconfirmedPayouts } from "./views";
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
  if (h.customId !== customIdFor(m.showId, order.pledgeId)) return "PayPal's hold belongs to a different pledge";
  return null;
}

/** The guard action an approved option stands for. A missing number becomes NaN, which the guard refuses. */
function actionFor(o: ProposalOption, p: Projection): AgentAction {
  switch (o.id) {
    case "extend":
      return { kind: "extend_deadline", newDeadline: o.newDeadline ?? Number.NaN };
    case "lower":
      return { kind: "lower_threshold", newThreshold: o.newThreshold ?? Number.NaN };
    case "pay_short":
      return { kind: "send_payouts", lines: p.mandate ? splitPayout(p.collectedNet, p.mandate.parties).lines : [] };
  }
}

const SAFE_REF = /^[A-Za-z0-9-]{1,64}$/;

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
      const at = this.deps.clock.now();
      store.setMeta("created_at", String(at));
      // A show nobody signs is deleted after a day (the alarm does it). Signing removes this.
      store.setMeta("expires_at", String(at + UNSIGNED_TTL_MS));
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
    const lapse = this.expiresAt();
    if (lapse !== null && this.deps.clock.now() >= lapse) throw new ServiceError(404, "not_found", "This sign link has expired. Start a new show.");
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
    // One transaction: if the signing event can't be written, the sign token survives and the artist can try again.
    const { projection } = store.transaction(() => {
      store.setMeta("manage_key_hash", keyHash);
      store.deleteMeta("sign_token_hash");
      store.deleteMeta("expires_at");
      return commit(store, now, { type: "mandate_signed", mandate: signed.mandate, hash: signed.hash, signedAt: signed.signedAt });
    });
    this.log({ saw: "The artist read the money rules and held to sign.", did: `Opened pledging: ${mandate.threshold} fans by ${new Date(Date.parse(mandate.deadline)).toUTCString()}.`, rule: null, resultId: signed.hash.slice(0, 12) });
    return { showId, manageKey, mandateHash: signed.hash, threshold: mandate.threshold, deadline: mandate.deadline, sharePath: `/s/${showId}`, managePath: `/s/${showId}/manage`, show: this.publicView(projection) };
  }

  /** A cheap change marker: the last ledger seq and the last agent-log seq, e.g. "e123.l45". It changes whenever either grows. */
  version(): string {
    return `e${this.deps.store.lastEventSeq()}.l${this.deps.store.lastLogSeq()}`;
  }

  publicView(p: Projection = this.project()): PublicShow {
    if (!p.mandate || !p.mandateHash) throw new ServiceError(404, "not_found", "This show isn't live yet.");
    return publicShow(p, p.mandate, p.mandateHash, { demo: this.kind() === "demo", paypalClientId: this.deps.paypalClientId, now: this.now(), version: this.version() });
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
    const at = this.now();
    let open = 0;
    for (const o of p.orders.values()) if (o.resolved || at - o.createdAt < ORDER_OPEN_MS) open += 1;
    if (open >= MAX_ORDERS_PER_SHOW) throw new ServiceError(409, "conflict", "This show has taken as many pledges as it can.");
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
    const p = this.applyDeadline();
    const m = this.requireMandate(p);
    const order = p.orders.get(orderId);
    if (!order) throw new ServiceError(404, "not_found", "We didn't create that order for this show.");
    if (order.resolved) {
      const existing = p.pledges.get(order.pledgeId);
      if (!existing) throw new ServiceError(409, "conflict", "This order was already used and didn't become a pledge.");
      return { pledgeId: existing.pledgeId, status: "held", tipped: p.campaign.state !== "live", show: this.publicView(p) };
    }
    if (this.now() - order.createdAt >= ORDER_OPEN_MS) {
      await this.retireAbandoned(orderId, order);
      throw new ServiceError(409, "conflict", "This pledge took too long to finish, so nothing was held or charged. Please start again.");
    }
    if (p.campaign.state !== "live" && p.campaign.state !== "tipped") throw new ServiceError(409, "conflict", "Pledging has closed for this show. Nothing was held or charged.");
    let hold: Hold;
    try {
      hold = await this.deps.paypal.authorizeOrder(orderId);
    } catch (e) {
      if (e instanceof PayPalError && (UNREADABLE.has(e.paypalName) || e.hasIssue("ORDER_ALREADY_AUTHORIZED"))) {
        const recovered = await this.recoverExisting(orderId, order, m, !UNREADABLE.has(e.paypalName));
        if (recovered) return recovered;
        throw new ServiceError(502, "paypal_error", "PayPal's answer wasn't clear. Nothing was charged and any hold is being cancelled; please try again.");
      }
      if (e instanceof PayPalError && !e.retryable) throw new ServiceError(409, "conflict", "PayPal didn't place the hold. Nothing was charged.");
      throw new ServiceError(502, "paypal_error", "PayPal is having trouble. Nothing was charged; please try again.");
    }
    return this.recordHold(orderId, order, m, hold);
  }

  /** PayPal answered with a hold for this order: check it against the order and the mandate, then count it, or refuse it and queue it to be cancelled. */
  private recordHold(orderId: string, order: OrderView, m: Mandate, hold: Hold): AuthorizeResponse {
    const store = this.deps.store;
    let p = this.applyDeadline(); // the deadline may have passed while PayPal answered
    const now = this.now();
    const problem = holdProblem(hold, orderId, order, m);
    if (problem) {
      commit(store, now, { type: "pledge_rejected", pledgeId: order.pledgeId, orderId, authorizationId: hold.authorizationId || null, reason: problem });
      if (hold.authorizationId && (hold.status === "CREATED" || hold.status === "PENDING")) queueVoid(store, hold.authorizationId, now);
      this.log({ saw: `PayPal answered for order ${orderId}: ${problem}.`, did: "Refused this hold and queued it to be cancelled. Nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: hold.authorizationId || null });
      throw new ServiceError(422, "invalid", "PayPal didn't hold the right amount, so that hold is being cancelled. Nothing was charged.");
    }
    const wasLive = p.campaign.state === "live";
    let held: ReturnType<typeof commit>;
    try {
      held = commit(store, now, { type: "pledge_held", pledgeId: order.pledgeId, orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents, authorizedAt: hold.createdAt, expiresAt: hold.expiresAt, initials: order.initials, simulated: false });
      p = held.projection;
    } catch (e) {
      if (!(e instanceof IllegalTransition)) throw e;
      commit(store, now, { type: "late_hold", pledgeId: order.pledgeId, orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents });
      queueVoid(store, hold.authorizationId, now);
      this.log({ saw: sawCounts(this.project()), did: "A hold arrived after pledging closed. Cancelling it; nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: hold.authorizationId });
      throw new ServiceError(409, "conflict", "Pledging closed before your hold arrived, so it is being cancelled. Nothing was charged.");
    }
    const pledge = p.pledges.get(order.pledgeId)!;
    // A racing duplicate call finds the event already written: it must not log the same hold twice.
    if (held.appended) this.log({ saw: sawCounts(p), did: `${fanName(pledge)} held a spot. PayPal is holding ${formatUSD(hold.amountCents)}; nobody is charged yet.`, rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: hold.authorizationId });
    if (held.appended && wasLive && p.campaign.state === "tipped") this.log({ saw: sawCounts(p), did: "The show reached its target. Charging every hold now.", rule: "rule-2-capture-at-tip" });
    return { pledgeId: pledge.pledgeId, status: "held", tipped: p.campaign.state !== "live", show: this.publicView(p) };
  }

  /**
   * An order older than ORDER_OPEN_MS that never became a pledge. Ask PayPal (GET) whether it holds anything; close the
   * order either way and queue any live hold to be cancelled. If PayPal can't say, the order stays open (it no longer
   * counts toward the cap, and a later call looks again).
   */
  private async retireAbandoned(orderId: string, order: OrderView): Promise<void> {
    let live: string | null;
    try {
      const found = await this.deps.paypal.getOrderPayments(orderId);
      live = found.authorizations.find((a) => (a.status === "CREATED" || a.status === "PENDING") && SAFE_REF.test(a.id))?.id ?? null;
    } catch {
      return;
    }
    const now = this.now();
    commit(this.deps.store, now, { type: "pledge_rejected", pledgeId: order.pledgeId, orderId, authorizationId: live, reason: "the order was abandoned" });
    if (live) {
      queueVoid(this.deps.store, live, now);
      this.log({ saw: `Order ${orderId} was never finished, but PayPal holds money on it.`, did: "Refused it and queued the hold to be cancelled. Nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: live });
    }
  }

  /**
   * PayPal may hold money on this order that we never recorded: its answer was unreadable, or our earlier answer was
   * lost and PayPal now says ORDER_ALREADY_AUTHORIZED. Look the order up and read any live hold in full. If it is
   * exactly this order's hold at the signed price, record it as the fan's pledge (so the fan is never pushed into a
   * second hold). Otherwise refuse it and queue it to be cancelled. Null when nothing was recorded.
   */
  private async recoverExisting(orderId: string, order: OrderView, m: Mandate, alreadyAuthorized: boolean): Promise<AuthorizeResponse | null> {
    let liveId: string | undefined;
    let orderCustomId: string | undefined;
    try {
      const found = await this.deps.paypal.getOrderPayments(orderId);
      liveId = found.authorizations.find((a) => (a.status === "CREATED" || a.status === "PENDING") && SAFE_REF.test(a.id))?.id;
      orderCustomId = found.customId;
    } catch {
      return null; // PayPal can't say: the order stays open and the fan's retry asks again.
    }
    if (!liveId) {
      // PayPal says the order was authorized, yet nothing live is on it (voided or expired): end the order for good, so a retry can't loop.
      if (alreadyAuthorized) {
        commit(this.deps.store, this.now(), { type: "pledge_rejected", pledgeId: order.pledgeId, orderId, authorizationId: null, reason: "PayPal's hold on this order is no longer live" });
        this.log({ saw: `PayPal says order ${orderId} was already authorized, but no hold on it is live.`, did: "Closed the order. Nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: null });
        throw new ServiceError(409, "conflict", "PayPal didn't place the hold. Nothing was charged.");
      }
      return null;
    }
    let hold: Hold | null;
    try {
      hold = await this.deps.paypal.getAuthorization(liveId, orderId);
    } catch {
      hold = null;
    }
    const wantCustomId = customIdFor(m.showId, order.pledgeId);
    const mismatch = orderCustomId !== undefined && orderCustomId !== wantCustomId ? "PayPal's hold belongs to a different pledge" : hold && hold.authorizationId === liveId ? holdProblem(hold, orderId, order, m) : null;
    if (hold && hold.authorizationId === liveId && !mismatch) return this.recordHold(orderId, order, m, hold);
    const now = this.now();
    commit(this.deps.store, now, { type: "pledge_rejected", pledgeId: order.pledgeId, orderId, authorizationId: liveId, reason: mismatch ?? "PayPal's answer could not be read" });
    queueVoid(this.deps.store, liveId, now);
    this.log({ saw: mismatch ? `PayPal holds money on order ${orderId}, but ${mismatch}.` : `PayPal's answer for order ${orderId} couldn't be read, but a hold exists.`, did: "Refused it and queued it to be cancelled. Nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.authorize(orderId), resultId: liveId });
    if (mismatch) throw new ServiceError(422, "invalid", "PayPal's hold didn't match this show, so it is being cancelled. Nothing was charged.");
    return null;
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
      attention: [...attentionLines(this.deps.store.jobs()), ...reversalLines(this.deps.store.events()), ...unconfirmedPayoutLines(p, this.now())],
      collectedNetCents: p.collectedNet,
      now: this.now(),
      version: this.version(),
      sharePath: `/s/${showId}`,
    };
  }

  /** The model ports for ONE call: metered on the turn's subrequest meter, and templates-only when a call no longer fits. */
  private modelDeps(): AiDeps {
    const { ai, budget } = this.deps.ai;
    const meter = this.deps.paypal.meter;
    if (!ai || TURN_CALL_BUDGET - meter.used < MODEL_CALL_COST) return { ai: null, budget };
    return {
      ai: {
        run: (model, input) => {
          meter.add();
          return ai.run(model, input);
        },
      },
      budget: {
        tryReserve: (n) => {
          meter.add();
          return budget.tryReserve(n);
        },
      },
    };
  }

  /** One alarm turn: demo fast-forward, deadline, a due pace check, money jobs, re-hold planning, notes, then expiry (unsigned shows and demo copies). */
  async tick(): Promise<{ expired: boolean }> {
    if (!this.exists()) return { expired: false };
    const store = this.deps.store;
    // Nobody signed this show: there is no money to move, so the only thing left is its 24 h expiry.
    if (!this.project().mandate) return { expired: this.pastExpiry() };
    // One meter for the whole turn: pace-check and note model calls share it with the PayPal jobs.
    this.deps.paypal.meter.reset();
    const demo = this.kind() === "demo";
    // Fast-forward waits until every queued simulated fan is seated (or given up on), then jumps the demo clock.
    if (demo && store.getMeta("ff_pending") && !store.hasPending(["sim_hold"])) this.jumpToDeadline();
    let p = this.applyDeadline();
    if (p.mandate) {
      const due = duePaceCheck(p.mandate, p.campaign, p.paceChecks, this.now());
      for (const n of due.mark) commit(store, this.now(), { type: "pace_checked", check: n });
      if (due.run !== null) await this.runPaceCheck(due.run);
    }
    await drain(this.exec(), RUNNERS, MAX_JOBS_PER_TURN, false);
    // Held pledges nothing is working on any more must not block the payout forever (spec 8), and a finished real show releases leftover holds.
    await sweepStuckHolds(this.exec());
    this.queueLeftoverVoids(this.project());
    // After the drain, so fans seated this turn get their re-hold job now, not on some later wake-up.
    this.planReholds(this.project());
    p = this.applyDeadline();
    this.flagUnconfirmedPayouts(p);
    if (this.notesDue(p)) await this.writeNotes(p);
    return { expired: demo ? this.checkExpiry() : false };
  }

  /** A capture_failed pledge's hold may still be open at PayPal. Once a real show is over, release it (a demo copy does this at its expiry). */
  private leftoverVoids(p: Projection): string[] {
    if (this.kind() === "demo") return [];
    const s = p.campaign.state;
    if (s !== "missed" && s !== "cancelled" && s !== "settled") return [];
    return [...p.pledges.values()].filter((x) => x.status === "capture_failed" && !x.holdClosed && !this.deps.store.job(`void:${x.authorizationId}`)).map((x) => x.authorizationId);
  }

  private queueLeftoverVoids(p: Projection): void {
    const now = this.now();
    for (const auth of this.leftoverVoids(p)) queueVoid(this.deps.store, auth, now);
  }

  /** Logs each recovered payout with no batch id after the wait, once (the log itself is the marker). */
  private flagUnconfirmedPayouts(p: Projection): void {
    const logged = new Set(this.deps.store.logs().filter((l) => l.did === UNCONFIRMED_PAYOUT_LINE).map((l) => l.resultId));
    for (const x of unconfirmedPayouts(p, this.now())) {
      if (logged.has(x.senderBatchId)) continue;
      this.log({ saw: "PayPal already had this payout, but no batch id has come back.", did: UNCONFIRMED_PAYOUT_LINE, rule: null, resultId: x.senderBatchId });
    }
  }

  private unflaggedPayoutWakes(p: Projection): number[] {
    const logged = new Set(this.deps.store.logs().filter((l) => l.did === UNCONFIRMED_PAYOUT_LINE).map((l) => l.resultId));
    return p.payouts.filter((x) => x.recovered && x.batchId === null && !logged.has(x.senderBatchId)).map((x) => x.sentAt + RECOVERED_BATCH_ATTENTION_MS + 1);
  }

  private async runPaceCheck(check: 1 | 2): Promise<void> {
    const store = this.deps.store;
    const p = this.project();
    const m = this.requireMandate(p);
    const c = p.campaign;
    const nums = paceNumbers(m, c, this.now());
    const saw = `${nums.committed} of ${nums.threshold} fans with ${nums.daysLeft} day${nums.daysLeft === 1 ? "" : "s"} left (${nums.percentElapsed}% of the way). At this pace, about ${nums.projected}.`;
    if (nums.projected >= c.threshold) {
      commit(store, this.now(), { type: "pace_checked", check });
      return this.log({ saw, did: "On pace. Nothing to change.", rule: null });
    }
    const options = paceOptions(m, c, p.approvals, p.collectedNet, nums);
    if (options.length === 0) {
      commit(store, this.now(), { type: "pace_checked", check });
      return this.log({ saw, did: "Behind pace, but the signed rules leave nothing to propose.", rule: "rule-5-ask-first" });
    }
    const extend = options.find((o) => o.id === "extend");
    const lower = options.find((o) => o.id === "lower");
    const facts: PaceFacts = { ...nums, options, extendDays: extend?.newDeadline !== undefined ? Math.ceil((extend.newDeadline - c.deadline) / DAY_MS) : null, lowerTo: lower?.newThreshold ?? null };
    // The model's answer is schema- and number-checked inside paceNote before anything else looks at it.
    const note = await paceNote(this.modelDeps(), facts);
    // The model call took time: apply the deadline, then re-check the options against the campaign as it is NOW.
    const after = this.applyDeadline();
    if (after.campaign.state !== "live") {
      commit(store, this.now(), { type: "pace_checked", check });
      return;
    }
    const again = paceOptions(m, after.campaign, after.approvals, after.collectedNet, paceNumbers(m, after.campaign, this.now()));
    // Compare by option id only: a target number (like the lowered threshold) drifts with the clock, and the note matches the options we made.
    const sig = (os: typeof options) => os.map((o) => o.id).join(",");
    if (sig(again) !== sig(options)) return; // things changed while the model wrote: check again next turn
    commit(store, this.now(), { type: "proposal_made", proposalId: `pace${check}`, options, explanation: note.value.text, recommend: note.value.recommend, source: note.source });
    commit(store, this.now(), { type: "pace_checked", check });
    const resting = note.source === "resting" ? " The AI is resting until 00:00 UTC, so a plain template wrote this." : "";
    this.log({ saw, did: `Proposed: ${options.map((o) => o.label).join(" or ")}. Waiting for the artist.${resting}`, rule: "rule-5-ask-first", source: note.source });
  }

  /** The artist approves one option. Deadline first, then the guard with the option's approval key. */
  async approve(proposalId: string, req: ApproveRequest): Promise<ApproveResponse> {
    const store = this.deps.store;
    const p = this.applyDeadline();
    const m = this.requireMandate(p);
    const proposal = typeof proposalId === "string" ? p.proposals.get(proposalId) : undefined;
    if (!proposal) throw new ServiceError(404, "not_found", "There's no such proposal.");
    if (proposal.approved) throw new ServiceError(409, "conflict", "That proposal was already approved.");
    const option = proposal.options.find((o) => o.id === req?.option);
    if (!option) throw new ServiceError(422, "invalid", "Pick one of the proposal's options.");
    const action = actionFor(option, p);
    const decision = guard(action, { mandate: m, campaign: p.campaign, approvals: new Set([...p.approvals, option.approvalKey]), collectedNet: p.collectedNet });
    const saw = sawCounts(p);
    if (!decision.allowed) {
      this.log({ saw, did: `Did not apply "${option.label}". ${decision.reason}`, rule: decision.rule });
      throw new ServiceError(409, "conflict", decision.reason);
    }
    const now = this.now();
    let after: Projection;
    try {
      // The approval and what it unlocks are written together: no half-approved proposal.
      after = store.transaction(() => {
        const a = commit(store, now, { type: "proposal_approved", proposalId, option: option.id, approvalKey: option.approvalKey });
        if (!a.appended) throw new ServiceError(409, "conflict", "That proposal was already approved.");
        let last = a.projection;
        if (action.kind === "extend_deadline") last = commit(store, now, { type: "deadline_extended", newDeadline: action.newDeadline }).projection;
        if (action.kind === "lower_threshold") last = commit(store, now, { type: "threshold_lowered", newThreshold: action.newThreshold }).projection;
        if (action.kind === "send_payouts") {
          const key = `payout:${m.showId}`;
          if (store.job(key)?.status === "blocked") store.updateJob(key, { status: "pending", nextAt: now });
        }
        return last;
      });
    } catch (e) {
      if (e instanceof IllegalTransition) throw new ServiceError(409, "conflict", "That change can't be applied any more.");
      throw e;
    }
    this.log({ saw, did: `The artist approved "${option.label}". ${decision.reason}`, rule: decision.rule });
    if (p.campaign.state === "live" && after.campaign.state === "tipped") this.log({ saw: sawCounts(after), did: "The lower target is already met. Charging every hold now.", rule: "rule-2-capture-at-tip" });
    return { proposalId, option: option.id, rule: decision.rule, show: this.publicView(after) };
  }

  /** The artist says "not now". Nothing changes; the agent log records it (the page also hides the card). */
  declineProposal(proposalId: string): DeclineResponse {
    const p = this.applyDeadline();
    this.requireMandate(p);
    const proposal = typeof proposalId === "string" ? p.proposals.get(proposalId) : undefined;
    if (!proposal) throw new ServiceError(404, "not_found", "There's no such proposal.");
    if (proposal.approved) throw new ServiceError(409, "conflict", "That proposal was already approved.");
    this.log({ saw: sawCounts(p), did: `You said not now to ${proposal.options.map((o) => `"${o.label}"`).join(" or ")}. Nothing changes.`, rule: null });
    return { proposalId, show: this.publicView(p) };
  }

  /** Spec 3.7: only a tipped show can be called off. Open holds are voided, every charge refunded. */
  async callOff(): Promise<CallOffResponse> {
    const p = this.applyDeadline();
    this.requireMandate(p);
    if (p.campaign.state !== "tipped") {
      throw new ServiceError(409, "conflict", p.campaign.state === "live" ? "A show that hasn't reached its target can't be called off; if it misses, every hold is cancelled at the deadline." : "This show can no longer be called off.");
    }
    const saw = sawCounts(p);
    const r = commit(this.deps.store, this.now(), { type: "show_cancelled" });
    this.log({ saw, did: "The artist called the show off. Cancelling open holds and refunding every charge.", rule: "rule-5-ask-first" });
    return { show: this.publicView(r.projection) };
  }

  /**
   * Records a verified PayPal webhook once. It never changes counts or money: a webhook's capture amount is GROSS,
   * so collected money only ever comes from the net of a capture response we fetched ourselves. Webhooks only ask for a GET check.
   */
  async ingestWebhook(e: PayPalLedgerEvent): Promise<{ recorded: boolean }> {
    const store = this.deps.store;
    if (typeof e?.eventId !== "string" || e.eventId.length === 0 || e.eventId.length > 128) return { recorded: false };
    const p = this.applyDeadline();
    const now = this.now();
    const r = commit(store, now, { type: "webhook_received", eventId: e.eventId, kind: e.kind, ref: String(e.ref).slice(0, 128), amountCents: e.amountCents ?? null, customId: typeof e.customId === "string" ? e.customId.slice(0, 200) : null });
    if (!r.appended) return { recorded: false };
    const safeRef = SAFE_REF.test(e.ref);
    let did = "Recorded it. Amounts only come from PayPal answers we fetch ourselves.";
    switch (e.kind) {
      case "charged":
      case "charge_failed":
      case "hold_voided": {
        const auth = this.authForWebhook(p, e);
        if (auth) {
          requestReconcile(store, auth, now, `PayPal sent ${e.kind}`);
          did = "Checking that hold with PayPal before counting anything.";
        }
        break;
      }
      case "payout_batch_done":
      case "payout_batch_failed": {
        const payout = e.customId ? p.payouts.find((x) => x.senderBatchId === e.customId) : undefined;
        if (payout && safeRef && (payout.batchId === null || payout.batchId === e.ref)) {
          // A duplicate-recovered batch has no batch id yet: this webhook (customId = sender_batch_id) supplies it.
          if (payout.batchId === null) commit(store, now, { type: "payout_batch_seen", senderBatchId: payout.senderBatchId, batchId: e.ref });
          store.putJob({ key: `poll:${e.ref}:hook-${e.eventId}`, kind: "payout_poll", target: e.ref, nextAt: now, note: "1" }, now);
          did = "Checking the payout batch with PayPal.";
        }
        break;
      }
      case "payout_item_paid":
      case "payout_item_failed":
      case "payout_item_pending": {
        const retry = e.customId?.endsWith("-r1") ?? false;
        const batchId = p.payouts.find((x) => x.retry === retry)?.batchId;
        if (batchId) {
          store.putJob({ key: `poll:${batchId}:hook-${e.eventId}`, kind: "payout_poll", target: batchId, nextAt: now, note: "1" }, now);
          did = e.kind === "payout_item_pending" ? "A payout is waiting (the person may need to claim it). Checking the payout batch with PayPal." : "Checking the payout batch with PayPal.";
        }
        break;
      }
      case "charge_reversed":
        did = "Needs attention: PayPal reversed a charge (a chargeback). Nothing was changed automatically.";
        break;
      default:
        break;
    }
    this.log({ saw: `PayPal sent a notice (${e.kind}).`, did, rule: null, resultId: safeRef ? e.ref : null });
    return { recorded: true };
  }

  /** A PayPal event of a type we know came through verification but could not be read. Say so; never act on it. */
  noteUnreadableWebhook(eventType: unknown): { recorded: boolean } {
    if (!isKnownEventType(eventType)) return { recorded: false };
    const type = eventType as string;
    const about = type.startsWith("PAYMENT.AUTHORIZATION") ? "a hold" : type.startsWith("PAYMENT.CAPTURE") ? "a charge" : type.startsWith("PAYMENT.PAYOUTSBATCH") ? "a payout batch" : "a payout";
    this.log({ saw: `PayPal sent a notice about ${about} that we couldn't read.`, did: "Ignored it. Nothing was changed.", rule: null, resultId: type });
    return { recorded: true };
  }

  private authForWebhook(p: Projection, e: PayPalLedgerEvent): string | null {
    if (p.pledgeByAuth.has(e.ref) || p.retired.has(e.ref)) return e.ref;
    const pid = e.customId ? pledgeIdFromCustomId(e.customId) : null;
    if (!pid) return null;
    const pledge: PledgeView | undefined = p.pledges.get(pid) ?? [...p.pledges.values()].find((x) => x.paypalPledgeId === pid);
    return pledge && pledge.status === "held" ? pledge.authorizationId : null;
  }

  /** Notes run once, after every money job is done and every payout check has finished. */
  private notesDue(p: Projection): boolean {
    if (!p.mandate || p.notes) return false;
    const s = p.campaign.state;
    if (s !== "settled" && s !== "missed" && s !== "cancelled") return false;
    if (p.campaign.pledges.held > 0) return false;
    if (s === "cancelled" && p.campaign.pledges.charged > 0) return false;
    return !this.deps.store.hasPending([...MONEY_JOBS, "payout_poll"]);
  }

  private async writeNotes(p: Projection): Promise<void> {
    const m = this.requireMandate(p);
    const s = p.campaign.state;
    const outcome = s === "settled" ? "paid" : s === "missed" ? "called_off" : "refunded";
    const first = p.payouts.find((x) => !x.retry);
    const fans = s === "settled" ? p.campaign.pledges.charged : s === "missed" ? p.campaign.pledges.released : p.campaign.pledges.refunded;
    const saw = sawCounts(p);
    const notes: SettlementNote[] = [];
    for (const party of m.parties) {
      const amountCents = outcome === "paid" ? (first?.lines.find((l) => l.role === party.role)?.amount ?? 0) : 0;
      const state = outcome === "paid" ? payoutStateOf(p, m.showId, party.role) : "none";
      if (outcome === "paid" && (state === "pending" || state === "failed")) {
        // Never say "paid" before PayPal has confirmed it.
        const text = state === "failed" ? `${party.label}'s payout of ${formatUSD(amountCents)} didn't go through, so it is not counted as paid. Check the PayPal email.` : `${party.label}'s payout of ${formatUSD(amountCents)} is still waiting on PayPal.`;
        notes.push({ role: party.role, label: party.label, text, source: "template" });
        continue;
      }
      if (outcome === "paid" && amountCents === 0) {
        notes.push({ role: party.role, label: party.label, text: `${m.showName} happened, but no money was left for ${party.label} under the money rules the artist signed.`, source: "template" });
        continue;
      }
      const facts = { role: party.role, label: party.label, showName: m.showName, outcome, amountCents, fans, ticketPriceCents: m.ticketPrice } as const;
      const r = await settlementNote(this.modelDeps(), facts);
      notes.push({ role: party.role, label: party.label, text: r.value, source: r.source });
    }
    const { appended } = commit(this.deps.store, this.now(), { type: "notes_written", notes });
    if (appended) this.log({ saw, did: `Wrote a plain-English settlement note for each of the ${notes.length} people involved.`, rule: null, source: notes.some((n) => n.source === "model") ? "model" : (notes[0]?.source ?? "template") });
  }

  private expiresAt(): number | null {
    const v = this.deps.store.getMeta("expires_at");
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private pastExpiry(): boolean {
    const at = this.expiresAt();
    return at !== null && this.deps.clock.now() >= at;
  }

  /** A judge's private demo show: signed at once with fictional rules, starting fans queued as real sandbox holds. */
  async initDemo(input: { showId: string; seed: DemoSeed; demoKeyHash: string }): Promise<PublicShow> {
    const store = this.deps.store;
    if (store.getMeta("show_id")) throw new ServiceError(409, "conflict", "That demo show already exists.");
    const real = this.deps.clock.now();
    const launchedAt = new Date(real).toISOString();
    const deadline = real + input.seed.windowMs;
    const mandate = buildMandate({ ...input.seed.draft, showId: input.showId, launchedAt, deadline: new Date(deadline).toISOString(), showDate: new Date(deadline + 3 * DAY_MS).toISOString().slice(0, 10) });
    const signed = await signMandate(mandate, launchedAt);
    // No awaits from here on: the check and the writes happen together.
    if (store.getMeta("show_id")) throw new ServiceError(409, "conflict", "That demo show already exists.");
    store.transaction(() => {
      store.setMeta("show_id", input.showId);
      store.setMeta("kind", "demo");
      store.setMeta("manage_key_hash", input.demoKeyHash);
      store.setMeta("created_at", String(real));
      store.setMeta("expires_at", String(real + DEMO_TTL_MS));
      commit(store, real, { type: "mandate_signed", mandate: signed.mandate, hash: signed.hash, signedAt: signed.signedAt });
    });
    this.log({ saw: "A judge opened the demo.", did: `Seeded ${mandate.showName}: ${mandate.threshold} fans needed. Simulated fans are real sandbox card holds; nobody is charged unless the show tips.`, rule: null, resultId: signed.hash.slice(0, 12) });
    this.queueSimHolds(input.seed.startFans);
    return this.publicView();
  }

  private requireDemo(): void {
    if (this.kind() !== "demo") throw new ServiceError(404, "not_found", "Simulated fans and demo controls exist only in the demo.");
  }

  /** Simulated fans ever queued for this show (any outcome). Retries (-r1) are the same fan. This is the hard cap's counter. */
  private simsUsed(): number {
    return this.deps.store.jobs().filter((j) => j.kind === "sim_hold" && !j.target.endsWith("-r1")).length;
  }

  private pendingSims(): number {
    return this.deps.store.jobs().filter((j) => j.kind === "sim_hold" && j.status === "pending").length;
  }

  /** Queues `count` simulated fans as jobs (one real PayPal hold each, run a few per turn by the alarm). Never past SIM_CAP_PER_SHOW. */
  private queueSimHolds(count: number): number {
    const store = this.deps.store;
    const now = this.now();
    const used = this.simsUsed();
    const n = Math.max(0, Math.min(count, SIM_CAP_PER_SHOW - used));
    const base = this.project().pledges.size + this.pendingSims();
    for (let i = 0; i < n; i++) {
      const pledgeId = newId("p", this.deps.random);
      store.putJob({ key: `sim:${pledgeId}`, kind: "sim_hold", target: pledgeId, nextAt: now, note: SIM_INITIALS[(base + i) % SIM_INITIALS.length] }, now);
    }
    return n;
  }

  addSimFans(count: unknown): DemoFansResponse {
    this.requireDemo();
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > SIM_ADD_MAX) throw new ServiceError(422, "invalid", `Add between 1 and ${SIM_ADD_MAX} fans at a time.`);
    const p = this.applyDeadline();
    if (p.campaign.state !== "live" && p.campaign.state !== "tipped") throw new ServiceError(409, "conflict", "Pledging has closed for this show.");
    if (this.simsUsed() + count > SIM_CAP_PER_SHOW) throw new ServiceError(409, "conflict", `This demo show can take at most ${SIM_CAP_PER_SHOW} simulated fans.`);
    const queued = this.queueSimHolds(count);
    return { queued, show: this.publicView(p) };
  }

  /**
   * topUp (show A): queue simulated holds until the show has its target plus DEMO_TOP_UP_EXTRA fans (the sandbox fee would
   * otherwise leave it a few cents short), and jump once they are seated. Otherwise jump now (show B).
   */
  fastForward(topUp: boolean): PublicShow {
    this.requireDemo();
    const p = this.applyDeadline();
    const c = p.campaign;
    if (c.state !== "live" && c.state !== "tipped") return this.publicView(p);
    if (topUp) {
      const need = c.threshold + DEMO_TOP_UP_EXTRA - fansCommitted(c) - this.pendingSims();
      if (need > 0) this.queueSimHolds(need);
      this.deps.store.setMeta("ff_pending", "1");
      return this.publicView(p);
    }
    this.jumpToDeadline();
    return this.publicView();
  }

  /** Demo only ("Check pace now"): move the demo clock to DEMO_PACE_POINT of the window, then run the pace check that is due. */
  async checkPaceNow(): Promise<PublicShow> {
    this.requireDemo();
    const store = this.deps.store;
    this.deps.paypal.meter.reset();
    const p = this.applyDeadline();
    const m = this.requireMandate(p);
    const c = p.campaign;
    if (c.state !== "live") return this.publicView(p);
    const launched = Date.parse(m.launchedAt);
    const at = launched + Math.floor((c.deadline - launched) * DEMO_PACE_POINT);
    const offset = at - this.deps.clock.now();
    if (offset > this.clockOffset()) {
      store.setMeta("clock_offset", String(offset));
      this.log({ saw: sawCounts(p), did: "Demo: skipped ahead to three quarters of the way to the deadline for a pace check.", rule: null });
    }
    const due = duePaceCheck(m, c, p.paceChecks, this.now());
    for (const n of due.mark) commit(store, this.now(), { type: "pace_checked", check: n });
    if (due.run !== null) await this.runPaceCheck(due.run);
    else this.log({ saw: sawCounts(this.project()), did: "The pace was already checked. Nothing new to propose.", rule: null });
    return this.publicView(this.applyDeadline());
  }

  /** Reset: jump the old copy to its deadline (open holds are voided) and let it delete itself within an hour. */
  retire(): { retired: true } {
    this.requireDemo();
    this.jumpToDeadline();
    const real = this.deps.clock.now();
    const current = this.expiresAt();
    this.deps.store.setMeta("expires_at", String(Math.min(current ?? real, real + DEMO_GRACE_MS)));
    return { retired: true };
  }

  /** Demo only: move the campaign clock just past the deadline, then apply it. Does nothing once the show is over. */
  private jumpToDeadline(): void {
    const store = this.deps.store;
    store.deleteMeta("ff_pending");
    const p = this.project();
    if (!p.mandate || (p.campaign.state !== "live" && p.campaign.state !== "tipped")) return;
    const saw = sawCounts(p);
    const offset = p.campaign.deadline + 1000 - this.deps.clock.now();
    if (offset > this.clockOffset()) store.setMeta("clock_offset", String(offset));
    this.log({ saw, did: "Demo: skipped ahead to the deadline.", rule: null });
    this.applyDeadline();
  }

  /** Queues a re-hold for every seated simulated fan (one per current hold; the job moves itself to the due time). */
  private planReholds(p: Projection): void {
    if (p.campaign.state !== "live") return;
    const now = this.now();
    for (const x of p.pledges.values()) {
      if (x.simulated && x.status === "held") this.deps.store.putJob({ key: `rehold:${x.authorizationId}`, kind: "rehold", target: x.pledgeId, nextAt: x.expiresAt - REHOLD_MARGIN_MS }, now);
    }
  }

  /**
   * True when a demo copy is past its expiry, has no money step pending, and no live sandbox hold is left (the adapter then
   * deletes the storage). A hold is live while it is held (or its charge failed) and not past its own expiry, or while a
   * retired or replaced hold has no confirmed void and has not lapsed. Until then the alarm is re-armed with a doubling wait
   * (1 h up to 24 h) and void jobs are re-opened each time. The waiting is bounded: DEMO_GRACE_TOTAL_MAX_MS after the first
   * expiry the copy is deleted anyway, with a final log line (sandbox holds lapse by themselves).
   */
  private checkExpiry(): boolean {
    const store = this.deps.store;
    if (!this.pastExpiry()) return false;
    this.jumpToDeadline();
    const p = this.project();
    const live = this.liveHolds(p);
    const busy = store.hasPending(MONEY_JOBS);
    if (live.length === 0 && !busy) return true;
    const now = this.deps.clock.now();
    const firstAt = Number(store.getMeta("expiry_first_at") ?? String(now));
    if (now - firstAt >= DEMO_GRACE_TOTAL_MAX_MS) {
      this.log({ saw: sawCounts(p), did: "This demo copy is being removed. Any hold still open at PayPal lapses on its own; nobody is charged.", rule: null });
      return true;
    }
    store.setMeta("expiry_first_at", String(firstAt));
    for (const { auth, voidable } of live) {
      if (!voidable) continue;
      const key = `void:${auth}`;
      const j = store.job(key);
      if (!j) queueVoid(store, auth, now);
      else if (j.status === "failed") store.updateJob(key, { status: "pending", attempts: 0, nextAt: now });
    }
    const graces = Number(store.getMeta("expiry_graces") ?? "0");
    store.setMeta("expires_at", String(now + demoGraceMs(graces)));
    store.setMeta("expiry_graces", String(graces + 1));
    return false;
  }

  /** Holds that may still be open at PayPal and that nothing has closed yet. `voidable` holds are safe to release now. */
  private liveHolds(p: Projection): { auth: string; voidable: boolean }[] {
    const now = this.deps.clock.now();
    const s = p.campaign.state;
    // Only a show that is ending may release a held pledge; a charge still in progress is left to its own jobs.
    const ending = s === "missed" || s === "cancelled";
    const over = ending || s === "settled";
    const out: { auth: string; voidable: boolean }[] = [];
    for (const x of p.pledges.values()) {
      if (x.expiresAt <= now) continue;
      if (x.status === "held") out.push({ auth: x.authorizationId, voidable: ending });
      else if (x.status === "capture_failed" && !x.holdClosed) out.push({ auth: x.authorizationId, voidable: over });
    }
    for (const r of p.retired.values()) if (!r.voided && r.expiresAt > now) out.push({ auth: r.authorizationId, voidable: true });
    return out;
  }

  /** When the Durable Object alarm should next fire, in REAL time; null when nothing is left to do. */
  nextWakeAt(): number | null {
    if (!this.exists()) return null;
    const p = this.project();
    const now = this.now();
    const c = p.campaign;
    const times: number[] = [];
    if (p.mandate && (c.state === "live" || c.state === "tipped")) times.push(c.deadline);
    if (p.mandate && c.state === "live") {
      const [half, late] = paceCheckTimes(p.mandate, c);
      if (!p.paceChecks.has(1)) times.push(half);
      if (late !== null && !p.paceChecks.has(2)) times.push(late);
    }
    const job = this.deps.store.nextJobAt();
    if (job !== undefined) times.push(job);
    if (this.notesDue(p)) times.push(now);
    times.push(...this.unflaggedPayoutWakes(p));
    times.push(...sweepWakes(this.deps.store, p, now));
    if (this.leftoverVoids(p).length > 0) times.push(now);
    const lapse = this.expiresAt();
    // Expiry is stored in REAL time; `times` are campaign time (the final subtraction undoes the offset).
    if (lapse !== null && (!p.mandate || this.kind() === "demo")) times.push(lapse + this.clockOffset());
    if (this.kind() === "demo" && this.deps.store.getMeta("ff_pending") && !this.deps.store.hasPending(["sim_hold"])) times.push(now);
    if (times.length === 0) return null;
    return Math.max(Math.min(...times), now) - this.clockOffset();
  }
}

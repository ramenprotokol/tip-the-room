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
import type { ApproveRequest, ApproveResponse, AuthorizeResponse, CallOffResponse, CreateOrderRequest, CreateOrderResponse, ManageView, PublicShow, SignRequest, SignResponse } from "../worker/api-types";
import type { AiDeps } from "./ai";
import { paceNote, settlementNote, type PaceFacts } from "./ai-jobs";
import { toMandateDraft } from "./draft";
import { ServiceError } from "./errors";
import type { ProposalOption, SettlementNote } from "./events";
import { commit, drain, logStep, queueVoid, requestReconcile, type ExecDeps } from "./executor";
import { customIdFor, newId, newSecret, pledgeIdFromCustomId, sameHex, sha256Hex, type Clock, type Random } from "./ids";
import { duePaceCheck, paceCheckTimes, paceNumbers, paceOptions } from "./pace";
import type { PayPalPort } from "./paypal-port";
import { MAX_JOBS_PER_TURN, MAX_ORDERS_PER_SHOW, MODEL_CALL_COST, MONEY_JOBS, TURN_CALL_BUDGET } from "./policy";
import type { OrderView, PledgeView, Projection } from "./project";
import { RUNNERS } from "./runners";
import type { Store } from "./store";
import { attentionLines, ledgerRows, logRows, manageParties, payoutStateOf, proposalRows, publicShow, reversalLines } from "./views";
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
    // One transaction: if the signing event can't be written, the sign token survives and the artist can try again.
    const { projection } = store.transaction(() => {
      store.setMeta("manage_key_hash", keyHash);
      store.deleteMeta("sign_token_hash");
      return commit(store, now, { type: "mandate_signed", mandate: signed.mandate, hash: signed.hash, signedAt: signed.signedAt });
    });
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
        throw new ServiceError(502, "paypal_error", "PayPal's answer wasn't clear. Nothing was charged and any hold is being cancelled; please try again.");
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
      attention: [...attentionLines(this.deps.store.jobs()), ...reversalLines(this.deps.store.events())],
      collectedNetCents: p.collectedNet,
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

  /** One alarm turn: deadline first, then a due pace check, then due money jobs, then notes. */
  async tick(): Promise<{ expired: boolean }> {
    if (!this.exists()) return { expired: false };
    // One meter for the whole turn: pace-check and note model calls share it with the PayPal jobs.
    this.deps.paypal.meter.reset();
    let p = this.applyDeadline();
    if (p.mandate) {
      const due = duePaceCheck(p.mandate, p.campaign, p.paceChecks, this.now());
      for (const n of due.mark) commit(this.deps.store, this.now(), { type: "pace_checked", check: n });
      if (due.run !== null) await this.runPaceCheck(due.run);
    }
    await drain(this.exec(), RUNNERS, MAX_JOBS_PER_TURN, false);
    p = this.applyDeadline();
    if (this.notesDue(p)) await this.writeNotes(p);
    return { expired: false };
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
    if (JSON.stringify(again) !== JSON.stringify(options)) return; // things changed while the model wrote: check again next turn
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
    if (times.length === 0) return null;
    return Math.max(Math.min(...times), now) - this.clockOffset();
  }
}

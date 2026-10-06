import { formatUSD } from "../core/money";
import type { RuleId } from "../core/rules";
import { PayPalError } from "../paypal/errors";
import { requestIds, type Charge, type OrderPayments, type Refund } from "../paypal/payments";
import { eventKey } from "./events";
import { commit, decide, done, fail, logStep, requestReconcile, retryLater, skip, type ExecDeps, type Runner, type Runners } from "./executor";
import { backoffMs, MAX_JOB_ATTEMPTS, RECHECK_MS } from "./policy";
import type { PledgeView, Projection } from "./project";
import { errText, fanName, sawCounts } from "./words";

const FAILED_CAPTURE = new Set(["DECLINED", "FAILED"]);
const GONE_AUTH = new Set(["VOIDED", "EXPIRED", "DENIED"]);
const RETIRED_WORDS = { late: "it arrived after pledging closed", rejected: "PayPal held the wrong thing", replaced: "a fresh hold replaced it" } as const;

/** A capture counts only when PayPal says COMPLETED and gives both gross and net. Undefined net is never 0. */
export function isCountable(c: Charge): boolean {
  return c.status === "COMPLETED" && Number.isInteger(c.netCents) && Number.isInteger(c.grossCents);
}

function pledgeByAuth(p: Projection, authorizationId: string): PledgeView | undefined {
  const id = p.pledgeByAuth.get(authorizationId);
  return id ? p.pledges.get(id) : undefined;
}

/**
 * Records a capture PayPal has finished (COMPLETED with gross and net). Returns false, recording nothing, otherwise.
 * It never records a failure: capture_failed shares its key with capture_ok, so failures go through failAfterCheck.
 */
export function recordCharge(d: ExecDeps, p: Projection, pledge: PledgeView, charge: Charge): boolean {
  if (!isCountable(charge)) return false;
  const gross = charge.grossCents as number;
  const net = charge.netCents as number;
  const fee = charge.feeCents ?? gross - net;
  const saw = sawCounts(p);
  const res = commit(d.store, d.clock.now(), { type: "capture_ok", authorizationId: pledge.authorizationId, captureId: charge.captureId, grossCents: gross, feeCents: fee, netCents: net });
  if (!res.appended) {
    // The same capture already recorded (a reconcile and a capture raced, or a lease ran out): nothing to say.
    const key = eventKey({ type: "capture_ok", authorizationId: pledge.authorizationId, captureId: charge.captureId, grossCents: gross, feeCents: fee, netCents: net });
    const existing = d.store.events().find((s) => s.key === key)?.event;
    if (existing && existing.type === "capture_ok" && existing.captureId === charge.captureId) return true;
    // The key was used by something else (e.g. an earlier failure record). Never double-write; tell the artist.
    logStep(d, { saw, did: `Needs attention: ${fanName(pledge)}'s charge went through at PayPal, but this show's record already says otherwise.`, rule: "rule-2-capture-at-tip", requestId: requestIds.capture(pledge.authorizationId), resultId: charge.captureId });
    return true;
  }
  logStep(d, { saw, did: `Charged ${fanName(pledge)} ${formatUSD(gross)}. After PayPal's fee, ${formatUSD(net)} came in.`, rule: "rule-2-capture-at-tip", requestId: requestIds.capture(pledge.authorizationId), resultId: charge.captureId });
  if (gross - fee !== net) {
    logStep(d, { saw: `PayPal said gross ${formatUSD(gross)}, fee ${formatUSD(fee)}, net ${formatUSD(net)}.`, did: "Those numbers don't add up, so only the net amount is counted.", rule: "rule-4-pay-the-split", resultId: charge.captureId });
  }
  return true;
}

/** Writes capture_failed. Only call right after a fresh order check showed no live capture. */
function writeCaptureFailed(d: ExecDeps, p: Projection, pledge: PledgeView, reason: string, saw: string, did: string, resultId: string | null): void {
  commit(d.store, d.clock.now(), { type: "capture_failed", authorizationId: pledge.authorizationId, reason });
  logStep(d, { saw: saw || sawCounts(p), did, rule: "rule-2-capture-at-tip", requestId: requestIds.capture(pledge.authorizationId), resultId });
}

type Check = "recorded" | "not_captured" | "unclear";

/** Looks at the order: a live (not declined) capture is read and recorded if final. */
async function checkOrderForCapture(d: ExecDeps, p: Projection, pledge: PledgeView): Promise<Check> {
  const order = await d.paypal.getOrderPayments(pledge.orderId);
  const live = order.captures.find((c) => !FAILED_CAPTURE.has(c.status));
  if (!live) return "not_captured";
  const charge = await d.paypal.getCapture(live.id, pledge.authorizationId);
  return recordCharge(d, p, pledge, charge) ? "recorded" : "unclear";
}

/** A declined/failed capture answer: confirm with PayPal that nothing was captured BEFORE writing a failure. */
async function failAfterCheck(d: ExecDeps, p: Projection, pledge: PledgeView, charge: Charge): Promise<Check> {
  const result = await checkOrderForCapture(d, p, pledge);
  if (result === "not_captured") {
    writeCaptureFailed(d, p, pledge, "PayPal declined the charge", sawCounts(p), `${fanName(pledge)}'s charge didn't go through. Their money was never taken.`, charge.captureId);
  }
  return result;
}

const runCapture: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const pledge = pledgeByAuth(p, job.target);
  if (!pledge) {
    // Never capture a hold the ledger can't record. If a fresh hold replaced this one, charge that instead.
    const retired = p.retired.get(job.target);
    if (!retired) return fail(d, job, "This hold isn't part of this show.", "a charge was asked for a hold this show doesn't know, so it was left alone.");
    const current = retired.why === "replaced" ? p.pledges.get(retired.pledgeId) : undefined;
    if (current && current.status === "held") {
      d.store.putJob({ key: `capture:${current.authorizationId}`, kind: "capture", target: current.authorizationId, nextAt: d.clock.now() }, d.clock.now());
      d.store.updateJob(job.key, { status: "skipped", note: "That hold was replaced; the fresh hold is charged instead." });
      logStep(d, { saw: sawCounts(p), did: `${fanName(current)}'s old hold was replaced, so the fresh hold will be charged instead.`, rule: "rule-2-capture-at-tip" });
      return;
    }
    d.store.updateJob(job.key, { status: "skipped", note: `That hold is not counted (${RETIRED_WORDS[retired.why]}).` });
    logStep(d, { saw: sawCounts(p), did: `Did not charge an extra hold that was never counted (${RETIRED_WORDS[retired.why]}).`, rule: "rule-1-hold-only" });
    return;
  }
  if (pledge.status !== "held") return done(d, job, "Already settled.");
  const decision = decide(p, { kind: "capture_all_held" });
  if (!decision.allowed) return skip(d, job, p, decision, `Did not charge ${fanName(pledge)}.`);
  let charge: Charge;
  try {
    if (attempt > 1) {
      const seen = await checkOrderForCapture(d, p, pledge);
      if (seen === "recorded") return done(d, job, "Found the charge at PayPal.");
      if (seen === "unclear") {
        // A live capture exists but isn't final: never send the capture again, look again shortly.
        done(d, job, "A charge is in progress at PayPal. Checking again shortly.");
        return requestReconcile(d.store, pledge.authorizationId, d.clock.now() + RECHECK_MS, "capture in progress");
      }
    }
    charge = await d.paypal.captureHold(pledge.authorizationId);
  } catch (e) {
    if (e instanceof PayPalError && e.retryable) return retryLater(d, job, attempt, errText(e));
    done(d, job, `PayPal gave no usable answer (${errText(e)}). Checking the order with PayPal.`);
    return requestReconcile(d.store, pledge.authorizationId, d.clock.now(), "capture answer unusable");
  }
  if (recordCharge(d, p, pledge, charge)) return done(d, job, `PayPal answered ${charge.status}.`);
  if (FAILED_CAPTURE.has(charge.status)) {
    try {
      const result = await failAfterCheck(d, p, pledge, charge);
      if (result !== "unclear") return done(d, job, result === "recorded" ? "Found the charge at PayPal." : "Charge declined.");
    } catch (e) {
      done(d, job, `Couldn't confirm the decline (${errText(e)}). Checking again shortly.`);
      return requestReconcile(d.store, pledge.authorizationId, d.clock.now() + RECHECK_MS, "decline unconfirmed");
    }
  }
  done(d, job, `PayPal answered ${charge.status} without final amounts. Checking again shortly.`);
  requestReconcile(d.store, pledge.authorizationId, d.clock.now() + RECHECK_MS, `capture ${charge.status}`);
};

const runVoid: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const auth = job.target;
  const pledge = pledgeByAuth(p, auth);
  const retired = p.retired.get(auth);
  let rule: RuleId = "rule-1-hold-only";
  let who: string;
  if (pledge) {
    const over = p.campaign.state === "missed" || p.campaign.state === "cancelled" || p.campaign.state === "settled";
    if (pledge.status === "capture_failed" && over && !pledge.holdClosed) {
      // The charge failed but the hold may still be open at PayPal. Once the show is over nothing can use it: release it.
      who = `${fanName(pledge)}'s leftover hold`;
    } else if (pledge.status !== "held") {
      return done(d, job, "Already settled.");
    } else {
    const decision = decide(p, { kind: "void_all_held" });
    if (!decision.allowed) return skip(d, job, p, decision, `Did not cancel ${fanName(pledge)}'s hold.`);
    rule = decision.rule;
    who = `${fanName(pledge)}'s hold`;
    }
  } else if (retired) {
    if (retired.voided) return done(d, job, "Already cancelled.");
    // A hold that was never counted (or no longer is) is only ever released: rule 1, nobody is charged.
    who = `an extra hold that was never counted (${RETIRED_WORDS[retired.why]})`;
  } else {
    return fail(d, job, "This hold isn't part of this show.", "a hold-release was asked for a hold this show doesn't know, so it was left alone.");
  }
  try {
    await d.paypal.voidHold(auth);
  } catch (e) {
    if (e instanceof PayPalError && e.retryable) return retryLater(d, job, attempt, errText(e));
    done(d, job, `PayPal refused (${errText(e)}). Checking the hold with PayPal.`);
    return requestReconcile(d.store, auth, d.clock.now(), "void refused");
  }
  commit(d.store, d.clock.now(), { type: "void_ok", authorizationId: auth });
  logStep(d, { saw: sawCounts(p), did: `Cancelled ${who}. Nobody was charged.`, rule, requestId: requestIds.void(auth), resultId: auth });
  done(d, job, "Cancelled.");
};

/** The refund id PayPal gave when it first answered PENDING, if we recorded one. */
function pendingRefundId(d: ExecDeps, captureId: string): string | null {
  const e = d.store.events().find((s) => s.key === `refund:${captureId}:PENDING`);
  return e && e.event.type === "refund_ok" ? e.event.refundId : null;
}

const runRefund: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const captureId = job.target;
  const pledgeId = p.pledgeByCapture.get(captureId);
  const pledge = pledgeId ? p.pledges.get(pledgeId) : undefined;
  if (!pledge) return fail(d, job, "That charge isn't part of this show.", "a refund was asked for a charge this show doesn't know, so it was left alone.");
  if (pledge.status !== "charged") return done(d, job, "Already settled.");
  const decision = decide(p, { kind: "refund_all_charged" });
  if (!decision.allowed) return skip(d, job, p, decision, `Did not refund ${fanName(pledge)}.`);

  const finish = (refundId: string | null) => {
    commit(d.store, d.clock.now(), { type: "refund_ok", captureId, refundId, status: "COMPLETED" });
    logStep(d, { saw: sawCounts(p), did: `Refunded ${fanName(pledge)} ${formatUSD(pledge.grossCents ?? pledge.amountCents)}. PayPal keeps its fee on refunds.`, rule: decision.rule, requestId: requestIds.refund(captureId), resultId: refundId });
  };
  /** Only PayPal's own capture record can say the refund finished (status REFUNDED). */
  const refundFinished = async (): Promise<boolean> => (await d.paypal.getCapture(captureId, pledge.authorizationId)).status === "REFUNDED";

  // A PENDING refund was recorded earlier: look at the capture, never re-send (the same request id may replay).
  if (d.store.hasEvent(`refund:${captureId}:PENDING`)) {
    try {
      if (await refundFinished()) {
        finish(pendingRefundId(d, captureId));
        return done(d, job, "Refund completed.");
      }
    } catch (e) {
      return retryLater(d, job, attempt, errText(e));
    }
    return retryLater(d, job, attempt, "The refund is still pending at PayPal.");
  }

  let refund: Refund;
  try {
    refund = await d.paypal.refundCharge(captureId);
  } catch (e) {
    if (e instanceof PayPalError && e.hasIssue("CAPTURE_FULLY_REFUNDED")) {
      try {
        if (await refundFinished()) {
          finish(null);
          return done(d, job, "Already refunded.");
        }
      } catch (e2) {
        return retryLater(d, job, attempt, errText(e2));
      }
      return retryLater(d, job, attempt, "PayPal says fully refunded, but the charge doesn't show it yet.");
    }
    // A refusal retrying cannot fix fails fast. Network/5xx/429 and unusable answers (maybe already refunded) retry.
    if (e instanceof PayPalError && !e.retryable && e.paypalName !== "EMPTY_RESPONSE_BODY") {
      return fail(d, job, `PayPal refused the refund (${errText(e)}).`, `PayPal couldn't finish ${fanName(pledge)}'s refund. It was not retried; it needs a look.`);
    }
    return retryLater(d, job, attempt, errText(e));
  }
  if (refund.status === "COMPLETED") {
    finish(refund.refundId);
    return done(d, job, "Refund COMPLETED.");
  }
  if (refund.status === "PENDING") {
    // Recorded without counting; the job stays open and checks the capture later.
    commit(d.store, d.clock.now(), { type: "refund_ok", captureId, refundId: refund.refundId, status: "PENDING" });
    logStep(d, { saw: sawCounts(p), did: `${fanName(pledge)}'s refund is on its way; PayPal hasn't finished it yet.`, rule: decision.rule, requestId: requestIds.refund(captureId), resultId: refund.refundId });
    return retryLater(d, job, attempt, "The refund is pending at PayPal.");
  }
  // FAILED, CANCELLED or anything else: do not re-send with the same request id (it may replay the failure).
  fail(d, job, `PayPal answered ${refund.status} for the refund.`, `PayPal couldn't finish ${fanName(pledge)}'s refund. It was not retried; it needs a look.`);
};

/** GET-based truth: what happened to this authorization at PayPal. Records success for "already captured/voided". */
const runReconcile: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const auth = job.target;
  const pledge = pledgeByAuth(p, auth);
  const retired = p.retired.get(auth);
  if (pledge && pledge.status !== "held") return done(d, job, "Already settled.");
  if (!pledge && (!retired || retired.voided)) return done(d, job, "Nothing left to check.");
  const orderId = pledge?.orderId ?? retired?.orderId ?? null;
  if (!orderId) return fail(d, job, "There is no PayPal order to check for this hold.", "a hold couldn't be checked because it has no PayPal order.");
  let order: OrderPayments;
  try {
    order = await d.paypal.getOrderPayments(orderId);
  } catch (e) {
    return retryLater(d, job, attempt, errText(e));
  }
  const closing = p.campaign.state === "missed" || p.campaign.state === "cancelled";
  // The reducer accepts capture_failed only in these states (src/core/campaign.ts); elsewhere it would throw.
  const canFail = p.campaign.state === "tipped" || p.campaign.state === "paying_out";
  const cannotRecord = () => fail(d, job, `The hold is ${status}, but a failed charge can't be recorded while the show is ${p.campaign.state}.`, "a hold's state at PayPal doesn't match this show, so it needs a look.");
  const capture = order.captures.find((c) => !FAILED_CAPTURE.has(c.status));
  if (pledge && capture) {
    let charge: Charge;
    try {
      charge = await d.paypal.getCapture(capture.id, auth);
    } catch (e) {
      return retryLater(d, job, attempt, errText(e));
    }
    if (recordCharge(d, p, pledge, charge)) return done(d, job, "Found the charge at PayPal.");
    return retryLater(d, job, attempt, `The charge is ${charge.status} at PayPal.`);
  }
  const status = order.authorizations.find((a) => a.id === auth)?.status ?? "UNKNOWN";
  const now = d.clock.now();
  if (GONE_AUTH.has(status)) {
    if (pledge && !closing) {
      if (!canFail) return cannotRecord();
      writeCaptureFailed(d, p, pledge, "The hold ended before it could be charged", "PayPal says the hold has ended.", `${fanName(pledge)}'s hold ended before the charge. Their money was never taken.`, auth);
    } else {
      commit(d.store, now, { type: "void_ok", authorizationId: auth });
      logStep(d, { saw: "PayPal says the hold has ended.", did: "That hold is already cancelled. Nobody was charged.", rule: pledge ? "rule-3-void-on-miss" : "rule-1-hold-only", resultId: auth });
    }
    return done(d, job, `The hold is ${status}.`);
  }
  if (status === "CREATED" && pledge && !closing) {
    if (!canFail) return cannotRecord();
    // A capture may still be settling at PayPal: only record a failure on the second look.
    if (attempt < 2) return retryLater(d, job, attempt, "The hold is still open and no charge shows yet; looking once more.");
    writeCaptureFailed(d, p, pledge, "PayPal refused the charge; the hold is still open", "PayPal refused the charge and the hold is still open.", `Counted ${fanName(pledge)} as not charged. The hold lapses on its own; nobody is charged.`, auth);
    return done(d, job, "Charge refused.");
  }
  if (status === "CREATED") {
    const voidJob = d.store.job(`void:${auth}`);
    if (voidJob && voidJob.attempts < MAX_JOB_ATTEMPTS) {
      d.store.updateJob(voidJob.key, { status: "pending", nextAt: now + backoffMs(voidJob.attempts) });
      return done(d, job, "The hold is still open; cancelling it again later.");
    }
    const lapse = new Date(pledge?.expiresAt ?? now).toISOString().slice(0, 10);
    return fail(d, job, `Couldn't cancel a hold; it lapses by ${lapse}.`, `Couldn't cancel a hold. It lapses on its own by ${lapse}; nobody is charged.`);
  }
  retryLater(d, job, attempt, `PayPal says the hold is ${status}.`);
};

export const HOLD_RUNNERS: Runners = { capture: runCapture, void: runVoid, refund: runRefund, reconcile: runReconcile };

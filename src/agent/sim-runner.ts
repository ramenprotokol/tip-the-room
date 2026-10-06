import { IllegalTransition } from "../core/campaign";
import { assertPayPalId } from "../paypal/amount";
import { PayPalError } from "../paypal/errors";
import { requestIds, type Hold } from "../paypal/payments";
import { commit, done, fail, logStep, queueVoid, retryLater, type ExecDeps, type Runner, type Runners } from "./executor";
import { MAX_JOB_ATTEMPTS, REHOLD_MARGIN_MS } from "./policy";
import type { Job } from "./store";
import { errText, fanName, holdDescription, sawCounts } from "./words";

export const SIM_INITIALS = ["JR", "AK", "LM", "TD", "SO", "PB", "NV", "CH", "EW", "RG", "MI", "BF", "OT", "KS", "DL", "HY", "QA", "UZ", "WN", "XE", "GP", "VC", "IB", "FM", "YJ", "ZR"];

/** Answers PayPal gave that our own checks refused: a hold may exist that we can't read. The same request id replays it, so we ask again. */
const UNREADABLE = new Set(["EMPTY_RESPONSE_BODY", "BAD_RESPONSE_BODY", "UNEXPECTED_CURRENCY", "BAD_AMOUNT"]);

function idsLookRight(h: Hold): boolean {
  try {
    assertPayPalId(h.authorizationId, "authorization id");
    assertPayPalId(h.orderId, "order id");
    return true;
  } catch {
    return false;
  }
}

/**
 * Records a refused simulated hold. A refused pledge id is never reused (its PayPal-Request-Id would replay the refusal
 * forever): one retry with a NEW id, then give up. `reason` is internal (job note only); users see plain words.
 */
function declined(d: ExecDeps, job: Job, pledgeId: string, orderId: string | null, authorizationId: string | null, reason: string, needsVoid: boolean): void {
  const now = d.clock.now();
  commit(d.store, now, { type: "pledge_rejected", pledgeId, orderId, authorizationId, reason });
  if (needsVoid && authorizationId) queueVoid(d.store, authorizationId, now);
  const last = pledgeId.endsWith("-r1");
  if (!last) d.store.putJob({ key: `sim:${pledgeId}-r1`, kind: "sim_hold", target: `${pledgeId}-r1`, nextAt: now, note: job.note }, now);
  logStep(d, {
    saw: sawCounts(d.store.projection()),
    did: last ? "Gave up on this simulated fan. Nothing was charged." : "A simulated fan's hold wasn't placed, so trying once more with a new pledge. Nothing was charged.",
    rule: "rule-1-hold-only",
    requestId: requestIds.hold(d.showId, pledgeId),
    resultId: authorizationId,
  });
  done(d, job, `Refused: ${reason}`);
}

/**
 * Out of tries on answers we couldn't read. The order may hold a live sandbox hold we never recorded, so look once more
 * (GET). A live hold is recorded as refused and queued to be cancelled; otherwise the job fails loudly so it shows as
 * needing attention. It never ends failed with an untracked hold.
 */
async function finalCheck(d: ExecDeps, job: Job, pledgeId: string, e: PayPalError): Promise<void> {
  const note = errText(e);
  if (e.orderId) {
    try {
      const found = await d.paypal.getOrderPayments(e.orderId);
      const live = found.authorizations.find((a) => (a.status === "CREATED" || a.status === "PENDING") && /^[A-Za-z0-9-]{1,64}$/.test(a.id));
      if (live) {
        const now = d.clock.now();
        commit(d.store, now, { type: "pledge_rejected", pledgeId, orderId: e.orderId, authorizationId: live.id, reason: "PayPal's answer could not be read" });
        queueVoid(d.store, live.id, now);
        logStep(d, { saw: sawCounts(d.store.projection()), did: "A simulated fan's hold came back unreadable. Cancelling it; nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.hold(d.showId, pledgeId), resultId: live.id });
        return done(d, job, "Unreadable answer; found a live hold and queued it to be cancelled.");
      }
      return fail(d, job, `Gave up after ${MAX_JOB_ATTEMPTS} tries; the order shows no live hold. Last answer: ${note}`, "a simulated fan's hold couldn't be placed. Nothing is held for them.");
    } catch {
      // Fall through: we could not look.
    }
  }
  fail(d, job, `Gave up after ${MAX_JOB_ATTEMPTS} tries and could not check the order. A hold may exist. Last answer: ${note}`, "a simulated fan's hold may have been placed but couldn't be checked, so it needs a look. It lapses on its own; nobody is charged.");
}

const runSimHold: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const m = p.mandate;
  if (!m) return fail(d, job, "The money rules aren't signed.");
  const pledgeId = job.target;
  if (d.store.hasEvent(`pledge:${pledgeId}`)) return done(d, job, "Already recorded.");
  if (p.campaign.state !== "live" && p.campaign.state !== "tipped") return done(d, job, "Pledging has closed, so no simulated fan was added.");
  let hold: Hold;
  try {
    hold = await d.paypal.createCardHold({ showId: d.showId, pledgeId, amountCents: m.ticketPrice, description: holdDescription(m) }, d.card);
  } catch (e) {
    if (e instanceof PayPalError && (e.retryable || UNREADABLE.has(e.paypalName))) {
      if (attempt >= MAX_JOB_ATTEMPTS) return finalCheck(d, job, pledgeId, e);
      return retryLater(d, job, attempt, errText(e));
    }
    return declined(d, job, pledgeId, null, null, errText(e), false);
  }
  // Only a CREATED hold for exactly the ticket price counts. DENIED (or anything else) is never recorded as held.
  if (hold.status !== "CREATED" || hold.amountCents !== m.ticketPrice || !idsLookRight(hold)) {
    const live = (hold.status === "CREATED" || hold.status === "PENDING") && idsLookRight(hold);
    return declined(d, job, pledgeId, idsLookRight(hold) ? hold.orderId : null, live ? hold.authorizationId : null, `answered ${hold.status} for ${hold.amountCents} cents`, live);
  }
  const now = d.clock.now();
  try {
    commit(d.store, now, { type: "pledge_held", pledgeId, orderId: hold.orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents, authorizedAt: hold.createdAt, expiresAt: hold.expiresAt, initials: job.note || "SF", simulated: true });
  } catch (e) {
    if (!(e instanceof IllegalTransition)) throw e;
    commit(d.store, now, { type: "late_hold", pledgeId, orderId: hold.orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents });
    queueVoid(d.store, hold.authorizationId, now);
    logStep(d, { saw: sawCounts(d.store.projection()), did: "A simulated fan's hold arrived after pledging closed. Cancelling it; nobody is charged.", rule: "rule-1-hold-only", requestId: requestIds.hold(d.showId, pledgeId), resultId: hold.authorizationId });
    return done(d, job, "Arrived late; cancelling.");
  }
  const after = d.store.projection();
  const pledge = after.pledges.get(pledgeId);
  logStep(d, { saw: sawCounts(after), did: `Simulated ${pledge ? fanName(pledge) : "fan"} held a spot with a real sandbox card hold. Nobody is charged yet.`, rule: "rule-1-hold-only", requestId: requestIds.hold(d.showId, pledgeId), resultId: hold.authorizationId });
  done(d, job, "Held.");
};

/**
 * Renews a simulated hold near expiry: a fresh card hold under a NEW pledge id first (the old id's request id would replay),
 * then the old one is voided. Reauthorize is never used.
 */
const runRehold: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const m = p.mandate;
  const pledge = p.pledges.get(job.target);
  if (!m || !pledge || pledge.status !== "held" || !pledge.simulated) return done(d, job, "Nothing to renew.");
  if (p.campaign.state !== "live") return done(d, job, "Only an open show renews holds.");
  const now = d.clock.now();
  const dueAt = pledge.expiresAt - REHOLD_MARGIN_MS;
  if (now < dueAt) return d.store.updateJob(job.key, { nextAt: dueAt });
  // Copy the old ids now: the projection object changes as soon as hold_replaced is committed.
  const oldAuthorizationId = pledge.authorizationId;
  const oldOrderId = pledge.orderId;
  const who = fanName(pledge);
  const n = Number(/-h(\d+)$/.exec(pledge.paypalPledgeId)?.[1] ?? "0") + 1;
  const newPledgeId = `${pledge.pledgeId}-h${n}`;
  const stays = `The old hold for ${who} stays until it lapses.`;
  let hold: Hold;
  try {
    hold = await d.paypal.createCardHold({ showId: d.showId, pledgeId: newPledgeId, amountCents: pledge.amountCents, description: holdDescription(m) }, d.card);
  } catch (e) {
    if (e instanceof PayPalError && (e.retryable || UNREADABLE.has(e.paypalName))) return retryLater(d, job, attempt, errText(e));
    return fail(d, job, `Couldn't renew ${who}'s hold (${errText(e)}).`, `a simulated fan's hold couldn't be renewed. ${stays}`);
  }
  if (hold.status !== "CREATED" || hold.amountCents !== pledge.amountCents || !idsLookRight(hold)) {
    if ((hold.status === "CREATED" || hold.status === "PENDING") && idsLookRight(hold)) {
      commit(d.store, now, { type: "pledge_rejected", pledgeId: newPledgeId, orderId: hold.orderId, authorizationId: hold.authorizationId, reason: `renewal answered ${hold.status}` });
      queueVoid(d.store, hold.authorizationId, now);
    }
    return fail(d, job, `Renewal refused: ${hold.status}`, `a simulated fan's hold wasn't renewed. ${stays}`);
  }
  // The answer took time: the fan may have been charged or released meanwhile. Never swap the ids of a hold that is no longer live.
  const fresh = d.store.projection();
  const current = fresh.pledges.get(pledge.pledgeId);
  if (!current || current.status !== "held" || fresh.campaign.state !== "live" || current.authorizationId !== oldAuthorizationId) {
    commit(d.store, now, { type: "late_hold", pledgeId: newPledgeId, orderId: hold.orderId, authorizationId: hold.authorizationId, amountCents: hold.amountCents });
    queueVoid(d.store, hold.authorizationId, now);
    logStep(d, { saw: sawCounts(fresh), did: `A renewed hold for ${who} arrived after it was no longer needed. Cancelling it; nobody is charged.`, rule: "rule-1-hold-only", requestId: requestIds.hold(d.showId, newPledgeId), resultId: hold.authorizationId });
    return done(d, job, "Not needed any more; the new hold is being cancelled.");
  }
  commit(d.store, now, { type: "hold_replaced", pledgeId: pledge.pledgeId, newPaypalPledgeId: newPledgeId, orderId: hold.orderId, authorizationId: hold.authorizationId, oldOrderId, oldAuthorizationId, authorizedAt: hold.createdAt, expiresAt: hold.expiresAt });
  queueVoid(d.store, oldAuthorizationId, now);
  logStep(d, { saw: sawCounts(d.store.projection()), did: `Renewed ${who}'s hold before it expired: a new hold first, then the old one is cancelled. Nobody was charged.`, rule: "rule-1-hold-only", requestId: requestIds.hold(d.showId, newPledgeId), resultId: hold.authorizationId });
  done(d, job, "Renewed.");
};

export const SIM_RUNNERS: Runners = { sim_hold: runSimHold, rehold: runRehold };

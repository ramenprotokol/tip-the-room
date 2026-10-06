import { formatUSD } from "../core/money";
import { splitPayout, type PayoutLine } from "../core/split";
import { PayPalError } from "../paypal/errors";
import { isDuplicateBatch, payoutBatchId, type PayoutBatch, type SentBatch } from "../paypal/payouts";
import { block, commit, decide, done, fail, logStep, retryLater, skip, type ExecDeps, type Runner, type Runners } from "./executor";
import { isShowId } from "./ids";
import { PAYOUT_POLL_MAX, POLL_DELAY_MS } from "./policy";
import type { PayoutView, Projection } from "./project";
import { errText, sawCounts } from "./words";

/** Final payout item failures (the same set the webhook mapper calls payout_item_failed). UNCLAIMED and HELD are pending, not failed. */
export const PAYOUT_FAILED: ReadonlySet<string> = new Set(["FAILED", "RETURNED", "BLOCKED", "DENIED", "CANCELED", "REFUNDED"]);
/** Errors after which the batch may already exist at PayPal: retry with the same sender_batch_id. */
const MAYBE_SENT = new Set(["BAD_RESPONSE_BODY", "EMPTY_RESPONSE_BODY"]);

export function roleOfItem(showId: string, senderItemId: string): string | null {
  const prefix = `${showId}-`;
  if (!senderItemId.startsWith(prefix)) return null;
  return senderItemId.slice(prefix.length).replace(/-r1$/, "") || null;
}

export function schedulePoll(d: ExecDeps, batchId: string, n: number): void {
  const now = d.clock.now();
  d.store.putJob({ key: `poll:${batchId}:${n}`, kind: "payout_poll", target: batchId, nextAt: now + POLL_DELAY_MS * n, note: String(n) }, now);
}

const listLines = (lines: PayoutLine[]) => lines.map((l) => `${l.label} ${formatUSD(l.amount)}`).join(" · ");

function labelOf(p: Projection, showId: string, senderItemId: string): string {
  const role = roleOfItem(showId, senderItemId);
  return p.mandate?.parties.find((x) => x.role === role)?.label ?? senderItemId;
}

function itemWords(status: string): string {
  if (status === "SUCCESS") return "paid";
  if (PAYOUT_FAILED.has(status)) return "couldn't be paid";
  if (status === "UNCLAIMED") return "waiting for them to claim it";
  return "pending";
}

function proposeShortfall(d: ExecDeps, p: Projection, approvalKey: string, shortfall: number): void {
  const proposalId = `short${p.collectedNet}`;
  const { appended } = commit(d.store, d.clock.now(), {
    type: "proposal_made",
    proposalId,
    options: [{ id: "pay_short", approvalKey, label: "Pay out what came in", collectedNet: p.collectedNet }],
    explanation: `After PayPal's fees, ${formatUSD(p.collectedNet)} came in. That is ${formatUSD(shortfall)} short of the amounts you signed. Approve to pay out what came in, in the signed order.`,
    recommend: "pay_short",
    source: "template",
  });
  if (appended) logStep(d, { saw: sawCounts(p), did: "The money is short of the signed amounts, so payouts wait for the artist's OK.", rule: "rule-5-ask-first" });
}

/**
 * A guard-skipped payout job is permanently spent: putJob won't re-add the `payout:<show>` key. That is acceptable
 * because send_payouts only fires when held = 0 (the amount is final), and the guard allows it from then on.
 */
const runPayout: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  if (!p.mandate) return fail(d, job, "The money rules aren't signed.");
  if (!isShowId(d.showId)) return fail(d, job, "Not a valid show id.");
  if (d.showId !== p.mandate.showId) return fail(d, job, "The worker's show id doesn't match the signed show.", "the payout was for a different show than the one signed, so nothing was sent.");
  if (p.payouts.some((x) => !x.retry)) return done(d, job, "Payouts were already sent.");
  const senderBatchId = payoutBatchId(d.showId);
  if (p.campaign.state === "paying_out" && p.campaign.pledges.held === 0 && p.collectedNet === 0) {
    commit(d.store, d.clock.now(), { type: "payout_sent", senderBatchId, batchId: null, status: "NOTHING_TO_PAY", lines: [], retry: false, recovered: false });
    logStep(d, { saw: sawCounts(p), did: "No money came in, so there was nothing to pay out.", rule: "rule-4-pay-the-split" });
    return done(d, job, "Nothing to pay.");
  }
  // The split comes from code and the signed mandate, never from the model.
  const expected = splitPayout(p.collectedNet, p.mandate.parties);
  const decision = decide(p, { kind: "send_payouts", lines: expected.lines });
  if (decision.needsApproval && decision.approvalKey) {
    block(d, job, decision.reason);
    return proposeShortfall(d, p, decision.approvalKey, expected.shortfall);
  }
  if (!decision.allowed) return skip(d, job, p, decision, "Did not send payouts.");
  const toSend = expected.lines.filter((l) => l.amount > 0);
  let sent: SentBatch;
  try {
    sent = await d.paypal.sendPayouts(d.showId, expected.lines, false);
  } catch (e) {
    if (isDuplicateBatch(e)) {
      // Already sent: never send again. A later PAYMENT.PAYOUTSBATCH.* webhook fills in the batch id.
      commit(d.store, d.clock.now(), { type: "payout_sent", senderBatchId, batchId: null, status: "ALREADY_SENT", lines: toSend, retry: false, recovered: true });
      logStep(d, { saw: sawCounts(p), did: "PayPal already has this payout batch, so it was not sent again. Waiting for PayPal to confirm it.", rule: decision.rule, requestId: senderBatchId });
      return done(d, job, "Already sent.");
    }
    if (e instanceof PayPalError && (e.retryable || MAYBE_SENT.has(e.paypalName))) return retryLater(d, job, attempt, errText(e));
    return fail(d, job, `PayPal refused the payout batch (${errText(e)}).`);
  }
  const first = commit(d.store, d.clock.now(), { type: "payout_sent", senderBatchId: sent.senderBatchId, batchId: sent.batchId, status: sent.status, lines: sent.sentLines, retry: false, recovered: false });
  // A second run (lease expired) may have recorded ALREADY_SENT with no batch id first: give the record the real id so polling works.
  if (!first.appended) commit(d.store, d.clock.now(), { type: "payout_batch_seen", senderBatchId: sent.senderBatchId, batchId: sent.batchId });
  logStep(d, { saw: sawCounts(p), did: `Sent the payouts exactly as signed: ${listLines(sent.sentLines)}.`, rule: decision.rule, requestId: sent.senderBatchId, resultId: sent.batchId });
  schedulePoll(d, sent.batchId, 1);
  done(d, job, `Batch ${sent.status}.`);
};

const runPayoutPoll: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  const batchId = job.target;
  const payout = p.payouts.find((x) => x.batchId === batchId);
  if (!payout) return fail(d, job, "That payout batch isn't part of this show.");
  let batch: PayoutBatch;
  try {
    batch = await d.paypal.getPayoutBatch(batchId);
  } catch (e) {
    return retryLater(d, job, attempt, errText(e));
  }
  const { appended } = commit(d.store, d.clock.now(), { type: "payout_items", batchId, items: batch.items });
  const failed = batch.items.filter((i) => PAYOUT_FAILED.has(i.status));
  // Items can be missing right after create, and UNCLAIMED / HELD / PENDING / ONHOLD are not final.
  const pending = batch.items.length < payout.lines.length || batch.items.some((i) => i.status !== "SUCCESS" && !PAYOUT_FAILED.has(i.status));
  if (appended) {
    logStep(d, { saw: `PayPal says the payout batch is ${batch.status}.`, did: batch.items.map((i) => `${labelOf(p, d.showId, i.senderItemId)}: ${itemWords(i.status)}`).join(" · ") || "No payout items yet.", rule: "rule-4-pay-the-split", resultId: batchId });
  }
  if (failed.length > 0 && !payout.retry) {
    const now = d.clock.now();
    d.store.putJob({ key: `payout_retry:${d.showId}`, kind: "payout_retry", target: d.showId, nextAt: now }, now);
  }
  if (failed.length > 0 && payout.retry && appended) {
    logStep(d, { saw: "The second try failed too.", did: `Needs attention: ${failed.map((i) => labelOf(p, d.showId, i.senderItemId)).join(", ")} couldn't be paid twice. Check their PayPal email.`, rule: null, resultId: batchId });
  }
  // The poll number lives in the job key (poll:<batch>:<n>); job.note is overwritten by retryLater.
  const n = Number(job.key.split(":").pop()) || 1;
  if (pending) {
    if (n < PAYOUT_POLL_MAX) schedulePoll(d, batchId, n + 1);
    else logStep(d, { saw: sawCounts(p), did: "Needs attention: some payouts are still unconfirmed at PayPal, so they need a look.", rule: null, resultId: batchId });
  }
  done(d, job, `Batch ${batch.status}.`);
};

/** The first batch's failed lines, re-checked against the signed split. A line that doesn't match it exactly is never retried. */
export function retryLines(showId: string, p: Projection, first: PayoutView): PayoutLine[] {
  if (!p.mandate || p.campaign.state !== "settled") return [];
  const expected = splitPayout(p.collectedNet, p.mandate.parties).lines;
  const failedRoles = new Set(
    Object.values(first.items)
      .filter((i) => PAYOUT_FAILED.has(i.status))
      .map((i) => roleOfItem(showId, i.senderItemId)),
  );
  return first.lines.filter((l) => l.amount > 0 && failedRoles.has(l.role) && expected.some((x) => x.role === l.role && x.label === l.label && x.paypalEmail === l.paypalEmail && x.amount === l.amount));
}

const runPayoutRetry: Runner = async (d, job, attempt) => {
  const p = d.store.projection();
  if (!isShowId(d.showId)) return fail(d, job, "Not a valid show id.");
  if (!p.mandate || d.showId !== p.mandate.showId) return fail(d, job, "The worker's show id doesn't match the signed show.", "the payout retry was for a different show than the one signed, so nothing was sent.");
  const first = p.payouts.find((x) => !x.retry);
  if (!first) return fail(d, job, "There is no first payout batch to retry.");
  if (p.payouts.some((x) => x.retry)) return done(d, job, "Already retried once.");
  const lines = retryLines(d.showId, p, first);
  if (lines.length === 0) return done(d, job, "Nothing to retry.");
  const senderBatchId = payoutBatchId(d.showId, true);
  let sent: SentBatch;
  try {
    sent = await d.paypal.sendPayouts(d.showId, lines, true);
  } catch (e) {
    if (isDuplicateBatch(e)) {
      commit(d.store, d.clock.now(), { type: "payout_sent", senderBatchId, batchId: null, status: "ALREADY_SENT", lines, retry: true, recovered: true });
      logStep(d, { saw: sawCounts(p), did: "PayPal already has the retry batch, so it was not sent again.", rule: "rule-4-pay-the-split", requestId: senderBatchId });
      return done(d, job, "Already sent.");
    }
    if (e instanceof PayPalError && (e.retryable || MAYBE_SENT.has(e.paypalName))) return retryLater(d, job, attempt, errText(e));
    return fail(d, job, `PayPal refused the retry batch (${errText(e)}).`);
  }
  const again = commit(d.store, d.clock.now(), { type: "payout_sent", senderBatchId: sent.senderBatchId, batchId: sent.batchId, status: sent.status, lines: sent.sentLines, retry: true, recovered: false });
  if (!again.appended) commit(d.store, d.clock.now(), { type: "payout_batch_seen", senderBatchId: sent.senderBatchId, batchId: sent.batchId });
  logStep(d, { saw: sawCounts(p), did: `Tried once more for the payouts that failed: ${listLines(sent.sentLines)}.`, rule: "rule-4-pay-the-split", requestId: sent.senderBatchId, resultId: sent.batchId });
  schedulePoll(d, sent.batchId, 1);
  done(d, job, `Retry batch ${sent.status}.`);
};

export const PAYOUT_RUNNERS: Runners = { payout: runPayout, payout_poll: runPayoutPoll, payout_retry: runPayoutRetry };

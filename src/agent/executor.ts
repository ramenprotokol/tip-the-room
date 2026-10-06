import { reduce, type Effect } from "../core/campaign";
import { guard, type AgentAction, type GuardDecision } from "../core/guard";
import type { RuleId } from "../core/rules";
import type { TestCard } from "../paypal/payments";
import { eventKey, type AiSource, type LedgerEvent } from "./events";
import type { Clock } from "./ids";
import type { PayPalPort } from "./paypal-port";
import { backoffMs, jobCost, LEASE_MS, MAX_JOB_ATTEMPTS, MAX_JOBS_PER_TURN, TURN_CALL_BUDGET } from "./policy";
import { campaignEventFor, chargedPledges, heldPledges, type Projection } from "./project";
import type { Job, JobKind, Store } from "./store";
import { errText, sawCounts } from "./words";

export interface ExecDeps {
  store: Store;
  paypal: PayPalPort;
  /** Campaign time (a demo copy may run ahead of real time). */
  clock: Clock;
  showId: string;
  card: TestCard;
}

export interface CommitResult {
  appended: boolean;
  projection: Projection;
  effects: Effect[];
}

/**
 * Appends one ledger event and, in the same transaction, the jobs its effects need.
 * - An event whose key already exists changes nothing (replay-safe).
 * - The reducer runs first: an event it refuses throws IllegalTransition and nothing is written.
 * - Jobs are planned from the post-event state, under deterministic keys, BEFORE any PayPal call.
 * - Store.transaction drops the cached projection if anything throws.
 */
export function commit(store: Store, at: number, event: LedgerEvent): CommitResult {
  if (store.hasEvent(eventKey(event))) return { appended: false, projection: store.projection(), effects: [] };
  return store.transaction(() => {
    const before = store.projection();
    const ce = campaignEventFor(event, before);
    const effects = ce ? reduce(before.campaign, ce).effects : [];
    store.appendEvent(at, event);
    const projection = store.projection();
    planJobs(store, projection, effects, at);
    return { appended: true, projection, effects };
  });
}

/** Turns reducer effects into one job per PayPal call. Keys make this idempotent. */
export function planJobs(store: Store, p: Projection, effects: Effect[], now: number): void {
  for (const e of effects) {
    switch (e.type) {
      case "capture_all_held":
      case "capture_new_pledge":
        for (const pl of heldPledges(p)) store.putJob({ key: `capture:${pl.authorizationId}`, kind: "capture", target: pl.authorizationId, nextAt: now }, now);
        break;
      case "void_all_held":
        for (const pl of heldPledges(p)) queueVoid(store, pl.authorizationId, now);
        break;
      case "refund_all_charged":
        for (const pl of chargedPledges(p)) if (pl.captureId) store.putJob({ key: `refund:${pl.captureId}`, kind: "refund", target: pl.captureId, nextAt: now }, now);
        break;
      case "send_payouts":
        if (p.mandate) store.putJob({ key: `payout:${p.mandate.showId}`, kind: "payout", target: p.mandate.showId, nextAt: now }, now);
        break;
    }
  }
}

export type Runner = (d: ExecDeps, job: Job, attempt: number) => Promise<void>;
export type Runners = Partial<Record<JobKind, Runner>>;

export interface DrainResult {
  ran: number;
  more: boolean;
}

/**
 * Runs due jobs one at a time, at most `maxJobs` per invocation. It also keeps a per-turn PayPal fetch budget
 * (free plan: 50 subrequests): the port's meter is reset here, and a job whose worst-case cost no longer fits the
 * remaining budget is not started; it stays queued (`more` is true) for the next turn.
 */
export async function drain(d: ExecDeps, runners: Runners, maxJobs = MAX_JOBS_PER_TURN): Promise<DrainResult> {
  let ran = 0;
  d.paypal.meter.reset();
  while (ran < maxJobs) {
    const [job] = d.store.dueJobs(d.clock.now(), 1);
    if (!job) break;
    if (TURN_CALL_BUDGET - d.paypal.meter.used < jobCost(job.kind, job.attempts + 1)) break;
    ran += 1;
    await runJob(d, runners, job);
  }
  return { ran, more: d.store.dueJobs(d.clock.now(), 1).length > 0 };
}

/** Plain words for a job kind, for user-facing log lines. */
const KIND_WORDS: Record<JobKind, string> = {
  capture: "charge",
  void: "hold-release",
  refund: "refund",
  reconcile: "PayPal check",
  payout: "payout",
  payout_retry: "payout retry",
  payout_poll: "payout check",
  sim_hold: "practice hold",
  rehold: "hold renewal",
};

async function runJob(d: ExecDeps, runners: Runners, job: Job): Promise<void> {
  const attempt = job.attempts + 1;
  // Claim the job first: a concurrent drain won't pick it up while we wait on PayPal.
  d.store.updateJob(job.key, { attempts: attempt, nextAt: d.clock.now() + LEASE_MS });
  const runner = runners[job.kind];
  if (!runner) return fail(d, job, `No runner handles ${job.kind} jobs.`);
  if (attempt > MAX_JOB_ATTEMPTS * 2) return fail(d, job, "This step kept stopping without an answer.");
  try {
    await runner(d, { ...job, attempts: attempt }, attempt);
  } catch (e) {
    fail(d, job, `Stopped on an unexpected error: ${errText(e)}`);
  }
}

export function done(d: ExecDeps, job: Job, note: string): void {
  d.store.updateJob(job.key, { status: "done", note });
}

/** The guard said no: the job is dropped and the reason logged with its rule. */
export function skip(d: ExecDeps, job: Job, p: Projection, decision: GuardDecision, did: string): void {
  d.store.updateJob(job.key, { status: "skipped", note: decision.reason });
  logStep(d, { saw: sawCounts(p), did: `${did} ${decision.reason}`, rule: decision.rule });
}

/** Waits for the artist (e.g. a payout shortfall). Approval sets it back to pending. */
export function block(d: ExecDeps, job: Job, note: string): void {
  d.store.updateJob(job.key, { status: "blocked", note });
}

/**
 * `note` is internal (it may hold PayPal codes). The log line is shown to users, so it carries only
 * `userText`, which must be plain words with no PayPal error text.
 */
export function fail(d: ExecDeps, job: Job, note: string, userText = "this step couldn't finish, so it needs a look."): void {
  d.store.updateJob(job.key, { status: "failed", note });
  logStep(d, { saw: `A ${KIND_WORDS[job.kind]} step stopped.`, did: `Needs attention: ${userText}`, rule: null });
}

/** Same job, same PayPal-Request-Id, later. Gives up (fail) after MAX_JOB_ATTEMPTS. */
export function retryLater(d: ExecDeps, job: Job, attempt: number, note: string): void {
  if (attempt >= MAX_JOB_ATTEMPTS) {
    return fail(d, job, `Gave up after ${attempt} tries. Last answer: ${note}`, `this ${KIND_WORDS[job.kind]} step kept failing after ${attempt} tries.`);
  }
  d.store.updateJob(job.key, { nextAt: d.clock.now() + backoffMs(attempt), note });
}

/** Ask PayPal (GET) what really happened to this authorization. Re-opens a finished check. */
export function requestReconcile(store: Store, authorizationId: string, at: number, note: string): void {
  const key = `reconcile:${authorizationId}`;
  if (store.putJob({ key, kind: "reconcile", target: authorizationId, nextAt: at, note }, at)) return;
  const j = store.job(key);
  if (j && j.status !== "pending") store.updateJob(key, { status: "pending", nextAt: at, attempts: 0, note });
}

export function queueVoid(store: Store, authorizationId: string, at: number): void {
  store.putJob({ key: `void:${authorizationId}`, kind: "void", target: authorizationId, nextAt: at }, at);
}

/** The guard, against the current (post-reduce) campaign and the signed mandate. */
export function decide(p: Projection, action: AgentAction): GuardDecision {
  if (!p.mandate) return { allowed: false, needsApproval: false, rule: "rule-1-hold-only", reason: "The money rules aren't signed yet." };
  return guard(action, { mandate: p.mandate, campaign: p.campaign, approvals: p.approvals, collectedNet: p.collectedNet });
}

export function logStep(d: ExecDeps, s: { saw: string; did: string; rule: RuleId | null; requestId?: string | null; resultId?: string | null; source?: AiSource | "code" }): void {
  d.store.log({ at: d.clock.now(), saw: s.saw, did: s.did, rule: s.rule, requestId: s.requestId ?? null, resultId: s.resultId ?? null, source: s.source ?? "code" });
}

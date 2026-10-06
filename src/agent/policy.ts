import { DAY_MS } from "../core/holds";
import type { JobKind } from "./store";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Free plan: 50 subrequests (outbound fetches) per invocation.
 * - SUBREQUEST_LIMIT is Cloudflare's cap.
 * - SUBREQUEST_RESERVE is headroom for what the job costs below cannot see: the OAuth token fetch (1, or 2
 *   after a 401), http-level retries of a PayPal request (up to 2 more per request), and any non-PayPal fetch.
 * - TURN_CALL_BUDGET is what drain may spend on PayPal fetches in one turn. The port counts real fetches
 *   (token fetches and retries included), so `used` is the true figure; the job costs are the worst case in
 *   PayPal requests assuming no http retries, and the reserve absorbs retries inside the job in flight.
 * A job that would not fit the remaining budget is not started; it stays queued for the next turn/alarm.
 */
export const SUBREQUEST_LIMIT = 50;
export const SUBREQUEST_RESERVE = 12;
export const TURN_CALL_BUDGET = SUBREQUEST_LIMIT - SUBREQUEST_RESERVE;
/**
 * One model call is two subrequests: the daily-budget reservation (a Durable Object call) and the AI binding call.
 * They are metered on the same meter as PayPal fetches, so a turn's total stays inside TURN_CALL_BUDGET.
 */
export const MODEL_CALL_COST = 2;
/** A hard cap on jobs per turn too (cheap jobs would otherwise starve other work such as AI notes). */
export const MAX_JOBS_PER_TURN = 12;

/**
 * Worst-case PayPal requests one run of a job can make.
 * - capture, attempt 1: captureHold + failAfterCheck (getOrderPayments + getCapture) = 3.
 * - capture, attempt 2 or later: order check (2) + captureHold + failAfterCheck (2) = 5.
 * - refund: refundCharge + getCapture after CAPTURE_FULLY_REFUNDED = 2 (a PENDING poll is 1).
 * - reconcile: getOrderPayments + getCapture = 2.
 * - void, payout, payout_retry, payout_poll: 1.
 * - sim_hold (createCardHold + authorize/void) 2; rehold (new hold + void old + one check) 3 (Task 10).
 */
export function jobCost(kind: JobKind, attempt: number): number {
  switch (kind) {
    case "capture":
      return attempt > 1 ? 5 : 3;
    case "refund":
    case "reconcile":
    case "sim_hold":
      return 2;
    case "rehold":
      return 3;
    case "void":
    case "payout":
    case "payout_retry":
    case "payout_poll":
      return 1;
  }
}
export const MAX_JOB_ATTEMPTS = 8;
/** A job being worked on is invisible to other drains for this long (a crash makes it due again). */
export const LEASE_MS = 60_000;
/** How soon to re-check an answer PayPal hasn't finished (PENDING, or no amounts yet). */
export const RECHECK_MS = 60_000;
const BACKOFF = [30_000, 120_000, 600_000, 1_800_000, HOUR_MS];
/** Wait before retry number `attempt` (1-based): 30 s, 2 min, 10 min, 30 min, then hourly. */
export function backoffMs(attempt: number): number {
  return BACKOFF[Math.min(Math.max(attempt, 1), BACKOFF.length) - 1];
}
/** Payout batch polls: n-th poll waits n minutes; at most this many. */
export const POLL_DELAY_MS = 60_000;
export const PAYOUT_POLL_MAX = 8;
/** Renew a simulated hold this long before it expires. */
export const REHOLD_MARGIN_MS = 2 * DAY_MS;
/** The second pace check runs this long before the deadline (spec 3.4). */
export const PACE_LATE_MS = 72 * HOUR_MS;
/** "Check pace now" (demo only) moves a demo show's clock to this share of its window: show B is behind pace there. */
export const DEMO_PACE_POINT = 0.75;

export const DEMO_TTL_MS = 24 * HOUR_MS;
/** A show nobody signed is deleted this long after it was created. */
export const UNSIGNED_TTL_MS = 24 * HOUR_MS;
/** Demo fast-forward tops show A up to its target plus this many simulated fans, so the sandbox fee cannot leave it short. */
export const DEMO_TOP_UP_EXTRA = 2;
/** A demo copy past its expiry waits this long before looking again for live holds; the wait doubles each time (see demoGraceMs). */
export const DEMO_GRACE_MS = HOUR_MS;
/** The wait between expiry checks never grows past this. */
export const DEMO_GRACE_MAX_MS = 24 * HOUR_MS;
/** Wait before expiry check number `graces` (0-based): 1 h, 2 h, 4 h, ... capped at 24 h. */
export function demoGraceMs(graces: number): number {
  return Math.min(DEMO_GRACE_MS * 2 ** Math.min(Math.max(graces, 0), 10), DEMO_GRACE_MAX_MS);
}
/** After this long past its first expiry a demo copy is deleted whatever is left (sandbox holds lapse on their own). */
export const DEMO_GRACE_TOTAL_MAX_MS = 30 * DAY_MS;
/** A sandbox card hold lasts this long; used when a retired hold's own expiry isn't on record. */
export const SANDBOX_HOLD_LIFETIME_MS = 29 * DAY_MS;
/** New demo copies allowed per day across all visitors. Each copy seats about 48 real sandbox holds. */
export const DEMO_COPIES_PER_DAY = 50;
export const SIM_CAP_PER_SHOW = 60;
export const SIM_ADD_MAX = 20;
export const MAX_ORDERS_PER_SHOW = 500;
/** Jobs that move or release money; a show isn't finished while one is pending. */
export const MONEY_JOBS: JobKind[] = ["capture", "void", "refund", "payout", "payout_retry", "reconcile", "sim_hold"];
/** A payout PayPal already had (recovered) with no batch id after this long is flagged for the artist. */
export const RECOVERED_BATCH_ATTENTION_MS = 6 * HOUR_MS;
/**
 * A pledge still `held` after the show tipped, with no capture or reconcile job left to run, would block payouts forever.
 * The sweep waits SWEEP_BACKOFF_MS[n] before sweep number n (0-based): sweeps 1 to SWEEP_MAX-1 ask PayPal again (reconcile);
 * the last one settles on what PayPal shows was actually captured.
 */
export const SWEEP_BACKOFF_MS = [10 * 60_000, 30 * 60_000, 2 * HOUR_MS];
export const SWEEP_MAX = SWEEP_BACKOFF_MS.length;
/** Stuck holds handled per turn (each final settle costs up to 2 PayPal requests). */
export const SWEEP_PER_TURN = 3;
/** Settle looks (2 h apart) allowed after the reconcile sweeps when PayPal shows a capture it cannot read yet; then the sweep stops. */
export const SWEEP_FINAL_LOOKS = 12;

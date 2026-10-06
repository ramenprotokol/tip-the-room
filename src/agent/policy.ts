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
export const DEMO_TTL_MS = 24 * HOUR_MS;
export const DEMO_GRACE_MS = HOUR_MS;
export const DEMO_MAX_GRACES = 3;
export const SIM_CAP_PER_SHOW = 60;
export const SIM_ADD_MAX = 20;
export const MAX_ORDERS_PER_SHOW = 500;
/** Jobs that move or release money; a show isn't finished while one is pending. */
export const MONEY_JOBS: JobKind[] = ["capture", "void", "refund", "payout", "payout_retry", "reconcile", "sim_hold"];

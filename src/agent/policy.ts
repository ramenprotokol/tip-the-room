import { DAY_MS } from "../core/holds";
import type { JobKind } from "./store";

const HOUR_MS = 60 * 60 * 1000;

/** Free plan: 50 subrequests per invocation. A job makes at most 2 PayPal calls (plus one token fetch per turn). */
export const MAX_JOBS_PER_TURN = 12;
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

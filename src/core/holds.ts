export const DAY_MS = 24 * 60 * 60 * 1000;
/** Capture is only guaranteed in the first 3 days after an authorization. */
export const HONOR_PERIOD_MS = 3 * DAY_MS;
/** An authorization can be captured (after reauthorizing) for up to 29 days. */
export const AUTH_VALID_MS = 29 * DAY_MS;
/** A campaign's pledge window is at most 21 days, so no hold outlives its authorization. */
export const MAX_CAMPAIGN_DAYS = 21;
/** The artist may approve one deadline extension of at most 7 days. */
export const MAX_EXTENSION_DAYS = 7;

export function needsReauthorization(authorizedAt: number, now: number): boolean {
  if (!Number.isFinite(authorizedAt) || !Number.isFinite(now)) return true;
  return now - authorizedAt >= HONOR_PERIOD_MS;
}

export function isAuthorizationExpired(authorizedAt: number, now: number): boolean {
  if (!Number.isFinite(authorizedAt) || !Number.isFinite(now)) return true;
  return now - authorizedAt >= AUTH_VALID_MS;
}

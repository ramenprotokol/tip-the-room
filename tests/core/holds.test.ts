import { describe, expect, it } from "vitest";
import { AUTH_VALID_MS, DAY_MS, HONOR_PERIOD_MS, isAuthorizationExpired, needsReauthorization } from "../../src/core/holds";

const t0 = Date.UTC(2026, 10, 1, 12, 0, 0);

describe("hold timing", () => {
  it("uses PayPal's 3-day honor period and 29-day validity", () => {
    expect(HONOR_PERIOD_MS).toBe(3 * DAY_MS);
    expect(AUTH_VALID_MS).toBe(29 * DAY_MS);
  });
  it("needs reauthorization from the start of day 3 onward", () => {
    expect(needsReauthorization(t0, t0 + 3 * DAY_MS - 1)).toBe(false);
    expect(needsReauthorization(t0, t0 + 3 * DAY_MS)).toBe(true);
  });
  it("is expired from day 29 onward", () => {
    expect(isAuthorizationExpired(t0, t0 + 29 * DAY_MS - 1)).toBe(false);
    expect(isAuthorizationExpired(t0, t0 + 29 * DAY_MS)).toBe(true);
  });
});

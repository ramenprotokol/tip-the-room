import { describe, expect, it } from "vitest";
import { PayPalError } from "../../src/paypal/errors";

describe("PayPalError.retryable", () => {
  it("is true for network failures, 429 and 5xx", () => {
    expect(new PayPalError(0, "NETWORK_ERROR", "x").retryable).toBe(true);
    expect(new PayPalError(429, "RATE_LIMIT_REACHED", "x").retryable).toBe(true);
    expect(new PayPalError(503, "SERVICE_UNAVAILABLE", "x").retryable).toBe(true);
  });
  it("is false for 4xx", () => expect(new PayPalError(422, "UNPROCESSABLE_ENTITY", "x").retryable).toBe(false));
  it.each(["UNEXPECTED_CURRENCY", "BAD_AMOUNT", "BAD_RESPONSE_BODY", "BAD_TOKEN_RESPONSE"])("is false for the synthetic %s even with status 502", (name) => {
    expect(new PayPalError(502, name, "x").retryable).toBe(false);
  });
});

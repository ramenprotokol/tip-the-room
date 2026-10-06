import { describe, expect, it } from "vitest";
import { centsToValue, valueToCents } from "../../src/paypal/amount";

describe("amount", () => {
  it.each([[0, "0.00"], [5, "0.05"], [1500, "15.00"], [123456, "1234.56"]])("%i cents → %s", (c, v) => expect(centsToValue(c)).toBe(v));
  it.each([["15.00", 1500], ["15", 1500], ["15.5", 1550], ["0.05", 5], ["1234.56", 123456]])("%s → %i cents", (v, c) => expect(valueToCents(v)).toBe(c));
  it("rejects bad cents", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => centsToValue(bad)).toThrow(RangeError);
  });
  it("rejects bad values", () => {
    for (const bad of ["", "1.234", "-1.00", "1e3", " 1.00", "abc"]) expect(() => valueToCents(bad)).toThrow(RangeError);
  });
});

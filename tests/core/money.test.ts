import { describe, expect, it } from "vitest";
import { dollarsToCents, formatUSD, formatUSDShort } from "../../src/core/money";

describe("dollarsToCents", () => {
  it("converts whole and fractional dollars without float drift", () => {
    expect(dollarsToCents(15)).toBe(1500);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
    expect(dollarsToCents(19.99)).toBe(1999);
  });
  it("rejects negative and non-finite amounts", () => {
    expect(() => dollarsToCents(-1)).toThrow(RangeError);
    expect(() => dollarsToCents(Number.NaN)).toThrow(RangeError);
    expect(() => dollarsToCents(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("formatUSD", () => {
  it("formats cents as US dollars", () => {
    expect(formatUSD(43500)).toBe("$435.00");
    expect(formatUSD(0)).toBe("$0.00");
    expect(formatUSD(123456)).toBe("$1,234.56");
  });
  it("drops cents for whole dollars in the short form", () => {
    expect(formatUSDShort(43500)).toBe("$435");
    expect(formatUSDShort(123400)).toBe("$1,234");
    expect(formatUSDShort(43550)).toBe("$435.50");
  });
});

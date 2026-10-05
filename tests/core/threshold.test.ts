import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DEFAULT_FEE_BUFFER_BPS, thresholdPledges } from "../../src/core/threshold";

describe("thresholdPledges", () => {
  it("matches the Juniper Vale sample: $80 room + $100 opener + $300 artist at $15 → 34 fans", () => {
    expect(thresholdPledges({ fixedCosts: [8000, 10000], artistMinimum: 30000, ticketPrice: 1500, feeBufferBps: 500 })).toBe(34);
  });
  it("matches the Maya sample: $100 café + $200 artist at $15 → 21 fans", () => {
    expect(thresholdPledges({ fixedCosts: [10000], artistMinimum: 20000, ticketPrice: 1500, feeBufferBps: DEFAULT_FEE_BUFFER_BPS })).toBe(21);
  });
  it("never returns less than 1", () => {
    expect(thresholdPledges({ fixedCosts: [], artistMinimum: 0, ticketPrice: 1500, feeBufferBps: 500 })).toBe(1);
  });
  it("rejects a zero or fractional ticket price and bad buffers", () => {
    expect(() => thresholdPledges({ fixedCosts: [], artistMinimum: 100, ticketPrice: 0, feeBufferBps: 500 })).toThrow(RangeError);
    expect(() => thresholdPledges({ fixedCosts: [], artistMinimum: 100, ticketPrice: 10.5, feeBufferBps: 500 })).toThrow(RangeError);
    expect(() => thresholdPledges({ fixedCosts: [], artistMinimum: 100, ticketPrice: 1500, feeBufferBps: -1 })).toThrow(RangeError);
    expect(() => thresholdPledges({ fixedCosts: [-5], artistMinimum: 100, ticketPrice: 1500, feeBufferBps: 500 })).toThrow(RangeError);
  });
  it("always raises enough to cover costs plus the buffer (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 500_000 }), { maxLength: 4 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 100, max: 20_000 }),
        fc.integer({ min: 0, max: 2000 }),
        (fixedCosts, artistMinimum, ticketPrice, feeBufferBps) => {
          const n = thresholdPledges({ fixedCosts, artistMinimum, ticketPrice, feeBufferBps });
          const need = fixedCosts.reduce((a, b) => a + b, 0) + artistMinimum;
          const needed = need * (10000 + feeBufferBps);
          expect(n * ticketPrice * 10000).toBeGreaterThanOrEqual(needed);
          if (n > 1) expect((n - 1) * ticketPrice * 10000).toBeLessThan(needed);
        },
      ),
    );
  });
});

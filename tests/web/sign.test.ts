import { describe, expect, it } from "vitest";
import { BONUS, MISS, PAYOUT, PLEDGE, REDUCED_T, TIP } from "../../src/web/shared/sign";

describe("choreography cue tables match the reference", () => {
  it("has the reference timings", () => {
    expect(TIP).toEqual({ flare: 0.62, pop: 1.0, gather: 1.78, itson: 2.38, swap: 3.1, done: 4.3 });
    expect(PAYOUT).toEqual({ stream: 0.5, paid: 1.6, done: 2.6 });
    expect(MISS).toEqual({ wave: 0.9, release: 0.12, msg: 2.05, done: 3.1 });
    expect(PLEDGE).toEqual({ step: 0.24, land: 0.38, dur: 0.5 });
    expect(BONUS).toEqual({ step: 0.3, dur: 0.6 });
    expect(REDUCED_T).toEqual({ tip: 0.7, payout: 0.7, miss: 1.3 });
  });
});

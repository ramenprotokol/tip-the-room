import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { artistMinimum, fixedTotal, splitPayout, type Party } from "../../src/core/split";

const juniper: Party[] = [
  { role: "room", label: "Spindle Records", paypalEmail: "room@example.com", fixed: 8000 },
  { role: "opener", label: "The Low Tides", paypalEmail: "opener@example.com", fixed: 10000 },
  { role: "artist", label: "Juniper Vale", paypalEmail: "artist@example.com", minimum: 30000 },
];

describe("splitPayout", () => {
  it("pays room, then opener, then the artist the rest", () => {
    const r = splitPayout(51000, juniper);
    expect(r.lines.map((l) => [l.role, l.amount])).toEqual([["room", 8000], ["opener", 10000], ["artist", 33000]]);
    expect(r.shortfall).toBe(0);
  });
  it("reports a shortfall when the artist would get less than their minimum", () => {
    const r = splitPayout(40000, juniper);
    expect(r.lines.map((l) => l.amount)).toEqual([8000, 10000, 22000]);
    expect(r.shortfall).toBe(8000);
  });
  it("pays fixed parties in order when money runs short", () => {
    const r = splitPayout(12000, juniper);
    expect(r.lines.map((l) => l.amount)).toEqual([8000, 4000, 0]);
    expect(r.shortfall).toBe(48000 - 12000);
  });
  it("computes totals", () => {
    expect(fixedTotal(juniper)).toBe(18000);
    expect(artistMinimum(juniper)).toBe(30000);
  });
  it("rejects zero or two artists, and fixed parties without an amount", () => {
    expect(() => splitPayout(100, juniper.slice(0, 2))).toThrow(/exactly one artist/);
    expect(() => splitPayout(100, [...juniper, { ...juniper[2] }])).toThrow(/exactly one artist/);
    expect(() => splitPayout(100, [{ role: "room", label: "R", paypalEmail: "r@example.com" }, juniper[2]])).toThrow(/fixed amount/);
  });
  it("never pays out more than was collected, and pays it all (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 200_000 }), (collected, room, opener) => {
        const parties: Party[] = [
          { role: "room", label: "R", paypalEmail: "r@example.com", fixed: room },
          { role: "opener", label: "O", paypalEmail: "o@example.com", fixed: opener },
          { role: "artist", label: "A", paypalEmail: "a@example.com", minimum: 0 },
        ];
        const r = splitPayout(collected, parties);
        const paid = r.lines.reduce((s, l) => s + l.amount, 0);
        expect(paid).toBe(collected);
        expect(r.lines.every((l) => Number.isInteger(l.amount) && l.amount >= 0)).toBe(true);
      }),
    );
  });
});

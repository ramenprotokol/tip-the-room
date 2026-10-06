import { describe, expect, it } from "vitest";
import { compareVersion } from "../../src/web/shared/version";

describe("compareVersion", () => {
  it("compares the event seq first, then the log seq, as numbers", () => {
    expect(compareVersion("e10.l1", "e9.l99")).toBeGreaterThan(0);
    expect(compareVersion("e3.l2", "e3.l10")).toBeLessThan(0);
    expect(compareVersion("e3.l2", "e3.l2")).toBe(0);
    expect(compareVersion("e2.l50", "e3.l1")).toBeLessThan(0);
  });
  it("treats an unknown format as newer", () => {
    expect(compareVersion("v7", "e3.l2")).toBeGreaterThan(0);
    expect(compareVersion("e3.l2", "weird")).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { NO_COPY_HINT, noCopyLine } from "../../src/web/shared/no-copy";

describe("no demo copy state", () => {
  it("a cap (429) says the limit is reached and points to the judge code", () => {
    const t = noCopyLine(429);
    expect(t).toContain("No demo copy right now");
    expect(t).toContain("today’s limit is reached");
    expect(t).toContain("judge code");
    expect(t).not.toContain("Seating");
  });
  it("an outage says the shows could not start, not a limit", () => {
    expect(noCopyLine(503)).toContain("could not start");
    expect(noCopyLine(null)).not.toContain("limit");
  });
  it("the button hint gives a reason", () => { expect(NO_COPY_HINT).toContain("demo copy"); });
});

import { describe, expect, it } from "vitest";
import { paypalClientId } from "../../src/web/shared/env";

describe("paypalClientId", () => {
  it("falls back to the public id the API sends when the build has none", () => {
    expect(paypalClientId("api-client")).toBe("api-client");
    expect(paypalClientId("  api-client ")).toBe("api-client");
    expect(paypalClientId()).toBe("");
  });
});

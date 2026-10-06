import { describe, expect, it } from "vitest";
import { assertPayPalId } from "../../src/paypal/amount";
import { SANDBOX_BASE } from "../../src/paypal/config";
import { PayPalHttp } from "../../src/paypal/http";
import { authorizeOrder, captureHold, reauthorizeHold, refundCharge, voidHold } from "../../src/paypal/payments";
import { getPayoutBatch } from "../../src/paypal/payouts";
import { fakeFetch } from "./fake-fetch";

const BAD = ["X/../../../payments/captures/C1/refund?", "A?b=1", "A%2FB", "", "a b", "x".repeat(65)];

describe("assertPayPalId", () => {
  it("accepts letters, digits and dashes up to 64", () => {
    expect(assertPayPalId("5O190127TN364715T", "id")).toBe("5O190127TN364715T");
    expect(assertPayPalId("a-b-9", "id")).toBe("a-b-9");
    expect(assertPayPalId("x".repeat(64), "id")).toBe("x".repeat(64));
  });
  it("rejects anything else with a RangeError that never echoes the id", () => {
    for (const bad of BAD) {
      try {
        assertPayPalId(bad, "capture id");
        throw new Error("did not throw");
      } catch (e) {
        expect(e).toBeInstanceOf(RangeError);
        expect((e as Error).message).toBe("capture id is not a valid PayPal id");
      }
    }
  });
});

const calls: [string, (http: PayPalHttp, id: string) => Promise<unknown>][] = [
  ["authorizeOrder", (h, id) => authorizeOrder(h, id)],
  ["captureHold", (h, id) => captureHold(h, id)],
  ["voidHold", (h, id) => voidHold(h, id)],
  ["reauthorizeHold", (h, id) => reauthorizeHold(h, id, 1500)],
  ["refundCharge", (h, id) => refundCharge(h, id)],
  ["getPayoutBatch", (h, id) => getPayoutBatch(h, id)],
];

describe("path injection", () => {
  for (const [name, fn] of calls) {
    it(`${name} rejects bad ids with RangeError and makes zero API calls`, async () => {
      for (const bad of BAD) {
        const f = fakeFetch([]);
        const http = new PayPalHttp({ clientId: "i", clientSecret: "s", baseUrl: SANDBOX_BASE }, { fetch: f.fetch, sleep: async () => {} });
        await expect(fn(http, bad)).rejects.toBeInstanceOf(RangeError);
        expect(f.calls).toHaveLength(0);
      }
    });
  }
});

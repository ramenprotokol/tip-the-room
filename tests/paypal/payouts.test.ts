import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PayoutLine } from "../../src/core/split";
import { SANDBOX_BASE } from "../../src/paypal/config";
import { PayPalError } from "../../src/paypal/errors";
import { PayPalHttp } from "../../src/paypal/http";
import { getPayoutBatch, isDuplicateBatch, payoutBatchId, sendPayouts } from "../../src/paypal/payouts";
import { fakeFetch } from "./fake-fetch";

const fixture = (name: string) => JSON.parse(readFileSync(`tests/paypal/fixtures/${name}.json`, "utf8"));
const client = (responses: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(responses);
  return { f, http: new PayPalHttp({ clientId: "i", clientSecret: "s", baseUrl: SANDBOX_BASE }, { fetch: f.fetch, sleep: async () => {} }) };
};
const lines: PayoutLine[] = [
  { role: "room", label: "Lucky's Café", paypalEmail: "room@example.com", amount: 10000 },
  { role: "opener", label: "Opener", paypalEmail: "opener@example.com", amount: 0 },
  { role: "artist", label: "Maya", paypalEmail: "maya@example.com", amount: 21250 },
];

describe("payoutBatchId", () => {
  it("is deterministic per show", () => expect(payoutBatchId("show1")).toBe("payout-show1"));
  it("rejects show ids that are empty, unsafe or too long", () => {
    for (const bad of ["", "a b", "a/b", "x".repeat(101)]) expect(() => payoutBatchId(bad)).toThrow(RangeError);
  });
});

describe("sendPayouts", () => {
  it("sends exactly the non-zero lines, with deterministic ids, and returns the batch", async () => {
    const body = fixture("payout-create");
    const { f, http } = client([{ status: 201, body }]);
    const sent = await sendPayouts(http, "show1", lines);
    expect(sent).toEqual({ batchId: body.batch_header.payout_batch_id, senderBatchId: "payout-show1", status: body.batch_header.batch_status, sentLines: [lines[0], lines[2]] });
    const call = f.apiCalls()[0];
    expect(call.url).toBe(`${SANDBOX_BASE}/v1/payments/payouts`);
    expect(call.headers["paypal-request-id"]).toBe("payout-show1");
    expect(JSON.parse(call.body!)).toEqual({
      sender_batch_header: { sender_batch_id: "payout-show1", email_subject: "Your share from Tip the Room", recipient_type: "EMAIL" },
      items: [
        { recipient_type: "EMAIL", receiver: "room@example.com", amount: { value: "100.00", currency: "USD" }, sender_item_id: "show1-room", note: "Lucky's Café: your share of the show" },
        { recipient_type: "EMAIL", receiver: "maya@example.com", amount: { value: "212.50", currency: "USD" }, sender_item_id: "show1-artist", note: "Maya: your share of the show" },
      ],
    });
  });

  it("refuses when every line is $0, without calling PayPal", async () => {
    const { f, http } = client([]);
    await expect(sendPayouts(http, "show1", [{ ...lines[1] }])).rejects.toThrow(/nothing to pay/i);
    expect(f.apiCalls()).toHaveLength(0);
  });

  it("refuses non-integer or negative amounts and duplicate roles", async () => {
    const { http } = client([]);
    await expect(sendPayouts(http, "s", [{ ...lines[0], amount: 10.5 }])).rejects.toThrow(RangeError);
    await expect(sendPayouts(http, "s", [{ ...lines[0], amount: -1 }])).rejects.toThrow(RangeError);
    await expect(sendPayouts(http, "s", [lines[0], lines[0]])).rejects.toThrow(/twice/);
  });
});

describe("isDuplicateBatch", () => {
  it("recognises the duplicate refusal recorded in payout-duplicate.json", () => {
    const rec = fixture("payout-duplicate");
    const err = new PayPalError(rec.status, rec.name, "dup", undefined, rec.issues);
    expect(isDuplicateBatch(err)).toBe(true);
  });
  it("matches on the issue text alone when the field is missing", () => {
    expect(isDuplicateBatch(new PayPalError(400, "USER_BUSINESS_ERROR", "x", undefined, [{ issue: "Batch with given Sender_Batch_Id already exists" }]))).toBe(true);
  });
  it("never matches USER_BUSINESS_ERROR on its name alone", () => {
    expect(isDuplicateBatch(new PayPalError(400, "USER_BUSINESS_ERROR", "x"))).toBe(false);
    expect(isDuplicateBatch(new PayPalError(400, "USER_BUSINESS_ERROR", "x", undefined, [{ field: "RECEIVER", issue: "Receiver is invalid" }]))).toBe(false);
  });
  it("is false for other statuses and non-PayPal errors", () => {
    const rec = fixture("payout-duplicate");
    expect(isDuplicateBatch(new PayPalError(500, "INTERNAL_SERVER_ERROR", "x"))).toBe(false);
    expect(isDuplicateBatch(new PayPalError(500, rec.name, "x", undefined, rec.issues))).toBe(false);
    expect(isDuplicateBatch(new Error("x"))).toBe(false);
    expect(isDuplicateBatch(undefined)).toBe(false);
  });
});

describe("getPayoutBatch", () => {
  it("parses the real batch status", async () => {
    const body = fixture("payout-get");
    const { http } = client([{ status: 200, body }]);
    const batch = await getPayoutBatch(http, body.batch_header.payout_batch_id);
    expect(batch.batchId).toBe(body.batch_header.payout_batch_id);
    expect(batch.senderBatchId).toBe(body.batch_header.sender_batch_header.sender_batch_id);
    expect(batch.status).toBe(body.batch_header.batch_status);
    expect(batch.items).toEqual([{ senderItemId: "spike-1791256675621-room", status: "PENDING", transactionId: undefined, amountCents: 100 }]);
  });
  it("refuses an item that isn't in USD", async () => {
    const body = fixture("payout-get");
    body.items[0].payout_item.amount.currency = "CAD";
    const { http } = client([{ status: 200, body }]);
    await expect(getPayoutBatch(http, "V8PDK75HD9EW4")).rejects.toMatchObject({ paypalName: "UNEXPECTED_CURRENCY", status: 502 });
  });
});

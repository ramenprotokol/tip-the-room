import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PayoutLine } from "../../src/core/split";
import { SANDBOX_BASE } from "../../src/paypal/config";
import { PayPalError } from "../../src/paypal/errors";
import { PayPalHttp } from "../../src/paypal/http";
import { getPayoutBatch, isDuplicateBatch, isInsufficientFunds, payoutBatchId, payoutItemId, sendPayouts } from "../../src/paypal/payouts";
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
  it("does not crash on an issue entry with no issue text", () => {
    const e = new PayPalError(400, "USER_BUSINESS_ERROR", "x", undefined, [{ field: "RECEIVER" } as never]);
    expect(isDuplicateBatch(e)).toBe(false);
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

describe("isInsufficientFunds", () => {
  it("recognises a 422 named INSUFFICIENT_FUNDS", () => {
    expect(isInsufficientFunds(new PayPalError(422, "INSUFFICIENT_FUNDS", "x"))).toBe(true);
  });
  it("recognises the issue code under a generic name", () => {
    expect(isInsufficientFunds(new PayPalError(422, "UNPROCESSABLE_ENTITY", "x", undefined, [{ issue: "INSUFFICIENT_FUNDS" }]))).toBe(true);
    expect(isInsufficientFunds(new PayPalError(400, "USER_BUSINESS_ERROR", "x", undefined, [{ field: "x", issue: "insufficient_funds" }]))).toBe(true);
  });
  it("is false for other refusals, other statuses and non-PayPal errors", () => {
    expect(isInsufficientFunds(new PayPalError(400, "USER_BUSINESS_ERROR", "x"))).toBe(false);
    expect(isInsufficientFunds(new PayPalError(422, "UNPROCESSABLE_ENTITY", "x", undefined, [{ issue: "RECEIVER_UNREGISTERED" }]))).toBe(false);
    expect(isInsufficientFunds(new PayPalError(500, "INSUFFICIENT_FUNDS", "x"))).toBe(false);
    expect(isInsufficientFunds(new Error("INSUFFICIENT_FUNDS"))).toBe(false);
    expect(isInsufficientFunds(undefined)).toBe(false);
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
  it("throws BAD_RESPONSE_BODY when payout_batch_id is missing or a different batch", async () => {
    const body = fixture("payout-get");
    body.batch_header.payout_batch_id = "OTHERBATCH";
    await expect(getPayoutBatch(client([{ status: 200, body }]).http, "V8PDK75HD9EW4")).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY", status: 502 });
    const body2 = fixture("payout-get");
    delete body2.batch_header.payout_batch_id;
    await expect(getPayoutBatch(client([{ status: 200, body: body2 }]).http, "V8PDK75HD9EW4")).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY", status: 502 });
  });
  it("throws BAD_RESPONSE_BODY when sender_batch_id is missing", async () => {
    const body = fixture("payout-get");
    delete body.batch_header.sender_batch_header.sender_batch_id;
    await expect(getPayoutBatch(client([{ status: 200, body }]).http, "V8PDK75HD9EW4")).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY", status: 502 });
  });
  it("refuses an item that isn't in USD", async () => {
    const body = fixture("payout-get");
    body.items[0].payout_item.amount.currency = "CAD";
    const { http } = client([{ status: 200, body }]);
    await expect(getPayoutBatch(http, "V8PDK75HD9EW4")).rejects.toMatchObject({ paypalName: "UNEXPECTED_CURRENCY", status: 502 });
  });
});

describe("retry batch ids", () => {
  it("names the one retry batch and its items with -r1", () => {
    expect(payoutBatchId("show1", true)).toBe("payout-show1-r1");
    expect(payoutItemId("show1", "room")).toBe("show1-room");
    expect(payoutItemId("show1", "room", true)).toBe("show1-room-r1");
  });
  it("refuses an item id longer than 63 characters", () => {
    expect(() => payoutItemId("x".repeat(60), "artist")).toThrow(RangeError);
  });
  it("sends the retry batch with -r1 ids", async () => {
    const body = fixture("payout-create");
    const { f, http } = client([{ status: 201, body }]);
    const sent = await sendPayouts(http, "show1", [lines[0]], { retry: true });
    expect(sent.senderBatchId).toBe("payout-show1-r1");
    const call = f.apiCalls()[0];
    expect(call.headers["paypal-request-id"]).toBe("payout-show1-r1");
    expect(JSON.parse(call.body!).items[0].sender_item_id).toBe("show1-room-r1");
  });
});

describe("payout validation", () => {
  it("refuses a line without a valid PayPal email, without calling PayPal", async () => {
    const { f, http } = client([]);
    await expect(sendPayouts(http, "s", [{ ...lines[0], paypalEmail: "not-an-email" }])).rejects.toThrow(/PayPal email/);
    expect(f.apiCalls()).toHaveLength(0);
  });
  it("throws when PayPal's answer has no payout_batch_id", async () => {
    const { http } = client([{ status: 201, body: { batch_header: { batch_status: "PENDING" } } }]);
    await expect(sendPayouts(http, "s", [lines[0]])).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY" });
  });
  it("throws when a batch item has no sender_item_id", async () => {
    const body = fixture("payout-get");
    delete body.items[0].payout_item.sender_item_id;
    const { http } = client([{ status: 200, body }]);
    await expect(getPayoutBatch(http, "V8PDK75HD9EW4")).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY" });
  });
});

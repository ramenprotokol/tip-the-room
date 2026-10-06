import { describe, expect, it } from "vitest";
import { PayPalError } from "../../src/paypal/errors";
import { SANDBOX_BASE } from "../../src/paypal/config";
import { PayPalHttp } from "../../src/paypal/http";
import { mapWebhookEvent, verifyWebhook, type WebhookEvent } from "../../src/paypal/webhooks";
import { fakeFetch } from "./fake-fetch";

const client = (responses: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(responses);
  return { f, http: new PayPalHttp({ clientId: "i", clientSecret: "s", baseUrl: SANDBOX_BASE }, { fetch: f.fetch, sleep: async () => {} }) };
};
const sigHeaders = () =>
  new Headers({
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "T1",
    "paypal-transmission-sig": "SIG",
    "paypal-transmission-time": "2026-10-05T12:00:00Z",
  });
const raw = JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "2026-10-05T12:00:00Z", resource: { id: "C1" } });

describe("verifyWebhook", () => {
  it.each(["", "   "])("throws RangeError for an empty webhook id %j before any call", async (id) => {
    const { f, http } = client([]);
    const err = await verifyWebhook(http, sigHeaders(), raw, id).catch((e) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect(err.message).toBe("PAYPAL_WEBHOOK_ID is not set");
    expect(f.calls).toHaveLength(0);
  });
  it("asks PayPal to verify and returns true on SUCCESS", async () => {
    const { f, http } = client([{ status: 200, body: { verification_status: "SUCCESS" } }]);
    expect(await verifyWebhook(http, sigHeaders(), raw, "WHID")).toBe(true);
    const call = f.apiCalls()[0];
    expect(call.url).toBe(`${SANDBOX_BASE}/v1/notifications/verify-webhook-signature`);
    expect(JSON.parse(call.body!)).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      transmission_id: "T1",
      transmission_sig: "SIG",
      transmission_time: "2026-10-05T12:00:00Z",
      webhook_id: "WHID",
      webhook_event: JSON.parse(raw),
    });
  });
  it("returns false on FAILURE", async () => {
    const { http } = client([{ status: 200, body: { verification_status: "FAILURE" } }]);
    expect(await verifyWebhook(http, sigHeaders(), raw, "WHID")).toBe(false);
  });
  it("returns false without calling PayPal when a signature header is missing", async () => {
    const { f, http } = client([]);
    const h = sigHeaders();
    h.delete("paypal-transmission-sig");
    expect(await verifyWebhook(http, h, raw, "WHID")).toBe(false);
    expect(f.apiCalls()).toHaveLength(0);
  });
  it("returns false on a body that is not JSON", async () => {
    const { f, http } = client([]);
    expect(await verifyWebhook(http, sigHeaders(), "not json", "WHID")).toBe(false);
    expect(f.apiCalls()).toHaveLength(0);
  });
  it("lets a 5xx from the verify endpoint propagate so the Worker can answer 5xx", async () => {
    const { http } = client([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }]);
    await expect(verifyWebhook(http, sigHeaders(), raw, "WHID")).rejects.toBeInstanceOf(PayPalError);
  });
  it("rejects a cert URL that is not on a paypal.com host", async () => {
    const { f, http } = client([]);
    const h = sigHeaders();
    h.set("paypal-cert-url", "https://evil.example/cert");
    expect(await verifyWebhook(http, h, raw, "WHID")).toBe(false);
    expect(f.apiCalls()).toHaveLength(0);
  });
  it.each([
    "https://api.paypal.com.evil.example/c",
    "https://paypal.com@evil.example/c",
    "https://evilpaypal.com/c",
    "http://api.paypal.com/c",
  ])("rejects look-alike or insecure cert URL %s with no API call", async (url) => {
    const { f, http } = client([]);
    const h = sigHeaders();
    h.set("paypal-cert-url", url);
    expect(await verifyWebhook(http, h, raw, "WHID")).toBe(false);
    expect(f.apiCalls()).toHaveLength(0);
  });
});

const ev = (event_type: string, resource: Record<string, unknown>): WebhookEvent => ({ id: "WH-9", event_type, create_time: "2026-10-05T12:00:00Z", resource });
const at = Date.parse("2026-10-05T12:00:00Z");

describe("mapWebhookEvent", () => {
  it.each([
    ["PAYMENT.AUTHORIZATION.CREATED", { id: "A1", amount: { value: "15.00" }, custom_id: "show1:p7" }, { kind: "hold_created", ref: "A1", amountCents: 1500, customId: "show1:p7" }],
    ["PAYMENT.AUTHORIZATION.VOIDED", { id: "A1", custom_id: "show1:p7" }, { kind: "hold_voided", ref: "A1", customId: "show1:p7" }],
    ["PAYMENT.CAPTURE.COMPLETED", { id: "C1", amount: { value: "15.00" }, custom_id: "show1:p7" }, { kind: "charged", ref: "C1", amountCents: 1500, customId: "show1:p7" }],
    ["PAYMENT.CAPTURE.DENIED", { id: "C2", amount: { value: "15.00" } }, { kind: "charge_failed", ref: "C2", amountCents: 1500 }],
    ["PAYMENT.CAPTURE.DECLINED", { id: "C3" }, { kind: "charge_failed", ref: "C3" }],
    ["PAYMENT.CAPTURE.REFUNDED", { id: "C1", amount: { value: "15.00" } }, { kind: "refunded", ref: "C1", amountCents: 1500 }],
    ["PAYMENT.PAYOUTSBATCH.SUCCESS", { batch_header: { payout_batch_id: "B1" } }, { kind: "payout_batch_done", ref: "B1" }],
    ["PAYMENT.PAYOUTSBATCH.SUCCESS", { batch_header: { payout_batch_id: "B2", sender_batch_header: { sender_batch_id: "payout-show1" } } }, { kind: "payout_batch_done", ref: "B2", customId: "payout-show1" }],
    ["PAYMENT.PAYOUTSBATCH.DENIED", { batch_header: { payout_batch_id: "B1" } }, { kind: "payout_batch_failed", ref: "B1" }],
    ["PAYMENT.PAYOUTSBATCH.DENIED", { batch_header: { payout_batch_id: "B3", sender_batch_header: { sender_batch_id: "payout-show1" } } }, { kind: "payout_batch_failed", ref: "B3", customId: "payout-show1" }],
    ["PAYMENT.PAYOUTS-ITEM.SUCCEEDED", { payout_item_id: "I1", payout_item: { amount: { value: "100.00" }, sender_item_id: "show1-room" } }, { kind: "payout_item_paid", ref: "I1", amountCents: 10000, customId: "show1-room" }],
    ["PAYMENT.PAYOUTS-ITEM.FAILED", { payout_item_id: "I2", payout_item: { sender_item_id: "show1-room" } }, { kind: "payout_item_failed", ref: "I2", customId: "show1-room" }],
    ["PAYMENT.CAPTURE.REVERSED", { id: "C1", amount: { value: "15.00" }, custom_id: "show1:p7" }, { kind: "charge_reversed", ref: "C1", amountCents: 1500, customId: "show1:p7" }],
    ["PAYMENT.PAYOUTS-ITEM.UNCLAIMED", { payout_item_id: "I-UNCLAIMED", payout_item: { amount: { value: "100.00" }, sender_item_id: "show1-room" } }, { kind: "payout_item_pending", ref: "I-UNCLAIMED", amountCents: 10000, customId: "show1-room" }],
    ["PAYMENT.PAYOUTS-ITEM.HELD", { payout_item_id: "I-HELD", payout_item: { amount: { value: "100.00" }, sender_item_id: "show1-room" } }, { kind: "payout_item_pending", ref: "I-HELD", amountCents: 10000, customId: "show1-room" }],
    ["PAYMENT.PAYOUTS-ITEM.RETURNED", { payout_item_id: "I-RETURNED", payout_item: { amount: { value: "100.00" }, sender_item_id: "show1-room" } }, { kind: "payout_item_failed", ref: "I-RETURNED", amountCents: 10000, customId: "show1-room" }],
    ["PAYMENT.PAYOUTS-ITEM.BLOCKED", { payout_item_id: "I-BLOCKED", payout_item: { amount: { value: "100.00" }, sender_item_id: "show1-room" } }, { kind: "payout_item_failed", ref: "I-BLOCKED", amountCents: 10000, customId: "show1-room" }],
    ["PAYMENT.PAYOUTS-ITEM.DENIED", { payout_item_id: "I-DENIED", payout_item: { amount: { value: "100.00" }, sender_item_id: "show1-room" } }, { kind: "payout_item_failed", ref: "I-DENIED", amountCents: 10000, customId: "show1-room" }],
    ["PAYMENT.PAYOUTS-ITEM.CANCELED", { payout_item_id: "I-CANCELED", payout_item: { amount: { value: "100.00" }, sender_item_id: "show1-room" } }, { kind: "payout_item_failed", ref: "I-CANCELED", amountCents: 10000, customId: "show1-room" }],
    ["PAYMENT.PAYOUTS-ITEM.REFUNDED", { payout_item_id: "I-REFUNDED", payout_item: { amount: { value: "100.00" }, sender_item_id: "show1-room" } }, { kind: "payout_item_failed", ref: "I-REFUNDED", amountCents: 10000, customId: "show1-room" }],
  ])("%s", (type, resource, expected) => {
    expect(mapWebhookEvent(ev(type, resource))).toEqual({ eventId: "WH-9", at, ...expected });
  });

  it("ignores event types we don't use", () => expect(mapWebhookEvent(ev("CHECKOUT.ORDER.APPROVED", { id: "O1" }))).toBeNull());
  it("ignores events with no usable reference", () => expect(mapWebhookEvent(ev("PAYMENT.CAPTURE.COMPLETED", {}))).toBeNull());

  it("throws UNEXPECTED_CURRENCY for a non-USD amount", () => {
    expect(() => mapWebhookEvent(ev("PAYMENT.CAPTURE.COMPLETED", { id: "C1", amount: { value: "15.00", currency_code: "CAD" } }))).toThrow(/UNEXPECTED_CURRENCY.*PAYMENT\.CAPTURE\.COMPLETED.*CAD/);
    try {
      mapWebhookEvent(ev("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", { payout_item_id: "I1", payout_item: { amount: { value: "1.00", currency: "EUR" } } }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PayPalError).status).toBe(502);
      expect((e as PayPalError).paypalName).toBe("UNEXPECTED_CURRENCY");
    }
  });
  it("accepts USD and a missing currency", () => {
    expect(mapWebhookEvent(ev("PAYMENT.CAPTURE.COMPLETED", { id: "C1", amount: { value: "15.00", currency_code: "USD" } }))?.amountCents).toBe(1500);
    expect(mapWebhookEvent(ev("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", { payout_item_id: "I1", payout_item: { amount: { value: "1.00", currency: "USD" } } }))?.amountCents).toBe(100);
    expect(mapWebhookEvent(ev("PAYMENT.CAPTURE.COMPLETED", { id: "C1", amount: { value: "15.00" } }))?.amountCents).toBe(1500);
  });
  it("returns null when the event id is missing or empty", () => {
    expect(mapWebhookEvent({ id: "", event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "2026-10-05T12:00:00Z", resource: { id: "C1" } })).toBeNull();
    expect(mapWebhookEvent({ event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "2026-10-05T12:00:00Z", resource: { id: "C1" } } as unknown as WebhookEvent)).toBeNull();
    expect(mapWebhookEvent({ id: 5, event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "2026-10-05T12:00:00Z", resource: { id: "C1" } } as unknown as WebhookEvent)).toBeNull();
  });
  it.each([
    ["PAYMENT.CAPTURE.COMPLETED", { id: "C1", amount: { currency_code: "USD" } }],
    ["PAYMENT.CAPTURE.COMPLETED", { id: "C1", amount: { value: "" } }],
    ["PAYMENT.PAYOUTS-ITEM.SUCCEEDED", { payout_item_id: "I1", payout_item: { amount: { currency: "USD" } } }],
    ["PAYMENT.PAYOUTS-ITEM.FAILED", { payout_item_id: "I1", payout_item: { amount: { value: "" } } }],
  ])("throws BAD_AMOUNT when %s has an amount object with no value", (type, resource) => {
    try {
      mapWebhookEvent(ev(type, resource));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PayPalError);
      expect((e as PayPalError).status).toBe(502);
      expect((e as PayPalError).paypalName).toBe("BAD_AMOUNT");
      expect((e as PayPalError).message).toContain(type);
    }
  });
  it("returns null when create_time is missing or unparseable", () => {
    expect(mapWebhookEvent({ id: "W", event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "garbage", resource: { id: "C1" } })).toBeNull();
    expect(mapWebhookEvent({ id: "W", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "C1" } } as unknown as WebhookEvent)).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SANDBOX_BASE } from "../../src/paypal/config";
import { PayPalError } from "../../src/paypal/errors";
import { PayPalHttp } from "../../src/paypal/http";
import { authorizeOrder, captureHold, createCardHold, createPledgeOrder, getAuthorization, getCapture, getOrderPayments, reauthorizeHold, refundCharge, requestIds, voidHold } from "../../src/paypal/payments";
import { fakeFetch } from "./fake-fetch";

const fixture = (name: string) => JSON.parse(readFileSync(`tests/paypal/fixtures/${name}.json`, "utf8"));
const client = (responses: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(responses);
  return { f, http: new PayPalHttp({ clientId: "i", clientSecret: "s", baseUrl: SANDBOX_BASE }, { fetch: f.fetch, sleep: async () => {} }) };
};
const pledge = { showId: "show1", pledgeId: "p7", amountCents: 1500, description: "Hold for Lucky's Café show" };
const card = { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Simulated Fan" };

describe("request ids", () => {
  it("are deterministic and within 108 chars", () => {
    expect(requestIds.hold("show1", "p7")).toBe("hold:show1:p7");
    expect(requestIds.capture("A1")).toBe("capture:A1");
    expect(requestIds.void("A1")).toBe("void:A1");
    expect(requestIds.reauthorize("A1")).toBe("reauth:A1");
    expect(requestIds.refund("C1")).toBe("refund:C1");
    expect(requestIds.authorize("O1")).toBe("authorize:O1");
  });
});

describe("createPledgeOrder", () => {
  it("creates an AUTHORIZE order in USD with the pledge as custom_id", async () => {
    const { f, http } = client([{ status: 201, body: { id: "O1", status: "CREATED" } }]);
    expect(await createPledgeOrder(http, pledge)).toEqual({ orderId: "O1" });
    const call = f.apiCalls()[0];
    expect(call.url).toBe(`${SANDBOX_BASE}/v2/checkout/orders`);
    expect(call.headers["paypal-request-id"]).toBe("order:show1:p7");
    expect(JSON.parse(call.body!)).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: "show1", custom_id: "show1:p7", description: "Hold for Lucky's Café show", amount: { currency_code: "USD", value: "15.00" } }],
    });
  });
});

describe("createCardHold", () => {
  it("parses the real sandbox card order into a Hold", async () => {
    const body = fixture("order-card-authorize");
    const { f, http } = client([{ status: 201, body }]);
    const hold = await createCardHold(http, pledge, card);
    const auth = body.purchase_units[0].payments.authorizations[0];
    expect(hold).toEqual({
      authorizationId: auth.id,
      orderId: body.id,
      amountCents: 1500,
      status: auth.status,
      createdAt: Date.parse(auth.create_time),
      expiresAt: Date.parse(auth.expiration_time),
      customId: auth.custom_id,
    });
    expect(f.apiCalls()[0].headers["paypal-request-id"]).toBe("hold:show1:p7");
    expect(JSON.parse(f.apiCalls()[0].body!).payment_source.card).toEqual({ number: card.number, expiry: card.expiry, security_code: "123", name: card.name });
  });

  it("authorizes explicitly when the order comes back without an authorization", async () => {
    const authorized = fixture("order-card-authorize");
    const { f, http } = client([{ status: 201, body: { id: authorized.id, status: "APPROVED" } }, { status: 201, body: authorized }]);
    const hold = await createCardHold(http, pledge, card);
    expect(hold.orderId).toBe(authorized.id);
    expect(f.apiCalls()[1].url).toBe(`${SANDBOX_BASE}/v2/checkout/orders/${authorized.id}/authorize`);
    expect(f.apiCalls()[1].headers["paypal-request-id"]).toBe(`authorize:${authorized.id}`);
  });

  it("throws when PayPal returns no authorization at all", async () => {
    const { http } = client([{ status: 201, body: { id: "O9", status: "APPROVED" } }, { status: 201, body: { id: "O9", status: "APPROVED" } }]);
    await expect(createCardHold(http, pledge, card)).rejects.toThrow(/O9/);
  });
});

describe("authorizeOrder", () => {
  it("authorizes a buyer-approved order", async () => {
    const body = fixture("order-card-authorize");
    const { f, http } = client([{ status: 201, body }]);
    const hold = await authorizeOrder(http, body.id);
    expect(hold.orderId).toBe(body.id);
    expect(f.apiCalls()[0].headers["paypal-request-id"]).toBe(`authorize:${body.id}`);
  });
  it("an empty 2xx throws the non-retryable EMPTY_RESPONSE_BODY", async () => {
    const { http } = client([{ status: 201 }]);
    const err = (await authorizeOrder(http, "O9").catch((e) => e)) as PayPalError;
    expect(err.paypalName).toBe("EMPTY_RESPONSE_BODY");
    expect(err.retryable).toBe(false);
  });
  it("a body without authorizations throws BAD_RESPONSE_BODY 502 naming the order", async () => {
    const { http } = client([{ status: 201, body: { id: "O9", status: "PAYER_ACTION_REQUIRED" } }]);
    const err = (await authorizeOrder(http, "O9").catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ paypalName: "BAD_RESPONSE_BODY", status: 502 });
    expect(err.message).toContain("O9");
    expect(err.message).toContain("PAYER_ACTION_REQUIRED");
  });
});

describe("captureHold", () => {
  it("parses the real capture, including gross, fee and net", async () => {
    const body = fixture("capture");
    const { f, http } = client([{ status: 201, body }]);
    const charge = await captureHold(http, "AUTH1");
    expect(charge.captureId).toBe(body.id);
    expect(charge.authorizationId).toBe("AUTH1");
    expect(charge.status).toBe(body.status);
    const b = body.seller_receivable_breakdown;
    if (b) {
      expect(charge.grossCents).toBe(Math.round(Number(b.gross_amount.value) * 100));
      expect(charge.netCents).toBe(Math.round(Number(b.net_amount.value) * 100));
      expect(charge.grossCents! - charge.feeCents!).toBe(charge.netCents);
    }
    const call = f.apiCalls()[0];
    expect(call.url).toBe(`${SANDBOX_BASE}/v2/payments/authorizations/AUTH1/capture`);
    expect(call.headers["paypal-request-id"]).toBe("capture:AUTH1");
    expect(call.headers["prefer"]).toBe("return=representation");
    expect(JSON.parse(call.body!)).toEqual({ final_capture: true });
  });

  it("leaves net undefined when PayPal returns no breakdown (e.g. PENDING)", async () => {
    const { http } = client([{ status: 201, body: { id: "C2", status: "PENDING" } }]);
    expect(await captureHold(http, "A2")).toEqual({ captureId: "C2", authorizationId: "A2", status: "PENDING", grossCents: undefined, feeCents: undefined, netCents: undefined });
  });

  it("surfaces PayPal refusals as PayPalError", async () => {
    const { http } = client([{ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_VOIDED" }] } }]);
    const err = (await captureHold(http, "A3").catch((e) => e)) as PayPalError;
    expect(err.hasIssue("AUTHORIZATION_VOIDED")).toBe(true);
  });
});

describe("voidHold", () => {
  it("voids with a deterministic request id and accepts 204 or 200", async () => {
    const { f, http } = client([{ status: 204 }, { status: 200, body: { id: "A5", status: "VOIDED" } }]);
    await voidHold(http, "A4");
    await voidHold(http, "A5");
    expect(f.apiCalls().map((c) => [c.url, c.headers["paypal-request-id"]])).toEqual([
      [`${SANDBOX_BASE}/v2/payments/authorizations/A4/void`, "void:A4"],
      [`${SANDBOX_BASE}/v2/payments/authorizations/A5/void`, "void:A5"],
    ]);
  });
});

describe("reauthorizeHold", () => {
  it("returns the NEW authorization as a Hold", async () => {
    const { f, http } = client([{ status: 201, body: { id: "A6new", status: "CREATED", amount: { currency_code: "USD", value: "15.00" }, create_time: "2026-10-09T10:00:00Z", expiration_time: "2026-11-07T10:00:00Z" } }]);
    const hold = await reauthorizeHold(http, "A6", 1500);
    expect(hold).toMatchObject({ authorizationId: "A6new", amountCents: 1500, createdAt: Date.parse("2026-10-09T10:00:00Z") });
    expect(f.apiCalls()[0].headers["paypal-request-id"]).toBe("reauth:A6");
    expect(JSON.parse(f.apiCalls()[0].body!)).toEqual({ amount: { currency_code: "USD", value: "15.00" } });
  });

  it("surfaces the day-0 refusal recorded in the spike", async () => {
    const rec = fixture("reauthorize-error");
    const { http } = client([{ status: rec.status, body: { name: rec.name, details: rec.issues } }]);
    await expect(reauthorizeHold(http, "A7", 1500)).rejects.toBeInstanceOf(PayPalError);
  });
});

describe("refundCharge", () => {
  it("refunds the full capture with a deterministic request id", async () => {
    const body = fixture("refund");
    const { f, http } = client([{ status: 201, body }]);
    expect(await refundCharge(http, "C9")).toEqual({ refundId: body.id, captureId: "C9", status: body.status });
    expect(f.apiCalls()[0].url).toBe(`${SANDBOX_BASE}/v2/payments/captures/C9/refund`);
    expect(f.apiCalls()[0].headers["paypal-request-id"]).toBe("refund:C9");
  });
});

describe("currency and extra-field rules", () => {
  it("rejects a capture whose net is not USD", async () => {
    const body = fixture("capture");
    body.seller_receivable_breakdown.net_amount.currency_code = "CAD";
    const { http } = client([{ status: 201, body }]);
    const err = (await captureHold(http, "A8").catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.paypalName).toBe("UNEXPECTED_CURRENCY");
    expect(err.message).toMatch(/net_amount.*CAD/);
  });

  it("rejects an authorization amount that is not USD", async () => {
    const body = fixture("order-card-authorize");
    body.purchase_units[0].payments.authorizations[0].amount.currency_code = "CAD";
    const { http } = client([{ status: 201, body }]);
    const err = (await createCardHold(http, pledge, card).catch((e) => e)) as PayPalError;
    expect(err.paypalName).toBe("UNEXPECTED_CURRENCY");
  });

  it("derives the fee as gross minus net when paypal_fee is absent", async () => {
    const body = fixture("capture");
    delete body.seller_receivable_breakdown.paypal_fee;
    const { http } = client([{ status: 201, body }]);
    const c = await captureHold(http, "A9");
    expect(c.feeCents).toBe(88);
    expect(c.netCents).toBe(1412);
  });

  it("takes the fee from paypal_fee and ignores unknown fields", async () => {
    const { http } = client([{ status: 201, body: { ...fixture("capture"), brand_new_field: { x: 1 } } }]);
    const c = await captureHold(http, "A10");
    expect(c).toEqual({ captureId: "9MG27632DY398671M", authorizationId: "A10", status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 });
  });
});

describe("empty 2xx bodies", () => {
  it("createPledgeOrder throws EMPTY_RESPONSE_BODY instead of a TypeError", async () => {
    const { http } = client([{ status: 201 }]);
    await expect(createPledgeOrder(http, pledge)).rejects.toMatchObject({ paypalName: "EMPTY_RESPONSE_BODY", status: 502 });
  });
  it("captureHold throws EMPTY_RESPONSE_BODY and it is not retryable", async () => {
    const { http } = client([{ status: 201 }]);
    const err = (await captureHold(http, "A1").catch((e) => e)) as PayPalError;
    expect(err.paypalName).toBe("EMPTY_RESPONSE_BODY");
    expect(err.retryable).toBe(false);
  });
});

describe("Hold.customId", () => {
  it("comes from the authorization, falling back to the purchase unit", async () => {
    const body = fixture("order-card-authorize");
    delete body.purchase_units[0].payments.authorizations[0].custom_id;
    const { http } = client([{ status: 201, body }]);
    const hold = await createCardHold(http, pledge, card);
    expect(hold.customId).toBe(body.purchase_units[0].custom_id);
  });
  it("is absent when PayPal sends none", async () => {
    const body = fixture("order-card-authorize");
    delete body.purchase_units[0].payments.authorizations[0].custom_id;
    delete body.purchase_units[0].custom_id;
    const { http } = client([{ status: 201, body }]);
    expect((await createCardHold(http, pledge, card)).customId).toBeUndefined();
  });
});

describe("getOrderPayments", () => {
  it("lists the order's authorizations and captures", async () => {
    const { f, http } = client([{ status: 200, body: { id: "O1", status: "COMPLETED", purchase_units: [{ custom_id: "s:p", payments: { authorizations: [{ id: "A1", status: "CAPTURED" }], captures: [{ id: "C1", status: "COMPLETED" }] } }] } }]);
    expect(await getOrderPayments(http, "O1")).toEqual({ orderId: "O1", status: "COMPLETED", customId: "s:p", authorizations: [{ id: "A1", status: "CAPTURED" }], captures: [{ id: "C1", status: "COMPLETED" }] });
    expect(f.apiCalls()[0]).toMatchObject({ method: "GET", url: `${SANDBOX_BASE}/v2/checkout/orders/O1` });
  });
  it("returns empty lists when the order has no payments yet", async () => {
    const { http } = client([{ status: 200, body: { id: "O2", status: "CREATED" } }]);
    expect(await getOrderPayments(http, "O2")).toEqual({ orderId: "O2", status: "CREATED", authorizations: [], captures: [] });
  });
  it("throws BAD_RESPONSE_BODY when the id is missing or is a different order", async () => {
    const a = client([{ status: 200, body: { id: "OTHER", status: "CREATED" } }]);
    await expect(getOrderPayments(a.http, "O1")).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY", status: 502 });
    const b = client([{ status: 200, body: { status: "CREATED" } }]);
    await expect(getOrderPayments(b.http, "O1")).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY", status: 502 });
  });
  it("refuses an unsafe id before any call", async () => {
    const { f, http } = client([]);
    await expect(getOrderPayments(http, "../x")).rejects.toBeInstanceOf(RangeError);
    expect(f.apiCalls()).toHaveLength(0);
  });
});

describe("getAuthorization", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    id: "AUTH1",
    status: "CREATED",
    amount: { currency_code: "USD", value: "15.00" },
    create_time: "2026-11-01T00:00:00Z",
    expiration_time: "2026-11-30T00:00:00Z",
    custom_id: "sshow:p1",
    supplementary_data: { related_ids: { order_id: "ORDER1" } },
    ...over,
  });
  it("reads one authorization in full with a plain GET", async () => {
    const { f, http } = client([{ status: 200, body: body() }]);
    expect(await getAuthorization(http, "AUTH1", "ORDER1")).toMatchObject({ authorizationId: "AUTH1", orderId: "ORDER1", amountCents: 1500, status: "CREATED", customId: "sshow:p1" });
    expect(f.apiCalls()[0]).toMatchObject({ method: "GET", url: `${SANDBOX_BASE}/v2/payments/authorizations/AUTH1` });
    expect(f.apiCalls()[0].headers["paypal-request-id"]).toBeUndefined();
  });
  it("refuses an authorization that belongs to another order", async () => {
    const { http } = client([{ status: 200, body: body({ supplementary_data: { related_ids: { order_id: "OTHER" } } }) }]);
    await expect(getAuthorization(http, "AUTH1", "ORDER1")).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY" });
  });
  it("refuses an answer for a different authorization", async () => {
    const { http } = client([{ status: 200, body: body({ id: "AUTH2" }) }]);
    await expect(getAuthorization(http, "AUTH1", "ORDER1")).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY" });
  });
  it("turns a body missing its times into a PayPalError", async () => {
    const { http } = client([{ status: 200, body: body({ create_time: undefined }) }]);
    const err = await getAuthorization(http, "AUTH1", "ORDER1").catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ paypalName: "BAD_RESPONSE_BODY" });
  });
  it("refuses an unsafe id before any call", async () => {
    const { f, http } = client([]);
    await expect(getAuthorization(http, "../x", "ORDER1")).rejects.toBeInstanceOf(RangeError);
    expect(f.apiCalls()).toHaveLength(0);
  });
});

describe("getCapture", () => {
  it("parses gross, fee and net like captureHold", async () => {
    const body = fixture("capture");
    const { f, http } = client([{ status: 200, body }]);
    const c = await getCapture(http, body.id, "4SA6877655874993N");
    expect(c).toEqual({ captureId: body.id, authorizationId: "4SA6877655874993N", status: "COMPLETED", grossCents: 1500, feeCents: 88, netCents: 1412 });
    expect(f.apiCalls()[0]).toMatchObject({ method: "GET", url: `${SANDBOX_BASE}/v2/payments/captures/${body.id}` });
  });
  it("throws BAD_RESPONSE_BODY when the capture belongs to a different authorization", async () => {
    const body = fixture("capture");
    const { http } = client([{ status: 200, body }]);
    await expect(getCapture(http, body.id, "A11")).rejects.toMatchObject({ paypalName: "BAD_RESPONSE_BODY", status: 502 });
  });
});

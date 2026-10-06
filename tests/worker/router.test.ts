import { describe, expect, it } from "vitest";
import type { AuthorizeResponse, CreateOrderResponse, CreateShowResponse, ManageView, PublicShow, SignResponse } from "../../src/worker/api-types";
import { LIMITS, route } from "../../src/worker/router";
import { workerHarness } from "./harness";

const SENTENCE = "Acoustic set at Lucky's Café, Nov 20, $15 tickets, café wants $100, I need $200";

async function createAndSign(w: ReturnType<typeof workerHarness>) {
  const created = await w.call("POST", "/api/shows", { sentence: SENTENCE, deadline: "2026-11-08T00:00:00Z", emails: { room: "room@example.com", artist: "maya@example.com" } });
  const c = (await created.json()) as CreateShowResponse;
  const signed = await w.call("POST", `/api/shows/${c.showId}/sign`, { signToken: c.signToken, draft: c.draft });
  return { created, c, signed, s: (await signed.json()) as SignResponse };
}

describe("router", () => {
  it("answers health", async () => {
    const res = await workerHarness().call("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("creates a draft (code computes the target), signs it once, and serves the public show without emails", async () => {
    const w = workerHarness();
    const { created, c, signed, s } = await createAndSign(w);
    expect(created.status).toBe(201);
    expect(c).toMatchObject({ threshold: 21, problems: [], source: "template", draft: { showName: "Acoustic set", ticketPriceCents: 1500 } });
    expect(signed.status).toBe(200);
    expect(s.manageKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const show = await w.call("GET", `/api/shows/${c.showId}`);
    const text = await show.text();
    expect(show.status).toBe(200);
    expect(text).not.toContain("@");
    expect((JSON.parse(text) as PublicShow).threshold).toBe(21);
  });

  it("refuses a too-short sentence", async () => {
    const res = await workerHarness().call("POST", "/api/shows", { sentence: "hi" });
    expect(res.status).toBe(422);
  });

  it("answers 404 for bad and unknown show ids without touching a campaign", async () => {
    const w = workerHarness();
    expect((await w.call("GET", "/api/shows/NOT-AN-ID")).status).toBe(404);
    const unknown = await w.call("GET", "/api/shows/sabcdefghjk");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: "not_found", message: "There's no show here." } });
  });

  it("takes a pledge end to end and never authorizes an order id the show didn't create", async () => {
    const w = workerHarness();
    const { c } = await createAndSign(w);
    const orderRes = await w.call("POST", `/api/shows/${c.showId}/orders`, { initials: "AB" });
    expect(orderRes.status).toBe(201);
    const order = (await orderRes.json()) as CreateOrderResponse;
    const auth = await w.call("POST", `/api/shows/${c.showId}/orders/${order.orderId}/authorize`);
    expect(auth.status).toBe(200);
    expect(((await auth.json()) as AuthorizeResponse).show.fans.committed).toBe(1);
    const forged = await w.call("POST", `/api/shows/${c.showId}/orders/5O190127TN364715T/authorize`);
    expect(forged.status).toBe(404);
    expect(w.paypal.count("authorizeOrder")).toBe(1);
  });

  it("guards the manage view and the artist's actions with the manage key header", async () => {
    const w = workerHarness();
    const { c, s } = await createAndSign(w);
    expect((await w.call("GET", `/api/shows/${c.showId}/manage`)).status).toBe(403);
    const ok = await w.call("GET", `/api/shows/${c.showId}/manage`, undefined, { "x-manage-key": s.manageKey });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ManageView).parties[0].paypalEmail).toBe("room@example.com");
    expect((await w.call("POST", `/api/shows/${c.showId}/call-off`)).status).toBe(403);
    expect((await w.call("POST", `/api/shows/${c.showId}/proposals/pace1/approve`, { option: "extend" })).status).toBe(403);
  });

  it("carries the show's clock, a change marker, the share path and the sign-link flag", async () => {
    const w = workerHarness();
    const { c, s } = await createAndSign(w);
    const key = { "x-manage-key": s.manageKey };
    const read = async () => (await (await w.call("GET", `/api/shows/${c.showId}/manage`, undefined, key)).json()) as ManageView;
    const before = await read();
    expect(before.now).toBe(w.clock.now());
    expect(before.show.now).toBe(w.clock.now());
    expect(before.sharePath).toBe(`/s/${c.showId}`);
    expect(before.signLinkExpired).toBe(false);
    expect(before.version).toMatch(/^e\d+\.l\d+$/);
    expect(before.version).toBe(before.show.version);
    const pub = async () => ((await (await w.call("GET", `/api/shows/${c.showId}`)).json()) as PublicShow).version;
    expect(await pub()).toBe(before.version);
    const order = (await (await w.call("POST", `/api/shows/${c.showId}/orders`, { initials: "AB" })).json()) as CreateOrderResponse;
    await w.call("POST", `/api/shows/${c.showId}/orders/${order.orderId}/authorize`);
    expect(await pub()).not.toBe(before.version);
  });

  it("allows 1,500 manage reads an hour per visitor", () => {
    expect(LIMITS.manage).toEqual({ limit: 1500, windowMs: 60 * 60 * 1000 });
  });

  it("rate-limits each visitor and says when to retry", async () => {
    const w = workerHarness();
    for (let i = 0; i < 10; i++) expect((await w.call("POST", "/api/shows", { sentence: SENTENCE })).status).toBe(201);
    const limited = await w.call("POST", "/api/shows", { sentence: SENTENCE });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited", retryAfterSec: 3600 } });
    expect((await w.call("POST", "/api/shows", { sentence: SENTENCE }, { "cf-connecting-ip": "203.0.113.9" })).status).toBe(201);
  });

  it("refuses invalid JSON and oversized bodies", async () => {
    const w = workerHarness();
    expect((await w.call("POST", "/api/shows", "{not json")).status).toBe(400);
    expect((await w.call("POST", "/api/shows", JSON.stringify({ sentence: "x".repeat(17_000) }))).status).toBe(413);
  });

  it("sends CORS headers only to allowed origins and answers preflight", async () => {
    const w = workerHarness();
    const allowed = await w.call("GET", "/api/health", undefined, { origin: "http://localhost:5173" });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await w.call("GET", "/api/health", undefined, { origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await w.call("OPTIONS", "/api/shows", undefined, { origin: "http://localhost:5173" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-manage-key");
  });

  it("answers 404 for unknown paths and wrong methods", async () => {
    const w = workerHarness();
    expect((await w.call("GET", "/api/nope")).status).toBe(404);
    expect((await w.call("DELETE", "/api/health")).status).toBe(404);
  });
});

describe("PayPal webhooks", () => {
  const event = (showId: string, id = "WH-1") => ({ id, event_type: "PAYMENT.AUTHORIZATION.CREATED", create_time: "2026-11-01T00:00:00Z", resource: { id: "A1", custom_id: `${showId}:p1`, amount: { currency_code: "USD", value: "15.00" } } });

  it("are refused when PAYPAL_WEBHOOK_ID is not set", async () => {
    const res = await workerHarness().call("POST", "/api/webhooks/paypal", event("sabcdefghjk"));
    expect(res.status).toBe(403);
  });

  it("are refused when the signature check fails, and 502 when PayPal can't be asked", async () => {
    expect((await workerHarness({ webhookId: "WH-ID", verify: async () => false }).call("POST", "/api/webhooks/paypal", event("sabcdefghjk"))).status).toBe(400);
    const down = workerHarness({
      webhookId: "WH-ID",
      verify: async () => {
        throw new Error("network");
      },
    });
    expect((await down.call("POST", "/api/webhooks/paypal", event("sabcdefghjk"))).status).toBe(502);
  });

  it("route a verified event to its show by custom_id, once", async () => {
    const seen: string[] = [];
    const w = workerHarness({
      webhookId: "WH-ID",
      verify: async (_h, raw, id) => {
        seen.push(id);
        return raw.includes("PAYMENT.");
      },
    });
    const { c } = await createAndSign(w);
    const res = await w.call("POST", "/api/webhooks/paypal", event(c.showId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual(["WH-ID"]);
    const store = w.shows.get(c.showId)!.store;
    expect(store.events().filter((e) => e.event.type === "webhook_received")).toHaveLength(1);
  });

  it("acknowledge and ignore events for unknown shows or unknown types", async () => {
    const w = workerHarness({ webhookId: "WH-ID", verify: async () => true });
    expect(await (await w.call("POST", "/api/webhooks/paypal", event("sabcdefghjk"))).json()).toEqual({ ignored: true });
    expect(await (await w.call("POST", "/api/webhooks/paypal", { ...event("sabcdefghjk"), event_type: "CHECKOUT.ORDER.APPROVED" })).json()).toEqual({ ignored: true });
  });
});

describe("PayPal webhooks, edge cases", () => {
  it("answer 403, not a crash or a retry, when verification reports a missing webhook id", async () => {
    const w = workerHarness({
      webhookId: "WH-ID",
      verify: async () => {
        throw new RangeError("PAYPAL_WEBHOOK_ID is not set");
      },
    });
    const res = await w.call("POST", "/api/webhooks/paypal", { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { custom_id: "sabcdefghjk:p1" } });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("PAYPAL_WEBHOOK_ID");
  });

  it("never echo error text from a failed verification", async () => {
    const w = workerHarness({
      webhookId: "WH-ID",
      verify: async () => {
        throw new Error("secret-detail-from-paypal");
      },
    });
    const res = await w.call("POST", "/api/webhooks/paypal", { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { custom_id: "sabcdefghjk:p1" } });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret-detail");
  });

  it("log a known event type that can't be read in that show's agent log, and still answer 200", async () => {
    const w = workerHarness({ webhookId: "WH-ID", verify: async () => true });
    const { c } = await createAndSign(w);
    const bad = { id: "WH-9", event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "2026-11-01T00:00:00Z", resource: { id: "C1", custom_id: `${c.showId}:p1`, amount: { currency_code: "EUR", value: "15.00" } } };
    const res = await w.call("POST", "/api/webhooks/paypal", bad);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: true });
    const store = w.shows.get(c.showId)!.store;
    expect(store.events().filter((e) => e.event.type === "webhook_received")).toHaveLength(0);
    expect(store.logs().some((l) => l.saw.includes("couldn't read"))).toBe(true);
  });

  it("route payout events by sender_item_id and sender_batch_id", async () => {
    const w = workerHarness({ webhookId: "WH-ID", verify: async () => true });
    const { c } = await createAndSign(w);
    const item = { id: "WH-2", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", create_time: "2026-11-01T00:00:00Z", resource: { payout_item_id: "PI1", payout_item: { sender_item_id: `${c.showId}-room`, amount: { currency: "USD", value: "20.00" } } } };
    const batch = { id: "WH-3", event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS", create_time: "2026-11-01T00:00:00Z", resource: { batch_header: { payout_batch_id: "PB1", sender_batch_header: { sender_batch_id: `payout-${c.showId}` } } } };
    expect(await (await w.call("POST", "/api/webhooks/paypal", item)).json()).toEqual({ ok: true });
    expect(await (await w.call("POST", "/api/webhooks/paypal", batch)).json()).toEqual({ ok: true });
    const store = w.shows.get(c.showId)!.store;
    expect(store.events().filter((e) => e.event.type === "webhook_received")).toHaveLength(2);
  });

  it("refuse an oversized webhook body", async () => {
    const w = workerHarness({ webhookId: "WH-ID", verify: async () => true });
    const res = await w.call("POST", "/api/webhooks/paypal", JSON.stringify({ pad: "x".repeat(66_000) }));
    expect(res.status).toBe(413);
  });
});

describe("PayPal webhooks, verification is pre-filtered and rate limited", () => {
  const known = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "2026-11-01T00:00:00Z", resource: { id: "C1", custom_id: "sabcdefghjk:p1", amount: { currency_code: "USD", value: "15.00" } } };
  const counting = () => {
    const calls = { n: 0 };
    const w = workerHarness({
      webhookId: "WH-ID",
      verify: async () => {
        calls.n++;
        return true;
      },
    });
    return { w, calls };
  };

  it("answer 200 with no PayPal call for junk, unknown types, and events with no valid show id", async () => {
    const { w, calls } = counting();
    const junk = ["not json at all", "null", "42", "[]", "{}"];
    for (const body of junk) expect((await w.call("POST", "/api/webhooks/paypal", body)).status).toBe(200);
    expect((await w.call("POST", "/api/webhooks/paypal", { ...known, event_type: "CHECKOUT.ORDER.APPROVED" })).status).toBe(200);
    expect((await w.call("POST", "/api/webhooks/paypal", { ...known, resource: { custom_id: "NOT-A-SHOW:p1" } })).status).toBe(200);
    expect((await w.call("POST", "/api/webhooks/paypal", { ...known, resource: {} })).status).toBe(200);
    expect(calls.n).toBe(0);
  });

  it("verify a valid known event as before", async () => {
    const { w, calls } = counting();
    expect((await w.call("POST", "/api/webhooks/paypal", known)).status).toBe(200);
    expect(calls.n).toBe(1);
  });

  it("answer 429 with no PayPal call once a visitor passes the verification limit", async () => {
    const { w, calls } = counting();
    for (let i = 0; i < LIMITS.webhookVisitor.limit; i++) expect((await w.call("POST", "/api/webhooks/paypal", known)).status).toBe(200);
    const res = await w.call("POST", "/api/webhooks/paypal", known);
    expect(res.status).toBe(429);
    expect(calls.n).toBe(LIMITS.webhookVisitor.limit);
    // Junk is still cheap to answer and never counts against the limit.
    expect((await w.call("POST", "/api/webhooks/paypal", "junk")).status).toBe(200);
    // Another visitor is unaffected.
    expect((await w.call("POST", "/api/webhooks/paypal", known, { "cf-connecting-ip": "203.0.113.9" })).status).toBe(200);
  });

  it("answer 429 with no PayPal call once the global verification cap is spent", async () => {
    const { w, calls } = counting();
    for (let i = 0; i < LIMITS.webhookGlobal.limit; i++) await w.deps.quota.hit("webhookGlobal:all", LIMITS.webhookGlobal.limit, LIMITS.webhookGlobal.windowMs);
    const res = await w.call("POST", "/api/webhooks/paypal", known);
    expect(res.status).toBe(429);
    expect(calls.n).toBe(0);
  });
});

describe("request body cap", () => {
  const streamed = (chunks: Uint8Array[], pulled?: { n: number }) =>
    new ReadableStream<Uint8Array>({
      pull(ctrl) {
        const next = chunks.shift();
        if (pulled) pulled.n++;
        if (next) ctrl.enqueue(next);
        else ctrl.close();
      },
    });
  const post = (w: ReturnType<typeof workerHarness>, body: BodyInit) =>
    route(new Request("http://api.test/api/shows", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit), w.deps);

  it("stops reading a chunked body as soon as it passes the cap", async () => {
    const w = workerHarness();
    const pulled = { n: 0 };
    const chunk = new Uint8Array(4096).fill(120);
    const res = await post(w, streamed(Array.from({ length: 1000 }, () => chunk), pulled));
    expect(res.status).toBe(413);
    expect(pulled.n).toBeLessThan(10);
  });

  it("counts bytes, not characters", async () => {
    const w = workerHarness();
    // 6,000 three-byte characters: 6,000 characters (under the cap) but 18,000 bytes (over 16,384).
    const body = JSON.stringify({ sentence: "€".repeat(6000) });
    expect(body.length).toBeLessThan(16_384);
    expect((await post(w, streamed([new TextEncoder().encode(body)]))).status).toBe(413);
    const small = JSON.stringify({ sentence: "€".repeat(100) + " is a bit odd but fine" });
    expect((await post(w, streamed([new TextEncoder().encode(small)]))).status).not.toBe(413);
  });
});

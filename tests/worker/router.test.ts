import { describe, expect, it, vi } from "vitest";
import type { AuthorizeResponse, CreateOrderResponse, CreateShowResponse, ManageView, PublicShow, SignResponse } from "../../src/worker/api-types";
import { LIMITS, PUBLIC_SHOW_CACHE_SECONDS, READ_LIMIT, route, type EdgeCache } from "../../src/worker/router";
import { FakeAi, json } from "../agent/fake-ai";
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
    expect(await res.json()).toEqual({ ok: true, setup: { rateSalt: true, webhook: false, judgeCode: false, receivers: false, paypalClientId: "test-client-id" } });
  });

  it("health reports judge code and webhook as booleans only, never the values", async () => {
    const w = workerHarness({ judgeCode: "judge-code-123", webhookId: "WH-SECRET-1" });
    const text = await (await w.call("GET", "/api/health")).text();
    expect(JSON.parse(text).setup).toMatchObject({ judgeCode: true, webhook: true });
    expect(text).not.toContain("judge-code-123");
    expect(text).not.toContain("WH-SECRET-1");
    expect(text).not.toContain("test-salt");
  });

  it("health reports judgeCode false when the code is set but the page would never send it", async () => {
    for (const bad of ["short", "has space in it!", "x".repeat(65)]) {
      const w = workerHarness({ judgeCode: bad });
      expect(((await (await w.call("GET", "/api/health")).json()) as { setup: { judgeCode: boolean } }).setup.judgeCode).toBe(false);
    }
    const ok = workerHarness({ judgeCode: "abcd_EFGH-12" });
    expect(((await (await ok.call("GET", "/api/health")).json()) as { setup: { judgeCode: boolean } }).setup.judgeCode).toBe(true);
  });

  describe("public show cache", () => {
    function fakeCache() {
      const store = new Map<string, Response>();
      const puts: { key: string; cc: string | null }[] = [];
      const cache: EdgeCache = {
        match: async (k) => store.get(k)?.clone(),
        put: async (k, r) => {
          puts.push({ key: k, cc: r.headers.get("cache-control") });
          store.set(k, r);
        },
      };
      return { cache, store, puts };
    }

    it("serves the second read from the cache for 3 seconds, keyed by show id", async () => {
      const fc = fakeCache();
      const w = workerHarness({ cache: fc.cache });
      const { c } = await createAndSign(w);
      const calls = vi.spyOn(w.deps.campaigns, "call");
      const first = await w.call("GET", `/api/shows/${c.showId}`);
      const second = await w.call("GET", `/api/shows/${c.showId}`);
      expect(first.status).toBe(200);
      expect(await second.json()).toEqual(await first.json());
      expect(calls).toHaveBeenCalledTimes(1);
      expect(fc.puts).toHaveLength(1);
      expect(fc.puts[0]?.key).toContain(c.showId);
      expect(fc.puts[0]?.cc).toBe(`public, max-age=${PUBLIC_SHOW_CACHE_SECONDS}`);
      expect(PUBLIC_SHOW_CACHE_SECONDS).toBe(3);
      expect(second.headers.get("cache-control")).toBe("no-store");
    });

    it("never caches errors, manage replies or other shows", async () => {
      const fc = fakeCache();
      const w = workerHarness({ cache: fc.cache });
      const { c, s } = await createAndSign(w);
      expect((await w.call("GET", "/api/shows/s0000000000000000000000")).status).toBe(404);
      expect(fc.puts).toHaveLength(0);
      expect((await w.call("GET", `/api/shows/${c.showId}/manage`, undefined, { "x-manage-key": s.manageKey })).status).toBe(200);
      expect((await w.call("GET", `/api/shows/${c.showId}/manage`, undefined, { "x-manage-key": "wrong" })).status).not.toBe(200);
      expect(fc.puts).toHaveLength(0);
      await w.call("GET", `/api/shows/${c.showId}`);
      expect(fc.puts).toHaveLength(1);
    });

    it("a corrupt cache entry falls through to the show, and the fresh answer is stored with waitUntil", async () => {
      const fc = fakeCache();
      const w = workerHarness({ cache: fc.cache });
      const { c } = await createAndSign(w);
      const later: Promise<unknown>[] = [];
      w.deps.waitUntil = (p) => { later.push(p); };
      fc.store.set(`https://cache.tip-the-room.invalid/public-show/${c.showId}`, new Response("<<not json"));
      const res = await w.call("GET", `/api/shows/${c.showId}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { showId: string }).showId).toBe(c.showId);
      await Promise.all(later);
      expect(later).toHaveLength(1);
      expect(fc.puts).toHaveLength(1);
    });

    it("a cache that throws never fails the read", async () => {
      const broken: EdgeCache = { match: async () => Promise.reject(new Error("x")), put: async () => Promise.reject(new Error("x")) };
      const w = workerHarness({ cache: broken });
      const { c } = await createAndSign(w);
      expect((await w.call("GET", `/api/shows/${c.showId}`)).status).toBe(200);
    });
  });

  it("limits public show reads per visitor without touching a Durable Object", async () => {
    const w = workerHarness();
    const { c } = await createAndSign(w);
    let last = 200;
    for (let i = 0; i <= READ_LIMIT.limit; i += 1) last = (await w.call("GET", `/api/shows/${c.showId}`)).status;
    expect(last).toBe(429);
    expect((await w.call("GET", `/api/shows/${c.showId}`, undefined, { "cf-connecting-ip": "10.9.9.9" })).status).toBe(200);
  });

  it("per-sender webhook cap is 1000 an hour", () => {
    expect(LIMITS.webhookVisitor.limit).toBe(1000);
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

  it("caps new shows at 300 a day across everyone", async () => {
    const w = workerHarness();
    let last = 201;
    for (let i = 0; i <= LIMITS.createShowGlobal.limit; i++) last = (await w.call("POST", "/api/shows", { sentence: SENTENCE }, { "cf-connecting-ip": `10.${i >> 8}.${i & 255}.1` })).status;
    expect(last).toBe(429);
  });

  describe("the model's daily pool of drafts", () => {
    const answer = { showName: "Acoustic set", roomName: "Lucky's Café", showDate: "2026-11-20", ticketPriceDollars: 15, roomDollars: 100, openerDollars: 0, hostDollars: 0, artistMinimumDollars: 200 };
    const withAi = (judgeCode?: string) => {
      const w = workerHarness({ judgeCode });
      const everyone = new FakeAi();
      const judges = new FakeAi();
      const feed = (ai: FakeAi) => Object.assign(ai, { run: async (m: never, i: never) => (ai.calls.push({ model: m, input: i }), json(answer)) });
      w.deps.ai = { ai: feed(everyone), budget: { tryReserve: async () => true } };
      w.deps.aiJudge = { ai: feed(judges), budget: { tryReserve: async () => true } };
      return { w, everyone, judges };
    };
    const draft = async (w: ReturnType<typeof workerHarness>, i: number, headers: Record<string, string> = {}) => w.call("POST", "/api/shows", { sentence: SENTENCE }, { "cf-connecting-ip": `10.0.${i}.1`, ...headers });

    it("is 30 a day for the public; the 31st is drafted by the built-in parser, not refused", async () => {
      const { w, everyone } = withAi();
      for (let i = 0; i < LIMITS.draftAi.limit; i++) expect(((await (await draft(w, i)).json()) as CreateShowResponse).source).toBe("model");
      const after = await draft(w, 99);
      expect(after.status).toBe(201);
      expect(((await after.json()) as CreateShowResponse).source).toBe("template");
      expect(everyone.calls).toHaveLength(LIMITS.draftAi.limit);
    });

    it("gives judge links their own pool and their own AI port", async () => {
      const { w, everyone, judges } = withAi("judge-code-123");
      for (let i = 0; i < LIMITS.draftAi.limit + 1; i++) await draft(w, i);
      const j = await draft(w, 200, { "x-judge-code": "judge-code-123" });
      expect(((await j.json()) as CreateShowResponse).source).toBe("model");
      expect(judges.calls).toHaveLength(1);
      expect(everyone.calls).toHaveLength(LIMITS.draftAi.limit);
      const wrong = await draft(w, 201, { "x-judge-code": "wrong-code-123" });
      expect(((await wrong.json()) as CreateShowResponse).source).toBe("template");
    });

    it("is not spent by a refused request", async () => {
      const { w, everyone } = withAi();
      for (let i = 0; i < LIMITS.draftAi.limit + 5; i++) expect((await w.call("POST", "/api/shows", { sentence: "hi" }, { "cf-connecting-ip": `10.0.${i}.1` })).status).toBe(422);
      expect(((await (await draft(w, 250)).json()) as CreateShowResponse).source).toBe("model");
      expect(everyone.calls).toHaveLength(1);
    });
  });

  it("marks a show made with the judge code as a judge show, and no other", async () => {
    const w = workerHarness({ judgeCode: "judge-code-123" });
    const inits: (boolean | undefined)[] = [];
    const real = w.deps.campaigns.call.bind(w.deps.campaigns);
    w.deps.campaigns.call = async (id, op) => {
      if (op.op === "init" || op.op === "demo_init") inits.push(op.judge);
      return real(id, op);
    };
    await w.call("POST", "/api/shows", { sentence: SENTENCE }, { "x-judge-code": "judge-code-123" });
    await w.call("POST", "/api/shows", { sentence: SENTENCE }, { "x-judge-code": "wrong-code-123" });
    await w.call("POST", "/api/shows", { sentence: SENTENCE });
    await w.call("POST", "/api/demo", undefined, { "x-judge-code": "judge-code-123" });
    await w.call("POST", "/api/demo");
    expect(inits).toEqual([true, false, false, true, true, false, false]);
  });

  it("allows a visitor 8 new orders on one show in 3 hours; other shows, other visitors and authorize are unaffected", async () => {
    const w = workerHarness();
    const { c } = await createAndSign(w);
    const other = (await createAndSign(w)).c;
    const order = (id: string, ip?: string) => w.call("POST", `/api/shows/${id}/orders`, { initials: "AB" }, ip ? { "cf-connecting-ip": ip } : {});
    let first: CreateOrderResponse | undefined;
    for (let i = 0; i < LIMITS.orderPerShow.limit; i++) {
      const res = await order(c.showId);
      expect(res.status).toBe(201);
      first ??= (await res.json()) as CreateOrderResponse;
    }
    const refused = await order(c.showId);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect((await order(other.showId)).status).toBe(201);
    expect((await order(c.showId, "10.4.4.4")).status).toBe(201);
    expect((await w.call("POST", `/api/shows/${c.showId}/orders/${first!.orderId}/authorize`)).status).not.toBe(429);
    w.clock.t += 3 * 60 * 60 * 1000;
    expect((await order(c.showId)).status).toBe(201);
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

  it("carries the show's clock, a change marker, the share path", async () => {
    const w = workerHarness();
    const { c, s } = await createAndSign(w);
    const key = { "x-manage-key": s.manageKey };
    const read = async () => (await (await w.call("GET", `/api/shows/${c.showId}/manage`, undefined, key)).json()) as ManageView;
    const before = await read();
    expect(before.now).toBe(w.clock.now());
    expect(before.show.now).toBe(w.clock.now());
    expect(before.sharePath).toBe(`/s/${c.showId}`);
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

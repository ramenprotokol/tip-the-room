import { describe, expect, it } from "vitest";
import { act, apiClient, ApiFailure, FALLBACK_MESSAGE, NETWORK_MESSAGE, pendingCount, type FetchLike } from "../../src/web/shared/api";

interface Seen { url: string; init: RequestInit }
function fake(status: number, body: string): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  return { seen, fetch: async (url, init) => { seen.push({ url, init }); return new Response(body, { status }); } };
}

describe("api client", () => {
  it("calls the right path, sends JSON and the manage key only when given", async () => {
    const f = fake(200, JSON.stringify({ ok: 1 }));
    const api = apiClient("https://api.example", f.fetch);
    await api.getShow("s123");
    await api.manage("s123", "secret-key");
    await api.approve("s123", "secret-key", "pace1", { option: "extend" });
    await api.demoFastForward("dabc", "k123456", "b");
    expect(f.seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      "GET https://api.example/api/shows/s123",
      "GET https://api.example/api/shows/s123/manage",
      "POST https://api.example/api/shows/s123/proposals/pace1/approve",
      "POST https://api.example/api/demo/dabc/fast-forward",
    ]);
    expect((f.seen[0].init.headers as Record<string, string>)["x-manage-key"]).toBeUndefined();
    expect((f.seen[1].init.headers as Record<string, string>)["x-manage-key"]).toBe("secret-key");
    expect(f.seen[2].init.body).toBe(JSON.stringify({ option: "extend" }));
    expect(f.seen[3].init.body).toBe(JSON.stringify({ show: "b" }));
  });

  it("sends the judge code on demo create and reset only", async () => {
    const f = fake(201, JSON.stringify({ demoId: "d1" }));
    const api = apiClient("https://api.test", f.fetch, { judgeCode: () => "judge-code-123" });
    await api.createDemo();
    await api.demoReset("d1", "k123456");
    await api.getShow("s1");
    const h = (i: number) => f.seen[i].init.headers as Record<string, string>;
    expect(h(0)["x-judge-code"]).toBe("judge-code-123");
    expect(h(1)["x-judge-code"]).toBe("judge-code-123");
    expect(h(2)["x-judge-code"]).toBeUndefined();
  });

  it("encodes ids so a path can't be smuggled", async () => {
    const f = fake(200, "{}");
    await apiClient("", f.fetch).getShow("a/../b");
    expect(f.seen[0].url).toBe("/api/shows/a%2F..%2Fb");
  });

  it("turns an error body into ApiFailure with the server's plain message", async () => {
    const f = fake(502, JSON.stringify({ error: { code: "paypal_error", message: "PayPal didn't answer as expected. Nothing was charged." } }));
    const err = await apiClient("", f.fetch).authorize("s1", "ORDER1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err).toMatchObject({ status: 502, code: "paypal_error", message: "PayPal didn't answer as expected. Nothing was charged." });
  });

  it("keeps problems and retry hints, and falls back on unreadable errors", async () => {
    const a = await apiClient("", fake(422, JSON.stringify({ error: { code: "invalid", message: "Check the draft.", problems: ["Add a price.", 7] } })).fetch).sign("s1", { signToken: "t", draft: {} as never }).catch((e: unknown) => e);
    expect(a).toMatchObject({ code: "invalid", problems: ["Add a price."] });
    const b = await apiClient("", fake(500, "<html>").fetch).getShow("s1").catch((e: unknown) => e);
    expect(b).toMatchObject({ status: 500, code: "internal", message: FALLBACK_MESSAGE });
    const c = await apiClient("", fake(200, "").fetch).getShow("s1").catch((e: unknown) => e);
    expect(c).toMatchObject({ code: "internal" });
  });

  it("reports a network failure in plain words", async () => {
    const err = await apiClient("", async () => { throw new TypeError("Failed to fetch"); }).getShow("s1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: "network", message: NETWORK_MESSAGE });
  });

  it("counts work in flight until the caller's whole action ends", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const api = apiClient("", async () => { await gate; return new Response("{}", { status: 200 }); });
    const job = act(async () => { await api.getShow("s1"); });
    expect(pendingCount()).toBeGreaterThan(0);
    release();
    await job;
    expect(pendingCount()).toBe(0);
  });
});

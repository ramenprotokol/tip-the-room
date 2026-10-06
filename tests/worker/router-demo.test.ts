import { describe, expect, it } from "vitest";
import type { DemoFansResponse, DemoResponse } from "../../src/worker/api-types";
import { workerHarness } from "./harness";

const HOUR = 60 * 60 * 1000;

describe("demo routes", () => {
  it("create a private copy with two seeded shows and a demo key", async () => {
    const w = workerHarness();
    const res = await w.call("POST", "/api/demo");
    expect(res.status).toBe(201);
    const d = (await res.json()) as DemoResponse;
    expect(d.demoId).toMatch(/^d[a-z2-9]{10}$/);
    expect(d.demoKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(d.shows.map((s) => [s.showId, s.threshold])).toEqual([
      [`${d.demoId}a`, 34],
      [`${d.demoId}b`, 28],
    ]);
  });

  it("gives every visitor a different copy and key", async () => {
    const w = workerHarness();
    const a = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    const b = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    expect(a.demoId).not.toBe(b.demoId);
    expect(a.demoKey).not.toBe(b.demoKey);
    // One copy's key does not open the other.
    expect((await w.call("POST", `/api/demo/${b.demoId}/fast-forward`, undefined, { "x-manage-key": a.demoKey })).status).toBe(403);
  });

  it("need the demo key to add fans, fast-forward or reset", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    expect((await w.call("POST", `/api/demo/${d.demoId}/fans`, { show: "a", count: 2 })).status).toBe(403);
    const fans = await w.call("POST", `/api/demo/${d.demoId}/fans`, { show: "a", count: 2 }, { "x-manage-key": d.demoKey });
    expect(fans.status).toBe(200);
    expect(((await fans.json()) as DemoFansResponse).queued).toBe(2);
    expect((await w.call("POST", `/api/demo/${d.demoId}/fans`, { show: "c", count: 2 }, { "x-manage-key": d.demoKey })).status).toBe(422);
    expect((await w.call("POST", `/api/demo/${d.demoId}/fast-forward`)).status).toBe(403);
    const ff = await w.call("POST", `/api/demo/${d.demoId}/fast-forward`, undefined, { "x-manage-key": d.demoKey });
    expect(ff.status).toBe(200);
    expect((await w.call("POST", `/api/demo/${d.demoId}/reset`)).status).toBe(403);
  });

  it("makes no PayPal call while answering a request (fans are queued for the alarm)", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    await w.call("POST", `/api/demo/${d.demoId}/fans`, { show: "a", count: 20 }, { "x-manage-key": d.demoKey });
    await w.call("POST", `/api/demo/${d.demoId}/fast-forward`, undefined, { "x-manage-key": d.demoKey });
    expect(w.paypal.calls).toHaveLength(0);
  });

  it("limits adding fans per visitor, and asking for more than 20 at once or 60 in all", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    const key = { "x-manage-key": d.demoKey };
    expect((await w.call("POST", `/api/demo/${d.demoId}/fans`, { show: "b", count: 21 }, key)).status).toBe(422);
    expect((await w.call("POST", `/api/demo/${d.demoId}/fans`, { show: "b", count: "2" }, key)).status).toBe(422);
    // 12 requests an hour per visitor (the two refusals above used some).
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await w.call("POST", `/api/demo/${d.demoId}/fans`, { show: "b", count: 1 }, key)).status;
    expect(last).toBe(429);
  });

  it("reset retires the old copy and returns a new one", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    const res = await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { "x-manage-key": d.demoKey });
    expect(res.status).toBe(201);
    const fresh = (await res.json()) as DemoResponse;
    expect(fresh.demoId).not.toBe(d.demoId);
    const old = w.shows.get(`${d.demoId}b`)!;
    expect(Number(old.store.getMeta("expires_at"))).toBeLessThanOrEqual(w.clock.now() + HOUR);
    expect(old.svc.project().campaign.state).toBe("missed");
  });

  it("reset carries on when one or both old shows are already gone (404)", async () => {
    const w = workerHarness();
    for (const gone of [["a"], ["a", "b"]]) {
      const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
      for (const k of gone) w.shows.delete(`${d.demoId}${k}`);
      const res = await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { "x-manage-key": d.demoKey });
      expect(res.status).toBe(201);
      expect(((await res.json()) as DemoResponse).demoId).not.toBe(d.demoId);
    }
  });

  it("reset still refuses a wrong key (403) rather than treating it as gone", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    expect((await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { "x-manage-key": "k".repeat(43) })).status).toBe(403);
  });

  it("tells the page when the copy expires, and gives each show its own clock and change marker", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    expect(d.expiresAt).toBe(w.clock.now() + 24 * HOUR);
    expect(d.shows[0].now).toBe(w.clock.now());
    expect(d.shows[0].version).toMatch(/^e\d+\.l\d+$/);
  });

  it("a refused reset (rate limit) leaves the old copy alone", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    for (let i = 0; i < 4; i++) await w.call("POST", "/api/demo"); // 5 copies this hour
    expect((await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { "x-manage-key": d.demoKey })).status).toBe(429);
    expect(w.shows.get(`${d.demoId}b`)!.svc.project().campaign.state).toBe("live");
  });

  it("limits demo copies per visitor and answers 404 for a bad demo id", async () => {
    const w = workerHarness();
    for (let i = 0; i < 5; i++) expect((await w.call("POST", "/api/demo")).status).toBe(201);
    expect((await w.call("POST", "/api/demo")).status).toBe(429);
    expect((await w.call("POST", "/api/demo/NOPE/fast-forward")).status).toBe(404);
    expect((await w.call("POST", "/api/demo/dabcdefghjk/fast-forward", undefined, { "x-manage-key": "x".repeat(43) })).status).toBe(404);
  });

  it("retires copy a when copy b cannot be made, so no orphan runs holds", async () => {
    const w = workerHarness();
    const real = w.deps.campaigns.call.bind(w.deps.campaigns);
    w.deps.campaigns.call = async (showId, op) => {
      if (op.op === "demo_init" && showId.endsWith("b")) throw new Error("boom");
      return real(showId, op);
    };
    expect((await w.call("POST", "/api/demo")).status).toBe(500);
    const [id] = [...w.shows.keys()];
    expect(id.endsWith("a")).toBe(true);
    const a = w.shows.get(id)!;
    expect(a.svc.project().campaign.state).toBe("missed");
    expect(Number(a.store.getMeta("expires_at"))).toBeLessThanOrEqual(w.clock.now() + HOUR);
  });

  it("caps new demo copies across all visitors (50 a day)", async () => {
    const w = workerHarness();
    let status = 201;
    for (let i = 0; i < 51 && status === 201; i++) {
      // A different visitor each time (the per-visitor limit is 5 an hour).
      const res = await w.call("POST", "/api/demo", undefined, { "cf-connecting-ip": `10.0.${Math.floor(i / 250)}.${i % 250}` });
      status = res.status;
      if (i < 50) expect(status).toBe(201);
    }
    expect(status).toBe(429);
  });
});

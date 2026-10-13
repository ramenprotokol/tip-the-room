import { describe, expect, it, vi } from "vitest";
import type { DemoFansResponse, DemoPaceResponse, DemoResponse, ManageView } from "../../src/worker/api-types";
import { LIMITS } from "../../src/worker/router";
import { workerHarness } from "./harness";

const HOUR = 60 * 60 * 1000;
/** Takes every public copy a visitor may have in a day, an hour at a time so the hourly cap (12) is never the one that stops it. */
async function useUpDay(w: ReturnType<typeof workerHarness>, headers: (i: number) => Record<string, string> = () => ({})) {
  for (let i = 0; i < LIMITS.demoDay.limit; i++) {
    expect((await w.call("POST", "/api/demo", undefined, headers(i))).status).toBe(201);
    if (i % 10 === 9) w.clock.t += HOUR;
  }
}

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

  it("reset with a wrong key spends no quota, and the real key still works afterwards", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    for (let i = 0; i < LIMITS.demo.limit + 3; i++) expect((await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { "x-manage-key": "k".repeat(43) })).status).toBe(403);
    expect((await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { "x-manage-key": d.demoKey })).status).toBe(201);
  });

  it("caps reset attempts at 60 an hour per visitor, wrong key or not, without touching any show after that", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    const wrong = { "x-manage-key": "k".repeat(43) };
    for (let i = 0; i < LIMITS.demoResetTry.limit; i++) expect((await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, wrong)).status).toBe(403);
    const calls = vi.spyOn(w.deps.campaigns, "call");
    const res = await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, wrong);
    expect(res.status).toBe(429);
    expect(calls).not.toHaveBeenCalled();
    expect((await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { ...wrong, "cf-connecting-ip": "10.8.8.8" })).status).toBe(403);
  });

  it("a wrong key is refused even when the first show is already gone", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    w.shows.delete(`${d.demoId}a`);
    expect((await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { "x-manage-key": "k".repeat(43) })).status).toBe(403);
  });

  it("a visitor gets 25 public copies a day, then 429; another visitor and the judge pool are unaffected", async () => {
    const w = workerHarness({ judgeCode: "judge-code-123" });
    for (let i = 0; i < LIMITS.demoDay.limit; i++) {
      expect((await w.call("POST", "/api/demo")).status).toBe(201);
      if (i % 5 === 4) w.clock.t += HOUR; // stay inside the hourly cap of 12
    }
    expect((await w.call("POST", "/api/demo")).status).toBe(429);
    expect((await w.call("POST", "/api/demo", undefined, { "cf-connecting-ip": "10.1.1.1" })).status).toBe(201);
    expect((await w.call("POST", "/api/demo", undefined, { "x-judge-code": "judge-code-123" })).status).toBe(201);
    w.clock.t += 24 * HOUR;
    expect((await w.call("POST", "/api/demo")).status).toBe(201);
  });

  it("a refused reset (rate limit) leaves the old copy alone", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    for (let i = 1; i < LIMITS.demo.limit; i++) await w.call("POST", "/api/demo"); // the visitor limit is used up this hour
    expect((await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { "x-manage-key": d.demoKey })).status).toBe(429);
    expect(w.shows.get(`${d.demoId}b`)!.svc.project().campaign.state).toBe("live");
  });

  it("limits demo copies per visitor and answers 404 for a bad demo id", async () => {
    const w = workerHarness();
    await useUpDay(w);
    expect((await w.call("POST", "/api/demo")).status).toBe(429);
    expect((await w.call("POST", "/api/demo/NOPE/fast-forward")).status).toBe(404);
    expect((await w.call("POST", "/api/demo/dabcdefghjk/fast-forward", undefined, { "x-manage-key": "x".repeat(43) })).status).toBe(404);
  });

  it("counts an IPv6 /64 as one visitor, and a different /64 as another", async () => {
    const w = workerHarness();
    await useUpDay(w, (i) => ({ "cf-connecting-ip": `2001:db8:0:0:${i}::1` }));
    expect((await w.call("POST", "/api/demo", undefined, { "cf-connecting-ip": "2001:db8::ffff" })).status).toBe(429);
    expect((await w.call("POST", "/api/demo", undefined, { "cf-connecting-ip": "2001:db8:0:1::1" })).status).toBe(201);
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
      // A different visitor each time (the per-visitor limit is LIMITS.demo.limit an hour).
      const res = await w.call("POST", "/api/demo", undefined, { "cf-connecting-ip": `10.0.${Math.floor(i / 250)}.${i % 250}` });
      status = res.status;
      if (i < 50) expect(status).toBe(201);
    }
    expect(status).toBe(429);
  });

  it("a judge code skips the visitor limit and draws from its own daily pool", async () => {
    const w = workerHarness({ judgeCode: "judge-code-123" });
    await useUpDay(w);
    expect((await w.call("POST", "/api/demo")).status).toBe(429);
    expect((await w.call("POST", "/api/demo", undefined, { "x-judge-code": "judge-code-123" })).status).toBe(201);
    expect((await w.call("POST", "/api/demo", undefined, { "x-judge-code": "wrong-code-123" })).status).toBe(429);
  });

  it("the judge pool has its own daily cap", async () => {
    const w = workerHarness({ judgeCode: "judge-code-123" });
    let last = 201;
    for (let i = 0; i <= LIMITS.demoJudgeGlobal.limit; i += 1) {
      last = (await w.call("POST", "/api/demo", undefined, { "x-judge-code": "judge-code-123", "cf-connecting-ip": `10.0.0.${i}` })).status;
    }
    expect(last).toBe(429);
  });

  it("check pace now needs the demo key, answers with both shows and makes no PayPal call", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    expect((await w.call("POST", `/api/demo/${d.demoId}/pace`)).status).toBe(403);
    const res = await w.call("POST", `/api/demo/${d.demoId}/pace`, undefined, { "x-manage-key": d.demoKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DemoPaceResponse;
    expect(body.shows.map((s) => s.showId)).toEqual([`${d.demoId}a`, `${d.demoId}b`]);
    expect(w.paypal.calls).toHaveLength(0);
  });

  it("decline needs the key and a real proposal", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    const key = { "x-manage-key": d.demoKey };
    await w.call("POST", `/api/demo/${d.demoId}/pace`, undefined, key);
    const view = (await (await w.call("GET", `/api/shows/${d.demoId}b/manage`, undefined, key)).json()) as ManageView;
    const id = view.proposals[0].proposalId;
    expect((await w.call("POST", `/api/shows/${d.demoId}b/proposals/${id}/decline`)).status).toBe(403);
    expect((await w.call("POST", `/api/shows/${d.demoId}b/proposals/${id}/decline`, undefined, key)).status).toBe(200);
    expect((await w.call("POST", `/api/shows/${d.demoId}b/proposals/zzz/decline`, undefined, key)).status).toBe(404);
  });
});

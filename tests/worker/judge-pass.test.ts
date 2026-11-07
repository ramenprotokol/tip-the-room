import { describe, expect, it, vi } from "vitest";
import { DEMO_COPIES_PER_DAY, DEMO_JUDGE_COPIES_PER_DAY, DEMO_ROWS_PER_COPY_WORST, DO_ROWS_FREE_PER_DAY } from "../../src/agent/policy";
import { DAILY_NEURON_BUDGET, JUDGE_NEURON_RESERVE, PUBLIC_NEURON_BUDGET } from "../../src/agent/quota";
import type { ApiError, DemoResponse, HealthResponse, JudgeCheckResponse } from "../../src/worker/api-types";
import { LIMITS, READ_LIMIT, READ_LIMIT_JUDGE, waitWords } from "../../src/worker/router";
import { workerHarness } from "./harness";

const CODE = "judge-pass_Z9x2Kq7LmP4w";
const BUYER = { email: "judges-buyer@example.com", password: "Sandbox-Only-Pw-123" };
const asJudge = (code = CODE, extra: Record<string, string> = {}) => ({ "x-judge-code": code, ...extra });
const check = (w: ReturnType<typeof workerHarness>, headers: Record<string, string>) => w.call("POST", "/api/judge/check", undefined, headers);
const ip = (n: number) => ({ "cf-connecting-ip": `10.9.${Math.floor(n / 250)}.${n % 250}` });

describe("judge pass check", () => {
  it("accepts the right code and hands back the judges-only sandbox buyer", async () => {
    const w = workerHarness({ judgeCode: CODE, judgeBuyer: BUYER });
    const res = await check(w, asJudge());
    expect(res.status).toBe(200);
    expect((await res.json()) as JudgeCheckResponse).toEqual({ ok: true, buyer: BUYER, demoCopiesPerDay: DEMO_JUDGE_COPIES_PER_DAY });
  });

  it("answers buyer: null when the owner has not set a judges-only login (the page keeps the public one)", async () => {
    const w = workerHarness({ judgeCode: CODE });
    expect(((await (await check(w, asJudge())).json()) as JudgeCheckResponse).buyer).toBeNull();
  });

  it("never shows the buyer to a wrong, missing, empty or over-long code", async () => {
    const w = workerHarness({ judgeCode: CODE, judgeBuyer: BUYER });
    for (const headers of [asJudge("judge-pass_Z9x2Kq7LmP4x"), asJudge("short"), asJudge(CODE.slice(0, -1)), asJudge(`${CODE}0`), asJudge(""), asJudge("x".repeat(500)), {}]) {
      const res = await check(w, { ...headers, ...ip(Math.floor(Math.random() * 1e5)) });
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain(BUYER.password);
      expect(text).not.toContain(BUYER.email);
      expect(text).not.toContain(CODE);
      expect((JSON.parse(text) as ApiError).error.code).toBe("forbidden");
    }
  });

  it("refuses every code when no JUDGE_CODE is configured, including an empty one", async () => {
    const w = workerHarness({ judgeCode: null, judgeBuyer: BUYER });
    expect((await check(w, asJudge())).status).toBe(403);
    expect((await check(w, asJudge(""))).status).toBe(403);
  });

  it("limits wrong guesses per visitor (429 with a wait), but the right code still works and other visitors are untouched", async () => {
    const w = workerHarness({ judgeCode: CODE });
    for (let i = 0; i < LIMITS.judgeWrong.limit; i++) expect((await check(w, asJudge(`wrong-guess-${i}-padding`))).status).toBe(403);
    const blocked = await check(w, asJudge("one-more-wrong-guess"));
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as ApiError).error.message).toMatch(/wrong judge codes/);
    expect((await check(w, asJudge())).status).toBe(200);
    expect((await check(w, asJudge("wrong-from-elsewhere", ip(7)))).status).toBe(403);
  });

  it("does not write the code or the password to the console", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];
    const w = workerHarness({ judgeCode: CODE, judgeBuyer: BUYER });
    await check(w, asJudge());
    await check(w, asJudge("wrong-code-for-log-test"));
    await w.call("POST", "/api/demo", undefined, asJudge());
    for (const s of spies) {
      const said = JSON.stringify(s.mock.calls);
      expect(said).not.toContain(CODE);
      expect(said).not.toContain(BUYER.password);
      s.mockRestore();
    }
  });

  it("health says whether a judge code and a judges-only buyer are set, never their values", async () => {
    const w = workerHarness({ judgeCode: CODE, judgeBuyer: BUYER });
    const text = await (await w.call("GET", "/api/health")).text();
    expect((JSON.parse(text) as HealthResponse).setup).toMatchObject({ judgeCode: true, judgeBuyer: true });
    for (const secret of [CODE, BUYER.password, BUYER.email]) expect(text).not.toContain(secret);
  });
});

describe("caps and what a visitor sees at the cap", () => {
  it("the public pool, the per-visitor allowance and the judge pool are separate", async () => {
    const w = workerHarness({ judgeCode: CODE });
    for (let i = 0; i < LIMITS.demoGlobal.limit; i++) expect((await w.call("POST", "/api/demo", undefined, ip(i))).status).toBe(201);
    const full = await w.call("POST", "/api/demo", undefined, ip(999));
    expect(full.status).toBe(429);
    const body = (await full.json()) as ApiError;
    expect(body.error.message).toMatch(/free demo copies are all taken/);
    expect(body.error.message).toMatch(/judge code/i);
    expect(body.error.message).toMatch(/in about \d+ hours?|in a minute|in about \d+ minutes/);
    expect(body.error.retryAfterSec).toBeGreaterThan(0);
    expect(body.error.message).not.toMatch(/Too many tries/);
    // The judge pool still has its copies.
    expect((await w.call("POST", "/api/demo", undefined, asJudge(CODE, ip(1000)))).status).toBe(201);
  });

  it("a visitor at their own allowance is told their copy keeps running", async () => {
    const w = workerHarness();
    for (let i = 0; i < LIMITS.demoDay.limit; i++) await w.call("POST", "/api/demo");
    const res = await w.call("POST", "/api/demo");
    expect(res.status).toBe(429);
    expect(((await res.json()) as ApiError).error.message).toMatch(/keeps running/);
  });

  it("a full judge pool says so, and public copies are not touched", async () => {
    const w = workerHarness({ judgeCode: CODE });
    for (let i = 0; i < LIMITS.demoJudgeGlobal.limit; i++) expect((await w.call("POST", "/api/demo", undefined, asJudge(CODE, ip(i)))).status).toBe(201);
    const full = await w.call("POST", "/api/demo", undefined, asJudge(CODE, ip(500)));
    expect(full.status).toBe(429);
    expect(((await full.json()) as ApiError).error.message).toMatch(/kept for judges are all taken/);
    expect((await w.call("POST", "/api/demo", undefined, ip(501))).status).toBe(201);
  });

  it("a wrong judge code gets the public pool, never the judge one", async () => {
    const w = workerHarness({ judgeCode: CODE });
    for (let i = 0; i < LIMITS.demoDay.limit; i++) await w.call("POST", "/api/demo", undefined, asJudge("wrong-code-guess-1"));
    expect((await w.call("POST", "/api/demo", undefined, asJudge("wrong-code-guess-1"))).status).toBe(429);
  });

  it("a reset that hits the cap leaves the old copy running and says why", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    for (let i = 1; i < LIMITS.demoDay.limit; i++) await w.call("POST", "/api/demo");
    const res = await w.call("POST", `/api/demo/${d.demoId}/reset`, undefined, { "x-manage-key": d.demoKey });
    expect(res.status).toBe(429);
    expect(((await res.json()) as ApiError).error.message).toMatch(/keeps running/);
    expect(w.shows.get(`${d.demoId}a`)!.svc.project().campaign.state).toBe("live");
  });

  it("waitWords speaks plainly", () => {
    expect(waitWords(30)).toBe("in a minute");
    expect(waitWords(20 * 60)).toBe("in about 20 minutes");
    expect(waitWords(3600)).toBe("in about 1 hour");
    expect(waitWords(5 * 3600 + 100)).toBe("in about 5 hours");
  });
});

describe("per-visitor read limits", () => {
  const demoShow = async (w: ReturnType<typeof workerHarness>) => `${((await (await w.call("POST", "/api/demo")).json()) as DemoResponse).demoId}a`;

  it("a public visitor is cut off after READ_LIMIT reads an hour, with a calm message; a valid judge code reads more; a wrong one does not", async () => {
    const w = workerHarness({ judgeCode: CODE });
    const id = await demoShow(w);
    let last = 200;
    for (let i = 0; i <= READ_LIMIT.limit; i += 1) last = (await w.call("GET", `/api/shows/${id}`)).status;
    expect(last).toBe(429);
    const refused = await w.call("GET", `/api/shows/${id}`);
    expect(((await refused.json()) as ApiError).error.message).toMatch(/checking for updates too often/);
    // The same address with a wrong code is still just the public.
    expect((await w.call("GET", `/api/shows/${id}`, undefined, asJudge("wrong-code-xyz"))).status).toBe(429);
    // With the right code the same address keeps reading, on its own counter.
    expect((await w.call("GET", `/api/shows/${id}`, undefined, asJudge())).status).toBe(200);
    expect(READ_LIMIT_JUDGE.limit).toBeGreaterThan(READ_LIMIT.limit);
  });

  it("the limit window resets after an hour", async () => {
    const w = workerHarness();
    const id = await demoShow(w);
    for (let i = 0; i <= READ_LIMIT.limit; i += 1) await w.call("GET", `/api/shows/${id}`);
    expect((await w.call("GET", `/api/shows/${id}`)).status).toBe(429);
    w.clock.t += 61 * 60 * 1000;
    expect((await w.call("GET", `/api/shows/${id}`)).status).toBe(200);
  });
});

describe("capacity arithmetic against the free plans", () => {
  it("every pool used in one day still fits the Durable Object free rows (worst case per copy)", () => {
    const copies = DEMO_COPIES_PER_DAY + DEMO_JUDGE_COPIES_PER_DAY;
    expect(copies * DEMO_ROWS_PER_COPY_WORST).toBeLessThanOrEqual(DO_ROWS_FREE_PER_DAY * 0.9);
  });

  it("keeps judges a real share of both pools, and the public share smaller than the whole", () => {
    expect(DEMO_JUDGE_COPIES_PER_DAY).toBeGreaterThanOrEqual(10);
    expect(JUDGE_NEURON_RESERVE).toBeGreaterThanOrEqual(2000);
    expect(PUBLIC_NEURON_BUDGET).toBe(DAILY_NEURON_BUDGET - JUDGE_NEURON_RESERVE);
    expect(DAILY_NEURON_BUDGET).toBeLessThanOrEqual(10_000);
  });

  it("the public per-visitor allowance never exceeds a quarter of the public day", () => {
    expect(LIMITS.demoDay.limit * 4).toBeLessThanOrEqual(DEMO_COPIES_PER_DAY);
    expect(LIMITS.demo.limit).toBeLessThanOrEqual(LIMITS.demoDay.limit);
  });
});

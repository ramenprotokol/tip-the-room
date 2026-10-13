import { describe, expect, it } from "vitest";
import { DAILY_NEURON_BUDGET, nextUtcMidnight, PUBLIC_NEURON_BUDGET, Quota, quotaDispatch, utcDay } from "../../src/agent/quota";
import { memoryDb } from "./sqlite";

const T = Date.parse("2026-11-01T22:00:00Z");

function quota(): Quota {
  const q = new Quota(memoryDb());
  q.migrate();
  return q;
}

describe("daily neuron budget", () => {
  it("reserves until the limit, then refuses", () => {
    const q = quota();
    expect(q.reserveNeurons(T, 5000)).toBe(true);
    expect(q.reserveNeurons(T, 3000)).toBe(true);
    expect(q.reserveNeurons(T, 1)).toBe(false);
    expect(q.neuronsUsed(T)).toBe(DAILY_NEURON_BUDGET);
  });
  it("resets at 00:00 UTC", () => {
    const q = quota();
    q.reserveNeurons(T, 8000);
    expect(q.reserveNeurons(nextUtcMidnight(T), 150)).toBe(true);
    expect(utcDay(nextUtcMidnight(T))).toBe("2026-11-02");
    expect(nextUtcMidnight(T)).toBe(Date.parse("2026-11-02T00:00:00Z"));
  });
  it("refuses a nonsense cost", () => {
    expect(() => quota().reserveNeurons(T, 0)).toThrow(RangeError);
  });
});

describe("rate limits", () => {
  it("allows `limit` hits per window, then says when to retry", () => {
    const q = quota();
    for (let i = 0; i < 3; i++) expect(q.hit("demo:v1", 3, 60_000, T + i).ok).toBe(true);
    expect(q.hit("demo:v1", 3, 60_000, T + 10_000)).toEqual({ ok: false, retryAfterSec: 50 });
    expect(q.hit("demo:v2", 3, 60_000, T + 10_000).ok).toBe(true);
    expect(q.hit("demo:v1", 3, 60_000, T + 60_000).ok).toBe(true);
  });
  it("is reachable through quotaDispatch", () => {
    const q = quota();
    expect(quotaDispatch(q, { op: "reserve", neurons: 100 }, T)).toEqual({ ok: true });
    expect(quotaDispatch(q, { op: "hit", key: "k", limit: 1, windowMs: 1000 }, T)).toEqual({ ok: true, retryAfterSec: 0 });
    expect(quotaDispatch(q, { op: "used" }, T)).toEqual({ used: 100, limit: PUBLIC_NEURON_BUDGET, restingUntil: null });
  });
  it("lets the public use 5,000 of the 8,000 units and keeps the rest for judge links", () => {
    const q = quota();
    expect(quotaDispatch(q, { op: "reserve", neurons: 4900 }, T)).toEqual({ ok: true });
    expect(quotaDispatch(q, { op: "reserve", neurons: 150 }, T)).toEqual({ ok: false });
    expect(quotaDispatch(q, { op: "reserve", neurons: 100 }, T)).toEqual({ ok: true });
    expect(quotaDispatch(q, { op: "reserve", neurons: 1 }, T)).toEqual({ ok: false });
    expect(quotaDispatch(q, { op: "reserve", neurons: 150, judge: true }, T)).toEqual({ ok: true });
    expect(quotaDispatch(q, { op: "reserve", neurons: 2850, judge: true }, T)).toEqual({ ok: true });
    expect(quotaDispatch(q, { op: "reserve", neurons: 1, judge: true }, T)).toEqual({ ok: false });
    expect(q.neuronsUsed(T)).toBe(DAILY_NEURON_BUDGET);
  });
  it("reports resting for the caller asking: the public at 5,000, judges at 8,000", () => {
    const q = quota();
    q.reserveNeurons(T, 5000);
    expect(quotaDispatch(q, { op: "used" }, T)).toMatchObject({ used: 5000, limit: 5000, restingUntil: "2026-11-02T00:00:00.000Z" });
    expect(quotaDispatch(q, { op: "used", judge: true }, T)).toMatchObject({ used: 5000, limit: 8000, restingUntil: null });
  });
});

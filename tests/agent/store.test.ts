import { describe, expect, it } from "vitest";
import { backoffMs } from "../../src/agent/policy";
import { Store } from "../../src/agent/store";
import { captured, held, LAUNCH, signedEvent } from "./fixtures";
import { memoryDb } from "./sqlite";

function freshStore(): Store {
  const s = new Store(memoryDb());
  s.migrate();
  return s;
}

describe("Store", () => {
  it("does not exist until a show id is set, and an unmigrated store is not an error", () => {
    expect(new Store(memoryDb()).exists()).toBe(false);
    const s = freshStore();
    expect(s.exists()).toBe(false);
    s.setMeta("show_id", "sshowtestaa");
    expect(s.exists()).toBe(true);
  });

  it("appends each event once per deterministic key", async () => {
    const s = freshStore();
    expect(s.appendEvent(LAUNCH, await signedEvent())).toBe(true);
    expect(s.appendEvent(LAUNCH, held(1))).toBe(true);
    expect(s.appendEvent(LAUNCH + 5, held(1))).toBe(false);
    expect(s.events().map((e) => e.key)).toEqual(["mandate", "pledge:p1"]);
  });

  it("gives a pledge exactly one outcome and an authorization exactly one capture outcome", async () => {
    const s = freshStore();
    s.appendEvent(LAUNCH, held(1));
    expect(s.appendEvent(LAUNCH, { type: "late_hold", pledgeId: "p1", orderId: "O1", authorizationId: "A1", amountCents: 1500 })).toBe(false);
    expect(s.appendEvent(LAUNCH, captured(1))).toBe(true);
    expect(s.appendEvent(LAUNCH, { type: "capture_failed", authorizationId: "A1", reason: "x" })).toBe(false);
  });

  it("keeps the cached projection in step with new events", async () => {
    const s = freshStore();
    s.appendEvent(LAUNCH, await signedEvent());
    expect(s.projection().campaign.state).toBe("live");
    s.appendEvent(LAUNCH, held(1));
    s.appendEvent(LAUNCH, held(2));
    expect(s.projection().pledges.size).toBe(2);
    s.appendEvent(LAUNCH, held(3));
    expect(s.projection().campaign.state).toBe("tipped");
  });

  it("puts a job once per key and returns due jobs in order", () => {
    const s = freshStore();
    expect(s.putJob({ key: "capture:A1", kind: "capture", target: "A1", nextAt: 10 }, 0)).toBe(true);
    expect(s.putJob({ key: "capture:A1", kind: "capture", target: "A1", nextAt: 0 }, 0)).toBe(false);
    s.putJob({ key: "capture:A2", kind: "capture", target: "A2", nextAt: 5 }, 0);
    s.putJob({ key: "void:A3", kind: "void", target: "A3", nextAt: 50 }, 0);
    expect(s.dueJobs(10, 10).map((j) => j.key)).toEqual(["capture:A2", "capture:A1"]);
    expect(s.nextJobAt()).toBe(5);
    s.updateJob("capture:A2", { status: "done", note: "ok" });
    expect(s.job("capture:A2")).toMatchObject({ status: "done", note: "ok", attempts: 0 });
    expect(s.hasPending(["void"])).toBe(true);
    expect(s.hasPending(["refund"])).toBe(false);
    s.updateJob("void:A3", { status: "failed" });
    s.updateJob("capture:A1", { status: "done" });
    expect(s.nextJobAt()).toBeUndefined();
  });

  it("logs agent steps with rule and PayPal ids", () => {
    const s = freshStore();
    s.log({ at: 1, saw: "3 of 3 fans", did: "Charged Fan 01", rule: "rule-2-capture-at-tip", requestId: "capture:A1", resultId: "C1", source: "code" });
    expect(s.logs()).toEqual([{ seq: 1, at: 1, saw: "3 of 3 fans", did: "Charged Fan 01", rule: "rule-2-capture-at-tip", requestId: "capture:A1", resultId: "C1", source: "code" }]);
  });

  it("backs off 30 s, 2 min, 10 min, 30 min, then hourly", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([30_000, 120_000, 600_000, 1_800_000, 3_600_000, 3_600_000]);
  });
});

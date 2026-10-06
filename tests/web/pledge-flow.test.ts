import { describe, expect, it, vi } from "vitest";
import type { AuthorizeResponse } from "../../src/worker/api-types";
import { ApiFailure } from "../../src/web/shared/api";
import { CANCELLED, cleanInitials, failureMessage, PledgeFlow, REFUSED_RESUME, STALLED, UNCONFIRMED, type ApprovedOrder, type OrderMemory, type PledgeApi, type PledgeEvent } from "../../src/web/shared/pledge-flow";

const held = { pledgeId: "p1", status: "held", tipped: false, show: {} } as unknown as AuthorizeResponse;

function memoryStore(): OrderMemory & { value: ApprovedOrder | null } {
  const m = { value: null as ApprovedOrder | null, get: () => m.value, set: (o: ApprovedOrder) => { m.value = o; }, clear: () => { m.value = null; } };
  return m;
}

function setup(authorize: (orderId: string, n: number) => Promise<AuthorizeResponse>, createOrder?: () => Promise<never>) {
  const events: PledgeEvent[] = [];
  const authorized: string[] = [];
  let orders = 0;
  let auths = 0;
  const api: PledgeApi = {
    createOrder: createOrder ?? (async () => { orders += 1; return { orderId: `ORDER${orders}`, pledgeId: `p${orders}`, amountCents: 1500 }; }),
    authorize: (id) => { authorized.push(id); return authorize(id, ++auths); },
  };
  const memory = memoryStore();
  return { flow: new PledgeFlow(api, (e) => events.push(e), () => "MR", { retryDelaysMs: [0, 0], memory }), events, authorized, memory };
}

describe("pledge flow", () => {
  it("creates an order, authorizes it and reports the hold", async () => {
    const t = setup(async () => held);
    const id = await t.flow.createOrder();
    await t.flow.approve(id);
    expect(id).toBe("ORDER1");
    expect(t.events.map((e) => e.kind)).toEqual(["busy", "held"]);
    expect(t.events[1]).toMatchObject({ initials: "MR" });
    expect(t.flow.done).toBe(true);
    expect(t.flow.busy).toBe(false);
  });

  it("a 502 on authorize is uncertain: the SAME order is asked again and nothing new is created", async () => {
    const t = setup(async (_id, n) => { if (n === 1) throw new ApiFailure(502, "paypal_error", "PayPal didn't answer as expected. Nothing was charged."); return held; });
    await t.flow.approve(await t.flow.createOrder());
    expect(t.authorized).toEqual(["ORDER1", "ORDER1"]);
    expect(t.events.at(-1)?.kind).toBe("held");
    expect(t.memory.value).toBeNull();
  });

  it("when a 502 keeps coming, the order stays remembered and no new order can start", async () => {
    const t = setup(async () => { throw new ApiFailure(502, "paypal_error", "PayPal is having trouble."); });
    await t.flow.approve(await t.flow.createOrder());
    expect(t.events.at(-1)).toEqual({ kind: "unconfirmed", message: UNCONFIRMED });
    expect(t.memory.value).toEqual({ orderId: "ORDER1", initials: "MR" });
    expect(t.flow.canStart()).toBe(false);
    await expect(t.flow.createOrder()).rejects.toThrow(/still being checked/);
  });

  it("a late approval for an order that isn't the current one is ignored", async () => {
    const t = setup(async () => held);
    await t.flow.createOrder();
    await t.flow.approve("ORDER-OLD");
    expect(t.authorized).toEqual([]);
    expect(t.memory.value).toBeNull();
  });

  it("a cancelled popup places no hold and can be tried again", async () => {
    const t = setup(async () => held);
    await t.flow.createOrder();
    t.flow.cancel();
    expect(t.events.at(-1)).toEqual({ kind: "cancelled", message: CANCELLED });
    expect(t.flow.busy).toBe(false);
    expect(await t.flow.createOrder()).toBe("ORDER2");
  });

  it("shows our API's plain message when the order can't be created", async () => {
    const t = setup(async () => held, async () => { throw new ApiFailure(429, "rate_limited", "Too many tries. Please wait a moment and try again."); });
    await expect(t.flow.createOrder()).rejects.toBeInstanceOf(ApiFailure);
    expect(t.events.at(-1)).toEqual({ kind: "failed", message: "Too many tries. Please wait a moment and try again." });
  });

  it("does nothing more once the fan is on hold", async () => {
    const t = setup(async () => held);
    await t.flow.approve(await t.flow.createOrder());
    const n = t.events.length;
    await expect(t.flow.createOrder()).rejects.toThrow();
    t.flow.cancel();
    t.flow.error(new Error("late"));
    expect(t.events).toHaveLength(n);
  });

  it("simulate() runs the same create → authorize path and never throws", async () => {
    const t = setup(async () => { throw new ApiFailure(0, "network", "We couldn't reach Tip the Room. Check your connection and try again."); });
    await expect(t.flow.simulate()).resolves.toBeUndefined();
    expect(t.events.at(-1)?.kind).toBe("unconfirmed");
  });

  it("cleans initials and words unknown failures plainly", () => {
    expect(cleanInitials("m.r.")).toBe("MR");
    expect(cleanInitials("abcd")).toBe("ABC");
    expect(cleanInitials("<b>")).toBe("B");
    expect(cleanInitials("")).toBe("YOU");
    expect(failureMessage(new Error("INSTRUMENT_DECLINED"))).toBe("PayPal couldn't finish. Nothing was charged. Please try again.");
  });

  it("takes one order at a time: a second click while one is in flight is refused", async () => {
    let release: () => void = () => {};
    let calls = 0;
    const gate = new Promise<void>((r) => { release = r; });
    const t = setup(async () => held, async () => { calls += 1; await gate; return { orderId: "ORDER1", pledgeId: "p1", amountCents: 1500 } as never; });
    const first = t.flow.createOrder();
    await expect(t.flow.createOrder()).rejects.toThrow();
    release();
    expect(await first).toBe("ORDER1");
    expect(calls).toBe(1);
    expect(t.events.map((e) => e.kind)).toEqual(["busy"]);
  });

  it("canStart is false while an order is in flight, and the SDK's echo of a failed order adds no second message", async () => {
    let fail: (e: Error) => void = () => {};
    const gate = new Promise<never>((_, rej) => { fail = rej; });
    const t = setup(async () => held, () => gate);
    expect(t.flow.canStart()).toBe(true);
    const first = t.flow.createOrder();
    expect(t.flow.canStart()).toBe(false);
    fail(new Error("boom"));
    await expect(first).rejects.toThrow();
    expect(t.flow.canStart()).toBe(true);
    t.flow.error(new Error("boom"));
    expect(t.events.map((e) => e.kind)).toEqual(["busy", "failed"]);
  });

  it("confirms with the initials that were sent, even if the box changes during the popup", async () => {
    let box = "MR";
    const events: PledgeEvent[] = [];
    const api: PledgeApi = { createOrder: async () => ({ orderId: "O1", pledgeId: "p1", amountCents: 1500 }), authorize: async () => held };
    const flow = new PledgeFlow(api, (e) => events.push(e), () => box, { retryDelaysMs: [0, 0] });
    const id = await flow.createOrder();
    box = "ZZ";
    await flow.approve(id);
    expect(events.at(-1)).toMatchObject({ kind: "held", initials: "MR" });
  });

  it("a lost answer (network) is asked again on the SAME order, and never creates a second one", async () => {
    const t = setup(async (_id, n) => { if (n < 3) throw new ApiFailure(0, "network", "lost"); return held; });
    await t.flow.approve(await t.flow.createOrder());
    expect(t.authorized).toEqual(["ORDER1", "ORDER1", "ORDER1"]);
    expect(t.events.at(-1)?.kind).toBe("held");
    expect(t.memory.value).toBeNull();
  });

  it("after the retries run out, the approved order is remembered for a reload", async () => {
    const t = setup(async () => { throw new ApiFailure(0, "network", "lost"); });
    await t.flow.approve(await t.flow.createOrder());
    expect(t.events.at(-1)?.kind).toBe("unconfirmed");
    expect(t.memory.value).toEqual({ orderId: "ORDER1", initials: "MR" });
  });

  it("a definite refusal (4xx) forgets the order", async () => {
    const t = setup(async () => { throw new ApiFailure(409, "conflict", "Pledging has closed for this show."); });
    await t.flow.approve(await t.flow.createOrder());
    expect(t.authorized).toEqual(["ORDER1"]);
    expect(t.memory.value).toBeNull();
  });

  it("resume() asks about a remembered order and reports it as held without a new order", async () => {
    const t = setup(async () => held);
    t.memory.set({ orderId: "ORDERX", initials: "JD" });
    await t.flow.resume();
    expect(t.authorized).toEqual(["ORDERX"]);
    expect(t.events).toEqual([{ kind: "busy" }, { kind: "held", res: held, initials: "JD", resumed: true }]);
    expect(t.flow.done).toBe(true);
    expect(t.memory.value).toBeNull();
  });

  it("resume() does nothing without a remembered order, and says so plainly when the server refuses", async () => {
    const t = setup(async () => { throw new ApiFailure(404, "not_found", "nope"); });
    await t.flow.resume();
    expect(t.authorized).toEqual([]);
    expect(t.events).toEqual([]);
    t.memory.set({ orderId: "ORDERX", initials: "JD" });
    await t.flow.resume();
    expect(t.events.at(-1)).toEqual({ kind: "failed", message: REFUSED_RESUME });
    expect(t.flow.busy).toBe(false);
    expect(t.memory.value).toBeNull();
    expect(t.flow.canStart()).toBe(true);
  });

  it("resume() that gets no answer keeps the order and offers to check again on the same one", async () => {
    let n = 0;
    const t = setup(async () => { n += 1; if (n === 1) throw new ApiFailure(0, "network", "lost"); return held; });
    t.memory.set({ orderId: "ORDERX", initials: "JD" });
    await t.flow.resume();
    expect(t.events.at(-1)).toEqual({ kind: "unconfirmed", message: UNCONFIRMED });
    expect(t.flow.canStart()).toBe(false);
    await t.flow.resume();
    expect(t.authorized).toEqual(["ORDERX", "ORDERX"]);
    expect(t.events.at(-1)?.kind).toBe("held");
    expect(t.memory.value).toBeNull();
  });

  it("unlocks the button when PayPal never calls back (blocked popup)", async () => {
    vi.useFakeTimers();
    try {
      const events: PledgeEvent[] = [];
      const flow = new PledgeFlow({ createOrder: async () => ({ orderId: "ORDER1", pledgeId: "p1", amountCents: 1500 }), authorize: async () => held }, (e) => events.push(e), () => "MR", { stallMs: 1000 });
      await flow.createOrder();
      expect(flow.canStart()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(flow.canStart()).toBe(true);
      expect(events.at(-1)).toEqual({ kind: "failed", message: STALLED });
    } finally {
      vi.useRealTimers();
    }
  });
});

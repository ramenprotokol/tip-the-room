import { describe, expect, it } from "vitest";
import type { AuthorizeResponse } from "../../src/worker/api-types";
import { ApiFailure } from "../../src/web/shared/api";
import { CANCELLED, cleanInitials, failureMessage, PledgeFlow, type PledgeApi, type PledgeEvent } from "../../src/web/shared/pledge-flow";

const held = { pledgeId: "p1", status: "held", tipped: false, show: {} } as unknown as AuthorizeResponse;

function setup(authorize: (orderId: string, n: number) => Promise<AuthorizeResponse>, createOrder?: () => Promise<never>) {
  const events: PledgeEvent[] = [];
  const authorized: string[] = [];
  let orders = 0;
  let auths = 0;
  const api: PledgeApi = {
    createOrder: createOrder ?? (async () => { orders += 1; return { orderId: `ORDER${orders}`, pledgeId: `p${orders}`, amountCents: 1500 }; }),
    authorize: (id) => { authorized.push(id); return authorize(id, ++auths); },
  };
  return { flow: new PledgeFlow(api, (e) => events.push(e), () => "MR"), events, authorized };
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

  it("after a 502 on authorize, says so plainly and the next try uses a NEW order", async () => {
    const t = setup(async (_id, n) => { if (n === 1) throw new ApiFailure(502, "paypal_error", "PayPal didn't answer as expected. Nothing was charged."); return held; });
    await t.flow.approve(await t.flow.createOrder());
    expect(t.events.at(-1)).toEqual({ kind: "failed", message: "PayPal didn't answer as expected. Nothing was charged. Please try again." });
    expect(t.flow.busy).toBe(false);
    expect(t.flow.done).toBe(false);
    await t.flow.approve(await t.flow.createOrder());
    expect(t.authorized).toEqual(["ORDER1", "ORDER2"]);
    expect(t.events.at(-1)?.kind).toBe("held");
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
    expect(t.events.at(-1)?.kind).toBe("failed");
  });

  it("cleans initials and words unknown failures plainly", () => {
    expect(cleanInitials("m.r.")).toBe("MR");
    expect(cleanInitials("abcd")).toBe("ABC");
    expect(cleanInitials("<b>")).toBe("B");
    expect(cleanInitials("")).toBe("YOU");
    expect(failureMessage(new Error("INSTRUMENT_DECLINED"))).toBe("PayPal couldn't finish. Nothing was charged. Please try again.");
  });
});

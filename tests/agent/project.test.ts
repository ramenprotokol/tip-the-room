import { describe, expect, it } from "vitest";
import { LedgerCorrupt, project } from "../../src/agent/project";
import { captured, DEADLINE, held, signedEvent, stored } from "./fixtures";

describe("project", () => {
  it("rebuilds the campaign from events: tip, charges, payout", async () => {
    const events = stored([await signedEvent(), held(1), held(2), held(3), captured(1), captured(2), captured(3, 1400), { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE }]);
    const p = project(events);
    expect(p.campaign.state).toBe("paying_out");
    expect(p.campaign.pledges).toEqual({ held: 0, charged: 3, released: 0, refunded: 0, failed: 0 });
    expect(p.collectedNet).toBe(1412 + 1412 + 1400);
    expect(p.collectedGross).toBe(4500);
    expect(p.pledges.get("p3")).toMatchObject({ status: "charged", captureId: "C3", netCents: 1400, number: 3 });
  });

  it("is the same however many times it is replayed", async () => {
    const events = stored([await signedEvent(), held(1), held(2), held(3), captured(1)]);
    expect(project(events).campaign).toEqual(project(events).campaign);
  });

  it("counts net from capture events only; a capture for an unknown hold changes nothing", async () => {
    const p = project(stored([await signedEvent(), held(1), held(2), held(3), captured(9)]));
    expect(p.collectedNet).toBe(0);
    expect(p.campaign.pledges.charged).toBe(0);
  });

  it("releases a held pledge on void, but a retired (late) hold never touches the counts", async () => {
    const p = project(
      stored([
        await signedEvent(),
        held(1),
        { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE },
        { type: "late_hold", pledgeId: "p9", orderId: "O9", authorizationId: "A9", amountCents: 1500 },
        { type: "void_ok", authorizationId: "A9" },
        { type: "void_ok", authorizationId: "A1" },
      ]),
    );
    expect(p.campaign.state).toBe("missed");
    expect(p.campaign.pledges).toMatchObject({ held: 0, released: 1 });
    expect(p.retired.get("A9")).toMatchObject({ why: "late", voided: true });
  });

  it("moves a renewed hold to its new authorization and retires the old one", async () => {
    const p = project(
      stored([
        await signedEvent(),
        held(1, true),
        { type: "hold_replaced", pledgeId: "p1", newPaypalPledgeId: "p1-h1", orderId: "O1b", authorizationId: "A1b", oldOrderId: "O1", oldAuthorizationId: "A1", authorizedAt: 5, expiresAt: 6 },
      ]),
    );
    expect(p.pledges.get("p1")).toMatchObject({ authorizationId: "A1b", orderId: "O1b", paypalPledgeId: "p1-h1", status: "held" });
    expect(p.pledgeByAuth.get("A1b")).toBe("p1");
    expect(p.pledgeByAuth.has("A1")).toBe(false);
    expect(p.retired.get("A1")).toMatchObject({ why: "replaced", orderId: "O1" });
    expect(p.campaign.pledges.held).toBe(1);
  });

  it("records approvals from approved proposals and from calling the show off", async () => {
    const p = project(
      stored([
        await signedEvent(),
        { type: "proposal_made", proposalId: "pace1", options: [{ id: "lower", approvalKey: "lower:2", label: "Lower the target to 2", newThreshold: 2 }], explanation: "x", recommend: "lower", source: "template" },
        { type: "proposal_approved", proposalId: "pace1", option: "lower", approvalKey: "lower:2" },
        { type: "threshold_lowered", newThreshold: 2 },
      ]),
    );
    expect(p.approvals.has("lower:2")).toBe(true);
    expect(p.proposals.get("pace1")?.approved?.option).toBe("lower");
    expect(p.campaign.threshold).toBe(2);
  });

  it("does not treat a retry payout batch as the campaign's payout", async () => {
    const line = { role: "room" as const, label: "Lucky's Café", paypalEmail: "room@example.com", amount: 2000 };
    const p = project(stored([await signedEvent(), held(1), held(2), held(3), captured(1), captured(2), captured(3), { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE }, { type: "payout_sent", senderBatchId: "payout-s", batchId: "B1", status: "PENDING", lines: [line], retry: false, recovered: false }, { type: "payout_sent", senderBatchId: "payout-s-r1", batchId: "B2", status: "PENDING", lines: [line], retry: true, recovered: false }]));
    expect(p.campaign.state).toBe("settled");
    expect(p.payouts.map((x) => x.retry)).toEqual([false, true]);
  });

  it("throws LedgerCorrupt when an event can't be replayed", () => {
    expect(() => project(stored([held(1)]))).toThrow(LedgerCorrupt);
  });
});

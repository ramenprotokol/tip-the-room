export type CampaignState = "draft" | "live" | "tipped" | "paying_out" | "settled" | "missed" | "cancelled";

export interface PledgeCounts {
  held: number;
  charged: number;
  released: number;
  refunded: number;
  /** Captures that failed; the money was never taken. */
  failed: number;
}

export interface Campaign {
  state: CampaignState;
  threshold: number;
  /** Epoch ms when pledging closes. */
  deadline: number;
  pledges: PledgeCounts;
  extensionsUsed: number;
}

export type CampaignEvent =
  | { type: "mandate_signed"; threshold: number; deadline: number }
  | { type: "pledge_held" }
  | { type: "pledge_charged" }
  | { type: "pledge_capture_failed" }
  | { type: "deadline_reached"; now: number }
  | { type: "payouts_sent" }
  | { type: "holds_released"; count: number }
  | { type: "deadline_extended"; newDeadline: number }
  | { type: "show_cancelled" }
  | { type: "refunds_sent"; count: number };

export type Effect =
  | { type: "capture_all_held" }
  | { type: "capture_new_pledge" }
  | { type: "void_all_held" }
  | { type: "send_payouts" }
  | { type: "refund_all_charged" };

export interface Step {
  campaign: Campaign;
  effects: Effect[];
}

export class IllegalTransition extends Error {
  constructor(state: CampaignState, event: CampaignEvent["type"], why = "not allowed") {
    super(`Cannot apply ${event} while ${state}: ${why}`);
    this.name = "IllegalTransition";
  }
}

export function initialCampaign(): Campaign {
  return { state: "draft", threshold: 0, deadline: 0, pledges: { held: 0, charged: 0, released: 0, refunded: 0, failed: 0 }, extensionsUsed: 0 };
}

export function fansCommitted(c: Campaign): number {
  return c.pledges.held + c.pledges.charged;
}

const FINAL_OR_PAYING: readonly CampaignState[] = ["missed", "settled", "cancelled", "paying_out"];

export function reduce(c: Campaign, e: CampaignEvent): Step {
  const same = (campaign: Campaign, effects: Effect[] = []): Step => ({ campaign, effects });
  const p = c.pledges;
  switch (e.type) {
    case "mandate_signed":
      if (c.state !== "draft") throw new IllegalTransition(c.state, e.type);
      if (!Number.isInteger(e.threshold) || e.threshold < 1 || !Number.isFinite(e.deadline)) {
        throw new IllegalTransition(c.state, e.type, "threshold must be a whole number of at least 1 and the deadline a real time");
      }
      return same({ ...c, state: "live", threshold: e.threshold, deadline: e.deadline });

    case "pledge_held": {
      if (c.state !== "live" && c.state !== "tipped") throw new IllegalTransition(c.state, e.type, "pledging is closed");
      const next = { ...c, pledges: { ...p, held: p.held + 1 } };
      if (c.state === "tipped") return same(next, [{ type: "capture_new_pledge" }]);
      if (fansCommitted(next) >= c.threshold) return same({ ...next, state: "tipped" }, [{ type: "capture_all_held" }]);
      return same(next);
    }

    case "pledge_charged": {
      if (c.state !== "tipped" && c.state !== "paying_out" && c.state !== "cancelled") {
        throw new IllegalTransition(c.state, e.type, "captures only happen after the show tips");
      }
      if (p.held <= 0) throw new IllegalTransition(c.state, e.type, "no hold to charge");
      const next = { ...c, pledges: { ...p, held: p.held - 1, charged: p.charged + 1 } };
      // A capture that lands after cancellation must be refunded too.
      return same(next, c.state === "cancelled" ? [{ type: "refund_all_charged" }] : []);
    }

    case "pledge_capture_failed":
      if (c.state !== "tipped" && c.state !== "paying_out" && c.state !== "cancelled") {
        throw new IllegalTransition(c.state, e.type, "captures only happen after the show tips");
      }
      if (p.held <= 0) throw new IllegalTransition(c.state, e.type, "no hold to fail");
      return same({ ...c, pledges: { ...p, held: p.held - 1, failed: p.failed + 1 } });

    case "deadline_reached":
      if (FINAL_OR_PAYING.includes(c.state)) return same(c);
      if (e.now < c.deadline) return same(c);
      if (c.state === "live") return same({ ...c, state: "missed" }, [{ type: "void_all_held" }]);
      if (c.state === "tipped") return same({ ...c, state: "paying_out" }, [{ type: "send_payouts" }]);
      throw new IllegalTransition(c.state, e.type);

    case "payouts_sent":
      if (c.state !== "paying_out") throw new IllegalTransition(c.state, e.type);
      if (p.held !== 0) throw new IllegalTransition(c.state, e.type, "captures are still pending");
      return same({ ...c, state: "settled" });

    case "holds_released":
      if (c.state !== "missed" && c.state !== "cancelled") throw new IllegalTransition(c.state, e.type);
      if (!Number.isInteger(e.count) || e.count < 0 || e.count > p.held) throw new IllegalTransition(c.state, e.type, "count out of range");
      return same({ ...c, pledges: { ...p, held: p.held - e.count, released: p.released + e.count } });

    case "deadline_extended":
      if (c.state !== "live") throw new IllegalTransition(c.state, e.type);
      if (c.extensionsUsed >= 1) throw new IllegalTransition(c.state, e.type, "only one extension is allowed");
      if (e.newDeadline <= c.deadline) throw new IllegalTransition(c.state, e.type, "an extension must move the deadline later");
      return same({ ...c, deadline: e.newDeadline, extensionsUsed: c.extensionsUsed + 1 });

    case "show_cancelled":
      if (c.state !== "tipped") throw new IllegalTransition(c.state, e.type);
      return same({ ...c, state: "cancelled" }, [{ type: "void_all_held" }, { type: "refund_all_charged" }]);

    case "refunds_sent":
      if (c.state !== "cancelled") throw new IllegalTransition(c.state, e.type);
      if (!Number.isInteger(e.count) || e.count < 0 || e.count > p.charged) throw new IllegalTransition(c.state, e.type, "count out of range");
      return same({ ...c, pledges: { ...p, charged: p.charged - e.count, refunded: p.refunded + e.count } });

    default:
      throw new IllegalTransition(c.state, (e as { type: string }).type as CampaignEvent["type"], "unknown event");
  }
}

import { PayPalError } from "../paypal/errors";
import type { PayPalLedgerEvent } from "../paypal/webhooks";
import type { ApiError, ApproveRequest, CreateOrderRequest, SignRequest } from "../worker/api-types";
import type { DemoSeed } from "./demo";
import { ServiceError } from "./errors";
import { isShowId } from "./ids";
import type { CampaignService } from "./service";

/** The JSON messages the Worker sends to a campaign's Durable Object. */
export type CampaignOp =
  | { op: "init"; showId: string; signTokenHash: string }
  | { op: "sign"; body: SignRequest }
  | { op: "public" }
  | { op: "order"; body: CreateOrderRequest }
  | { op: "authorize"; orderId: string }
  | { op: "manage"; manageKey: string | null }
  | { op: "approve"; manageKey: string | null; proposalId: string; body: ApproveRequest }
  | { op: "call_off"; manageKey: string | null }
  | { op: "decline"; manageKey: string | null; proposalId: string }
  | { op: "webhook"; event: PayPalLedgerEvent }
  | { op: "webhook_unreadable"; eventType: string }
  | { op: "demo_init"; showId: string; seed: DemoSeed; demoKeyHash: string }
  | { op: "demo_fans"; manageKey: string | null; count: number }
  | { op: "demo_ff"; manageKey: string | null; topUp: boolean }
  | { op: "demo_pace"; manageKey: string | null }
  | { op: "demo_retire"; manageKey: string | null };

export type CampaignReply = { ok: true; data: unknown } | { ok: false; status: number; error: ApiError["error"] };

/** Ops that create a show. Every other op on an empty store is a 404 and creates nothing. */
const CREATES: ReadonlySet<string> = new Set(["init", "demo_init"]);

export async function dispatch(service: CampaignService, op: CampaignOp): Promise<CampaignReply> {
  try {
    if (op.op === "init" && (!isShowId(op.showId) || typeof op.signTokenHash !== "string" || !/^[0-9a-f]{64}$/.test(op.signTokenHash))) throw new ServiceError(400, "bad_request", "That isn't a valid show id.");
    if (op.op === "demo_init" && (!isShowId(op.showId) || !op.showId.startsWith("d") || typeof op.demoKeyHash !== "string" || !/^[0-9a-f]{64}$/.test(op.demoKeyHash) || (op.seed?.key !== "a" && op.seed?.key !== "b"))) throw new ServiceError(400, "bad_request", "That isn't a valid demo show.");
    if (CREATES.has(op.op)) service.ensureSchema();
    else if (!service.exists()) return { ok: false, status: 404, error: { code: "not_found", message: "There's no show here." } };
    return { ok: true, data: await run(service, op) };
  } catch (e) {
    return toReply(e);
  }
}

async function run(service: CampaignService, op: CampaignOp): Promise<unknown> {
  switch (op.op) {
    case "init":
      return service.init(op);
    case "sign":
      return service.sign(op.body);
    case "public":
      return service.publicView(service.applyDeadline());
    case "order":
      return service.createOrder(op.body);
    case "authorize":
      return service.authorize(op.orderId);
    case "manage":
      await service.checkKey(op.manageKey);
      return service.manageView();
    case "approve":
      await service.checkKey(op.manageKey);
      return service.approve(op.proposalId, op.body);
    case "call_off":
      await service.checkKey(op.manageKey);
      return service.callOff();
    case "decline":
      await service.checkKey(op.manageKey);
      return service.declineProposal(op.proposalId);
    case "demo_pace":
      await service.checkKey(op.manageKey);
      return service.checkPaceNow();
    case "webhook":
      return service.ingestWebhook(op.event);
    case "webhook_unreadable":
      return service.noteUnreadableWebhook(op.eventType);
    case "demo_init":
      return service.initDemo(op);
    case "demo_fans":
      await service.checkKey(op.manageKey);
      return service.addSimFans(op.count);
    case "demo_ff":
      await service.checkKey(op.manageKey);
      return service.fastForward(op.topUp);
    case "demo_retire":
      await service.checkKey(op.manageKey);
      return service.retire();
  }
}

function toReply(e: unknown): CampaignReply {
  if (e instanceof ServiceError) return { ok: false, status: e.status, error: { code: e.code, message: e.message, ...(e.problems ? { problems: e.problems } : {}) } };
  if (e instanceof PayPalError) return { ok: false, status: 502, error: { code: "paypal_error", message: "PayPal didn't answer as expected. Nothing was charged." } };
  return { ok: false, status: 500, error: { code: "internal", message: "Something went wrong on our side." } };
}

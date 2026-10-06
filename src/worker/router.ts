import type { AiDeps } from "../agent/ai";
import { draftFromSentence } from "../agent/ai-jobs";
import type { CampaignOp, CampaignReply } from "../agent/dispatch";
import { draftFields, previewDraft } from "../agent/draft";
import { ServiceError } from "../agent/errors";
import { isShowId, newId, newSecret, sha256Hex, showIdFromRef, type Clock, type Random } from "../agent/ids";
import type { QuotaPort } from "../agent/quota";
import { isKnownEventType, mapWebhookEvent, type PayPalLedgerEvent, type WebhookEvent } from "../paypal/webhooks";
import { MANAGE_KEY_HEADER, type ApiError, type CreateShowRequest, type CreateShowResponse, type ErrorCode } from "./api-types";

export interface CampaignsPort {
  call(showId: string, op: CampaignOp): Promise<CampaignReply>;
}

export interface RouterConfig {
  allowedOrigins: string[];
  /** Null when PAYPAL_WEBHOOK_ID is unset: webhooks are then refused. */
  webhookId: string | null;
  rateSalt: string;
}

export interface RouterDeps {
  campaigns: CampaignsPort;
  quota: QuotaPort;
  ai: AiDeps;
  random: Random;
  clock: Clock;
  config: RouterConfig;
  verifyWebhook(headers: Headers, rawBody: string, webhookId: string): Promise<boolean>;
}

const HOUR = 60 * 60 * 1000;
/** Spec 8: per-visitor limits (fixed windows) plus a global cap on new demo copies. */
export const LIMITS = {
  createShow: { limit: 10, windowMs: HOUR },
  sign: { limit: 20, windowMs: HOUR },
  order: { limit: 30, windowMs: HOUR },
  manage: { limit: 240, windowMs: HOUR },
  demo: { limit: 5, windowMs: HOUR },
  demoFans: { limit: 12, windowMs: HOUR },
  demoGlobal: { limit: 300, windowMs: 24 * HOUR },
} as const;
type LimitName = keyof typeof LIMITS;

const MAX_BODY = 16_384;
const MAX_WEBHOOK_BODY = 65_536;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface Ctx {
  req: Request;
  deps: RouterDeps;
  params: string[];
}
type Handler = (c: Ctx) => Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function errorBody(code: ErrorCode, message: string, extra: Partial<ApiError["error"]> = {}): ApiError {
  return { error: { code, message, ...extra } };
}

async function readText(req: Request, max: number): Promise<string> {
  if (Number(req.headers.get("content-length") ?? "0") > max) throw new HttpError(413, "too_large", "That request is too large.");
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "too_large", "That request is too large.");
  return text;
}

async function readJson<T>(req: Request): Promise<T> {
  const text = await readText(req, MAX_BODY);
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw new HttpError(400, "bad_request", "That request isn't valid JSON.");
  }
}

function fromReply(reply: CampaignReply, okStatus = 200): Response {
  return reply.ok ? json(okStatus, reply.data) : json(reply.status, { error: reply.error });
}

async function visitor(c: Ctx): Promise<string> {
  const ip = c.req.headers.get("cf-connecting-ip") ?? "local";
  return (await sha256Hex(`${c.deps.config.rateSalt}|${ip}`)).slice(0, 24);
}

async function limit(c: Ctx, name: LimitName, scope?: string): Promise<void> {
  const l = LIMITS[name];
  const r = await c.deps.quota.hit(`${name}:${scope ?? (await visitor(c))}`, l.limit, l.windowMs);
  if (!r.ok) throw new HttpError(429, "rate_limited", "Too many tries. Please wait a moment and try again.", r.retryAfterSec);
}

function showParam(c: Ctx): string {
  const id = c.params[0];
  if (!isShowId(id)) throw new HttpError(404, "not_found", "There's no show here.");
  return id;
}

const manageKey = (c: Ctx) => c.req.headers.get(MANAGE_KEY_HEADER);

const createShow: Handler = async (c) => {
  await limit(c, "createShow");
  const body = await readJson<CreateShowRequest>(c.req);
  if (!body || typeof body.sentence !== "string" || body.sentence.trim().length < 5 || body.sentence.length > 500) {
    throw new HttpError(422, "invalid", "Describe the show in one sentence (5 to 500 characters).");
  }
  const now = c.deps.clock.now();
  const suggestion = await draftFromSentence(c.deps.ai, body.sentence, now);
  const showId = newId("s", c.deps.random);
  const signToken = newSecret(c.deps.random);
  const reply = await c.deps.campaigns.call(showId, { op: "init", showId, signTokenHash: await sha256Hex(signToken) });
  if (!reply.ok) return fromReply(reply);
  const draft = draftFields(suggestion.value, body, now);
  const preview = previewDraft(showId, draft, now);
  const res: CreateShowResponse = { showId, signToken, draft, threshold: preview.threshold, problems: preview.problems, source: suggestion.source };
  return json(201, res);
};

const sign: Handler = async (c) => {
  await limit(c, "sign");
  const id = showParam(c);
  return fromReply(await c.deps.campaigns.call(id, { op: "sign", body: await readJson(c.req) }));
};

const getShow: Handler = async (c) => fromReply(await c.deps.campaigns.call(showParam(c), { op: "public" }));

const createOrder: Handler = async (c) => {
  await limit(c, "order");
  const id = showParam(c);
  return fromReply(await c.deps.campaigns.call(id, { op: "order", body: await readJson(c.req) }), 201);
};

const authorize: Handler = async (c) => {
  await limit(c, "order");
  const id = showParam(c);
  return fromReply(await c.deps.campaigns.call(id, { op: "authorize", orderId: c.params[1] }));
};

const manage: Handler = async (c) => {
  await limit(c, "manage");
  return fromReply(await c.deps.campaigns.call(showParam(c), { op: "manage", manageKey: manageKey(c) }));
};

const approve: Handler = async (c) => {
  await limit(c, "manage");
  const id = showParam(c);
  return fromReply(await c.deps.campaigns.call(id, { op: "approve", manageKey: manageKey(c), proposalId: c.params[1], body: await readJson(c.req) }));
};

const callOff: Handler = async (c) => {
  await limit(c, "manage");
  return fromReply(await c.deps.campaigns.call(showParam(c), { op: "call_off", manageKey: manageKey(c) }));
};

/** Our show id from whichever reference a PayPal resource carries (custom_id, sender_item_id, sender_batch_id). */
function showIdFromResource(event: WebhookEvent): string | null {
  const o = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);
  const r = o(event?.resource);
  const refs = [r?.custom_id, o(r?.payout_item)?.sender_item_id, o(o(r?.batch_header)?.sender_batch_header)?.sender_batch_id];
  for (const ref of refs) {
    const id = typeof ref === "string" ? showIdFromRef(ref) : null;
    if (id) return id;
  }
  return null;
}

const paypalWebhook: Handler = async (c) => {
  const webhookId = c.deps.config.webhookId;
  if (!webhookId) return json(403, errorBody("forbidden", "Webhooks are not configured."));
  const raw = await readText(c.req, MAX_WEBHOOK_BODY);
  let genuine: boolean;
  try {
    genuine = await c.deps.verifyWebhook(c.req.headers, raw, webhookId);
  } catch (e) {
    // A missing webhook id is our setup, not a transient fault: PayPal must not keep retrying it.
    if (e instanceof RangeError) return json(403, errorBody("forbidden", "Webhooks are not configured."));
    return json(502, errorBody("unavailable", "Couldn't verify the message with PayPal. Please retry."));
  }
  if (!genuine) return json(400, errorBody("bad_request", "The signature check failed."));
  let event: WebhookEvent;
  try {
    event = JSON.parse(raw) as WebhookEvent;
  } catch {
    return json(200, { ignored: true });
  }
  if (!event || typeof event !== "object") return json(200, { ignored: true });
  let mapped: PayPalLedgerEvent | null;
  try {
    mapped = mapWebhookEvent(event);
  } catch {
    mapped = null;
  }
  if (!mapped) {
    // A known type we couldn't read (missing id, odd amount or currency): tell that show's agent log. Ids only.
    if (isKnownEventType(event.event_type)) {
      const showId = showIdFromResource(event);
      if (showId) await c.deps.campaigns.call(showId, { op: "webhook_unreadable", eventType: event.event_type });
    }
    return json(200, { ignored: true });
  }
  const showId = mapped.customId ? showIdFromRef(mapped.customId) : null;
  if (!showId) return json(200, { ignored: true });
  const reply = await c.deps.campaigns.call(showId, { op: "webhook", event: mapped });
  if (reply.ok) return json(200, { ok: true });
  if (reply.status === 404) return json(200, { ignored: true });
  return json(500, errorBody("internal", "Couldn't record that message yet. Please retry."));
};

const ROUTES: { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: "GET", pattern: /^\/api\/health$/, handler: async () => json(200, { ok: true }) },
  { method: "POST", pattern: /^\/api\/shows$/, handler: createShow },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/sign$/, handler: sign },
  { method: "GET", pattern: /^\/api\/shows\/([a-z0-9]+)$/, handler: getShow },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/orders$/, handler: createOrder },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/orders\/([A-Za-z0-9-]+)\/authorize$/, handler: authorize },
  { method: "GET", pattern: /^\/api\/shows\/([a-z0-9]+)\/manage$/, handler: manage },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/proposals\/([a-z0-9]+)\/approve$/, handler: approve },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/call-off$/, handler: callOff },
  { method: "POST", pattern: /^\/api\/webhooks\/paypal$/, handler: paypalWebhook },
];

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": `content-type, ${MANAGE_KEY_HEADER}`,
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const retry = e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {};
    return json(e.status, errorBody(e.code, e.message, retry), e.retryAfterSec ? { "retry-after": String(e.retryAfterSec) } : {});
  }
  if (e instanceof ServiceError) return json(e.status, errorBody(e.code, e.message, e.problems ? { problems: e.problems } : {}));
  return json(500, errorBody("internal", "Something went wrong on our side."));
}

export async function route(req: Request, deps: RouterDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), deps.config.allowedOrigins);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const path = new URL(req.url).pathname;
  for (const r of ROUTES) {
    const m = r.pattern.exec(path);
    if (!m || r.method !== req.method) continue;
    try {
      return withHeaders(await r.handler({ req, deps, params: m.slice(1) }), cors);
    } catch (e) {
      return withHeaders(errorResponse(e), cors);
    }
  }
  return withHeaders(json(404, errorBody("not_found", "There's nothing here.")), cors);
}

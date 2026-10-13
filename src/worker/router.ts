import type { AiDeps } from "../agent/ai";
import { draftFromSentence } from "../agent/ai-jobs";
import type { CampaignOp, CampaignReply } from "../agent/dispatch";
import { draftFields, previewDraft } from "../agent/draft";
import { ServiceError } from "../agent/errors";
import { demoSeeds, type Receivers } from "../agent/demo";
import { demoShowIds, isDemoId, isShowId, newId, newSecret, sameHex, sha256Hex, showIdFromRef, visitorNet, type Clock, type Random } from "../agent/ids";
import { DEMO_COPIES_PER_DAY, DEMO_JUDGE_COPIES_PER_DAY, DEMO_TTL_MS } from "../agent/policy";
import type { QuotaPort } from "../agent/quota";
import { isKnownEventType, mapWebhookEvent, type PayPalLedgerEvent, type WebhookEvent } from "../paypal/webhooks";
import { JUDGE_CODE_HEADER, MANAGE_KEY_HEADER, type ApiError, type CreateShowRequest, type CreateShowResponse, type DemoFansRequest, type DemoFastForwardResponse, type DemoPaceResponse, type DemoResponse, type ErrorCode, type HealthResponse, type PublicShow, type SetupReport } from "./api-types";

export interface CampaignsPort {
  call(showId: string, op: CampaignOp): Promise<CampaignReply>;
}

export interface RouterConfig {
  allowedOrigins: string[];
  /** Null when PAYPAL_WEBHOOK_ID is unset: webhooks are then refused. */
  webhookId: string | null;
  rateSalt: string;
  /** Demo payout receivers (example.com unless sandbox accounts are configured). */
  receivers: Receivers;
  /** JUDGE_CODE secret, or null (then no request is a judge). */
  judgeCode: string | null;
  /** Facts for /api/health that the router can't derive itself. */
  setup: Omit<SetupReport, "webhook" | "judgeCode">;
}

export interface RouterDeps {
  campaigns: CampaignsPort;
  quota: QuotaPort;
  ai: AiDeps;
  random: Random;
  clock: Clock;
  config: RouterConfig;
  verifyWebhook(headers: Headers, rawBody: string, webhookId: string): Promise<boolean>;
  /** Edge cache for the public show reply (the Workers Cache API in production). Absent: no caching. */
  cache?: EdgeCache;
  /** The Worker's ctx.waitUntil, so a cache write finishes after the reply is sent. Absent: the write is awaited. */
  waitUntil?: (p: Promise<unknown>) => void;
}

/** The two Cache API calls we use. Keys are absolute URLs. */
export interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}

/** The public show reply is shared by every poller for this long (seconds), so a crowd of open pages costs one Durable Object call per show. */
export const PUBLIC_SHOW_CACHE_SECONDS = 3;
/** The page only sends a judge code of this shape, so health only reports one as set when it matches. */
const JUDGE_CODE_FORMAT = /^[A-Za-z0-9_-]{8,64}$/;

const HOUR = 60 * 60 * 1000;
/** Spec 8: per-visitor limits (fixed windows) plus a global cap on new demo copies. */
export const LIMITS = {
  createShow: { limit: 10, windowMs: HOUR },
  sign: { limit: 20, windowMs: HOUR },
  order: { limit: 30, windowMs: HOUR },
  manage: { limit: 1500, windowMs: HOUR },
  demo: { limit: 12, windowMs: HOUR },
  /** Public pool only: one visitor can't take more than a fifth of the day's copies. */
  demoDay: { limit: 10, windowMs: 24 * HOUR },
  demoJudge: { limit: 12, windowMs: HOUR },
  demoJudgeGlobal: { limit: DEMO_JUDGE_COPIES_PER_DAY, windowMs: 24 * HOUR },
  demoFans: { limit: 12, windowMs: HOUR },
  demoFastForward: { limit: 30, windowMs: HOUR },
  demoPace: { limit: 30, windowMs: HOUR },
  demoGlobal: { limit: DEMO_COPIES_PER_DAY, windowMs: 24 * HOUR },
  /** Webhook signature checks cost a PayPal call each, so they are capped per visitor and overall. PayPal sends from a few IPs and retries a 429. */
  webhookVisitor: { limit: 1000, windowMs: HOUR },
  webhookGlobal: { limit: 2000, windowMs: HOUR },
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

const tooLarge = () => new HttpError(413, "too_large", "That request is too large.");

/** Reads the body as a stream and stops as soon as the byte count passes `max` (bytes, not characters). */
async function readText(req: Request, max: number): Promise<string> {
  if (Number(req.headers.get("content-length") ?? "0") > max) throw tooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
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
  return (await sha256Hex(`${c.deps.config.rateSalt}|${visitorNet(ip)}`)).slice(0, 24);
}

async function limit(c: Ctx, name: LimitName, scope?: string): Promise<void> {
  const l = LIMITS[name];
  const r = await c.deps.quota.hit(`${name}:${scope ?? (await visitor(c))}`, l.limit, l.windowMs);
  if (!r.ok) throw new HttpError(429, "rate_limited", "Too many tries. Please wait a moment and try again.", r.retryAfterSec);
}

/**
 * Cheap reads (the public show, polled by every open page) are limited per Worker isolate in memory: no Durable
 * Object call and no storage write per request. Approximate by design, since each isolate counts alone.
 */
export const READ_LIMIT = { limit: 3600, windowMs: HOUR };
const reads = new Map<string, { start: number; count: number }>();
export function resetReadLimits(): void {
  reads.clear();
}
async function readLimit(c: Ctx): Promise<void> {
  const who = await visitor(c);
  const now = c.deps.clock.now();
  const r = reads.get(who);
  if (!r || now - r.start >= READ_LIMIT.windowMs) {
    if (reads.size >= 10_000) reads.clear();
    reads.set(who, { start: now, count: 1 });
    return;
  }
  r.count += 1;
  if (r.count > READ_LIMIT.limit) throw new HttpError(429, "rate_limited", "Too many tries. Please wait a moment and try again.", Math.max(1, Math.ceil((r.start + READ_LIMIT.windowMs - now) / 1000)));
}

/** Constant-time check: both sides are hashed to equal length first, then compared without early exit. */
async function isJudge(c: Ctx): Promise<boolean> {
  const want = c.deps.config.judgeCode;
  const got = c.req.headers.get(JUDGE_CODE_HEADER);
  if (!want || !got || got.length > 128) return false;
  return sameHex(await sha256Hex(got), await sha256Hex(want));
}

/** A new demo copy: judges with the code use their own pool; everyone else the public one. Checked before anything changes. */
async function demoCopyLimits(c: Ctx): Promise<void> {
  if (await isJudge(c)) {
    await limit(c, "demoJudge");
    await limit(c, "demoJudgeGlobal", "all");
    return;
  }
  await limit(c, "demo");
  await limit(c, "demoDay");
  await limit(c, "demoGlobal", "all");
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

/** Only the public read is cached, and only a 200: errors and every manage or other authenticated reply always go to the show. */
const getShow: Handler = async (c) => {
  await readLimit(c);
  const id = showParam(c);
  const cache = c.deps.cache;
  const key = `https://cache.tip-the-room.invalid/public-show/${id}`;
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    // A damaged cache entry is the same as no entry: ask the show.
    const cached = hit ? await hit.json().catch(() => undefined) : undefined;
    if (cached !== undefined) return json(200, cached);
  }
  const res = fromReply(await c.deps.campaigns.call(id, { op: "public" }));
  if (cache && res.status === 200) {
    const stored = new Response(res.clone().body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${PUBLIC_SHOW_CACHE_SECONDS}` } });
    const write = cache.put(key, stored).catch(() => undefined);
    if (c.deps.waitUntil) c.deps.waitUntil(write);
    else await write;
  }
  return res;
};

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

const decline: Handler = async (c) => {
  await limit(c, "manage");
  const id = showParam(c);
  return fromReply(await c.deps.campaigns.call(id, { op: "decline", manageKey: manageKey(c), proposalId: c.params[1] }));
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
  // Cheap pre-filter: only a known event type that names one of our shows is worth a PayPal call.
  // Everything else is acknowledged (200) so PayPal doesn't keep retrying it.
  let parsed: WebhookEvent;
  try {
    parsed = JSON.parse(raw) as WebhookEvent;
  } catch {
    return json(200, { ignored: true });
  }
  if (!parsed || typeof parsed !== "object" || !isKnownEventType(parsed.event_type) || !showIdFromResource(parsed)) return json(200, { ignored: true });
  await limit(c, "webhookVisitor");
  await limit(c, "webhookGlobal", "all");
  let genuine: boolean;
  try {
    genuine = await c.deps.verifyWebhook(c.req.headers, raw, webhookId);
  } catch (e) {
    // A missing webhook id is our setup, not a transient fault: PayPal must not keep retrying it.
    if (e instanceof RangeError) return json(403, errorBody("forbidden", "Webhooks are not configured."));
    return json(502, errorBody("unavailable", "Couldn't verify the message with PayPal. Please retry."));
  }
  if (!genuine) return json(400, errorBody("bad_request", "The signature check failed."));
  const event = parsed;
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

function demoParam(c: Ctx): string {
  const id = c.params[0];
  if (!isDemoId(id)) throw new HttpError(404, "not_found", "There's no demo here.");
  return id;
}

async function newDemoCopy(c: Ctx): Promise<DemoResponse> {
  const demoId = newId("d", c.deps.random);
  const demoKey = newSecret(c.deps.random);
  const demoKeyHash = await sha256Hex(demoKey);
  const shows: PublicShow[] = [];
  for (const seed of demoSeeds(c.deps.config.receivers)) {
    const showId = `${demoId}${seed.key}`;
    try {
      const reply = await c.deps.campaigns.call(showId, { op: "demo_init", showId, seed, demoKeyHash });
      if (!reply.ok) throw new HttpError(reply.status, reply.error.code, reply.error.message);
      shows.push(reply.data as PublicShow);
    } catch (e) {
      // The visitor never gets this copy's key, so a half-made copy would run its holds for nobody: retire what was made.
      for (const made of shows) {
        try {
          await c.deps.campaigns.call(made.showId, { op: "demo_retire", manageKey: demoKey });
        } catch {
          // Best effort: the copy still expires by itself within its 24 h.
        }
      }
      throw e;
    }
  }
  return { demoId, demoKey, shows: [shows[0], shows[1]], expiresAt: c.deps.clock.now() + DEMO_TTL_MS };
}

const createDemo: Handler = async (c) => {
  await demoCopyLimits(c);
  return json(201, await newDemoCopy(c));
};

const demoFans: Handler = async (c) => {
  await limit(c, "demoFans");
  const demoId = demoParam(c);
  const body = await readJson<DemoFansRequest>(c.req);
  if (body?.show !== "a" && body?.show !== "b") throw new HttpError(422, "invalid", "Pick show a or b.");
  return fromReply(await c.deps.campaigns.call(`${demoId}${body.show}`, { op: "demo_fans", manageKey: manageKey(c), count: body.count }));
};

const demoFastForward: Handler = async (c) => {
  await limit(c, "demoFastForward");
  const [a, b] = demoShowIds(demoParam(c));
  const ra = await c.deps.campaigns.call(a, { op: "demo_ff", manageKey: manageKey(c), topUp: true });
  if (!ra.ok) return fromReply(ra);
  const rb = await c.deps.campaigns.call(b, { op: "demo_ff", manageKey: manageKey(c), topUp: false });
  if (!rb.ok) return fromReply(rb);
  const res: DemoFastForwardResponse = { shows: [ra.data as PublicShow, rb.data as PublicShow] };
  return json(200, res);
};

const demoPace: Handler = async (c) => {
  await limit(c, "demoPace");
  const [a, b] = demoShowIds(demoParam(c));
  const ra = await c.deps.campaigns.call(a, { op: "demo_pace", manageKey: manageKey(c) });
  if (!ra.ok) return fromReply(ra);
  const rb = await c.deps.campaigns.call(b, { op: "demo_pace", manageKey: manageKey(c) });
  if (!rb.ok) return fromReply(rb);
  const res: DemoPaceResponse = { shows: [ra.data as PublicShow, rb.data as PublicShow] };
  return json(200, res);
};

/**
 * The key is checked first (read-only), so a wrong key spends no quota. Both limits are checked BEFORE the old copy is
 * retired, so a refused reset never leaves the visitor with no demo.
 */
const demoReset: Handler = async (c) => {
  const ids = demoShowIds(demoParam(c));
  for (const id of ids) {
    const r = await c.deps.campaigns.call(id, { op: "demo_check", manageKey: manageKey(c) });
    if (!r.ok && r.status !== 404) return fromReply(r);
  }
  await demoCopyLimits(c);
  for (const id of ids) {
    const r = await c.deps.campaigns.call(id, { op: "demo_retire", manageKey: manageKey(c) });
    // 404 means that show is already gone (a copy older than 24 h is deleted): carry on to a fresh copy.
    if (!r.ok && r.status !== 404) return fromReply(r);
  }
  return json(201, await newDemoCopy(c));
};

const health: Handler = async (c) => {
  const s = c.deps.config;
  const body: HealthResponse = { ok: true, setup: { ...s.setup, webhook: s.webhookId !== null, judgeCode: s.judgeCode !== null && JUDGE_CODE_FORMAT.test(s.judgeCode) } };
  return json(200, body);
};

const ROUTES: { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: "GET", pattern: /^\/api\/health$/, handler: health },
  { method: "POST", pattern: /^\/api\/shows$/, handler: createShow },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/sign$/, handler: sign },
  { method: "GET", pattern: /^\/api\/shows\/([a-z0-9]+)$/, handler: getShow },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/orders$/, handler: createOrder },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/orders\/([A-Za-z0-9-]+)\/authorize$/, handler: authorize },
  { method: "GET", pattern: /^\/api\/shows\/([a-z0-9]+)\/manage$/, handler: manage },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/proposals\/([a-z0-9]+)\/approve$/, handler: approve },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/proposals\/([a-z0-9]+)\/decline$/, handler: decline },
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/call-off$/, handler: callOff },
  { method: "POST", pattern: /^\/api\/webhooks\/paypal$/, handler: paypalWebhook },
  { method: "POST", pattern: /^\/api\/demo$/, handler: createDemo },
  { method: "POST", pattern: /^\/api\/demo\/([a-z0-9]+)\/fans$/, handler: demoFans },
  { method: "POST", pattern: /^\/api\/demo\/([a-z0-9]+)\/fast-forward$/, handler: demoFastForward },
  { method: "POST", pattern: /^\/api\/demo\/([a-z0-9]+)\/pace$/, handler: demoPace },
  { method: "POST", pattern: /^\/api\/demo\/([a-z0-9]+)\/reset$/, handler: demoReset },
];

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": `content-type, ${MANAGE_KEY_HEADER}, ${JUDGE_CODE_HEADER}`,
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

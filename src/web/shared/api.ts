// The one typed fetch client for every page. Errors become ApiFailure with a plain-English message that is safe to show as text.
import { JUDGE_CODE_HEADER, MANAGE_KEY_HEADER } from "../../worker/api-types";
import type { ApiError, ApproveRequest, ApproveResponse, AuthorizeResponse, CallOffResponse, CreateOrderRequest, CreateOrderResponse, CreateShowRequest, CreateShowResponse, DeclineResponse, DemoFansRequest, DemoFansResponse, DemoFastForwardResponse, DemoPaceResponse, DemoResponse, ErrorCode, ManageView, PublicShow, SignRequest, SignResponse } from "../../worker/api-types";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network",
    message: string,
    readonly problems: string[] = [],
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export const NETWORK_MESSAGE = "We couldn't reach Tip the Room. Check your connection and try again.";
export const TIMEOUT_MESSAGE = "Tip the Room is taking too long to answer. Please try again in a moment.";
export const FALLBACK_MESSAGE = "Something went wrong on our side.";

let pending = 0;
/** API calls and page actions still running. Parity tests wait for 0 before moving the frozen clock. */
export const pendingCount = (): number => pending;
/** Runs one page action (request plus the render that follows) and counts it as in flight until it ends. */
export async function act<T>(fn: () => Promise<T>): Promise<T> {
  pending += 1;
  try {
    return await fn();
  } finally {
    pending -= 1;
  }
}

export interface ClientOptions {
  /** The judge code from the visitor's link, sent on create show and demo create/reset only. */
  judgeCode?: () => string | null;
  timeoutMs?: number;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClient {
  createShow(body: CreateShowRequest): Promise<CreateShowResponse>;
  sign(showId: string, body: SignRequest): Promise<SignResponse>;
  getShow(showId: string): Promise<PublicShow>;
  createOrder(showId: string, body: CreateOrderRequest): Promise<CreateOrderResponse>;
  authorize(showId: string, orderId: string): Promise<AuthorizeResponse>;
  manage(showId: string, key: string): Promise<ManageView>;
  approve(showId: string, key: string, proposalId: string, body: ApproveRequest): Promise<ApproveResponse>;
  decline(showId: string, key: string, proposalId: string): Promise<DeclineResponse>;
  callOff(showId: string, key: string): Promise<CallOffResponse>;
  createDemo(): Promise<DemoResponse>;
  demoFans(demoId: string, key: string, body: DemoFansRequest): Promise<DemoFansResponse>;
  /** `show` names the button pressed; the server moves both shows (spec §4). */
  demoFastForward(demoId: string, key: string, show: "a" | "b"): Promise<DemoFastForwardResponse>;
  demoPace(demoId: string, key: string): Promise<DemoPaceResponse>;
  demoReset(demoId: string, key: string): Promise<DemoResponse>;
}

const seg = (s: string) => encodeURIComponent(s);

function readError(status: number, data: unknown): ApiFailure {
  const e = data && typeof data === "object" ? (data as Partial<ApiError>).error : undefined;
  const message = typeof e?.message === "string" && e.message.trim() ? e.message : FALLBACK_MESSAGE;
  const problems = Array.isArray(e?.problems) ? e.problems.filter((p): p is string => typeof p === "string") : [];
  const retry = typeof e?.retryAfterSec === "number" ? e.retryAfterSec : undefined;
  const code = (typeof e?.code === "string" ? e.code : "internal") as ErrorCode;
  return new ApiFailure(status, code, message, problems, retry);
}

export function apiClient(base: string, fetchFn: FetchLike = (input, init) => fetch(input, init), opts: ClientOptions = {}): ApiClient {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, key?: string, extra: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = { ...extra };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) headers[MANAGE_KEY_HEADER] = key;
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new ApiFailure(0, "network", timedOut ? TIMEOUT_MESSAGE : NETWORK_MESSAGE);
    }
    const text = await res.text().catch(() => "");
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw readError(res.status, data);
    if (data === null || typeof data !== "object") throw new ApiFailure(res.status, "internal", FALLBACK_MESSAGE);
    return data as T;
  }
  const run = <T>(method: "GET" | "POST", path: string, body?: unknown, key?: string, extra?: Record<string, string>) => act(() => call<T>(method, path, body, key, extra));
  const judge = (): Record<string, string> => {
    const code = opts.judgeCode?.();
    return code ? { [JUDGE_CODE_HEADER]: code } : {};
  };
  const show = (id: string) => `/api/shows/${seg(id)}`;
  const demo = (id: string) => `/api/demo/${seg(id)}`;
  return {
    createShow: (b) => run("POST", "/api/shows", b, undefined, judge()),
    sign: (id, b) => run("POST", `${show(id)}/sign`, b),
    getShow: (id) => run("GET", show(id)),
    createOrder: (id, b) => run("POST", `${show(id)}/orders`, b),
    authorize: (id, orderId) => run("POST", `${show(id)}/orders/${seg(orderId)}/authorize`),
    manage: (id, key) => run("GET", `${show(id)}/manage`, undefined, key),
    approve: (id, key, proposalId, b) => run("POST", `${show(id)}/proposals/${seg(proposalId)}/approve`, b, key),
    decline: (id, key, proposalId) => run("POST", `${show(id)}/proposals/${seg(proposalId)}/decline`, undefined, key),
    callOff: (id, key) => run("POST", `${show(id)}/call-off`, undefined, key),
    createDemo: () => run("POST", "/api/demo", undefined, undefined, judge()),
    demoFans: (id, key, b) => run("POST", `${demo(id)}/fans`, b, key),
    demoFastForward: (id, key, which) => run("POST", `${demo(id)}/fast-forward`, { show: which }, key),
    demoPace: (id, key) => run("POST", `${demo(id)}/pace`, undefined, key),
    demoReset: (id, key) => run("POST", `${demo(id)}/reset`, undefined, key, judge()),
  };
}

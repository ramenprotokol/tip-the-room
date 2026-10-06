import type { FetchLike } from "../../src/paypal/http";

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Throw instead of answering (simulates a network failure). */
  networkError?: boolean;
  /** Extra response headers, e.g. { "retry-after": "2" }. */
  headers?: Record<string, string>;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Answers calls in order. Token calls (`/v1/oauth2/token`) are answered automatically and not consumed. */
export function fakeFetch(responses: FakeResponse[], tokenExpiresIn = 32400) {
  const queue = [...responses];
  const calls: RecordedCall[] = [];
  let tokenCalls = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : undefined });
    if (url.endsWith("/v1/oauth2/token")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: tokenExpiresIn, token_type: "Bearer" }), { status: 200 });
    }
    const next = queue.shift();
    if (!next) throw new Error(`fakeFetch: no response queued for ${init.method} ${url}`);
    if (next.networkError) throw new TypeError("fetch failed");
    if (next.status === 204) return new Response(null, { status: 204, headers: next.headers });
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status, headers: next.headers });
  };
  return { fetch, calls, apiCalls: () => calls.filter((c) => !c.url.endsWith("/v1/oauth2/token")), tokenCalls: () => tokenCalls };
}

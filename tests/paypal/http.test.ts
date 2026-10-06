import { describe, expect, it } from "vitest";
import { loadConfig, SANDBOX_BASE } from "../../src/paypal/config";
import { PayPalError } from "../../src/paypal/errors";
import { PayPalHttp } from "../../src/paypal/http";
import { fakeFetch } from "./fake-fetch";

const config = { clientId: "id", clientSecret: "secret", baseUrl: SANDBOX_BASE };
const noSleep = async () => {};

describe("loadConfig", () => {
  it("reads the three variables and defaults the base to sandbox", () => {
    expect(loadConfig({ PAYPAL_CLIENT_ID: " a ", PAYPAL_CLIENT_SECRET: "b" })).toEqual({ clientId: "a", clientSecret: "b", baseUrl: SANDBOX_BASE });
  });
  it("strips a trailing slash from the base", () => {
    expect(loadConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_API_BASE: `${SANDBOX_BASE}/` }).baseUrl).toBe(SANDBOX_BASE);
  });
  it("refuses missing keys without echoing any value", () => {
    expect(() => loadConfig({ PAYPAL_CLIENT_ID: "a-visible-id" })).toThrow(/PAYPAL_CLIENT_SECRET/);
    try {
      loadConfig({ PAYPAL_CLIENT_ID: "a-visible-id" });
    } catch (e) {
      expect(String(e)).not.toContain("a-visible-id");
    }
  });
  it("refuses the live API", () => {
    expect(() => loadConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_API_BASE: "https://api-m.paypal.com" })).toThrow(/sandbox-only/);
  });
  it("never puts the secret in an error message", () => {
    const bad = { PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "s3cr3t", PAYPAL_API_BASE: "https://evil.example" };
    expect(() => loadConfig(bad)).toThrow();
    try {
      loadConfig(bad);
    } catch (e) {
      expect(String(e)).not.toContain("s3cr3t");
    }
  });
});

describe("PayPalHttp", () => {
  it("gets a token once and reuses it until near expiry", async () => {
    let now = 0;
    const f = fakeFetch([{ status: 200, body: { a: 1 } }, { status: 200, body: { a: 2 } }, { status: 200, body: { a: 3 } }], 3600);
    const http = new PayPalHttp(config, { fetch: f.fetch, now: () => now, sleep: noSleep });
    await http.request({ method: "GET", path: "/x" });
    await http.request({ method: "GET", path: "/x" });
    expect(f.tokenCalls()).toBe(1);
    now = (3600 - 59) * 1000; // inside the 60 s safety margin
    await http.request({ method: "GET", path: "/x" });
    expect(f.tokenCalls()).toBe(2);
  });

  it("sends basic auth for the token and bearer auth for calls", async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    await http.request({ method: "GET", path: "/x" });
    expect(f.calls[0].headers.authorization).toBe(`Basic ${btoa("id:secret")}`);
    expect(f.calls[0].body).toBe("grant_type=client_credentials");
    expect(f.calls[1].headers.authorization).toBe("Bearer tok-1");
  });

  it("sends JSON, the request id and Prefer", async () => {
    const f = fakeFetch([{ status: 201, body: { id: "C1" } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    const out = await http.request<{ id: string }>({ method: "POST", path: "/v2/y", body: { a: 1 }, requestId: "capture:A1", prefer: "return=representation" });
    expect(out).toEqual({ id: "C1" });
    const call = f.apiCalls()[0];
    expect(call.url).toBe(`${SANDBOX_BASE}/v2/y`);
    expect(call.headers["paypal-request-id"]).toBe("capture:A1");
    expect(call.headers["prefer"]).toBe("return=representation");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toBe('{"a":1}');
  });

  it("returns undefined for 204", async () => {
    const f = fakeFetch([{ status: 204 }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    expect(await http.request({ method: "POST", path: "/v2/z/void", requestId: "void:A1" })).toBeUndefined();
  });

  it("retries 5xx, 429 and network errors with the SAME request id", async () => {
    const f = fakeFetch([{ status: 503, body: { name: "SERVICE_UNAVAILABLE" } }, { status: 429, body: { name: "RATE_LIMIT_REACHED" } }, { status: 0, networkError: true }, { status: 201, body: { ok: true } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep, maxAttempts: 4 });
    await http.request({ method: "POST", path: "/p", body: {}, requestId: "r-1" });
    expect(f.apiCalls().map((c) => c.headers["paypal-request-id"])).toEqual(["r-1", "r-1", "r-1", "r-1"]);
  });

  it("never retries a POST that has no request id", async () => {
    const f = fakeFetch([{ status: 500, body: { name: "INTERNAL_SERVER_ERROR" } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    await expect(http.request({ method: "POST", path: "/p", body: {} })).rejects.toBeInstanceOf(PayPalError);
    expect(f.apiCalls()).toHaveLength(1);
  });

  it("does not retry 4xx and maps the PayPal error body", async () => {
    const f = fakeFetch([
      { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "nope", debug_id: "dbg1", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED", description: "d" }] } },
    ]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    const err = (await http.request({ method: "POST", path: "/p", requestId: "r" }).catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(422);
    expect(err.paypalName).toBe("UNPROCESSABLE_ENTITY");
    expect(err.debugId).toBe("dbg1");
    expect(err.hasIssue("AUTHORIZATION_ALREADY_CAPTURED")).toBe(true);
    expect(err.retryable).toBe(false);
    expect(f.apiCalls()).toHaveLength(1);
  });

  it("refreshes the token once on 401, then succeeds", async () => {
    const f = fakeFetch([{ status: 401, body: { error: "invalid_token" } }, { status: 200, body: { ok: 1 } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    expect(await http.request({ method: "GET", path: "/x" })).toEqual({ ok: 1 });
    expect(f.tokenCalls()).toBe(2);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const f = fakeFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep, maxAttempts: 3 });
    const err = (await http.request({ method: "GET", path: "/x" }).catch((e) => e)) as PayPalError;
    expect(err.status).toBe(500);
    expect(f.apiCalls()).toHaveLength(3);
  });

  it("rejects a request id longer than PayPal's 108-character limit", async () => {
    const f = fakeFetch([]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    await expect(http.request({ method: "POST", path: "/p", requestId: "x".repeat(109) })).rejects.toThrow(/108/);
  });

  it("two 401s in a row refresh the token exactly once, then throw 401", async () => {
    const f = fakeFetch([{ status: 401, body: { error: "invalid_token" } }, { status: 401, body: { error: "invalid_token" } }]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    const err = (await http.request({ method: "GET", path: "/x" }).catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(401);
    expect(f.tokenCalls()).toBe(2);
    expect(f.apiCalls()).toHaveLength(2);
  });

  it("keeps the real error when the token endpoint refuses (no network-error rewrite)", async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    const fetch = async (url: string) => {
      if (url.endsWith("/v1/oauth2/token")) {
        tokenCalls += 1;
        return new Response(JSON.stringify({ error: "invalid_client", error_description: "Client Authentication failed" }), { status: 401 });
      }
      apiCalls += 1;
      return new Response("{}", { status: 200 });
    };
    const http = new PayPalHttp(config, { fetch, sleep: noSleep });
    const err = (await http.request({ method: "GET", path: "/x" }).catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(401);
    expect(err.paypalName).toBe("invalid_client");
    expect(err.retryable).toBe(false);
    expect(tokenCalls).toBe(1);
    expect(apiCalls).toBe(0);
  });

  it("lets local errors (circular body) through unchanged, with no API call", async () => {
    const f = fakeFetch([]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    const body: Record<string, unknown> = {};
    body.self = body;
    const err = await http.request({ method: "POST", path: "/p", body, requestId: "r" }).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(PayPalError);
    expect(f.apiCalls()).toHaveLength(0);
  });

  it.each([
    ["no access_token", { expires_in: 100 }],
    ["empty access_token", { access_token: "", expires_in: 100 }],
    ["non-string access_token", { access_token: 5, expires_in: 100 }],
    ["missing expires_in", { access_token: "t" }],
    ["zero expires_in", { access_token: "t", expires_in: 0 }],
    ["negative expires_in", { access_token: "t", expires_in: -5 }],
    ["non-finite expires_in", { access_token: "t", expires_in: "soon" }],
  ])("rejects a bad token response (%s) and caches nothing", async (_n, tokenBody) => {
    let tokenCalls = 0;
    const fetch = async (url: string) => {
      if (url.endsWith("/v1/oauth2/token")) {
        tokenCalls += 1;
        return new Response(JSON.stringify(tokenBody), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    const http = new PayPalHttp(config, { fetch, sleep: noSleep });
    for (let i = 0; i < 2; i++) {
      const err = (await http.token().catch((e) => e)) as PayPalError;
      expect(err).toBeInstanceOf(PayPalError);
      expect(err.status).toBe(502);
      expect(err.paypalName).toBe("BAD_TOKEN_RESPONSE");
    }
    expect(tokenCalls).toBe(2);
  });

  it.each(["x", "https://evil.example/x", "@evil.example/x", ""])("rejects path %j before any network call", async (path) => {
    const f = fakeFetch([]);
    const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
    await expect(http.request({ method: "GET", path })).rejects.toBeInstanceOf(RangeError);
    expect(f.calls).toHaveLength(0);
  });

  it("turns a non-JSON 2xx body into BAD_RESPONSE_BODY", async () => {
    const f = fakeFetch([]);
    const fetch = async (url: string, init: RequestInit) =>
      url.endsWith("/v1/oauth2/token") ? f.fetch(url, init) : new Response("<html>oops</html>", { status: 200 });
    const http = new PayPalHttp(config, { fetch, sleep: noSleep });
    const err = (await http.request({ method: "GET", path: "/x" }).catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(502);
    expect(err.paypalName).toBe("BAD_RESPONSE_BODY");
  });

  describe("token network failures", () => {
    /** Token fetch rejects `rejectTokens` times, then answers; API calls come from `api`. */
    const flaky = (rejectTokens: number, api: Response[]) => {
      let tokenCalls = 0;
      const apiHeaders: Record<string, string>[] = [];
      const fetch = async (url: string, init: RequestInit) => {
        if (url.endsWith("/v1/oauth2/token")) {
          tokenCalls += 1;
          if (tokenCalls <= rejectTokens) throw new TypeError("fetch failed");
          return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
        }
        apiHeaders.push(Object.fromEntries(new Headers(init.headers).entries()));
        return api.shift()!;
      };
      return { fetch, tokenCalls: () => tokenCalls, apiHeaders };
    };

    it("retries a token fetch that rejects once, with the same request id", async () => {
      const f = flaky(1, [new Response("{}", { status: 201 })]);
      const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
      await http.request({ method: "POST", path: "/p", body: {}, requestId: "r-1" });
      expect(f.tokenCalls()).toBe(2);
      expect(f.apiHeaders.map((h) => h["paypal-request-id"])).toEqual(["r-1"]);
    });

    it("throws PayPalError status 0 after maxAttempts when the token fetch always rejects", async () => {
      const f = flaky(99, []);
      const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep, maxAttempts: 3 });
      const err = (await http.request({ method: "GET", path: "/x" }).catch((e) => e)) as PayPalError;
      expect(err).toBeInstanceOf(PayPalError);
      expect(err.status).toBe(0);
      expect(err.paypalName).toBe("NETWORK_ERROR");
      expect(f.tokenCalls()).toBe(3);
      expect(f.apiHeaders).toHaveLength(0);
    });

    it("does not retry a POST without a request id", async () => {
      const f = flaky(1, [new Response("{}", { status: 201 })]);
      const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
      const err = (await http.request({ method: "POST", path: "/p", body: {} }).catch((e) => e)) as PayPalError;
      expect(err).toBeInstanceOf(PayPalError);
      expect(err.status).toBe(0);
      expect(f.tokenCalls()).toBe(1);
    });

    it("retries when the 401 token refresh hits a network error", async () => {
      let tokenCalls = 0;
      let apiCalls = 0;
      const fetch = async (url: string) => {
        if (url.endsWith("/v1/oauth2/token")) {
          tokenCalls += 1;
          if (tokenCalls === 2) throw new TypeError("fetch failed");
          return new Response(JSON.stringify({ access_token: `t${tokenCalls}`, expires_in: 3600 }), { status: 200 });
        }
        apiCalls += 1;
        return apiCalls === 1 ? new Response("{}", { status: 401 }) : new Response('{"ok":1}', { status: 200 });
      };
      const http = new PayPalHttp(config, { fetch, sleep: noSleep });
      expect(await http.request({ method: "GET", path: "/x" })).toEqual({ ok: 1 });
    });

    it("lets local errors (a circular body) propagate unchanged", async () => {
      const f = flaky(0, []);
      const http = new PayPalHttp(config, { fetch: f.fetch, sleep: noSleep });
      const body: Record<string, unknown> = {};
      body.self = body;
      const err = await http.request({ method: "POST", path: "/p", body, requestId: "r" }).catch((e) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect(err).not.toBeInstanceOf(PayPalError);
    });
  });
});

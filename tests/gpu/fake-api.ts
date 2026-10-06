// Parity and functional GPU tests never touch a backend: Playwright answers every /api/ request from a script.
import type { BrowserContext, Page, Route } from "@playwright/test";

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
}
export interface FakeReply {
  status?: number;
  body: unknown;
}
export type FakeApi = (req: FakeRequest) => FakeReply | undefined;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-manage-key", "access-control-allow-methods": "GET, POST, OPTIONS", "cache-control": "no-store" };

export const apiError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): FakeReply => ({ status, body: { error: { code, message, ...extra } } });

/** Routes every request whose path starts with /api/ to `api`. Unknown requests get a 404 error body. Returns the requests seen. */
export async function installFakeApi(target: Page | BrowserContext, api: FakeApi): Promise<FakeRequest[]> {
  const seen: FakeRequest[] = [];
  await target.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route: Route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      let body: unknown;
      try {
        const raw = req.postData();
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const r: FakeRequest = { method: req.method(), path: new URL(req.url()).pathname, body, key: req.headers()["x-manage-key"] ?? null };
      seen.push(r);
      const reply = api(r) ?? apiError(404, "not_found", "There's nothing here.");
      await route.fulfill({ status: reply.status ?? 200, headers: { ...CORS, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(reply.body) });
    },
  );
  return seen;
}

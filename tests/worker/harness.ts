import { dispatch, type CampaignOp, type CampaignReply } from "../../src/agent/dispatch";
import { receiversFrom } from "../../src/agent/demo";
import { Quota } from "../../src/agent/quota";
import type { CampaignService } from "../../src/agent/service";
import type { Store } from "../../src/agent/store";
import { resetReadLimits, route, type EdgeCache, type RouterDeps } from "../../src/worker/router";
import { FakePayPal } from "../agent/fake-paypal";
import { LAUNCH, seqRandom, TestClock } from "../agent/fixtures";
import { makeService } from "../agent/harness";
import { memoryDb } from "../agent/sqlite";

export interface WorkerHarnessOptions {
  webhookId?: string | null;
  judgeCode?: string | null;
  cache?: EdgeCache;
  verify?: (headers: Headers, rawBody: string, webhookId: string) => Promise<boolean>;
}

/** The router with in-process "Durable Objects": one CampaignService per show id, JSON round-tripped like the real boundary. */
export function workerHarness(opts: WorkerHarnessOptions = {}) {
  resetReadLimits();
  const clock = new TestClock(LAUNCH);
  const paypal = new FakePayPal(clock);
  const shows = new Map<string, { svc: CampaignService; store: Store }>();
  const quota = new Quota(memoryDb());
  quota.migrate();
  const deps: RouterDeps = {
    campaigns: {
      async call(showId: string, op: CampaignOp): Promise<CampaignReply> {
        let s = shows.get(showId);
        if (!s) {
          const h = makeService({ clock, paypal });
          s = { svc: h.svc, store: h.store };
          shows.set(showId, s);
        }
        return JSON.parse(JSON.stringify(await dispatch(s.svc, JSON.parse(JSON.stringify(op)) as CampaignOp))) as CampaignReply;
      },
    },
    quota: { hit: async (key, limit, windowMs) => quota.hit(key, limit, windowMs, clock.now()) },
    ai: { ai: null, budget: { tryReserve: async () => true } },
    random: seqRandom(),
    clock,
    config: { allowedOrigins: ["http://localhost:5173"], webhookId: opts.webhookId ?? null, rateSalt: "test-salt", receivers: receiversFrom({}), judgeCode: opts.judgeCode ?? null, setup: { rateSalt: true, receivers: false, paypalClientId: "test-client-id" } },
    cache: opts.cache,
    verifyWebhook: opts.verify ?? (async () => false),
  };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    route(
      new Request(`http://api.test${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
      deps,
    );
  return { deps, clock, paypal, shows, call };
}

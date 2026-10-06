import { receiversFrom } from "../agent/demo";
import type { CampaignOp, CampaignReply } from "../agent/dispatch";
import { cryptoRandom, systemClock } from "../agent/ids";
import { loadConfig } from "../paypal/config";
import { PayPalHttp } from "../paypal/http";
import { verifyWebhook } from "../paypal/webhooks";
import type { Env } from "./env";
import { budgetPort, quotaPort } from "./quota-client";
import { route, type CampaignsPort, type RouterDeps } from "./router";

export { CampaignAgent } from "./do/campaign-agent";
export { QuotaAgent } from "./do/quota-agent";

function campaigns(env: Env): CampaignsPort {
  return {
    async call(showId: string, op: CampaignOp): Promise<CampaignReply> {
      const stub = env.CAMPAIGN.get(env.CAMPAIGN.idFromName(showId));
      const res = await stub.fetch("https://campaign/op", { method: "POST", body: JSON.stringify(op) });
      return (await res.json()) as CampaignReply;
    },
  };
}

function routerDeps(env: Env): RouterDeps {
  const binding = env.AI;
  return {
    campaigns: campaigns(env),
    quota: quotaPort(env),
    ai: { ai: binding ? { run: (model, input) => binding.run(model, input) } : null, budget: budgetPort(env) },
    random: cryptoRandom,
    clock: systemClock,
    config: {
      allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || null,
      rateSalt: env.RATE_SALT ?? "tip-the-room",
      receivers: receiversFrom(env),
      judgeCode: env.JUDGE_CODE?.trim() || null,
      setup: {
        rateSalt: Boolean(env.RATE_SALT?.trim()),
        receivers: Boolean(env.PAYPAL_RECEIVER_ROOM?.trim() && env.PAYPAL_RECEIVER_OPENER?.trim() && env.PAYPAL_RECEIVER_ARTIST?.trim()),
        paypalClientId: env.PAYPAL_CLIENT_ID?.trim() || null,
      },
    },
    verifyWebhook: (headers, rawBody, webhookId) => verifyWebhook(new PayPalHttp(loadConfig(env)), headers, rawBody, webhookId),
  };
}

export default {
  fetch: (request: Request, env: Env) => route(request, routerDeps(env)),
} satisfies ExportedHandler<Env>;

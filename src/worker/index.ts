import type { Env } from "./env";

export { CampaignAgent } from "./do/campaign-agent";
export { QuotaAgent } from "./do/quota-agent";

export default {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/api/health") return Response.json({ ok: true });
    return Response.json({ error: { code: "not_found", message: "There's nothing here." } }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

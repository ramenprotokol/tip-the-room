import { Quota, quotaDispatch, type QuotaOp } from "../../agent/quota";
import { cfDb } from "./sql-adapter";

/** Singleton ("global"): the daily AI neuron budget and the per-visitor rate limits. */
export class QuotaAgent {
  private quota: Quota | null = null;

  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (!this.quota) {
      this.quota = new Quota(cfDb(this.ctx.storage));
      this.quota.migrate();
    }
    const op = (await request.json()) as QuotaOp;
    return Response.json(quotaDispatch(this.quota, op, Date.now()));
  }
}

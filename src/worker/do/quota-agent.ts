import { Quota, quotaDispatch, type QuotaOp } from "../../agent/quota";
import { cfDb, type MeteredDb } from "./sql-adapter";

/** Singleton ("global"): the daily AI neuron budget and the per-visitor rate limits. */
export class QuotaAgent {
  private quota: Quota | null = null;
  private db: MeteredDb | null = null;

  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (!this.quota) {
      this.db = cfDb(this.ctx.storage);
      this.quota = new Quota(this.db);
      this.quota.migrate();
    }
    let op: QuotaOp;
    try {
      op = (await request.json()) as QuotaOp;
    } catch {
      // Fails closed: callers treat any non-2xx answer as "no".
      return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    const before = this.db?.rowsWritten() ?? 0;
    const reply = quotaDispatch(this.quota, op, Date.now());
    const name = typeof op?.op === "string" && /^[a-z_]{1,32}$/.test(op.op) ? op.op : "other";
    console.log(`do_rows do=quota kind=fetch op=${name} rows=${(this.db?.rowsWritten() ?? 0) - before}`);
    return Response.json(reply);
  }
}

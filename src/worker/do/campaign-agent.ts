import type { AiPort } from "../../agent/ai";
import { dispatch, type CampaignOp, type CampaignReply } from "../../agent/dispatch";
import { cryptoRandom, systemClock } from "../../agent/ids";
import { meteredPayPal, SIM_CARD, type CallMeter } from "../../agent/paypal-port";
import { CampaignService } from "../../agent/service";
import { Store } from "../../agent/store";
import { loadConfig } from "../../paypal/config";
import type { Env } from "../env";
import { budgetPort } from "../quota-client";
import { cfDb } from "./sql-adapter";

const BAD_JSON: CampaignReply = { ok: false, status: 400, error: { code: "bad_request", message: "That request isn't valid JSON." } };
const BROKEN: CampaignReply = { ok: false, status: 500, error: { code: "internal", message: "Something went wrong on our side." } };

/** One campaign = one Durable Object with SQLite storage. A thin adapter: the logic is in CampaignService. */
export class CampaignAgent {
  private service: CampaignService | null = null;
  private meter: CallMeter | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private svc(): CampaignService {
    if (!this.service) {
      const config = loadConfig(this.env);
      const binding = this.env.AI;
      const ai: AiPort | null = binding ? { run: (model, input) => binding.run(model, input) } : null;
      // The port's fetches are counted on its meter, so the per-turn budget sees every real PayPal request.
      const { port, meter } = meteredPayPal(config);
      this.meter = meter;
      this.service = new CampaignService({
        store: new Store(cfDb(this.ctx.storage)),
        paypal: port,
        clock: systemClock,
        ai: { ai, budget: budgetPort(this.env) },
        random: cryptoRandom,
        paypalClientId: config.clientId,
        card: SIM_CARD,
      });
    }
    return this.service;
  }

  async fetch(request: Request): Promise<Response> {
    let op: CampaignOp;
    try {
      op = (await request.json()) as CampaignOp;
    } catch {
      return Response.json(BAD_JSON);
    }
    let service: CampaignService;
    try {
      service = this.svc();
    } catch {
      // Missing sandbox keys: the message names a variable at most, never a value (see loadConfig).
      return Response.json(BROKEN);
    }
    // Each request is its own invocation with its own subrequest count; ops that drain jobs reset it again themselves.
    this.meter?.reset();
    return Response.json(await this.run(service, op));
  }

  private async run(service: CampaignService, op: CampaignOp): Promise<CampaignReply> {
    const reply = await dispatch(service, op);
    await this.reschedule(service);
    return reply;
  }

  async alarm(): Promise<void> {
    const service = this.svc();
    if (!service.exists()) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const { expired } = await service.tick();
    if (expired) {
      // A demo copy is 24 h old and has no money step left: delete everything it stored.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.service = null;
      return;
    }
    await this.reschedule(service);
  }

  private async reschedule(service: CampaignService): Promise<void> {
    if (!service.exists()) return;
    const at = service.nextWakeAt();
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }
}

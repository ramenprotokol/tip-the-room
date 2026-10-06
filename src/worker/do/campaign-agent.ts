import type { AiPort } from "../../agent/ai";
import { dispatch, type CampaignOp, type CampaignReply } from "../../agent/dispatch";
import { cryptoRandom, systemClock, type Clock } from "../../agent/ids";
import { meteredPayPal, SIM_CARD, type PayPalPort } from "../../agent/paypal-port";
import { CampaignService } from "../../agent/service";
import { Store } from "../../agent/store";
import { loadConfig, type PayPalConfig } from "../../paypal/config";
import type { Env } from "../env";
import { budgetPort } from "../quota-client";
import { cfDb } from "./sql-adapter";

const BAD_JSON: CampaignReply = { ok: false, status: 400, error: { code: "bad_request", message: "That request isn't valid JSON." } };
const BROKEN: CampaignReply = { ok: false, status: 500, error: { code: "internal", message: "Something went wrong on our side." } };

/** If a turn throws, the next turn is armed no later than this far ahead, so a repeated throw can't drop the alarm. */
export const ALARM_RETRY_MAX_MS = 60_000;

/** Test seams. The runtime constructs the class with (ctx, env) only, so the defaults are the real ones. */
export interface AgentOptions {
  /** Builds the PayPal port (and its own call meter) for ONE invocation. */
  paypal?: (config: PayPalConfig) => PayPalPort;
  clock?: Clock;
}

/** One campaign = one Durable Object with SQLite storage. A thin adapter: the logic is in CampaignService. */
export class CampaignAgent {
  private store: Store | null = null;
  private readonly clock: Clock;
  private readonly makePort: (config: PayPalConfig) => PayPalPort;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    opts: AgentOptions = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.makePort = opts.paypal ?? ((config) => meteredPayPal(config).port);
  }

  /**
   * A service for ONE invocation (a fetch or an alarm). Its PayPal port carries its own subrequest meter, so
   * interleaved invocations (an alarm mid-drain plus a fan's request) never reset or share each other's count.
   * Only the store is shared; it holds no meter.
   */
  private invocation(): CampaignService {
    const config = loadConfig(this.env);
    const binding = this.env.AI;
    const ai: AiPort | null = binding ? { run: (model, input) => binding.run(model, input) } : null;
    this.store ??= new Store(cfDb(this.ctx.storage));
    return new CampaignService({
      store: this.store,
      paypal: this.makePort(config),
      clock: this.clock,
      ai: { ai, budget: budgetPort(this.env) },
      random: cryptoRandom,
      paypalClientId: config.clientId,
      card: SIM_CARD,
    });
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
      service = this.invocation();
    } catch {
      // Missing sandbox keys: the message names a variable at most, never a value (see loadConfig).
      return Response.json(BROKEN);
    }
    const reply = await dispatch(service, op);
    await this.reschedule(service);
    return Response.json(reply);
  }

  async alarm(): Promise<void> {
    let service: CampaignService;
    try {
      service = this.invocation();
    } catch {
      // Can't run a turn (keys missing): look again soon rather than dropping the alarm.
      await this.ctx.storage.setAlarm(this.clock.now() + ALARM_RETRY_MAX_MS);
      return;
    }
    if (!service.exists()) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    let threw = true;
    let expired = false;
    try {
      ({ expired } = await service.tick());
      threw = false;
    } finally {
      if (!expired) await this.reschedule(service, threw);
    }
    if (expired) {
      // A demo copy is 24 h old and has no money step left: delete everything it stored.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.store = null;
    }
  }

  /** Arms the next wake-up. After a failed turn it is never later than now + ALARM_RETRY_MAX_MS, and always set. */
  private async reschedule(service: CampaignService, afterFailure = false): Promise<void> {
    if (!service.exists()) return;
    let at = service.nextWakeAt();
    if (afterFailure) {
      const cap = this.clock.now() + ALARM_RETRY_MAX_MS;
      at = at === null ? cap : Math.min(at, cap);
    }
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }
}

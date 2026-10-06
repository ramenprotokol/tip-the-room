import type { AiPort } from "../../agent/ai";
import { dispatch, type CampaignOp, type CampaignReply } from "../../agent/dispatch";
import { cryptoRandom, systemClock, type Clock } from "../../agent/ids";
import { meteredPayPal, SIM_CARD, type PayPalPort } from "../../agent/paypal-port";
import { CampaignService } from "../../agent/service";
import { Store } from "../../agent/store";
import { loadConfig, type PayPalConfig } from "../../paypal/config";
import { TokenHolder, type FetchLike } from "../../paypal/http";
import type { Env } from "../env";
import { budgetPort } from "../quota-client";
import { cfDb } from "./sql-adapter";

const BAD_JSON: CampaignReply = { ok: false, status: 400, error: { code: "bad_request", message: "That request isn't valid JSON." } };
const BROKEN: CampaignReply = { ok: false, status: 500, error: { code: "internal", message: "Something went wrong on our side." } };

/**
 * If the service can't be built (keys missing) or a turn throws, the next turn is armed no later than this far ahead, so a
 * failure can't drop the alarm. The wait doubles with each failure in a row (60 s, 2 min, ... up to 1 h) and resets on success.
 */
export const ALARM_BACKOFF_MIN_MS = 60_000;
export const ALARM_BACKOFF_MAX_MS = 60 * 60_000;
/** DO storage key holding the current failure wait (ms). */
const BACKOFF_KEY = "alarm_backoff_ms";

/** Test seams. The runtime constructs the class with (ctx, env) only, so the defaults are the real ones. */
export interface AgentOptions {
  /** Builds the PayPal port (and its own call meter) for ONE invocation. */
  paypal?: (config: PayPalConfig) => PayPalPort;
  clock?: Clock;
  /** The fetch under the default PayPal port (token and API calls). */
  fetch?: FetchLike;
}

/** One campaign = one Durable Object with SQLite storage. A thin adapter: the logic is in CampaignService. */
export class CampaignAgent {
  private store: Store | null = null;
  private readonly clock: Clock;
  private readonly makePort: (config: PayPalConfig) => PayPalPort;
  /** The OAuth token lives as long as this object, shared by every invocation. Each invocation still meters its own fetches. */
  private readonly tokens = new TokenHolder();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    opts: AgentOptions = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.makePort = opts.paypal ?? ((config) => meteredPayPal(config, { tokenHolder: this.tokens, fetch: opts.fetch }).port);
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
      // Can't run a turn (keys missing): look again later, waiting longer each time, rather than dropping the alarm.
      await this.ctx.storage.setAlarm(this.clock.now() + (await this.bumpBackoff()));
      return;
    }
    if (!service.exists()) {
      await this.ctx.storage.deleteAlarm();
      await this.clearBackoff();
      return;
    }
    let threw = true;
    let expired = false;
    try {
      ({ expired } = await service.tick());
      threw = false;
    } finally {
      if (!expired) await this.reschedule(service, threw ? this.clock.now() + (await this.bumpBackoff()) : undefined);
      if (!threw && !expired) await this.clearBackoff();
    }
    if (expired) {
      // A demo copy is 24 h old and has no money step left: delete everything it stored.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.store = null;
    }
  }

  private async clearBackoff(): Promise<void> {
    if ((await this.ctx.storage.get(BACKOFF_KEY)) !== undefined) await this.ctx.storage.delete(BACKOFF_KEY);
  }

  /** The wait after one more failure in a row: 60 s, doubling, never over 1 h. Stored so it survives eviction. */
  private async bumpBackoff(): Promise<number> {
    const last = (await this.ctx.storage.get(BACKOFF_KEY)) as number | undefined;
    const next = typeof last === "number" && last >= ALARM_BACKOFF_MIN_MS ? Math.min(last * 2, ALARM_BACKOFF_MAX_MS) : ALARM_BACKOFF_MIN_MS;
    await this.ctx.storage.put(BACKOFF_KEY, next);
    return next;
  }

  /** Arms the next wake-up. After a failed turn `cap` bounds it, so the alarm is always set. */
  private async reschedule(service: CampaignService, cap?: number): Promise<void> {
    if (!service.exists()) return;
    let at = service.nextWakeAt();
    if (cap !== undefined) at = at === null ? cap : Math.min(at, cap);
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }
}

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
import { cfDb, type MeteredDb } from "./sql-adapter";

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
  private db: MeteredDb | null = null;
  private readonly clock: Clock;
  private readonly makePort: (config: PayPalConfig) => PayPalPort;
  /** The OAuth token lives as long as this object, shared by every invocation. Each invocation still meters its own fetches. */
  private readonly tokens = new TokenHolder();
  /**
   * The alarm time this object last set (null = deleted), or undefined when unknown (fresh instance, or an alarm just fired).
   * reschedule() runs on every fetch, including polls, and skips the storage write when the wake time hasn't changed.
   */
  private alarmAt: number | null | undefined;

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
    this.db ??= cfDb(this.ctx.storage);
    this.store ??= new Store(this.db);
    return new CampaignService({
      store: this.store,
      paypal: this.makePort(config),
      clock: this.clock,
      ai: { ai, budget: budgetPort(this.env, () => this.isJudgeShow()) },
      random: cryptoRandom,
      paypalClientId: config.clientId,
      card: SIM_CARD,
    });
  }

  /** The show was made through a judge link (read at each reserve; never throws, so a storage hiccup just means the public budget). */
  private isJudgeShow(): boolean {
    try {
      return this.store?.getMeta("judge") === "1";
    } catch {
      return false;
    }
  }

  /** One line per invocation for the free-tier budget (scripts/tail-report.ts sums them). Lower bound: storage.put isn't counted (setAlarm is skipped when unchanged). */
  private logRows(kind: "fetch" | "alarm", op: string, before: number): void {
    const name = /^[a-z_]{1,32}$/.test(op) ? op : "other";
    console.log(`do_rows do=campaign kind=${kind} op=${name} rows=${(this.db?.rowsWritten() ?? 0) - before}`);
  }

  async fetch(request: Request): Promise<Response> {
    let op: CampaignOp;
    try {
      op = (await request.json()) as CampaignOp;
    } catch {
      this.logRows("fetch", "other", this.db?.rowsWritten() ?? 0);
      return Response.json(BAD_JSON);
    }
    let service: CampaignService;
    try {
      service = this.invocation();
    } catch {
      // Missing sandbox keys: the message names a variable at most, never a value (see loadConfig).
      this.logRows("fetch", typeof op?.op === "string" ? op.op : "other", this.db?.rowsWritten() ?? 0);
      return Response.json(BROKEN);
    }
    const before = this.db?.rowsWritten() ?? 0;
    const reply = await dispatch(service, op);
    await this.reschedule(service);
    this.logRows("fetch", typeof op?.op === "string" ? op.op : "other", before);
    return Response.json(reply);
  }

  async alarm(): Promise<void> {
    this.alarmAt = undefined; // the alarm that woke us is spent; what is armed now is unknown until we set it
    let service: CampaignService;
    try {
      service = this.invocation();
    } catch {
      // Can't run a turn (keys missing): look again later, waiting longer each time, rather than dropping the alarm.
      await this.ctx.storage.setAlarm(this.clock.now() + (await this.bumpBackoff()));
      this.logRows("alarm", "tick", this.db?.rowsWritten() ?? 0);
      return;
    }
    const before = this.db?.rowsWritten() ?? 0;
    if (!service.exists()) {
      await this.ctx.storage.deleteAlarm();
      await this.clearBackoff();
      this.logRows("alarm", "tick", this.db?.rowsWritten() ?? 0);
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
    this.logRows("alarm", "tick", before);
    if (expired) {
      // A demo copy is 24 h old and has no money step left: delete everything it stored.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.alarmAt = undefined;
      this.store = null;
      this.db = null;
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
    if (at === this.alarmAt) return;
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
    this.alarmAt = at;
  }
}

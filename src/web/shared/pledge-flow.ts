// The fan's pledge, separate from the DOM and the PayPal SDK so its failure paths are unit-tested.
import type { AuthorizeResponse, CreateOrderResponse } from "../../worker/api-types";
import { ApiFailure } from "./api";

export interface PledgeApi {
  createOrder(initials: string): Promise<CreateOrderResponse>;
  authorize(orderId: string): Promise<AuthorizeResponse>;
}

export type PledgeEvent =
  | { kind: "busy" }
  | { kind: "held"; res: AuthorizeResponse; initials: string; resumed?: boolean }
  | { kind: "cancelled"; message: string }
  | { kind: "failed"; message: string }
  /** The answer for an approved order never arrived. The order is kept; only "Check again" (resume) or a reload may settle it. */
  | { kind: "unconfirmed"; message: string };

/** An order PayPal approved whose answer from our server hasn't arrived yet. */
export interface ApprovedOrder {
  orderId: string;
  initials: string;
}

/** Where that order is kept until the server confirms it, so a reload asks about it instead of starting a new hold. */
export interface OrderMemory {
  get(): ApprovedOrder | null;
  set(o: ApprovedOrder): void;
  clear(): void;
}

export const noMemory: OrderMemory = { get: () => null, set: () => undefined, clear: () => undefined };

/** This tab only (sessionStorage), per show. Storage that is switched off just means no resume after a reload. */
export function sessionMemory(showId: string): OrderMemory {
  const key = `ttr:approved:${showId}`;
  const store = (): Storage | null => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  };
  return {
    get() {
      try {
        const v = JSON.parse(store()?.getItem(key) ?? "null") as Partial<ApprovedOrder> | null;
        if (!v || typeof v.orderId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(v.orderId)) return null;
        if (typeof v.initials !== "string" || !/^[A-Z]{1,3}$/.test(v.initials)) return null;
        return { orderId: v.orderId, initials: v.initials };
      } catch {
        return null;
      }
    },
    set(o) {
      try {
        store()?.setItem(key, JSON.stringify(o));
      } catch {
        // Storage off: the in-page retries still run.
      }
    },
    clear() {
      try {
        store()?.removeItem(key);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

export interface PledgeFlowOptions {
  /** Waits before asking again when the answer to "authorize" was lost on the way (network error or timeout). */
  retryDelaysMs?: number[];
  memory?: OrderMemory;
  /** If PayPal never calls back (for example the popup was blocked), the button unlocks after this long. */
  stallMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const CANCELLED = "No hold was placed. You can try again whenever you like.";
export const STALLED = "PayPal didn't open or didn’t answer. Nothing was charged. Please try again, and allow pop-ups for this site.";
export const UNCONFIRMED = "We didn't hear back. Your pledge may have gone through. Checking again…";
export const REFUSED_RESUME = "Your last try didn't go through. Nothing was charged.";
const PAYPAL_TROUBLE = "PayPal didn't answer as expected. Nothing was charged. Please try again.";
const UNKNOWN = "PayPal couldn't finish. Nothing was charged. Please try again.";

/** 1 to 3 letters for the bulb; "YOU" when the fan leaves it blank. The server checks it again. */
export function cleanInitials(v: string): string {
  return (v || "").replace(/[^a-z]/gi, "").slice(0, 3).toUpperCase() || "YOU";
}

export function failureMessage(e: unknown): string {
  if (e instanceof ApiFailure) return e.code === "paypal_error" ? PAYPAL_TROUBLE : e.message;
  return UNKNOWN;
}

/** Not a definite answer: no reply (status 0), a server or PayPal error (5xx), or something we can't read. PayPal may have placed the hold. */
const uncertain = (e: unknown) => !(e instanceof ApiFailure) || e.status === 0 || e.status >= 500;

export class PledgeFlow {
  busy = false;
  done = false;
  /** The initials sent with the order in flight; the confirmation uses these, not whatever the box says later. */
  private sent = "YOU";
  /** The order this flow is working on. A late approval for any other order is ignored. */
  private current: string | null = null;
  private readonly delays: number[];
  private readonly memory: OrderMemory;
  private readonly stallMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private stall: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: PledgeApi,
    private readonly emit: (e: PledgeEvent) => void,
    private readonly initials: () => string,
    opts: PledgeFlowOptions = {},
  ) {
    this.delays = opts.retryDelaysMs ?? [1000, 3000];
    this.memory = opts.memory ?? noMemory;
    this.stallMs = opts.stallMs ?? 10 * 60_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The button checks this before opening PayPal: false while an order is in flight, after the fan is on hold, or while an approved order is still unconfirmed. */
  canStart(): boolean {
    return !this.busy && !this.done && this.memory.get() === null;
  }

  /** The PayPal button calls this for every attempt, so a failed or cancelled order is never reused. */
  async createOrder(): Promise<string> {
    if (this.done) throw new Error("This fan is already on hold.");
    if (this.busy) throw new Error("A pledge is already in progress.");
    if (this.memory.get()) throw new Error("An earlier pledge is still being checked.");
    this.busy = true;
    this.sent = this.initials();
    this.emit({ kind: "busy" });
    try {
      const { orderId } = await this.api.createOrder(this.sent);
      this.current = orderId;
      this.armStall();
      return orderId;
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }

  /** PayPal approved this order. A lost answer is asked again on the SAME order; it is never replaced by a new one. */
  async approve(orderId: string): Promise<void> {
    if (this.done || orderId !== this.current) return;
    this.disarmStall();
    this.memory.set({ orderId, initials: this.sent });
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.finish(await this.api.authorize(orderId), false);
        return;
      } catch (e) {
        if (uncertain(e) && attempt < this.delays.length) {
          await this.sleep(this.delays[attempt] ?? 0);
          continue;
        }
        if (uncertain(e)) this.unconfirmed();
        else {
          this.memory.clear();
          this.fail(e);
        }
        return;
      }
    }
  }

  /** On page load: an approved order whose answer never arrived. The server answers "held" if it recorded the hold. */
  async resume(): Promise<void> {
    const o = this.memory.get();
    if (!o || this.done || this.busy) return;
    this.busy = true;
    this.current = o.orderId;
    this.emit({ kind: "busy" });
    try {
      const res = await this.api.authorize(o.orderId);
      this.sent = o.initials;
      this.finish(res, true);
    } catch (e) {
      if (uncertain(e)) this.unconfirmed();
      else {
        this.memory.clear();
        this.busy = false;
        this.emit({ kind: "failed", message: REFUSED_RESUME });
      }
    }
  }

  cancel(): void {
    if (this.done) return;
    this.disarmStall();
    this.busy = false;
    this.emit({ kind: "cancelled", message: CANCELLED });
  }

  /** The SDK's error callback. Ignored when no order of ours is in flight (createOrder already reported its own failure). */
  error(e: unknown): void {
    if (this.done || !this.busy) return;
    this.fail(e);
  }

  /** Test hook path: the same create → authorize calls the button makes, without the popup. */
  async simulate(): Promise<void> {
    try {
      await this.approve(await this.createOrder());
    } catch {
      // Already reported through emit.
    }
  }

  private finish(res: AuthorizeResponse, resumed: boolean): void {
    this.memory.clear();
    this.busy = false;
    this.done = true;
    this.emit(resumed ? { kind: "held", res, initials: this.sent, resumed: true } : { kind: "held", res, initials: this.sent });
  }

  private unconfirmed(): void {
    this.disarmStall();
    this.busy = false;
    this.emit({ kind: "unconfirmed", message: UNCONFIRMED });
  }

  private armStall(): void {
    this.disarmStall();
    this.stall = setTimeout(() => {
      this.stall = null;
      if (this.busy && !this.done) {
        this.busy = false;
        this.emit({ kind: "failed", message: STALLED });
      }
    }, this.stallMs);
  }

  private disarmStall(): void {
    if (this.stall !== null) {
      clearTimeout(this.stall);
      this.stall = null;
    }
  }

  private fail(e: unknown): void {
    this.disarmStall();
    this.busy = false;
    this.emit({ kind: "failed", message: failureMessage(e) });
  }
}

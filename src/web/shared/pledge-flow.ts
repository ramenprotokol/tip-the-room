// The fan's pledge, separate from the DOM and the PayPal SDK so its failure paths are unit-tested.
import type { AuthorizeResponse, CreateOrderResponse } from "../../worker/api-types";
import { ApiFailure } from "./api";

export interface PledgeApi {
  createOrder(initials: string): Promise<CreateOrderResponse>;
  authorize(orderId: string): Promise<AuthorizeResponse>;
}

export type PledgeEvent = { kind: "busy" } | { kind: "held"; res: AuthorizeResponse; initials: string } | { kind: "cancelled"; message: string } | { kind: "failed"; message: string };

export const CANCELLED = "No hold was placed. You can try again whenever you like.";
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

export class PledgeFlow {
  busy = false;
  done = false;
  /** The initials sent with the order in flight; the confirmation uses these, not whatever the box says later. */
  private sent = "YOU";

  constructor(
    private readonly api: PledgeApi,
    private readonly emit: (e: PledgeEvent) => void,
    private readonly initials: () => string,
  ) {}

  /** The button checks this before opening PayPal: false while an order is in flight or after the fan is on hold. */
  canStart(): boolean {
    return !this.busy && !this.done;
  }

  /** The PayPal button calls this for every attempt, so a failed or cancelled order is never reused. */
  async createOrder(): Promise<string> {
    if (this.done) throw new Error("This fan is already on hold.");
    if (this.busy) throw new Error("A pledge is already in progress.");
    this.busy = true;
    this.sent = this.initials();
    this.emit({ kind: "busy" });
    try {
      return (await this.api.createOrder(this.sent)).orderId;
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }

  async approve(orderId: string): Promise<void> {
    if (this.done) return;
    try {
      const res = await this.api.authorize(orderId);
      this.busy = false;
      this.done = true;
      this.emit({ kind: "held", res, initials: this.sent });
    } catch (e) {
      this.fail(e);
    }
  }

  cancel(): void {
    if (this.done) return;
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

  private fail(e: unknown): void {
    this.busy = false;
    this.emit({ kind: "failed", message: failureMessage(e) });
  }
}

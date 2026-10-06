// PayPal JS SDK v6, loaded from the sandbox host only (spec §6.1: Orders v2 intent AUTHORIZE, our server creates and
// authorizes the order). The real popup is checked by hand in Plan 6; GPU tests load a stub from this same URL.
export const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

interface Session {
  start(options: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, order: Promise<{ orderId: string }>): Promise<void>;
}
interface SdkInstance {
  findEligibleMethods(options?: { currencyCode?: string }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: { onApprove(data: { orderId: string }): Promise<void> | void; onCancel(data?: unknown): void; onError(error: unknown): void }): Session | Promise<Session>;
}
interface PayPalV6 {
  createInstance(options: { clientId: string; components: string[] }): Promise<SdkInstance>;
}
declare global {
  interface Window {
    paypal?: PayPalV6;
  }
}

let loading: Promise<PayPalV6> | null = null;

export function loadSdk(timeoutMs = 15_000): Promise<PayPalV6> {
  if (window.paypal) return Promise.resolve(window.paypal);
  loading ??= new Promise<PayPalV6>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    const timer = setTimeout(() => reject(new Error("The PayPal SDK took too long to load.")), timeoutMs);
    s.onload = () => {
      clearTimeout(timer);
      if (window.paypal) resolve(window.paypal);
      else reject(new Error("The PayPal SDK loaded without window.paypal."));
    };
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error("The PayPal SDK failed to load."));
    };
    document.head.append(s);
  }).catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

export interface ButtonHandlers {
  /** False while an order is in flight (or the fan is already on hold): a click then does nothing. */
  canStart(): boolean;
  /** Our API creates the order; returns its id. Called for every click. */
  createOrder(): Promise<string>;
  onApprove(orderId: string): Promise<void>;
  onCancel(): void;
  onError(error: unknown): void;
}

/** Replaces the slot's placeholder text with PayPal's button. Rejects when the SDK can't load or PayPal isn't offered. */
export async function mountPayPalButton(slot: HTMLElement, clientId: string, h: ButtonHandlers): Promise<void> {
  const paypal = await loadSdk();
  const sdk = await paypal.createInstance({ clientId, components: ["paypal-payments"] });
  const eligible = await sdk.findEligibleMethods({ currencyCode: "USD" });
  if (!eligible.isEligible("paypal")) throw new Error("PayPal isn't offered here.");
  const session = await sdk.createPayPalOneTimePaymentSession({ onApprove: (d) => h.onApprove(d.orderId), onCancel: () => h.onCancel(), onError: (e) => h.onError(e) });
  const button = document.createElement("paypal-button");
  button.setAttribute("type", "pay");
  slot.textContent = "";
  slot.classList.add("is-rendered");
  slot.append(button);
  button.addEventListener("click", () => {
    if (!h.canStart()) return;
    session.start({ presentationMode: "auto" }, h.createOrder().then((orderId) => ({ orderId }))).catch((e: unknown) => h.onError(e));
  });
}

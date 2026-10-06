// Build-time settings (public values only) and the test-hook switch. Browser only.
const env = import.meta.env;
const query = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

/** API origin, e.g. "https://api.tiptheroom.example". Empty means the page's own origin. */
export const API_BASE: string = (env.VITE_API_BASE ?? "").trim().replace(/\/+$/, "");
/** PayPal sandbox client id (public). Never the secret. Empty: the PayPal button is not loaded. */
const PAYPAL_ID: string = (env.VITE_PAYPAL_CLIENT_ID ?? "").trim();
/** Origin printed in share links. Defaults to wherever the page is served from. */
export const PUBLIC_ORIGIN: string = (env.VITE_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "") || (typeof location === "undefined" ? "" : location.origin);
/** The sandbox buyer judges log in with (spec §4: printed on the page). Public sandbox values. */
export const SANDBOX_BUYER = { email: (env.VITE_SANDBOX_BUYER_EMAIL ?? "").trim(), password: (env.VITE_SANDBOX_BUYER_PASSWORD ?? "").trim() };
/** Test hooks (window.__marquee and the reference-only controls): dev server, or a test build opened with ?e2e. */
export const HOOKS: boolean = env.DEV || (env.VITE_E2E_HOOKS === "1" && query.has("e2e"));
/** Parity runs (?e2e=parity): no background polling, so the fake API's scripted answers stay in step. */
export const PARITY: boolean = HOOKS && query.get("e2e") === "parity";

/** The PayPal client id. Test pages may pass ?paypal=<id> (hooks only) to load a stubbed SDK. */
export function paypalClientId(): string {
  const override = HOOKS ? query.get("paypal") : null;
  return override && /^[A-Za-z0-9_-]{1,128}$/.test(override) ? override : PAYPAL_ID;
}

/** Production pages drop the reference pack's own controls ("Simulate PayPal approval", the reference nav, demo controls). */
export function removeRefOnly(): void {
  if (!HOOKS) document.querySelectorAll("[data-ref-only]").forEach((e) => e.remove());
}

/** Tests (and the local e2e run) wait for this instead of window.__marquee, which production builds don't have. */
export function markReady(): void {
  document.body.dataset.ready = "1";
}

export function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

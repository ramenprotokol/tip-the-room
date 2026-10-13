// Build-time settings (public values only) and the test-hook switch. Browser only.
const query = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

/** API origin, e.g. "https://api.tiptheroom.example". Empty means the page's own origin. */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? "").trim().replace(/\/+$/, "");
/** PayPal sandbox client id (public). Never the secret. Empty: the PayPal button is not loaded. */
const PAYPAL_ID: string = (import.meta.env.VITE_PAYPAL_CLIENT_ID ?? "").trim();
/** Origin printed in share links. Defaults to wherever the page is served from. */
export const PUBLIC_ORIGIN: string = (import.meta.env.VITE_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "") || (typeof location === "undefined" ? "" : location.origin);
/** The sandbox buyer judges log in with (spec §4: printed on the page). Public sandbox values. */
const BUYER_BUILT = { email: (import.meta.env.VITE_SANDBOX_BUYER_EMAIL ?? "").trim(), password: (import.meta.env.VITE_SANDBOX_BUYER_PASSWORD ?? "").trim() };
/** Test hooks (window.__marquee and the reference-only controls): dev server, or a test build opened with ?e2e. */
export const HOOKS: boolean = import.meta.env.DEV || (import.meta.env.VITE_E2E_HOOKS === "1" && query.has("e2e"));
/** Test pages may pass ?buyer=<email>,<password> (hooks only) to show a login without baking one into the build. */
const BUYER_TEST = HOOKS ? (query.get("buyer") ?? "").split(",") : [];
export const SANDBOX_BUYER = BUYER_TEST.length === 2 && BUYER_TEST[0] ? { email: BUYER_TEST[0].trim(), password: BUYER_TEST[1].trim() } : BUYER_BUILT;
/** Parity runs (?e2e=parity): no background polling, so the fake API's scripted answers stay in step. */
export const PARITY: boolean = HOOKS && query.get("e2e") === "parity";

/** No background polling: parity runs, and flow tests that open a page with ?e2e=quiet (so late polls can't land mid-assertion). */
export const QUIET: boolean = PARITY || (HOOKS && query.get("e2e") === "quiet");

/** The PayPal client id. Build setting first, else the id the API sends with the show (also public). Test pages may pass ?paypal=<id> (hooks only) to load a stubbed SDK. */
export function paypalClientId(fallback = ""): string {
  const override = HOOKS ? query.get("paypal") : null;
  return override && /^[A-Za-z0-9_-]{1,128}$/.test(override) ? override : PAYPAL_ID || fallback.trim();
}

/** Production pages drop the reference pack's own controls ("Simulate PayPal approval", the reference nav, demo controls). */
export function removeRefOnly(): void {
  if (!HOOKS) document.querySelectorAll("[data-ref-only]").forEach((e) => e.remove());
}

/** The page has its real data (or has given up and shown a notice): lift the loading veil (boot.css). */
export function markBooted(): void {
  document.body.dataset.booted = "1";
}

/** Tests (and the local e2e run) wait for this instead of window.__marquee, which production builds don't have. */
export function markReady(): void {
  markBooted();
  document.body.dataset.ready = "1";
}

export function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The judge code from a judge's link (?judge=...), kept for this tab, so judges draw from their own pool of demo copies. */
export function judgeCode(): string | null {
  const ok = (v: string | null) => (v && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
  const fromUrl = ok(query.get("judge"));
  try {
    if (fromUrl) window.sessionStorage.setItem("ttr:judge", fromUrl);
    return fromUrl ?? ok(window.sessionStorage.getItem("ttr:judge"));
  } catch {
    return fromUrl;
  }
}

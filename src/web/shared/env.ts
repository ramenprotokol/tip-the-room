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

/** The shape a judge code must have to be sent at all (the Worker checks the real value). */
export const JUDGE_CODE_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;
const JUDGE_KEY = "ttr:judge";

/**
 * The judge code the visitor typed into the For judges box. It lives in this browser only (not the address bar, so it never
 * reaches a history list, a server log or a shared link), and is sent in a header on the few calls that use it.
 */
export function judgeCode(): string | null {
  for (const area of [safeStorage(), sessionOnly()]) {
    try {
      const v = area?.getItem(JUDGE_KEY) ?? null;
      if (v && JUDGE_CODE_SHAPE.test(v)) return v;
    } catch {
      /* storage can throw (private mode): try the next one */
    }
  }
  return null;
}

function sessionOnly(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Remembers a code the Worker accepted (null forgets it). */
export function saveJudgeCode(code: string | null): void {
  for (const area of [safeStorage(), sessionOnly()]) {
    try {
      if (code) area?.setItem(JUDGE_KEY, code);
      else area?.removeItem(JUDGE_KEY);
    } catch {
      /* nothing to do: the code then lasts until this page closes */
    }
  }
}

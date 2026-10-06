// Before a Pages deploy: the production build settings (.env.production.local, read the way Vite reads them) are
// complete and agree with the live Worker. Prints origins and yes/no only, never the values of credentials.
import { loadEnv } from "vite";
import type { HealthResponse } from "../src/worker/api-types";
import { extraHostsFromEnv, liveOrigin } from "./lib/live";

const env = loadEnv("production", process.cwd(), "VITE_");
let bad = 0;
const check = (ok: boolean, what: string, detail = "") => {
  if (!ok) bad += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  ·  ${detail}` : ""}`);
};
const extra = extraHostsFromEnv();
// A real site build needs https; localhost is only accepted by liveOrigin for the checks, so require https explicitly.
const httpsOrigin = (v: string | undefined) => (typeof v === "string" && v.trim().startsWith("https://") ? liveOrigin(v.trim(), extra) : null);
const api = httpsOrigin(env.VITE_API_BASE);

check(api !== null, "VITE_API_BASE is an https origin", api ?? "missing or not an allowed https origin");
check(httpsOrigin(env.VITE_PUBLIC_ORIGIN) !== null, "VITE_PUBLIC_ORIGIN is an https origin", httpsOrigin(env.VITE_PUBLIC_ORIGIN) ?? "missing or not an allowed https origin");
check(Boolean(env.VITE_PAYPAL_CLIENT_ID?.trim()), "VITE_PAYPAL_CLIENT_ID is set");
check(Boolean(env.VITE_SANDBOX_BUYER_EMAIL?.trim() && env.VITE_SANDBOX_BUYER_PASSWORD?.trim()), "judge sandbox buyer is set");
check(!env.VITE_E2E_HOOKS, "VITE_E2E_HOOKS is empty for the real site");
if (api) {
  try {
    const h = (await (await fetch(`${api}/api/health`)).json()) as HealthResponse;
    check(h.ok === true, "the Worker answers /api/health");
    check(h.setup.paypalClientId === env.VITE_PAYPAL_CLIENT_ID?.trim(), "the site and the Worker use the same PayPal sandbox app");
    for (const [k, v] of Object.entries(h.setup)) if (typeof v === "boolean") check(v, `Worker setup: ${k}`);
  } catch (e) {
    check(false, "the Worker answers /api/health", e instanceof Error ? e.message : String(e));
  }
}
console.log(bad ? `\nShip check: ${bad} problem(s).` : "\nShip check: all green.");
process.exit(bad ? 1 : 0);

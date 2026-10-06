// Local end-to-end judge flow: the real Worker (wrangler dev --local --env check, PayPal sandbox from .dev.vars)
// and the built pages without test hooks. Run: npm run e2e:local
import { defineConfig } from "@playwright/test";
import { extraHostsFromEnv, liveOrigin } from "./scripts/lib/live";

// E2E_BASE_URL=https://<site> runs the same flow against the deployed site (npm run e2e:live); nothing is started or deployed.
const raw = process.env.E2E_BASE_URL?.trim() || null;
const live = raw === null ? null : liveOrigin(raw, extraHostsFromEnv());
if (raw !== null && live === null) throw new Error("E2E_BASE_URL must be an https origin on an allowed host (*.pages.dev, *.workers.dev or LIVE_ALLOWED_HOSTS)");

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 15 * 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: live ?? "http://127.0.0.1:5173", launchOptions: { args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] } },
  webServer: live ? undefined : [
    {
      command: "rm -rf .wrangler/e2e && npx wrangler dev --local --env check --ip 127.0.0.1 --port 8788 --persist-to .wrangler/e2e",
      url: "http://127.0.0.1:8788/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 5173 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5173/",
      reuseExistingServer: false,
      timeout: 180_000,
      env: { VITE_API_BASE: "http://127.0.0.1:8788", VITE_PAYPAL_CLIENT_ID: "", VITE_PUBLIC_ORIGIN: "", VITE_E2E_HOOKS: "", VITE_SANDBOX_BUYER_EMAIL: "", VITE_SANDBOX_BUYER_PASSWORD: "" },
    },
  ],
});

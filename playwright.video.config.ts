// Records the submission video. By default it starts the local stack (like e2e:local); with VIDEO_BASE_URL (or E2E_BASE_URL)
// set to an allowed https origin it films the deployed site instead. Nothing is started or deployed in that case.
// Run: npm run video:record   or   VIDEO_BASE_URL=https://<site> npm run video:record
import { defineConfig } from "@playwright/test";
import { extraHostsFromEnv, liveOrigin } from "./scripts/lib/live";

const raw = process.env.VIDEO_BASE_URL?.trim() || process.env.E2E_BASE_URL?.trim() || null;
const live = raw === null ? null : liveOrigin(raw, extraHostsFromEnv());
if (raw !== null && live === null) throw new Error("VIDEO_BASE_URL must be an https origin on an allowed host (*.pages.dev, *.workers.dev or LIVE_ALLOWED_HOSTS)");

export default defineConfig({
  testDir: "tests/video",
  timeout: 40 * 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/video-run",
  use: { baseURL: live ?? "http://127.0.0.1:5173", launchOptions: { args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] } },
  webServer: live ? undefined : [
    {
      command: "rm -rf .wrangler/video && npx wrangler dev --local --env check --ip 127.0.0.1 --port 8788 --persist-to .wrangler/video",
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

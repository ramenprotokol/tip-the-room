// Offline UI checks for the ledger grids: Vite dev server only, no API, no PayPal, no GPU. Run: npx playwright test -c playwright.ledger.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/ledger-ui",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5297", viewport: { width: 1280, height: 1100 } },
  webServer: {
    command: "npx vite --port 5297 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5297/",
    reuseExistingServer: false,
    timeout: 60_000,
    env: { VITE_API_BASE: "", VITE_PAYPAL_CLIENT_ID: "", VITE_PUBLIC_ORIGIN: "https://tiptheroom.example", VITE_SANDBOX_BUYER_EMAIL: "public-buyer@example.com", VITE_SANDBOX_BUYER_PASSWORD: "public-sandbox-pass" },
  },
});

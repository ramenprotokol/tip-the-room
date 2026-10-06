// NOTE: parity runs need internet (the reference pages load fonts, three and gsap from CDNs) and a local GPU
// (WebGL via Metal). Without them the harness fails loudly instead of passing.
import { defineConfig } from "@playwright/test";

/** Public build settings for test servers: same-origin API (Playwright fakes it), no PayPal button, fixed share-link origin. */
const TEST_ENV = { VITE_API_BASE: "", VITE_PAYPAL_CLIENT_ID: "", VITE_PUBLIC_ORIGIN: "https://tiptheroom.example", VITE_SANDBOX_BUYER_EMAIL: "", VITE_SANDBOX_BUYER_PASSWORD: "" };

// GPU parity tests: local only (hosted CI has no GPU). The reference is served as plain static files,
// the app by Vite, so each runs exactly the code it ships.
export default defineConfig({
  testDir: "tests/gpu",
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    launchOptions: { args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] },
  },
  webServer: [
    {
      command: "python3 -m http.server 5198 --bind 127.0.0.1 --directory reference",
      url: "http://127.0.0.1:5198/v2/demo.html",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "npx vite --port 5199 --strictPort",
      url: "http://127.0.0.1:5199/",
      reuseExistingServer: true,
      timeout: 60_000,
      env: TEST_ENV,
    },
    {
      command: "npx vite build && npx vite preview --port 5200 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5200/",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...TEST_ENV, VITE_E2E_HOOKS: "1" },
    },
    {
      command: "npx vite build --outDir dist-nohooks && npx vite preview --outDir dist-nohooks --port 5201 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5201/",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...TEST_ENV, VITE_API_BASE: "http://127.0.0.1:5201", VITE_E2E_HOOKS: "" },
    },
  ],
});

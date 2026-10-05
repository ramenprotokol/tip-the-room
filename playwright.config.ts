// NOTE: parity runs need internet (the reference pages load fonts, three and gsap from CDNs) and a local GPU
// (WebGL via Metal). Without them the harness fails loudly instead of passing.
import { defineConfig } from "@playwright/test";

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
    },
    {
      command: "npx vite build && npx vite preview --port 5200 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5200/",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});

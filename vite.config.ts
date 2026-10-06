import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  server: { hmr: false, host: "127.0.0.1" },
  optimizeDeps: { entries: ["index.html", "start.html", "pledge.html", "manage.html"] },
  build: {
    rolldownOptions: {
      input: {
        main: resolve(root, "index.html"),
        start: resolve(root, "start.html"),
        pledge: resolve(root, "pledge.html"),
        manage: resolve(root, "manage.html"),
      },
      // Guarantees module-evaluation order across chunks, so gsap-global (window.gsap) runs before ui.ts's
      // module-load GSAP config. Without it the shared ui chunk can evaluate first in the production build.
      output: { strictExecutionOrder: true },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/gpu/**", "node_modules/**"],
    testTimeout: 30_000,
    // tests/agent/sqlite.ts uses node:sqlite, which prints an ExperimentalWarning in every worker.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});

import { defineConfig } from "vitest/config";
import type { Connect, Plugin } from "vite";
import { resolve } from "node:path";
import { rewritePagePath } from "./src/web/build/routes";

const root = import.meta.dirname;

/** /s/:id, /s/:id/manage and /start work on the dev and preview servers exactly as on Pages. */
function pagesRoutes(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    if (req.url) req.url = rewritePagePath(req.url);
    next();
  };
  return {
    name: "pages-routes",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig({
  plugins: [pagesRoutes()],
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
    exclude: ["tests/gpu/**", "tests/e2e/**", "node_modules/**"],
    testTimeout: 30_000,
    // tests/agent/sqlite.ts uses node:sqlite, which prints an ExperimentalWarning in every worker.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});

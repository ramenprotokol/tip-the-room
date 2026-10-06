import { defineConfig } from "vitest/config";
import { loadEnv, type Connect, type Plugin } from "vite";
import { resolve } from "node:path";
import { assertProductionApiBase, headersFile, stripRefOnly } from "./src/web/build/pages";
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

/** dist/_headers with the CSP for this build's API origin. */
function pagesFiles(apiBase: string): Plugin {
  return {
    name: "pages-files",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(apiBase) });
    },
  };
}

/** Production pages never ship the reference's own controls (the JS removes them too, but only after it loads). */
function stripReferenceControls(): Plugin {
  return { name: "strip-ref-only", apply: "build", transformIndexHtml: { order: "pre", handler: (html) => stripRefOnly(html) } };
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, root, "VITE_");
  // Hooks builds (VITE_E2E_HOOKS=1, served by the test preview) may use the page's own origin; every other build is a real site.
  if (command === "build" && env.VITE_E2E_HOOKS !== "1") assertProductionApiBase(env.VITE_API_BASE ?? "");
  return {
  plugins: [pagesRoutes(), pagesFiles((env.VITE_API_BASE ?? "").trim()), ...(env.VITE_E2E_HOOKS === "1" ? [] : [stripReferenceControls()])],
  server: { hmr: false, host: "127.0.0.1" },
  optimizeDeps: { entries: ["index.html", "start.html", "pledge.html", "manage.html"] },
  build: {
    // No inline modulepreload polyfill: the CSP allows no inline scripts.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        main: resolve(root, "index.html"),
        start: resolve(root, "start.html"),
        pledge: resolve(root, "pledge.html"),
        manage: resolve(root, "manage.html"),
        notfound: resolve(root, "404.html"),
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
};
});

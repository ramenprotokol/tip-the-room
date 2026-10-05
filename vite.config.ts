import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  server: { hmr: false, host: "127.0.0.1" },
  optimizeDeps: { entries: ["index.html", "start.html", "pledge.html", "manage.html"] },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        start: resolve(root, "start.html"),
        pledge: resolve(root, "pledge.html"),
        manage: resolve(root, "manage.html"),
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/gpu/**", "node_modules/**"],
    testTimeout: 30_000,
  },
});

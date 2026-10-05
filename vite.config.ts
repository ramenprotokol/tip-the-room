import { defineConfig } from "vitest/config";

export default defineConfig({
  server: { hmr: false },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/gpu/**", "node_modules/**"],
    testTimeout: 30_000,
  },
});

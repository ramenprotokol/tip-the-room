import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "dist-nohooks/**", "dist-e2e/**", "node_modules/**", "playwright-report/**", "test-results/**", "reference/**", "spikes/**", ".wrangler/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);

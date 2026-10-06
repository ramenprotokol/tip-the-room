import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const jsFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : []));

describe("production build without hooks", () => {
  it("ships no test-hook code in any JS chunk", () => {
    const out = mkdtempSync(join(tmpdir(), "ttr-nohooks-"));
    try {
      execFileSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], {
        cwd: root,
        stdio: "pipe",
        env: { ...process.env, NODE_ENV: "production", VITE_API_BASE: "https://api.example.com", VITE_PAYPAL_CLIENT_ID: "", VITE_PUBLIC_ORIGIN: "", VITE_E2E_HOOKS: "" },
      });
      const files = jsFiles(out);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const code = readFileSync(f, "utf8");
        expect(code, f).not.toContain("__marquee");
        expect(code, f).not.toContain("Simulate PayPal approval");
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 180_000);
});

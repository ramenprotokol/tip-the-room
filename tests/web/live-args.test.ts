import { describe, expect, it } from "vitest";
import { liveOrigin, parseCheckArgs } from "../../scripts/lib/live";

describe("liveOrigin", () => {
  it("accepts https workers.dev and pages.dev origins", () => {
    expect(liveOrigin("https://api.example.workers.dev")).toBe("https://api.example.workers.dev");
    expect(liveOrigin("https://site.pages.dev/")).toBe("https://site.pages.dev");
  });
  it("accepts localhost over http", () => {
    expect(liveOrigin("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788");
    expect(liveOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  });
  it("refuses plain http, other hosts, paths, credentials and lookalikes", () => {
    for (const bad of ["http://api.example.workers.dev", "https://evil.com", "https://workers.dev", "https://api.example.workers.dev/x", "https://u:p@a.workers.dev", "https://a.workers.dev.evil.com", "https://a.workers.dev?x=1", "nonsense", "", undefined]) {
      expect(liveOrigin(bad)).toBeNull();
    }
  });
  it("allows owner-approved custom hosts only when listed", () => {
    expect(liveOrigin("https://tip.example.org")).toBeNull();
    expect(liveOrigin("https://tip.example.org", ["tip.example.org"])).toBe("https://tip.example.org");
  });
});

describe("parseCheckArgs", () => {
  it("defaults to local with no expectations", () => {
    expect(parseCheckArgs([])).toEqual({ base: null, expectAi: false, expectPaid: false });
  });
  it("reads the flags", () => {
    expect(parseCheckArgs(["--base", "https://a.workers.dev", "--expect-ai", "--expect-paid"])).toEqual({ base: "https://a.workers.dev", expectAi: true, expectPaid: true });
  });
  it("reports an error for a bad or missing base", () => {
    expect(parseCheckArgs(["--base", "http://a.workers.dev"]).error).toBeTruthy();
    expect(parseCheckArgs(["--base"]).error).toBeTruthy();
  });
});

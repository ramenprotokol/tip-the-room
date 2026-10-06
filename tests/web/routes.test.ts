import { describe, expect, it } from "vitest";
import { rewritePagePath } from "../../src/web/build/routes";

describe("page routes (same as public/_redirects)", () => {
  it("maps share, manage and start paths to their pages and keeps the query", () => {
    expect(rewritePagePath("/s/acoustic-set-nov20")).toBe("/pledge.html");
    expect(rewritePagePath("/s/acoustic-set-nov20/?e2e=parity")).toBe("/pledge.html?e2e=parity");
    expect(rewritePagePath("/s/sabcdefghjk/manage?e2e")).toBe("/manage.html?e2e");
    expect(rewritePagePath("/start")).toBe("/start.html");
    expect(rewritePagePath("/start?e2e=parity")).toBe("/start.html?e2e=parity");
  });
  it("leaves everything else alone", () => {
    for (const u of ["/", "/?e2e=parity", "/src/web/pages/pledge.ts", "/api/shows/x", "/s/a/b/c", "/assets/x.js", "/pledge.html"]) expect(rewritePagePath(u)).toBe(u);
  });
});

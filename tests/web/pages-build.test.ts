import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiOrigin, assertProductionApiBase, contentSecurityPolicy, headersFile, stripRefOnly } from "../../src/web/build/pages";

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

describe("Pages build files", () => {
  it("allows exactly PayPal's SDK hosts, Google Fonts and the API", () => {
    const csp = contentSecurityPolicy("https://api.tiptheroom.example/");
    expect(directive(csp, "script-src")).toBe("script-src 'self' https://www.paypal.com https://www.sandbox.paypal.com https://www.paypalobjects.com");
    expect(directive(csp, "frame-src")).toBe("frame-src https://www.paypal.com https://www.sandbox.paypal.com");
    expect(directive(csp, "style-src")).toContain("https://fonts.googleapis.com");
    expect(directive(csp, "font-src")).toContain("https://fonts.gstatic.com");
    expect(directive(csp, "connect-src")).toContain("https://api.tiptheroom.example");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(directive(csp, "script-src")).not.toContain("unsafe-inline");
  });
  it("uses the page's own origin when no API base is set, and refuses a relative one", () => {
    expect(apiOrigin("")).toBeNull();
    expect(directive(contentSecurityPolicy(""), "connect-src")).toBe("connect-src 'self' https://www.paypal.com https://www.sandbox.paypal.com https://api-m.sandbox.paypal.com");
    expect(() => apiOrigin("/api")).toThrow(/absolute URL/);
  });
  it("refuses a production build whose API base is empty, relative or not https (local http is fine)", () => {
    for (const bad of ["", "  ", "/api", "api.example.com", "http://api.example.com", "ftp://x.example.com"]) expect(() => assertProductionApiBase(bad), bad).toThrow(/VITE_API_BASE/);
    for (const ok of ["https://api.tiptheroom.example", "https://api.tiptheroom.example/", "http://127.0.0.1:8788", "http://localhost:8788"]) expect(() => assertProductionApiBase(ok), ok).not.toThrow();
  });
  it("writes a Pages _headers file for every path", () => {
    const lines = headersFile("").split("\n");
    expect(lines[0]).toBe("/*");
    expect(lines.slice(1).filter(Boolean).every((l) => l.startsWith("  "))).toBe(true);
    expect(lines.some((l) => l.startsWith("  Content-Security-Policy: default-src 'self'"))).toBe(true);
    expect(lines).toContain("  X-Content-Type-Options: nosniff");
  });
  it("routes share and manage links to their pages, manage first", () => {
    expect(readFileSync("public/_redirects", "utf8").trim().split("\n").map((l) => l.trim().split(/\s+/))).toEqual([
      ["/s/:id/manage", "/manage.html", "200"],
      ["/s/:id", "/pledge.html", "200"],
    ]);
  });
  it("has a plain 404 page that points to the demo and the start page", () => {
    expect(existsSync("404.html")).toBe(true);
    const html = readFileSync("404.html", "utf8");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/start"');
    expect(html).toContain("There’s nothing here");
  });
});

describe("stripRefOnly", () => {
  it("removes each data-ref-only element with its children, and nothing else", () => {
    const html = `<main><p>keep</p><div class="x" data-ref-only><div><button>a</button></div></div><button id="simulate" data-ref-only>Sim</button><p>also</p></main><nav class="ref-nav" data-ref-only aria-label="R">R: <a href="demo.html">d</a></nav>`;
    expect(stripRefOnly(html)).toBe(`<main><p>keep</p><p>also</p></main>`);
  });
  it("leaves pages without ref-only markup alone and refuses an unclosed element", () => {
    expect(stripRefOnly("<main><p>x</p></main>")).toBe("<main><p>x</p></main>");
    expect(() => stripRefOnly("<div data-ref-only><p>x</p>")).toThrow(/no closing tag/);
  });
  it("strips every real page", () => {
    for (const f of ["index.html", "start.html", "pledge.html", "manage.html"]) expect(stripRefOnly(readFileSync(f, "utf8"))).not.toMatch(/data-ref-only/);
  });
});

// Files Cloudflare Pages reads from dist/: the security headers (generated, because the API origin is a build setting).
const PAYPAL = ["https://www.paypal.com", "https://www.sandbox.paypal.com"];

export function apiOrigin(apiBase: string): string | null {
  if (!apiBase) return null;
  try {
    return new URL(apiBase).origin;
  } catch {
    throw new Error(`VITE_API_BASE must be an absolute URL such as https://api.example.com, got "${apiBase}"`);
  }
}

/** PayPal's SDK script and checkout frames, Google Fonts, the API. Inline styles stay allowed (the pages and AG Grid's theme use them). */
export function contentSecurityPolicy(apiBase: string): string {
  const api = apiOrigin(apiBase);
  const d: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", ...PAYPAL, "https://www.paypalobjects.com"]],
    ["style-src", ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]],
    ["font-src", ["'self'", "https://fonts.gstatic.com", "data:"]],
    ["img-src", ["'self'", "data:", "blob:", ...PAYPAL, "https://www.paypalobjects.com"]],
    ["connect-src", ["'self'", ...(api ? [api] : []), ...PAYPAL, "https://api-m.sandbox.paypal.com"]],
    ["frame-src", [...PAYPAL]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'", ...PAYPAL]],
    ["object-src", ["'none'"]],
  ];
  return d.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

export function headersFile(apiBase: string): string {
  return ["/*", `  Content-Security-Policy: ${contentSecurityPolicy(apiBase)}`, "  X-Content-Type-Options: nosniff", "  Referrer-Policy: strict-origin-when-cross-origin", "  Permissions-Policy: camera=(), microphone=(), geolocation=()", ""].join("\n");
}

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

/** A real site build must name its API: an empty base means "same origin", and on Pages every API call would 404. Local http (127.0.0.1, localhost) is for local test builds. */
export function assertProductionApiBase(apiBase: string): void {
  const raw = apiBase.trim();
  let u: URL | null;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }
  const local = u !== null && u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (!u || !(u.protocol === "https:" || local)) {
    throw new Error(`A production build needs VITE_API_BASE set to the API's absolute https URL, such as https://api.example.com (got "${raw}"). Set it in the environment or a .env file.`);
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

/** Removes every element carrying data-ref-only (with its children). Production builds without test hooks only. */
export function stripRefOnly(html: string): string {
  const open = /<([a-z][a-z0-9]*)\b[^>]*\sdata-ref-only(?=[\s=>/])[^>]*>/i;
  let out = html;
  for (let n = 0; n < 100; n += 1) {
    const m = open.exec(out);
    if (!m) return out;
    const tag = (m[1] ?? "").toLowerCase();
    const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    tags.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = -1;
    for (let t = tags.exec(out); t; t = tags.exec(out)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    if (end < 0) throw new Error(`a data-ref-only <${tag}> has no closing tag`);
    out = out.slice(0, m.index) + out.slice(end);
  }
  throw new Error("more than 100 data-ref-only elements");
}

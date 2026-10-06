// Shared by the live-check scripts: which origins they may talk to, and the worker:check flags.
// Live modes only ever READ and play the public demo; they never deploy.

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ALLOWED_SUFFIXES = [".workers.dev", ".pages.dev"];

/** Returns the origin when it is safe to point a live check at, otherwise null. https only (plain http only for localhost), no path. */
export function liveOrigin(raw: string | undefined, extraHosts: string[] = []): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  const host = u.hostname.toLowerCase();
  if (LOCAL.has(host)) return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  if (u.protocol !== "https:") return null;
  const ok = ALLOWED_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length) || extraHosts.map((h) => h.trim().toLowerCase()).includes(host);
  return ok ? u.origin : null;
}

export interface CheckArgs {
  base: string | null;
  expectAi: boolean;
  expectPaid: boolean;
  error?: string;
}

/** Parses `--base <origin> --expect-ai --expect-paid`. `extraHosts` comes from LIVE_ALLOWED_HOSTS (custom domains the owner approves). */
export function parseCheckArgs(args: string[], extraHosts: string[] = []): CheckArgs {
  const at = args.indexOf("--base");
  const out: CheckArgs = { base: null, expectAi: args.includes("--expect-ai"), expectPaid: args.includes("--expect-paid") };
  if (at >= 0) {
    const origin = liveOrigin(args[at + 1], extraHosts);
    if (!origin) return { ...out, error: "--base needs an https origin with no path on an allowed host (*.workers.dev, *.pages.dev, or one listed in LIVE_ALLOWED_HOSTS), e.g. https://tip-the-room-api.example.workers.dev" };
    out.base = origin;
  }
  return out;
}

export const extraHostsFromEnv = (): string[] => (process.env.LIVE_ALLOWED_HOSTS ?? "").split(",").filter(Boolean);

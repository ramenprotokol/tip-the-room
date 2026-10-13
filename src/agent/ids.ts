export type Random = (byteCount: number) => Uint8Array;
export const cryptoRandom: Random = (n) => crypto.getRandomValues(new Uint8Array(n));

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** 32 lower-case letters and digits, without l, o, 0 and 1. 256 % 32 === 0, so there is no bias. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** "s" = show, "p" = pledge, "d" = demo copy; plus 10 random characters. */
export function newId(prefix: "s" | "p" | "d", random: Random): string {
  let out: string = prefix;
  for (const b of random(10)) out += ALPHABET[b % 32];
  return out;
}

const SHOW_ID = /^(s[a-z2-9]{10}|d[a-z2-9]{10}[ab])$/;
const DEMO_ID = /^d[a-z2-9]{10}$/;

export function isShowId(id: string): boolean {
  return typeof id === "string" && SHOW_ID.test(id);
}

export function isDemoId(id: string): boolean {
  return typeof id === "string" && DEMO_ID.test(id);
}

/** A demo copy's two shows: "<demoId>a" tips, "<demoId>b" misses. */
export function demoShowIds(demoId: string): [string, string] {
  return [`${demoId}a`, `${demoId}b`];
}

const HEXTET = /^[0-9a-f]{1,4}$/i;
const DOTTED = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The eight 16-bit groups of an IPv6 address (an IPv4 tail counts as two), or null when it is not one. */
function ipv6Groups(text: string): number[] | null {
  let t = text.trim();
  if (t.startsWith("[") && t.endsWith("]")) t = t.slice(1, -1);
  const zone = t.indexOf("%");
  if (zone >= 0) t = t.slice(0, zone);
  if (!t.includes(":")) return null;
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const bits = part.split(":");
    for (let i = 0; i < bits.length; i++) {
      const dotted = i === bits.length - 1 ? DOTTED.exec(bits[i]) : null;
      if (dotted) {
        const o = dotted.slice(1).map(Number);
        if (o.some((n) => n > 255)) return null;
        out.push(o[0] * 256 + o[1], o[2] * 256 + o[3]);
      } else if (HEXTET.test(bits[i])) out.push(parseInt(bits[i], 16));
      else return null;
    }
    return out;
  };
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const gap = 8 - left.length - right.length;
  return gap >= 1 ? [...left, ...new Array<number>(gap).fill(0), ...right] : null;
}

/**
 * What a rate limit should count as one visitor. An IPv6 address is a whole /64 to its owner, so only its first 64 bits
 * count; an IPv4-mapped IPv6 address is the IPv4 address. IPv4 and anything unparseable (like "local") come back unchanged.
 */
export function visitorNet(ip: string): string {
  const g = ipv6Groups(ip);
  if (!g) return ip;
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
}

/** 32 random bytes, base64url. Used for manage keys, demo keys and sign tokens. */
export function newSecret(random: Random): string {
  let s = "";
  for (const b of random(32)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two hex digests. */
export function sameHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PayPal custom_id for a pledge: "<show>:<pledge>". PayPal's cap is 127 characters. */
export function customIdFor(showId: string, pledgeId: string): string {
  const id = `${showId}:${pledgeId}`;
  if (id.length > 127) throw new RangeError("custom_id must be at most 127 characters");
  return id;
}

/** Finds our show id in a webhook's custom_id ("show:pledge"), sender_item_id ("show-role[-r1]") or sender_batch_id ("payout-show[-r1]"). */
export function showIdFromRef(ref: string): string | null {
  if (typeof ref !== "string") return null;
  const m = /^payout-([a-z0-9]+)(?:-r1)?$/.exec(ref) ?? /^([a-z0-9]+):/.exec(ref) ?? /^([a-z0-9]+)-[a-z]+(?:-r1)?$/.exec(ref);
  const id = m?.[1];
  return id && isShowId(id) ? id : null;
}

/** The pledge part of "<show>:<pledge>". */
export function pledgeIdFromCustomId(customId: string): string | null {
  const i = customId.indexOf(":");
  return i > 0 && i < customId.length - 1 ? customId.slice(i + 1) : null;
}

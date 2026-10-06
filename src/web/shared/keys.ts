// Show ids from the URL, the artist's manage key, the judge's demo copy, dismissed proposals. Storage may throw (private mode): every access is guarded.
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const MANAGE = "ttr:manage:";
const DEMO = "ttr:demo";
const DISMISSED = "ttr:dismissed:";
const KEY_RE = /^[A-Za-z0-9_-]{6,128}$/;
const ID_RE = /^[a-z0-9-]{3,40}$/;

/** "/s/<id>" or "/s/<id>/manage" (Pages rewrites), or "?show=<id>" on a plain .html page. */
export function showIdFromPath(pathname: string, search = ""): string | null {
  const m = /^\/s\/([^/]+)(?:\/manage)?\/?$/.exec(pathname);
  let id: string | null;
  try {
    id = m ? decodeURIComponent(m[1]) : new URLSearchParams(search).get("show");
  } catch {
    return null;
  }
  return id && ID_RE.test(id) ? id : null;
}

export function takeKeyFromHash(hash: string): string | null {
  const k = hash.replace(/^#/, "");
  return KEY_RE.test(k) ? k : null;
}

export function rememberKey(store: KeyStore | null, showId: string, key: string): void {
  try {
    store?.setItem(MANAGE + showId, key);
  } catch {
    // Private mode: the key lives only in the link the artist saved.
  }
}

export function recallKey(store: KeyStore | null, showId: string): string | null {
  try {
    const k = store?.getItem(MANAGE + showId) ?? null;
    return k && KEY_RE.test(k) ? k : null;
  } catch {
    return null;
  }
}

export interface SavedDemo {
  demoId: string;
  demoKey: string;
  expiresAt: number;
}

export function saveDemo(store: KeyStore | null, d: SavedDemo): void {
  try {
    store?.setItem(DEMO, JSON.stringify(d));
  } catch {
    // Without storage the judge gets a fresh copy on the next visit.
  }
}

export function loadDemo(store: KeyStore | null): SavedDemo | null {
  try {
    const raw = store?.getItem(DEMO);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SavedDemo>;
    if (typeof d.demoId === "string" && /^[a-z0-9]{3,40}$/.test(d.demoId) && typeof d.demoKey === "string" && KEY_RE.test(d.demoKey) && typeof d.expiresAt === "number") {
      return { demoId: d.demoId, demoKey: d.demoKey, expiresAt: d.expiresAt };
    }
    return null;
  } catch {
    return null;
  }
}

export function dismiss(store: KeyStore | null, showId: string, proposalId: string): void {
  try {
    store?.setItem(`${DISMISSED}${showId}:${proposalId}`, "1");
  } catch {
    // The card comes back on reload; the agent log still has the "not now".
  }
}

export function isDismissed(store: KeyStore | null, showId: string, proposalId: string): boolean {
  try {
    return store?.getItem(`${DISMISSED}${showId}:${proposalId}`) === "1";
  } catch {
    return false;
  }
}

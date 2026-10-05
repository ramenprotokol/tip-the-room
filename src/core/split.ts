import type { Cents } from "./money";

export type Role = "room" | "opener" | "host" | "artist";

export interface Party {
  role: Role;
  /** Name shown to people, e.g. "Spindle Records". */
  label: string;
  /** Where the payout goes (a sandbox account in the demo). */
  paypalEmail: string;
  /** Fixed amount for room, opener and host, in cents. */
  fixed?: Cents;
  /** Least the artist must receive, in cents. Artist only. */
  minimum?: Cents;
}

export interface PayoutLine {
  role: Role;
  label: string;
  paypalEmail: string;
  amount: Cents;
}

export interface SplitResult {
  lines: PayoutLine[];
  /** How far the money falls short of fixed costs plus the artist's minimum. 0 when fully covered. */
  shortfall: Cents;
}

function checkParties(parties: Party[]): void {
  const artists = parties.filter((p) => p.role === "artist");
  if (artists.length !== 1) throw new Error("A split needs exactly one artist");
  for (const p of parties) {
    if (p.role !== "artist" && (p.fixed === undefined || !Number.isInteger(p.fixed) || p.fixed < 0)) {
      throw new Error(`${p.label} needs a fixed amount in whole cents`);
    }
  }
}

export function fixedTotal(parties: Party[]): Cents {
  return parties.filter((p) => p.role !== "artist").reduce((s, p) => s + (p.fixed ?? 0), 0);
}

export function artistMinimum(parties: Party[]): Cents {
  return parties.find((p) => p.role === "artist")?.minimum ?? 0;
}

/** Pays fixed parties in order while money remains, then gives the artist everything left. */
export function splitPayout(collectedNet: Cents, parties: Party[]): SplitResult {
  checkParties(parties);
  let remaining = collectedNet;
  const fixedLines: PayoutLine[] = [];
  for (const p of parties) {
    if (p.role === "artist") continue;
    const amount = Math.min(p.fixed ?? 0, remaining);
    remaining -= amount;
    fixedLines.push({ role: p.role, label: p.label, paypalEmail: p.paypalEmail, amount });
  }
  const artist = parties.find((p) => p.role === "artist") as Party;
  const lines = [...fixedLines, { role: artist.role, label: artist.label, paypalEmail: artist.paypalEmail, amount: remaining }];
  const shortfall = Math.max(0, fixedTotal(parties) + artistMinimum(parties) - collectedNet);
  return { lines, shortfall };
}

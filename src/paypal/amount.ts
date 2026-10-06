import type { Cents } from "../core/money";

/** 1500 → "15.00", using integer maths only. */
export function centsToValue(c: Cents): string {
  if (!Number.isSafeInteger(c) || c < 0) throw new RangeError("amount must be a non-negative whole number of cents");
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

/** "15.00" | "15" | "15.5" → 1500 | 1500 | 1550. */
export function valueToCents(v: string): Cents {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) throw new RangeError(`not a PayPal amount: "${v}"`);
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new RangeError(`amount too large: "${v}"`);
  return cents;
}

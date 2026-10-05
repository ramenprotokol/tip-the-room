import type { Cents } from "./money";

export const DEFAULT_FEE_BUFFER_BPS = 500;

export interface ThresholdInput {
  /** Fixed amounts paid before the artist (room, opener, host), in cents. */
  fixedCosts: Cents[];
  /** The least the artist must receive, in cents. */
  artistMinimum: Cents;
  /** Pledge per fan, in cents. */
  ticketPrice: Cents;
  /** Extra margin for PayPal fees, in basis points (500 = 5%). */
  feeBufferBps: number;
}

function isNonNegativeInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/** How many fans must pledge so the money covers every fixed cost, the artist's minimum, and the fee buffer. */
export function thresholdPledges(input: ThresholdInput): number {
  const { fixedCosts, artistMinimum, ticketPrice, feeBufferBps } = input;
  if (!Number.isInteger(ticketPrice) || ticketPrice <= 0) {
    throw new RangeError("ticketPrice must be a positive whole number of cents");
  }
  if (!Number.isInteger(feeBufferBps) || feeBufferBps < 0 || feeBufferBps > 5000) {
    throw new RangeError("feeBufferBps must be a whole number from 0 to 5000");
  }
  if (!fixedCosts.every(isNonNegativeInt) || !isNonNegativeInt(artistMinimum)) {
    throw new RangeError("costs must be non-negative whole numbers of cents");
  }
  const need = fixedCosts.reduce((sum, c) => sum + c, 0) + artistMinimum;
  const numerator = need * (10000 + feeBufferBps);
  const denominator = 10000 * ticketPrice;
  return Math.max(1, Math.ceil(numerator / denominator));
}

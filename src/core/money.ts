/** Every stored or computed amount is an integer number of US cents. */
export type Cents = number;

export function dollarsToCents(dollars: number): Cents {
  if (!Number.isFinite(dollars) || dollars < 0) {
    throw new RangeError(`Amount must be a finite, non-negative number of dollars (got ${dollars})`);
  }
  return Math.round(dollars * 100);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function formatUSD(cents: Cents): string {
  return usd.format(cents / 100);
}

export function formatUSDShort(cents: Cents): string {
  return cents % 100 === 0 ? usdWhole.format(cents / 100) : formatUSD(cents);
}

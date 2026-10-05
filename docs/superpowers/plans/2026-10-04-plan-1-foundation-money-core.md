# Plan 1 · Foundation + Money Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the Tip the Room repo and build the pure-TypeScript money core: amounts in cents, the fan target, the payout split, hold timing, the signed mandate, the campaign state machine, and the rule guard that every agent money action must pass.

**Architecture:**
- `src/core/` is framework-free TypeScript with no I/O apart from WebCrypto hashing. Both the Cloudflare Worker (Plan 4) and the browser (Plans 2 and 5) import it.
- All money is integer **cents**.
- The campaign is a pure reducer, `(state, event) → (state, effects)`.
- The guard is a pure function, `(action, context) → decision`, naming which of the five plain-English money rules applied.

**Tech Stack:** Node 22, TypeScript 6, Vite 8, Vitest 5, fast-check 4, ESLint 10 + typescript-eslint.

## Global Constraints

- Repo: `<repo>` (git identity is ramenprotokol automatically; never change git config).
- **Never** `git push`, deploy, or publish anything. Commit locally only.
- **Never** read or write outside `<repo>` (plus the npm cache).
- No secrets in the repo; `.dev.vars` is gitignored and must stay untouched.
- Money is always integer cents (`Cents = number`). Never use floats for stored amounts.
- `feeBufferBps` default is `500` (5%). The fan target formula is `ceil((sum of fixed costs + artist minimum) × (10000 + feeBufferBps) / (10000 × ticketPrice))`, minimum 1.
- Hold timing:
  - A PayPal authorization is valid for **29 days**, and capture is guaranteed only in the first **3 days** (the honor period).
  - A campaign window is at most **21 days**.
  - At most **1** deadline extension, of at most **7 days**.
- The five money rules, with these exact ids and plain-English titles, are used in UI copy later:
  - `rule-1-hold-only`: "Fans are only held, never charged, until the target is reached."
  - `rule-2-capture-at-tip`: "When the target is reached, charge every hold."
  - `rule-3-void-on-miss`: "If the deadline passes below the target, cancel every hold."
  - `rule-4-pay-the-split`: "Pay everyone exactly the split you signed."
  - `rule-5-ask-first`: "Ask the artist first before changing the deadline or the target, or refunding."
- Run commands from the repo root. Every commit message ends with:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (implementer tasks).

---

### Task 1: Scaffold the repo

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.js`, `LICENSE`, `README.md`, `index.html`, `src/main.ts`, `.github/workflows/checks.yml`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `typecheck`, `lint`, `test`. A `tests/**/*.test.ts` Vitest glob (excluding `tests/gpu/**`). `tsconfig` covering `src`, `tests` and `vite.config.ts`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "tip-the-room",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Pledge-to-make-it-happen shows: fans hold a spot with PayPal, an agent charges everyone and pays out only if the show tips.",
  "license": "MIT",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "engines": { "node": ">=22" },
  "repository": { "type": "git", "url": "git+https://github.com/ramenprotokol/tip-the-room.git" },
  "homepage": "https://github.com/ramenprotokol/tip-the-room"
}
```

- [ ] **Step 2: Install dev dependencies**

Run: `npm install -D typescript@^6.0.3 vite@^8.3.1 vitest@^5.0.2 fast-check@^4.10.2 eslint@^10.11.0 @eslint/js@^10.0.1 typescript-eslint@^8.71.0 @types/node@^26.6.3`
Expected: `package-lock.json` created, no errors.

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src", "tests", "vite.config.ts"]
}
```

- [ ] **Step 4: Write `vite.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  server: { hmr: false },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/gpu/**", "node_modules/**"],
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 5: Write `eslint.config.js`**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "playwright-report/**", "test-results/**", "reference/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

- [ ] **Step 6: Write `LICENSE`** (standard MIT text, holder "Ramen Protocol")

```text
MIT License

Copyright (c) 2026 Ramen Protocol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 7: Write `README.md`** (stub; Plan 6 writes the real one)

```markdown
# Tip the Room

Fans hold a spot for a small show with PayPal. Nobody is charged unless enough fans join by the deadline. When they do, an agent charges every hold and pays the room, the opener and the artist the split the artist signed. When they don't, every hold is cancelled and nobody pays.

Built for the PayPal AI Hackathon (2026). Work in progress.

## Develop

    npm install
    npm test
    npm run dev
```

- [ ] **Step 8: Write `index.html` and `src/main.ts`** (placeholder page; Plan 2 replaces both)

`index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Tip the Room</title>
</head>
<body>
  <main id="app"><h1>Tip the Room</h1><p>Nobody's charged unless the show happens.</p></main>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

`src/main.ts`:
```ts
export const APP_NAME = "Tip the Room";
```

- [ ] **Step 9: Write `.github/workflows/checks.yml`**

```yaml
name: Checks

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: checks-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    name: Node 22
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Check out the repository
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
        with:
          persist-credentials: false
      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          cache: npm
      - name: Install locked dependencies
        run: npm ci
      - name: Type-check
        run: npm run typecheck
      - name: Lint
        run: npm run lint
      - name: Unit tests
        run: npm test
      - name: Build the static site
        run: npm run build
      - name: Audit dependencies
        run: npm audit --audit-level=moderate
```

- [ ] **Step 10: Write the smoke test `tests/smoke.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { APP_NAME } from "../src/main";

describe("scaffold", () => {
  it("exposes the app name", () => {
    expect(APP_NAME).toBe("Tip the Room");
  });
});
```

- [ ] **Step 11: Run every check**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all succeed. Vitest reports `1 passed`, and the build writes `dist/`.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts eslint.config.js LICENSE README.md index.html src/main.ts .github/workflows/checks.yml tests/smoke.test.ts
git commit -m "chore: scaffold Vite + TypeScript + Vitest + ESLint with CI checks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Money and hold timing

**Files:**
- Create: `src/core/money.ts`, `src/core/holds.ts`
- Test: `tests/core/money.test.ts`, `tests/core/holds.test.ts`

**Interfaces:**
- Produces:
  - `type Cents = number`
  - `dollarsToCents(dollars: number): Cents`
  - `formatUSD(cents: Cents): string` (e.g. `"$435.00"`)
  - `formatUSDShort(cents: Cents): string` (`"$435"` for whole dollars, else `"$435.50"`)
  - `DAY_MS`, `HONOR_PERIOD_MS`, `AUTH_VALID_MS`, `MAX_CAMPAIGN_DAYS = 21`, `MAX_EXTENSION_DAYS = 7`
  - `needsReauthorization(authorizedAt: number, now: number): boolean`
  - `isAuthorizationExpired(authorizedAt: number, now: number): boolean`

- [ ] **Step 1: Write the failing tests**

`tests/core/money.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { dollarsToCents, formatUSD, formatUSDShort } from "../../src/core/money";

describe("dollarsToCents", () => {
  it("converts whole and fractional dollars without float drift", () => {
    expect(dollarsToCents(15)).toBe(1500);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
    expect(dollarsToCents(19.99)).toBe(1999);
  });
  it("rejects negative and non-finite amounts", () => {
    expect(() => dollarsToCents(-1)).toThrow(RangeError);
    expect(() => dollarsToCents(Number.NaN)).toThrow(RangeError);
    expect(() => dollarsToCents(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("formatUSD", () => {
  it("formats cents as US dollars", () => {
    expect(formatUSD(43500)).toBe("$435.00");
    expect(formatUSD(0)).toBe("$0.00");
    expect(formatUSD(123456)).toBe("$1,234.56");
  });
  it("drops cents for whole dollars in the short form", () => {
    expect(formatUSDShort(43500)).toBe("$435");
    expect(formatUSDShort(123400)).toBe("$1,234");
    expect(formatUSDShort(43550)).toBe("$435.50");
  });
});
```

`tests/core/holds.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { AUTH_VALID_MS, DAY_MS, HONOR_PERIOD_MS, isAuthorizationExpired, needsReauthorization } from "../../src/core/holds";

const t0 = Date.UTC(2026, 10, 1, 12, 0, 0);

describe("hold timing", () => {
  it("uses PayPal's 3-day honor period and 29-day validity", () => {
    expect(HONOR_PERIOD_MS).toBe(3 * DAY_MS);
    expect(AUTH_VALID_MS).toBe(29 * DAY_MS);
  });
  it("needs reauthorization from the start of day 3 onward", () => {
    expect(needsReauthorization(t0, t0 + 3 * DAY_MS - 1)).toBe(false);
    expect(needsReauthorization(t0, t0 + 3 * DAY_MS)).toBe(true);
  });
  it("is expired from day 29 onward", () => {
    expect(isAuthorizationExpired(t0, t0 + 29 * DAY_MS - 1)).toBe(false);
    expect(isAuthorizationExpired(t0, t0 + 29 * DAY_MS)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core`
Expected: FAIL, "Failed to resolve import ../../src/core/money".

- [ ] **Step 3: Implement**

`src/core/money.ts`:
```ts
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
```

`src/core/holds.ts`:
```ts
export const DAY_MS = 24 * 60 * 60 * 1000;
/** Capture is only guaranteed in the first 3 days after an authorization. */
export const HONOR_PERIOD_MS = 3 * DAY_MS;
/** An authorization can be captured (after reauthorizing) for up to 29 days. */
export const AUTH_VALID_MS = 29 * DAY_MS;
/** A campaign's pledge window is at most 21 days, so no hold outlives its authorization. */
export const MAX_CAMPAIGN_DAYS = 21;
/** The artist may approve one deadline extension of at most 7 days. */
export const MAX_EXTENSION_DAYS = 7;

export function needsReauthorization(authorizedAt: number, now: number): boolean {
  return now - authorizedAt >= HONOR_PERIOD_MS;
}

export function isAuthorizationExpired(authorizedAt: number, now: number): boolean {
  return now - authorizedAt >= AUTH_VALID_MS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/money.ts src/core/holds.ts tests/core/money.test.ts tests/core/holds.test.ts
git commit -m "feat(core): integer-cent money helpers and PayPal hold timing

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fan target (threshold)

**Files:**
- Create: `src/core/threshold.ts`
- Test: `tests/core/threshold.test.ts`

**Interfaces:**
- Consumes: `Cents` from `src/core/money.ts`.
- Produces:
  - `interface ThresholdInput { fixedCosts: Cents[]; artistMinimum: Cents; ticketPrice: Cents; feeBufferBps: number }`
  - `DEFAULT_FEE_BUFFER_BPS = 500`
  - `thresholdPledges(input: ThresholdInput): number`

- [ ] **Step 1: Write the failing test** `tests/core/threshold.test.ts`

```ts
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DEFAULT_FEE_BUFFER_BPS, thresholdPledges } from "../../src/core/threshold";

describe("thresholdPledges", () => {
  it("matches the Juniper Vale sample: $80 room + $100 opener + $300 artist at $15 → 34 fans", () => {
    expect(thresholdPledges({ fixedCosts: [8000, 10000], artistMinimum: 30000, ticketPrice: 1500, feeBufferBps: 500 })).toBe(34);
  });
  it("matches the Maya sample: $100 café + $200 artist at $15 → 21 fans", () => {
    expect(thresholdPledges({ fixedCosts: [10000], artistMinimum: 20000, ticketPrice: 1500, feeBufferBps: DEFAULT_FEE_BUFFER_BPS })).toBe(21);
  });
  it("never returns less than 1", () => {
    expect(thresholdPledges({ fixedCosts: [], artistMinimum: 0, ticketPrice: 1500, feeBufferBps: 500 })).toBe(1);
  });
  it("rejects a zero or fractional ticket price and bad buffers", () => {
    expect(() => thresholdPledges({ fixedCosts: [], artistMinimum: 100, ticketPrice: 0, feeBufferBps: 500 })).toThrow(RangeError);
    expect(() => thresholdPledges({ fixedCosts: [], artistMinimum: 100, ticketPrice: 10.5, feeBufferBps: 500 })).toThrow(RangeError);
    expect(() => thresholdPledges({ fixedCosts: [], artistMinimum: 100, ticketPrice: 1500, feeBufferBps: -1 })).toThrow(RangeError);
    expect(() => thresholdPledges({ fixedCosts: [-5], artistMinimum: 100, ticketPrice: 1500, feeBufferBps: 500 })).toThrow(RangeError);
  });
  it("always raises enough to cover costs plus the buffer (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 500_000 }), { maxLength: 4 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 100, max: 20_000 }),
        fc.integer({ min: 0, max: 2000 }),
        (fixedCosts, artistMinimum, ticketPrice, feeBufferBps) => {
          const n = thresholdPledges({ fixedCosts, artistMinimum, ticketPrice, feeBufferBps });
          const need = fixedCosts.reduce((a, b) => a + b, 0) + artistMinimum;
          const needed = need * (10000 + feeBufferBps);
          expect(n * ticketPrice * 10000).toBeGreaterThanOrEqual(needed);
          if (n > 1) expect((n - 1) * ticketPrice * 10000).toBeLessThan(needed);
        },
      ),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core/threshold.test.ts`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 3: Implement** `src/core/threshold.ts`

```ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/core/threshold.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/threshold.ts tests/core/threshold.test.ts
git commit -m "feat(core): fan target from costs, artist minimum and fee buffer

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Payout split

**Files:**
- Create: `src/core/split.ts`
- Test: `tests/core/split.test.ts`

**Interfaces:**
- Consumes: `Cents`.
- Produces:
  - `type Role = "room" | "opener" | "host" | "artist"`
  - `interface Party { role: Role; label: string; paypalEmail: string; fixed?: Cents; minimum?: Cents }`
  - `interface PayoutLine { role: Role; label: string; paypalEmail: string; amount: Cents }`
  - `interface SplitResult { lines: PayoutLine[]; shortfall: Cents }`
  - `splitPayout(collectedNet: Cents, parties: Party[]): SplitResult`
  - `fixedTotal(parties: Party[]): Cents`
  - `artistMinimum(parties: Party[]): Cents`
- Rules:
  - Exactly one `artist` party. Every other party has `fixed`.
  - Fixed amounts are paid in array order while money remains.
  - The artist gets the rest.
  - `shortfall = max(0, fixedTotal + artistMinimum − collectedNet)`.

- [ ] **Step 1: Write the failing test** `tests/core/split.test.ts`

```ts
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { artistMinimum, fixedTotal, splitPayout, type Party } from "../../src/core/split";

const juniper: Party[] = [
  { role: "room", label: "Spindle Records", paypalEmail: "room@example.com", fixed: 8000 },
  { role: "opener", label: "The Low Tides", paypalEmail: "opener@example.com", fixed: 10000 },
  { role: "artist", label: "Juniper Vale", paypalEmail: "artist@example.com", minimum: 30000 },
];

describe("splitPayout", () => {
  it("pays room, then opener, then the artist the rest", () => {
    const r = splitPayout(51000, juniper);
    expect(r.lines.map((l) => [l.role, l.amount])).toEqual([["room", 8000], ["opener", 10000], ["artist", 33000]]);
    expect(r.shortfall).toBe(0);
  });
  it("reports a shortfall when the artist would get less than their minimum", () => {
    const r = splitPayout(40000, juniper);
    expect(r.lines.map((l) => l.amount)).toEqual([8000, 10000, 22000]);
    expect(r.shortfall).toBe(8000);
  });
  it("pays fixed parties in order when money runs short", () => {
    const r = splitPayout(12000, juniper);
    expect(r.lines.map((l) => l.amount)).toEqual([8000, 4000, 0]);
    expect(r.shortfall).toBe(48000 - 12000);
  });
  it("computes totals", () => {
    expect(fixedTotal(juniper)).toBe(18000);
    expect(artistMinimum(juniper)).toBe(30000);
  });
  it("rejects zero or two artists, and fixed parties without an amount", () => {
    expect(() => splitPayout(100, juniper.slice(0, 2))).toThrow(/exactly one artist/);
    expect(() => splitPayout(100, [...juniper, { ...juniper[2] }])).toThrow(/exactly one artist/);
    expect(() => splitPayout(100, [{ role: "room", label: "R", paypalEmail: "r@example.com" }, juniper[2]])).toThrow(/fixed amount/);
  });
  it("never pays out more than was collected, and pays it all (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 200_000 }), (collected, room, opener) => {
        const parties: Party[] = [
          { role: "room", label: "R", paypalEmail: "r@example.com", fixed: room },
          { role: "opener", label: "O", paypalEmail: "o@example.com", fixed: opener },
          { role: "artist", label: "A", paypalEmail: "a@example.com", minimum: 0 },
        ];
        const r = splitPayout(collected, parties);
        const paid = r.lines.reduce((s, l) => s + l.amount, 0);
        expect(paid).toBe(collected);
        expect(r.lines.every((l) => Number.isInteger(l.amount) && l.amount >= 0)).toBe(true);
      }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core/split.test.ts`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 3: Implement** `src/core/split.ts`

```ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/core/split.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/split.ts tests/core/split.test.ts
git commit -m "feat(core): ordered payout split with artist remainder and shortfall

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mandate (build, validate, sign, verify)

**Files:**
- Create: `src/core/mandate.ts`
- Test: `tests/core/mandate.test.ts`

**Interfaces:**
- Consumes:
  - `Cents`
  - `Party`, `fixedTotal`, `artistMinimum` from `split.ts`
  - `thresholdPledges`, `DEFAULT_FEE_BUFFER_BPS` from `threshold.ts`
  - `DAY_MS`, `MAX_CAMPAIGN_DAYS`, `MAX_EXTENSION_DAYS` from `holds.ts`
- Produces:
  - `interface MandateDraft { showId: string; showName: string; roomName: string; showDate: string /* YYYY-MM-DD */; ticketPrice: Cents; feeBufferBps: number; parties: Party[]; launchedAt: string /* ISO */; deadline: string /* ISO */ }`
  - `interface Mandate extends MandateDraft { version: 1; threshold: number; maxExtensions: 1; maxExtensionDays: 7 }`
  - `interface SignedMandate { mandate: Mandate; hash: string; signedAt: string }`
  - `buildMandate(draft: MandateDraft): Mandate`
  - `validateMandate(m: Mandate): string[]` (an empty array means valid; each string is a plain-English problem)
  - `canonicalJSON(value: unknown): string`
  - `signMandate(m: Mandate, signedAt: string): Promise<SignedMandate>`
  - `verifyMandate(s: SignedMandate): Promise<boolean>`

- [ ] **Step 1: Write the failing test** `tests/core/mandate.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildMandate, canonicalJSON, signMandate, validateMandate, verifyMandate, type MandateDraft } from "../../src/core/mandate";

const draft: MandateDraft = {
  showId: "juniper-vale-nov-20",
  showName: "Juniper Vale",
  roomName: "Spindle Records",
  showDate: "2026-11-20",
  ticketPrice: 1500,
  feeBufferBps: 500,
  parties: [
    { role: "room", label: "Spindle Records", paypalEmail: "room@example.com", fixed: 8000 },
    { role: "opener", label: "The Low Tides", paypalEmail: "opener@example.com", fixed: 10000 },
    { role: "artist", label: "Juniper Vale", paypalEmail: "artist@example.com", minimum: 30000 },
  ],
  launchedAt: "2026-11-04T18:00:00.000Z",
  deadline: "2026-11-19T02:00:00.000Z",
};

describe("buildMandate", () => {
  it("computes the fan target and fixes the extension limits", () => {
    const m = buildMandate(draft);
    expect(m.threshold).toBe(34);
    expect(m.version).toBe(1);
    expect(m.maxExtensions).toBe(1);
    expect(m.maxExtensionDays).toBe(7);
    expect(validateMandate(m)).toEqual([]);
  });
});

describe("validateMandate", () => {
  it("rejects a window longer than 21 days", () => {
    const m = buildMandate({ ...draft, deadline: "2026-11-26T18:00:01.000Z", showDate: "2026-11-30" });
    expect(validateMandate(m)).toContain("The pledge window can be at most 21 days.");
  });
  it("rejects a deadline before launch, a show before the deadline, and a bad email", () => {
    const m = buildMandate({
      ...draft,
      deadline: "2026-11-03T00:00:00.000Z",
      parties: [{ ...draft.parties[0], paypalEmail: "not-an-email" }, draft.parties[1], draft.parties[2]],
    });
    const problems = validateMandate(m);
    expect(problems).toContain("The deadline must be after the show goes live.");
    expect(problems).toContain("Spindle Records needs a valid PayPal email.");
    const late = buildMandate({ ...draft, showDate: "2026-11-18" });
    expect(validateMandate(late)).toContain("The show must be on or after the pledge deadline.");
  });
  it("rejects an empty show name", () => {
    expect(validateMandate(buildMandate({ ...draft, showName: "  " }))).toContain("Give the show a name.");
  });
});

describe("canonicalJSON", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJSON({ b: 1, a: { d: [3, 1], c: true } })).toBe('{"a":{"c":true,"d":[3,1]},"b":1}');
  });
});

describe("signMandate / verifyMandate", () => {
  it("hashes the canonical mandate with SHA-256 and detects tampering", async () => {
    const signed = await signMandate(buildMandate(draft), "2026-11-04T18:05:00.000Z");
    expect(signed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyMandate(signed)).toBe(true);
    const tampered = { ...signed, mandate: { ...signed.mandate, threshold: 20 } };
    expect(await verifyMandate(tampered)).toBe(false);
  });
  it("produces the same hash regardless of key order", async () => {
    const m = buildMandate(draft);
    const reordered = JSON.parse(JSON.stringify(m, Object.keys(m).reverse()));
    const a = await signMandate(m, "x");
    const b = await signMandate({ ...reordered, parties: m.parties }, "x");
    expect(a.hash).toBe(b.hash);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core/mandate.test.ts`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 3: Implement** `src/core/mandate.ts`

```ts
import type { Cents } from "./money";
import { DAY_MS, MAX_CAMPAIGN_DAYS, MAX_EXTENSION_DAYS } from "./holds";
import { artistMinimum, fixedTotal, type Party } from "./split";
import { thresholdPledges } from "./threshold";

export interface MandateDraft {
  showId: string;
  showName: string;
  roomName: string;
  /** Calendar date of the show, YYYY-MM-DD. */
  showDate: string;
  ticketPrice: Cents;
  feeBufferBps: number;
  /** Payout order: room, opener, host (any of them optional), then exactly one artist. */
  parties: Party[];
  /** ISO timestamp when pledging opens. */
  launchedAt: string;
  /** ISO timestamp when pledging closes. */
  deadline: string;
}

export interface Mandate extends MandateDraft {
  version: 1;
  threshold: number;
  maxExtensions: 1;
  maxExtensionDays: 7;
}

export interface SignedMandate {
  mandate: Mandate;
  /** SHA-256 hex digest of canonicalJSON(mandate). */
  hash: string;
  signedAt: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buildMandate(draft: MandateDraft): Mandate {
  const threshold = thresholdPledges({
    fixedCosts: draft.parties.filter((p) => p.role !== "artist").map((p) => p.fixed ?? 0),
    artistMinimum: artistMinimum(draft.parties),
    ticketPrice: draft.ticketPrice,
    feeBufferBps: draft.feeBufferBps,
  });
  return { ...draft, version: 1, threshold, maxExtensions: 1, maxExtensionDays: MAX_EXTENSION_DAYS as 7 };
}

export function validateMandate(m: Mandate): string[] {
  const problems: string[] = [];
  if (!m.showName.trim()) problems.push("Give the show a name.");
  if (!m.roomName.trim()) problems.push("Say where the show is.");
  if (!Number.isInteger(m.ticketPrice) || m.ticketPrice <= 0) problems.push("The pledge must be more than $0.");
  if (m.parties.filter((p) => p.role === "artist").length !== 1) problems.push("The split needs exactly one artist.");
  for (const p of m.parties) {
    if (!EMAIL.test(p.paypalEmail)) problems.push(`${p.label} needs a valid PayPal email.`);
    if (p.role !== "artist" && (p.fixed === undefined || !Number.isInteger(p.fixed) || p.fixed < 0)) {
      problems.push(`${p.label} needs a fixed amount.`);
    }
  }
  const launched = Date.parse(m.launchedAt);
  const deadline = Date.parse(m.deadline);
  if (Number.isNaN(launched) || Number.isNaN(deadline)) {
    problems.push("The launch time and deadline must be real dates.");
  } else {
    if (deadline <= launched) problems.push("The deadline must be after the show goes live.");
    if (deadline - launched > MAX_CAMPAIGN_DAYS * DAY_MS) problems.push("The pledge window can be at most 21 days.");
    if (m.showDate < m.deadline.slice(0, 10)) problems.push("The show must be on or after the pledge deadline.");
  }
  if (m.threshold < 1) problems.push("The fan target must be at least 1.");
  if (fixedTotal(m.parties) < 0) problems.push("Amounts cannot be negative.");
  return problems;
}

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signMandate(m: Mandate, signedAt: string): Promise<SignedMandate> {
  return { mandate: m, hash: await sha256Hex(canonicalJSON(m)), signedAt };
}

export async function verifyMandate(s: SignedMandate): Promise<boolean> {
  return (await sha256Hex(canonicalJSON(s.mandate))) === s.hash;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/core/mandate.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/mandate.ts tests/core/mandate.test.ts
git commit -m "feat(core): mandate build, plain-English validation, SHA-256 signing

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Campaign state machine

**Files:**
- Create: `src/core/campaign.ts`
- Test: `tests/core/campaign.test.ts`

**Interfaces:**
- Produces:
  - `type CampaignState = "draft" | "live" | "tipped" | "paying_out" | "settled" | "missed" | "cancelled"`
  - `interface Campaign { state: CampaignState; threshold: number; deadline: number; pledges: { held: number; charged: number; released: number; refunded: number }; extensionsUsed: number }`
  - `type CampaignEvent` — the union below
  - `type Effect` — the union below
  - `interface Step { campaign: Campaign; effects: Effect[] }`
  - `class IllegalTransition extends Error`
  - `initialCampaign(): Campaign`
  - `reduce(c: Campaign, e: CampaignEvent): Step`
  - `fansCommitted(c: Campaign): number`
- Transition table:

| From | Event | To | Effects |
|---|---|---|---|
| draft | mandate_signed | live | — |
| live | pledge_held | live, or tipped once `held + charged ≥ threshold` | `capture_all_held` when it tips |
| tipped | pledge_held | tipped | `capture_new_pledge` |
| live / tipped / paying_out | pledge_charged (needs `held > 0`) | same | — |
| live | deadline_reached | missed | `void_all_held` |
| tipped | deadline_reached | paying_out | `send_payouts` |
| paying_out | payouts_sent | settled | — |
| missed / cancelled | holds_released(count) | same | — |
| live | deadline_extended (one only) | live | — |
| tipped | show_cancelled | cancelled | `void_all_held`, `refund_all_charged` |
| cancelled | refunds_sent(count) | cancelled | — |
| missed / settled / cancelled / paying_out | deadline_reached | unchanged | none (idempotent) |
| anything else | — | throws `IllegalTransition` | — |

- [ ] **Step 1: Write the failing test** `tests/core/campaign.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { fansCommitted, IllegalTransition, initialCampaign, reduce, type Campaign, type CampaignEvent } from "../../src/core/campaign";

const DEADLINE = Date.UTC(2026, 10, 19, 2, 0, 0);

function run(events: CampaignEvent[], start: Campaign = initialCampaign()) {
  let c = start;
  const effects: string[] = [];
  for (const e of events) {
    const step = reduce(c, e);
    c = step.campaign;
    effects.push(...step.effects.map((x) => x.type));
  }
  return { c, effects };
}

const signed: CampaignEvent = { type: "mandate_signed", threshold: 3, deadline: DEADLINE };
const held: CampaignEvent = { type: "pledge_held" };

describe("campaign reducer", () => {
  it("goes live when the mandate is signed", () => {
    expect(run([signed]).c.state).toBe("live");
  });
  it("tips on the pledge that reaches the target and asks to capture every hold", () => {
    const { c, effects } = run([signed, held, held, held]);
    expect(c.state).toBe("tipped");
    expect(c.pledges.held).toBe(3);
    expect(effects).toEqual(["capture_all_held"]);
  });
  it("captures late pledges on arrival once tipped", () => {
    const { effects } = run([signed, held, held, held, held]);
    expect(effects).toEqual(["capture_all_held", "capture_new_pledge"]);
  });
  it("moves held to charged as captures succeed", () => {
    const { c } = run([signed, held, held, held, { type: "pledge_charged" }, { type: "pledge_charged" }]);
    expect(c.pledges).toEqual({ held: 1, charged: 2, released: 0, refunded: 0 });
    expect(fansCommitted(c)).toBe(3);
  });
  it("misses at the deadline below target, voids every hold, and is idempotent", () => {
    const { c, effects } = run([signed, held, { type: "deadline_reached", now: DEADLINE }, { type: "deadline_reached", now: DEADLINE + 1 }]);
    expect(c.state).toBe("missed");
    expect(effects).toEqual(["void_all_held"]);
    const after = reduce(c, { type: "holds_released", count: 1 }).campaign;
    expect(after.pledges).toEqual({ held: 0, charged: 0, released: 1, refunded: 0 });
  });
  it("pays out at the deadline after tipping, then settles", () => {
    const { c, effects } = run([signed, held, held, held, { type: "deadline_reached", now: DEADLINE }, { type: "payouts_sent" }]);
    expect(effects).toEqual(["capture_all_held", "send_payouts"]);
    expect(c.state).toBe("settled");
  });
  it("allows exactly one extension, only while live", () => {
    const once = run([signed, { type: "deadline_extended", newDeadline: DEADLINE + 1000 }]).c;
    expect(once.deadline).toBe(DEADLINE + 1000);
    expect(once.extensionsUsed).toBe(1);
    expect(() => reduce(once, { type: "deadline_extended", newDeadline: DEADLINE + 2000 })).toThrow(IllegalTransition);
    expect(() => reduce(once, { type: "deadline_extended", newDeadline: DEADLINE })).toThrow(IllegalTransition);
  });
  it("cancelling after tipping voids open holds and refunds charges", () => {
    const { c, effects } = run([signed, held, held, held, { type: "show_cancelled" }]);
    expect(c.state).toBe("cancelled");
    expect(effects).toEqual(["capture_all_held", "void_all_held", "refund_all_charged"]);
  });
  it("rejects pledges after the deadline and charges with nothing held", () => {
    const missed = run([signed, { type: "deadline_reached", now: DEADLINE }]).c;
    expect(() => reduce(missed, held)).toThrow(IllegalTransition);
    expect(() => reduce(run([signed]).c, { type: "pledge_charged" })).toThrow(IllegalTransition);
    expect(() => reduce(initialCampaign(), held)).toThrow(IllegalTransition);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core/campaign.test.ts`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 3: Implement** `src/core/campaign.ts`

```ts
export type CampaignState = "draft" | "live" | "tipped" | "paying_out" | "settled" | "missed" | "cancelled";

export interface PledgeCounts {
  held: number;
  charged: number;
  released: number;
  refunded: number;
}

export interface Campaign {
  state: CampaignState;
  threshold: number;
  /** Epoch ms when pledging closes. */
  deadline: number;
  pledges: PledgeCounts;
  extensionsUsed: number;
}

export type CampaignEvent =
  | { type: "mandate_signed"; threshold: number; deadline: number }
  | { type: "pledge_held" }
  | { type: "pledge_charged" }
  | { type: "deadline_reached"; now: number }
  | { type: "payouts_sent" }
  | { type: "holds_released"; count: number }
  | { type: "deadline_extended"; newDeadline: number }
  | { type: "show_cancelled" }
  | { type: "refunds_sent"; count: number };

export type Effect =
  | { type: "capture_all_held" }
  | { type: "capture_new_pledge" }
  | { type: "void_all_held" }
  | { type: "send_payouts" }
  | { type: "refund_all_charged" };

export interface Step {
  campaign: Campaign;
  effects: Effect[];
}

export class IllegalTransition extends Error {
  constructor(state: CampaignState, event: CampaignEvent["type"], why = "not allowed") {
    super(`Cannot apply ${event} while ${state}: ${why}`);
    this.name = "IllegalTransition";
  }
}

export function initialCampaign(): Campaign {
  return { state: "draft", threshold: 0, deadline: 0, pledges: { held: 0, charged: 0, released: 0, refunded: 0 }, extensionsUsed: 0 };
}

export function fansCommitted(c: Campaign): number {
  return c.pledges.held + c.pledges.charged;
}

const FINAL_OR_PAYING: CampaignState[] = ["missed", "settled", "cancelled", "paying_out"];

export function reduce(c: Campaign, e: CampaignEvent): Step {
  const same = (campaign: Campaign, effects: Effect[] = []): Step => ({ campaign, effects });
  const p = c.pledges;
  switch (e.type) {
    case "mandate_signed":
      if (c.state !== "draft") throw new IllegalTransition(c.state, e.type);
      return same({ ...c, state: "live", threshold: e.threshold, deadline: e.deadline });

    case "pledge_held": {
      if (c.state !== "live" && c.state !== "tipped") throw new IllegalTransition(c.state, e.type, "pledging is closed");
      const next = { ...c, pledges: { ...p, held: p.held + 1 } };
      if (c.state === "tipped") return same(next, [{ type: "capture_new_pledge" }]);
      if (fansCommitted(next) >= c.threshold) return same({ ...next, state: "tipped" }, [{ type: "capture_all_held" }]);
      return same(next);
    }

    case "pledge_charged":
      if (!["live", "tipped", "paying_out"].includes(c.state)) throw new IllegalTransition(c.state, e.type);
      if (p.held <= 0) throw new IllegalTransition(c.state, e.type, "no hold to charge");
      return same({ ...c, pledges: { ...p, held: p.held - 1, charged: p.charged + 1 } });

    case "deadline_reached":
      if (FINAL_OR_PAYING.includes(c.state)) return same(c);
      if (c.state === "live") return same({ ...c, state: "missed" }, [{ type: "void_all_held" }]);
      if (c.state === "tipped") return same({ ...c, state: "paying_out" }, [{ type: "send_payouts" }]);
      throw new IllegalTransition(c.state, e.type);

    case "payouts_sent":
      if (c.state !== "paying_out") throw new IllegalTransition(c.state, e.type);
      return same({ ...c, state: "settled" });

    case "holds_released":
      if (c.state !== "missed" && c.state !== "cancelled") throw new IllegalTransition(c.state, e.type);
      if (e.count < 0 || e.count > p.held) throw new IllegalTransition(c.state, e.type, "count out of range");
      return same({ ...c, pledges: { ...p, held: p.held - e.count, released: p.released + e.count } });

    case "deadline_extended":
      if (c.state !== "live") throw new IllegalTransition(c.state, e.type);
      if (c.extensionsUsed >= 1) throw new IllegalTransition(c.state, e.type, "only one extension is allowed");
      if (e.newDeadline <= c.deadline) throw new IllegalTransition(c.state, e.type, "an extension must move the deadline later");
      return same({ ...c, deadline: e.newDeadline, extensionsUsed: c.extensionsUsed + 1 });

    case "show_cancelled":
      if (c.state !== "tipped") throw new IllegalTransition(c.state, e.type);
      return same({ ...c, state: "cancelled" }, [{ type: "void_all_held" }, { type: "refund_all_charged" }]);

    case "refunds_sent":
      if (c.state !== "cancelled") throw new IllegalTransition(c.state, e.type);
      if (e.count < 0 || e.count > p.charged) throw new IllegalTransition(c.state, e.type, "count out of range");
      return same({ ...c, pledges: { ...p, charged: p.charged - e.count, refunded: p.refunded + e.count } });
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/core/campaign.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/campaign.ts tests/core/campaign.test.ts
git commit -m "feat(core): campaign state machine with tip, miss, payout and cancel paths

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Rule guard + plain-English rules + core barrel

**Files:**
- Create: `src/core/rules.ts`, `src/core/guard.ts`, `src/core/index.ts`
- Test: `tests/core/guard.test.ts`

**Interfaces:**
- Consumes: `Mandate` (mandate.ts), `Campaign`, `fansCommitted` (campaign.ts), `PayoutLine`, `splitPayout`, `fixedTotal` (split.ts), `Cents`, `DAY_MS`, `MAX_CAMPAIGN_DAYS`, `MAX_EXTENSION_DAYS` (holds.ts).
- Produces:
  - `type RuleId = "rule-1-hold-only" | "rule-2-capture-at-tip" | "rule-3-void-on-miss" | "rule-4-pay-the-split" | "rule-5-ask-first"`
  - `RULES: Record<RuleId, { number: 1|2|3|4|5; title: string }>`
  - `type AgentAction` (union below)
  - `interface GuardContext { mandate: Mandate; campaign: Campaign; approvals: ReadonlySet<string>; collectedNet: Cents }`
  - `interface GuardDecision { allowed: boolean; needsApproval: boolean; rule: RuleId; reason: string; approvalKey?: string }`
  - `approvalKeyFor(action: AgentAction): string | undefined`
  - `guard(action: AgentAction, ctx: GuardContext): GuardDecision`
  - `src/core/index.ts` re-exports every public name from money, holds, threshold, split, mandate, campaign, rules, guard.

- [ ] **Step 1: Write the failing test** `tests/core/guard.test.ts`

```ts
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildMandate, type MandateDraft } from "../../src/core/mandate";
import { initialCampaign, reduce, type Campaign } from "../../src/core/campaign";
import { splitPayout } from "../../src/core/split";
import { approvalKeyFor, guard, RULES, type AgentAction, type GuardContext } from "../../src/core/guard";
import { DAY_MS } from "../../src/core/holds";

const draft: MandateDraft = {
  showId: "s1", showName: "Juniper Vale", roomName: "Spindle Records", showDate: "2026-11-20",
  ticketPrice: 1500, feeBufferBps: 500,
  parties: [
    { role: "room", label: "Spindle Records", paypalEmail: "room@example.com", fixed: 8000 },
    { role: "opener", label: "The Low Tides", paypalEmail: "opener@example.com", fixed: 10000 },
    { role: "artist", label: "Juniper Vale", paypalEmail: "artist@example.com", minimum: 30000 },
  ],
  launchedAt: "2026-11-04T18:00:00.000Z", deadline: "2026-11-19T02:00:00.000Z",
};
const mandate = buildMandate(draft);
const deadline = Date.parse(draft.deadline);
const launched = Date.parse(draft.launchedAt);

function campaignIn(state: Campaign["state"], held = 0, charged = 0): Campaign {
  const base = reduce(initialCampaign(), { type: "mandate_signed", threshold: mandate.threshold, deadline }).campaign;
  return { ...base, state, pledges: { held, charged, released: 0, refunded: 0 } };
}
const ctx = (campaign: Campaign, extra: Partial<GuardContext> = {}): GuardContext => ({ mandate, campaign, approvals: new Set(), collectedNet: 0, ...extra });

describe("RULES", () => {
  it("has five plain-English rules", () => {
    expect(Object.values(RULES).map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);
    expect(RULES["rule-2-capture-at-tip"].title).toBe("When the target is reached, charge every hold.");
  });
});

describe("guard", () => {
  it("only captures once the show has tipped", () => {
    expect(guard({ kind: "capture_all_held" }, ctx(campaignIn("live", 20))).allowed).toBe(false);
    const ok = guard({ kind: "capture_all_held" }, ctx(campaignIn("tipped", 34)));
    expect(ok).toMatchObject({ allowed: true, needsApproval: false, rule: "rule-2-capture-at-tip" });
  });
  it("only voids after a miss or a cancellation", () => {
    expect(guard({ kind: "void_all_held" }, ctx(campaignIn("live", 20))).allowed).toBe(false);
    expect(guard({ kind: "void_all_held" }, ctx(campaignIn("missed", 20))).rule).toBe("rule-3-void-on-miss");
    expect(guard({ kind: "void_all_held" }, ctx(campaignIn("missed", 20))).allowed).toBe(true);
  });
  it("pays out only the exact signed split, only while paying out", () => {
    const collectedNet = 51000;
    const lines = splitPayout(collectedNet, mandate.parties).lines;
    expect(guard({ kind: "send_payouts", lines }, ctx(campaignIn("paying_out", 0, 34), { collectedNet })).allowed).toBe(true);
    const greedy = lines.map((l) => (l.role === "artist" ? { ...l, amount: l.amount + 1 } : l));
    const d = guard({ kind: "send_payouts", lines: greedy }, ctx(campaignIn("paying_out", 0, 34), { collectedNet }));
    expect(d).toMatchObject({ allowed: false, rule: "rule-4-pay-the-split" });
    expect(guard({ kind: "send_payouts", lines }, ctx(campaignIn("tipped", 34), { collectedNet })).allowed).toBe(false);
  });
  it("asks first when the money falls short of the signed minimums", () => {
    const collectedNet = 40000;
    const lines = splitPayout(collectedNet, mandate.parties).lines;
    const d = guard({ kind: "send_payouts", lines }, ctx(campaignIn("paying_out", 0, 34), { collectedNet }));
    expect(d).toMatchObject({ allowed: false, needsApproval: true, rule: "rule-5-ask-first", approvalKey: "payout-shortfall" });
    const approved = guard({ kind: "send_payouts", lines }, ctx(campaignIn("paying_out", 0, 34), { collectedNet, approvals: new Set(["payout-shortfall"]) }));
    expect(approved.allowed).toBe(true);
  });
  it("needs approval to extend, then allows one extension within 7 days and the 21-day window", () => {
    const action: AgentAction = { kind: "extend_deadline", newDeadline: deadline + 4 * DAY_MS };
    const key = approvalKeyFor(action) as string;
    expect(guard(action, ctx(campaignIn("live", 19)))).toMatchObject({ allowed: false, needsApproval: true, approvalKey: key });
    expect(guard(action, ctx(campaignIn("live", 19), { approvals: new Set([key]) })).allowed).toBe(true);
    const tooFar: AgentAction = { kind: "extend_deadline", newDeadline: deadline + 8 * DAY_MS };
    expect(guard(tooFar, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(tooFar) as string]) })).allowed).toBe(false);
    const pastWindow: AgentAction = { kind: "extend_deadline", newDeadline: launched + 22 * DAY_MS };
    expect(guard(pastWindow, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(pastWindow) as string]) })).allowed).toBe(false);
  });
  it("needs approval to lower the target and never below what covers fixed costs", () => {
    const ok: AgentAction = { kind: "lower_threshold", newThreshold: 30 };
    expect(guard(ok, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(ok) as string]) })).allowed).toBe(true);
    const tooLow: AgentAction = { kind: "lower_threshold", newThreshold: 11 };
    expect(guard(tooLow, ctx(campaignIn("live", 19), { approvals: new Set([approvalKeyFor(tooLow) as string]) })).allowed).toBe(false);
  });
  it("reauthorizes holds without asking while a show is open", () => {
    expect(guard({ kind: "reauthorize" }, ctx(campaignIn("tipped", 34))).allowed).toBe(true);
    expect(guard({ kind: "reauthorize" }, ctx(campaignIn("missed", 3))).allowed).toBe(false);
  });
  it("never allows a capture before the target or a void before a miss (property)", () => {
    const states: Campaign["state"][] = ["draft", "live", "tipped", "paying_out", "settled", "missed", "cancelled"];
    fc.assert(
      fc.property(fc.constantFrom(...states), fc.integer({ min: 0, max: 80 }), (state, held) => {
        const c = campaignIn(state, held);
        if (guard({ kind: "capture_all_held" }, ctx(c)).allowed) expect(c.state).toBe("tipped");
        if (guard({ kind: "capture_new_pledge" }, ctx(c)).allowed) expect(c.state).toBe("tipped");
        if (guard({ kind: "void_all_held" }, ctx(c)).allowed) expect(["missed", "cancelled"]).toContain(c.state);
      }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core/guard.test.ts`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 3: Implement**

`src/core/rules.ts`:
```ts
export type RuleId = "rule-1-hold-only" | "rule-2-capture-at-tip" | "rule-3-void-on-miss" | "rule-4-pay-the-split" | "rule-5-ask-first";

export const RULES: Record<RuleId, { number: 1 | 2 | 3 | 4 | 5; title: string }> = {
  "rule-1-hold-only": { number: 1, title: "Fans are only held, never charged, until the target is reached." },
  "rule-2-capture-at-tip": { number: 2, title: "When the target is reached, charge every hold." },
  "rule-3-void-on-miss": { number: 3, title: "If the deadline passes below the target, cancel every hold." },
  "rule-4-pay-the-split": { number: 4, title: "Pay everyone exactly the split you signed." },
  "rule-5-ask-first": { number: 5, title: "Ask the artist first before changing the deadline or the target, or refunding." },
};
```

`src/core/guard.ts`:
```ts
import type { Cents } from "./money";
import type { Mandate } from "./mandate";
import type { Campaign } from "./campaign";
import { DAY_MS, MAX_CAMPAIGN_DAYS, MAX_EXTENSION_DAYS } from "./holds";
import { fixedTotal, splitPayout, type PayoutLine } from "./split";
import type { RuleId } from "./rules";

export { RULES, type RuleId } from "./rules";

export type AgentAction =
  | { kind: "capture_all_held" }
  | { kind: "capture_new_pledge" }
  | { kind: "void_all_held" }
  | { kind: "reauthorize" }
  | { kind: "send_payouts"; lines: PayoutLine[] }
  | { kind: "extend_deadline"; newDeadline: number }
  | { kind: "lower_threshold"; newThreshold: number }
  | { kind: "refund_all_charged" };

export interface GuardContext {
  mandate: Mandate;
  campaign: Campaign;
  /** Approval keys the artist has granted (see approvalKeyFor). */
  approvals: ReadonlySet<string>;
  /** Money actually received after PayPal fees, in cents. */
  collectedNet: Cents;
}

export interface GuardDecision {
  allowed: boolean;
  needsApproval: boolean;
  rule: RuleId;
  reason: string;
  approvalKey?: string;
}

export function approvalKeyFor(action: AgentAction): string | undefined {
  switch (action.kind) {
    case "extend_deadline":
      return `extend:${action.newDeadline}`;
    case "lower_threshold":
      return `lower:${action.newThreshold}`;
    case "refund_all_charged":
      return "refund";
    default:
      return undefined;
  }
}

const allow = (rule: RuleId, reason: string): GuardDecision => ({ allowed: true, needsApproval: false, rule, reason });
const deny = (rule: RuleId, reason: string): GuardDecision => ({ allowed: false, needsApproval: false, rule, reason });
const ask = (key: string, reason: string): GuardDecision => ({ allowed: false, needsApproval: true, rule: "rule-5-ask-first", reason, approvalKey: key });

function sameLines(a: PayoutLine[], b: PayoutLine[]): boolean {
  return a.length === b.length && a.every((l, i) => l.role === b[i].role && l.paypalEmail === b[i].paypalEmail && l.amount === b[i].amount);
}

export function guard(action: AgentAction, ctx: GuardContext): GuardDecision {
  const { campaign: c, mandate: m, approvals } = ctx;
  switch (action.kind) {
    case "capture_all_held":
    case "capture_new_pledge":
      return c.state === "tipped"
        ? allow("rule-2-capture-at-tip", "The target is reached, so every hold is charged.")
        : deny("rule-1-hold-only", "The target isn't reached, so fans stay on hold.");

    case "void_all_held":
      return c.state === "missed" || c.state === "cancelled"
        ? allow("rule-3-void-on-miss", "The show didn't happen, so every hold is cancelled.")
        : deny("rule-3-void-on-miss", "Holds are only cancelled after a miss or a cancellation.");

    case "reauthorize":
      return ["live", "tipped", "paying_out"].includes(c.state)
        ? allow("rule-1-hold-only", "Refreshing holds keeps them valid; nobody is charged.")
        : deny("rule-1-hold-only", "This show has no open holds to refresh.");

    case "send_payouts": {
      if (c.state !== "paying_out") return deny("rule-4-pay-the-split", "Payouts happen only after the deadline of a show that tipped.");
      const expected = splitPayout(ctx.collectedNet, m.parties);
      if (!sameLines(action.lines, expected.lines)) return deny("rule-4-pay-the-split", "These payouts don't match the signed split.");
      if (expected.shortfall > 0 && !approvals.has("payout-shortfall")) {
        return ask("payout-shortfall", "The money is short of the signed amounts, so the artist decides.");
      }
      return allow("rule-4-pay-the-split", "Paying everyone the split the artist signed.");
    }

    case "extend_deadline": {
      const key = approvalKeyFor(action) as string;
      if (c.state !== "live") return deny("rule-5-ask-first", "Only an open show can be extended.");
      if (c.extensionsUsed >= m.maxExtensions) return deny("rule-5-ask-first", "The one allowed extension is already used.");
      if (action.newDeadline <= c.deadline) return deny("rule-5-ask-first", "An extension must move the deadline later.");
      if (action.newDeadline - c.deadline > MAX_EXTENSION_DAYS * DAY_MS) return deny("rule-5-ask-first", "An extension can add at most 7 days.");
      if (action.newDeadline - Date.parse(m.launchedAt) > MAX_CAMPAIGN_DAYS * DAY_MS) {
        return deny("rule-5-ask-first", "Holds can't be kept longer than 21 days in total.");
      }
      return approvals.has(key) ? allow("rule-5-ask-first", "The artist approved this extension.") : ask(key, "Extending the deadline needs the artist's OK.");
    }

    case "lower_threshold": {
      const key = approvalKeyFor(action) as string;
      if (c.state !== "live") return deny("rule-5-ask-first", "Only an open show's target can change.");
      if (action.newThreshold >= c.threshold || action.newThreshold < 1) return deny("rule-5-ask-first", "A new target must be lower and at least 1.");
      if (action.newThreshold * m.ticketPrice < fixedTotal(m.parties)) {
        return deny("rule-5-ask-first", "That target wouldn't cover the room and the other fixed costs.");
      }
      return approvals.has(key) ? allow("rule-5-ask-first", "The artist approved the lower target.") : ask(key, "Lowering the target needs the artist's OK.");
    }

    case "refund_all_charged": {
      if (c.state !== "cancelled") return deny("rule-5-ask-first", "Refunds happen only when a show is called off.");
      return approvals.has("refund") ? allow("rule-5-ask-first", "The artist called the show off, so everyone is refunded.") : ask("refund", "Refunding needs the artist's OK.");
    }
  }
}
```

`src/core/index.ts`:
```ts
export * from "./money";
export * from "./holds";
export * from "./threshold";
export * from "./split";
export * from "./mandate";
export * from "./campaign";
export * from "./rules";
export { approvalKeyFor, guard, type AgentAction, type GuardContext, type GuardDecision } from "./guard";
```

- [ ] **Step 4: Run the whole suite and all checks**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck and lint clean. Vitest: all core tests pass (about 44 across 8 files).

- [ ] **Step 5: Commit**

```bash
git add src/core/rules.ts src/core/guard.ts src/core/index.ts tests/core/guard.test.ts
git commit -m "feat(core): rule guard for every agent money action, with plain-English rules

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes (controller)

- **Spec coverage:**
  - 3 (campaign flow: draft → live → tipped → paid; missed; cancelled) → Task 6
  - 3.2 (mandate frozen with a hash) → Task 5
  - 3.5 (capture at tip; reauthorize) → Tasks 2 and 7
  - 6.2 (29 days / 3 days / 21-day window / idempotency) → Tasks 2, 5 and 6
  - 2c (plain-English rule titles) → Task 7
  - 8 (shortfall pauses the payout and asks the artist) → Tasks 4 and 7
- **Out of this plan:** PayPal I/O (Plan 3), agent runtime (Plan 4), UI (Plans 2 and 5).

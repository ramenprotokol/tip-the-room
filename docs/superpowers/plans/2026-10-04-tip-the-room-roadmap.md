# Tip the Room — build roadmap

Spec: `docs/superpowers/specs/2026-10-03-tip-the-room-design.md`. Deadline: PayPal AI Hackathon, **2026-11-12 12:00 PT**. Target: feature-complete Nov 1, submit Nov 10.

**Who builds what:**
- **Implementers:** Sonnet 5.5 subagents, one task each.
- **Opus** reviews every task (spec compliance, then code quality). It takes over any task where Sonnet's output is wrong twice or where the visual result doesn't match the reference.
- **Visual source of truth:** `reference/v2/`, the Marquee reference pack. The app must match it exactly (visual parity tests).

| Plan | What it delivers | Depends on | Status |
|---|---|---|---|
| 1 · Foundation + money core | Repo scaffold (Vite, TS, Vitest, ESLint, CI). Pure-TS money rules: cents, fan target, payout split, hold timing, mandate build/validate/sign, campaign state machine, rule guard with property tests | none | **done** (merged 0f055b6) |
| 2 · Marquee port + visual parity | `reference/v2` ported into `src/web/` as TS modules: shared WebGL renderer, demo page `/` running fully client-side, Playwright fake-clock parity tests against the reference | reference pack v2 (done, 007963c), Plan 1 | **done** (merged 0938522; 39 GPU tests: pixel + text parity, prod parity, fallbacks) |
| 3 · PayPal sandbox | Day-1 spikes: authorize, capture, void, reauthorize, Payouts toggle, simulated-fan method, agent toolkit on Workers. Then the PayPal REST client with idempotency, webhooks with signature verification, and a sandbox integration script | owner's sandbox app credentials in `.dev.vars` | **done** (merged; 250 unit tests, live `sandbox:check` 11/11 on a US sandbox account; agent toolkit NO-GO on Workers → REST client) |
| 4 · Agent runtime | Cloudflare Worker API. Campaign agent as a Durable Object (Agents SDK, alarms). D1 ledger. Workers AI for the sentence-to-draft step, pace proposals and plain-English notes, with a hard daily budget and template fallback | Plans 1, 3 | **done** (merged; 565 unit tests; live `worker:check` 19/19 against the sandbox; plain Durable Objects + SQLite instead of Agents SDK + D1) |
| 5 · Product surfaces | `/start` (artist: describe → draft → hold-to-sign → share link + QR), `/s/:id` (fan pledge with the real PayPal button), `/s/:id/manage` (artist: marquee, proposals, AG Grid ledger themed to the reference, agent log). Demo page wired to real sandbox calls | Plans 2, 3, 4 | |
| 6 · Ship | Cloudflare deploy via `ramen-deploy.sh`, privacy gate (`/privacyramen`), README (sources, Qloo-free, production path), build log crediting models (no session IDs), voice-free video under 3 min, Devpost submission | Plans 1–5 | |

Spike findings: `docs/superpowers/spikes/2026-10-05-paypal-sandbox.md`. Plan 4 must start from the PLAN 4 REQUIREMENTS in the progress ledger (`.git/sdd/progress.md`).

# Tip the Room — design

_Working name. Status: draft for owner review, 2026-10-03._

## 1. What it is

A settlement agent for small DIY shows (house concerts, record-store and café gigs, 25–80 people).

Fans pledge with a **PayPal hold, not a charge**. The show only happens, and nobody pays, unless enough fans commit by the deadline. The artist signs the money rules once (threshold, deadline, who gets paid what). From then on the agent watches the campaign, proposes fixes when it's behind, and at the right moment settles everything on its own: capture the holds and pay everyone out, or void every hold.

**Tagline:** "Nobody's charged unless the show happens."

**Built for:** the PayPal AI Hackathon (deadline 2026-11-12, 12:00 PT). PayPal sandbox only; no live money.

## 2. Who it's for and why

- **Artist / host (the organiser).** Small shows die on risk. Someone has to front the room fee or guarantee, and nobody knows if 15 or 50 people will turn up. Side Door, the platform that ran 3,300+ house and bookstore shows, shut down at the end of 2025. Most independent acts lose money on the road (a 2024 survey of 1,700 acts: 72% made no profit on their last tour).
- **Fan.** Wants to back a show without risking money on one that gets cancelled. A hold that is released if the show doesn't happen is the honest answer.
- **The proven mechanic.** "Only happens if enough people commit" already works for film screenings (Gathr). Nobody has paired it with an agent that settles the money itself under rules the artist signed.

Sources for the facts above are listed in the README when it is written; every figure must link to its source.

## 3. How a campaign works

```
draft ──approve mandate──▶ live ──threshold reached──▶ tipped ──payouts sent──▶ settled
                             │                            │
                             │ deadline passes, short     │ show cancelled (human confirms)
                             ▼                            ▼
                          missed ──holds voided──▶ closed   refunded
```

1. **Draft.** The artist describes the show in one sentence, e.g. "Acoustic set at a record shop, Nov 20, 40 people max, $15 a ticket. I need $300, the opener gets $100, the room wants $80." The AI turns that into a structured draft. **Code, not the model**, computes the threshold:
   `threshold_pledges = ceil((room + opener + host + artist_minimum) × (1 + fee_buffer) / ticket_price)`, where `fee_buffer` covers PayPal's fees (default 5%, editable).
   The artist edits or confirms every field.
2. **Mandate.** The artist approves the **mandate**: threshold, deadline, the payout split (fixed amounts paid in order room → opener → host, with the artist getting the rest and at least their minimum), and what the agent may do on its own. The mandate is frozen as JSON with a hash and shown on the pledge page.
   - Agent may, without asking: capture all holds when the threshold is met; void all holds at a missed deadline; reauthorize holds; send the payout batch exactly as the split says.
   - Agent must ask first: extend the deadline (at most once, at most 7 days, never past 21 days from launch); lower the threshold or price; refund after capture (show cancelled).
3. **Live.** Fans pledge on a public page with the PayPal button (Orders v2, `intent: AUTHORIZE`). Each pledge becomes a hold.
4. **Watching.** At 50% of the campaign window and at 72 hours before the deadline, the agent checks pace. Code projects the final count; the model explains it and proposes options, e.g. "40% with 3 days left. Extend 4 days, or lower the target to 22?" The artist approves or ignores.
5. **Tipped.** The moment the threshold is met, the agent captures every hold (reauthorizing any hold past the 3-day honor period first). Pledges after tipping are captured immediately. Then it sends one Payouts batch per the split.
6. **Missed.** At the deadline, if short, the agent voids every hold. "Nobody paid for a show that didn't happen."
7. **Cancelled after tipping.** The agent prepares refunds; the artist confirms; refunds go out.

**The rule that makes this trustworthy: the model proposes, the mandate decides.** Every money action goes through a guard in plain code that checks it against the frozen mandate. The model can choose and explain actions; it can never move money outside the mandate.

## 4. What the judge sees

- **Landing:** the tagline, a 3-step explainer, and "Try it as a judge".
- **Judge mode** creates a private demo with two seeded campaigns side by side (fictional artists and rooms; no real business names). Each visitor gets their own copy, so judges never collide. Copies expire after 24 hours.
  - The judge pledges on one campaign with the **real sandbox PayPal popup**, using sandbox buyer credentials printed on the page. The ledger shows "held, not charged".
  - "Add 20 fans" fills the campaign with simulated pledges (see 6.3).
  - "Fast-forward to deadline": campaign A tips (captures stream in, the payout batch goes out, real sandbox IDs appear in the ledger); campaign B misses (every hold voided).
  - "Reset" starts over.
- **Agent trace panel:** every step the agent took, in order: what it saw, what it proposed or did, which mandate rule allowed it, and the PayPal request and result IDs.
- **Settlement ledger (AG Grid):** pledges, holds, reauthorizations, captures, voids, payouts and refunds with status, amounts and PayPal IDs. Sort, filter, CSV export. This is the "settlement sheet" an artist actually needs after a show.

## 5. AI's role

AI does the language work; code does the money work.

| Job | Who does it |
|---|---|
| Turn the artist's sentence into a campaign draft | Model (JSON schema), artist confirms |
| Threshold, projections, split amounts | Code |
| Pace check: explain the situation, propose options | Model, from numbers code computed |
| Decide capture / void / reauthorize / payout | Code-guarded tools; the model can call them only when the mandate allows |
| Plain-English settlement statement for each party | Model, with a fixed template fallback |

Model: Cloudflare Workers AI (free tier: 10,000 neurons/day). Llama 3.3 70B for proposals, a smaller model for extraction. Hard daily budget with caching. If the budget runs out, the agent shows "resting until 00:00 UTC" and falls back to templates. **No money flow ever depends on the model being available.**

## 6. PayPal integration

### 6.1 APIs used (sandbox)
- **Pledge:** JS SDK v6 button → Orders v2 `intent: AUTHORIZE` → server calls `/v2/checkout/orders/{id}/authorize`. Store authorization ID, amount and created time.
- **Capture:** `/v2/payments/authorizations/{id}/capture`. **Void:** `/v2/payments/authorizations/{id}/void`. **Reauthorize:** `/v2/payments/authorizations/{id}/reauthorize`.
- **Payouts:** `/v1/payments/payouts`, one batch per settlement, to sandbox accounts for artist, opener and host.
- **Refunds:** `/v2/payments/captures/{id}/refund`.
- **Webhooks:** authorization, capture, void, refund and payout-batch events update the ledger; signatures are verified.
- **PayPal Agent Toolkit** (`@paypal/agent-toolkit`) for the tools it covers (get_order, create_refund, list_transactions), if it runs on Workers. Authorize, void, reauthorize and payouts are thin REST wrappers exposed as agent tools with the same mandate guard.

### 6.2 Hold timing
- A hold lasts 29 days, and capture is only guaranteed in the first 3 days (the honor period).
- So a campaign window is **at most 21 days**. The agent captures **at tipping, not on show night**, and reauthorizes any hold older than 3 days immediately before capturing.
- Every money call sends a `PayPal-Request-Id` so retries can't double-charge or double-pay.

### 6.3 Simulated fans (day-1 spike decides which)
In order of preference:
1. Server-side card authorizations with PayPal's sandbox test cards, if a fresh sandbox account allows it.
2. A few sandbox buyer wallets vaulted once by us, reused to create real holds without a login.
3. If neither works: simulated pledges are clearly labelled "simulated" rows with no PayPal IDs. The judge's own pledge is still a real hold.

**Never fake a PayPal ID.**

### 6.4 Production path (README only, not built)
Real artists would be onboarded through PayPal's multiparty platform so money goes straight to them, with the platform fee set per order. Marketplace and payment-facilitator flows need PayPal approval in production. The demo is sandbox-only, and the README says so.

## 7. Architecture (all free tier)

- **Front end:** React + Vite + TypeScript on Cloudflare Pages. AG Grid Community for the ledger.
- **API:** Cloudflare Worker.
- **Campaign agent:** Cloudflare Agents SDK, one Durable Object (SQLite-backed) per campaign. Alarms for the pace checks and the deadline; no cron triggers.
- **Ledger and campaigns:** Cloudflare D1 (append-only ledger events). No pledge state in KV (its free tier allows only 1,000 writes a day).
- **Model:** Workers AI.
- **Secrets:** PayPal sandbox client ID and secret as Worker secrets; `.dev.vars` locally (gitignored).

**Units, each testable alone:**
- `mandate` — the schema, freezing and hashing, and the `guard(action, campaign)` check.
- `money` — PayPal REST client with idempotency, retries and error mapping.
- `campaign` — the state machine above, with pure transition functions.
- `agent` — the tool definitions, prompts, budget and template fallbacks.
- `ledger` — event writes and reads in D1.
- `webhooks` — signature verification and mapping events to ledger events.
- `demo` — judge-mode seeding, the per-visitor copies, fast-forward, reset, and re-seeding holds before they expire.
- `web` — landing, pledge page, organiser dashboard, trace panel and AG Grid ledger.

## 8. Errors and edge cases

- **Some captures fail at tipping:** settle on what was actually captured. If that no longer covers room + opener + host, pause the payout and ask the artist.
- **Payout item fails:** mark it, retry once, then surface it to the artist. Never re-send a batch without the idempotency key.
- **Webhook arrives twice or out of order:** ledger events are keyed by PayPal event ID, so duplicates are ignored. State is rebuilt from the events.
- **The deadline alarm fires late:** the deadline check is idempotent and safe to run again.
- **Model budget is used up:** templates take over (see 5).
- **Demo holds near 29 days during judging (Dec 1–15):** an alarm re-seeds the demo campaigns before their holds expire.
- **Abuse of the public demo:** per-visitor rate limits, a cap on simulated fans per demo, and nothing outside sandbox.

## 9. Testing

- **Unit:**
  - Threshold and split maths.
  - Mandate guard: property tests that no generated action outside the mandate is ever allowed.
  - Campaign state machine: every transition, including illegal ones.
  - Webhook mapping.
- **Sandbox integration:** a scripted run of authorize → reauthorize → capture → payout → refund, and authorize → void, against the PayPal sandbox.
- **End to end:** Playwright against the deployed site: the full judge flow on both campaigns, including the real sandbox popup.
- **Release gate:** Ramen privacy check before every push. The live judge flow must be green on the deployed URL before submitting.

## 10. Day-1 spikes (go / no-go before building on them)

1. Sandbox: authorize, capture, void and reauthorize work on a fresh business account. Find out whether reauthorizing more than once is allowed (PayPal's docs disagree).
2. Sandbox Payouts works after switching it on in the app settings.
3. Which simulated-fan method from 6.3 works.
4. Agents SDK with alarms runs on the Cloudflare free plan.
5. Workers AI 70B tool calling, and its real neuron cost per agent turn.
6. `@paypal/agent-toolkit` runs on Workers (`nodejs_compat`); if not, use REST only.

## 11. Out of scope

Qloo or any taste data, multi-city routing, opener ranking, maps, artist accounts and logins (the demo uses per-visitor campaigns), live money, real PayPal onboarding, mobile apps, emails or SMS to fans.

## 12. Submission checklist (PayPal AI Hackathon)

- Public repo `ramenprotokol/tip-the-room` with an MIT license visible in the repo's About box.
- Hosted demo on Cloudflare Pages that stays up through judging (Dec 1–15).
- README: what it does, how to run it, sandbox buyer credentials for judges, the production path (6.4), and sources for every claim.
- YouTube video under 3 minutes. No voice; captions only. No copyrighted music. Shows the full flow working.
- Text description naming the tools used (PayPal Orders, Authorizations, Payouts, Webhooks, Agent Toolkit if used; Workers AI; AG Grid).
- A build log crediting which model wrote what, with no session IDs.
- **Dates:** feature-complete by Nov 1; video and README Nov 2–9; submit by Nov 10, two days before the deadline.

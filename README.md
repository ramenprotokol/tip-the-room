# Tip the Room

**Nobody's charged unless the show happens.**

Tip the Room is a settlement agent for small DIY shows: house concerts, record-store and café gigs for 25 to 80 people. Fans hold a spot with a **PayPal hold, not a charge**. The artist signs the money rules once: how many fans are needed by when, and who gets paid what. From then on an agent watches the show. If enough fans join by the deadline, it charges every hold and pays the room, the opener and the artist the split they signed. If not, it cancels every hold and nobody pays. Anything outside the signed rules waits for the artist's approval.

Built for the PayPal AI Hackathon (2026) by Ramen Protocol. **PayPal sandbox only: no real money moves.**

- **Try it:** https://tip-the-room.pages.dev (no sign-up)
- **Video (narrated, with captions, 2:44):** {{VIDEO_URL}}
- **Sandbox login for the PayPal popup (play money):** shown on the site in the "For judges" box, with Copy buttons.

## Why

- Small shows die on risk. Someone has to front the room fee, and nobody knows whether 15 or 50 people will come.
- Side Door, the platform that connected touring artists with DIY venues and had been behind about 3,300 shows since 2017, closed on December 31, 2025 ([Exclaim!, Nov 4, 2025](https://exclaim.ca/music/article/dan-mangan-s-side-door-concert-company-is-shutting-down)).
- Touring rarely pays: in a 2024 survey of 1,700 artists, 72% said they were making no profit from their tours (48% broke even, 24% lost money) ([Pirate, July 16, 2024](https://pirate.com/en/blog/touring-fees-survey/)).
- "It only happens if enough people commit" already works for film screenings: on Gathr, if a host doesn't raise enough to cover the screening cost threshold by the deadline, the event is cancelled "at no cost to you nor to your Bookings" ([Gathr help centre](https://support.gathr.com/how-to-host-a-theatrical-on-demand-film-screening)). Tip the Room pairs that mechanic with an agent that settles the money itself, inside rules the artist signed.

## What a judge can do (about 5 minutes)

Open the site. You get your own private copy of two sample shows (fictional artists and rooms). Their starting fans are real PayPal sandbox holds; the agent seats them a few at a time, so the signs fill over about a minute. The "For judges" box on the page lists these steps:

1. **Hold a spot on Juniper Vale** with the real PayPal sandbox popup, using the sandbox login in the box. Your bulb lights; the ledger says "on hold", not charged.
2. **Check pace now.** It jumps both shows forward in time so the agent checks whether fans are joining fast enough. If a show is behind (Marlow Finch is), the agent proposes a fix (lower the target) and waits for the artist; a pointer on the card links to that show's page, where you approve or say not now. The button unlocks once the starting fans are seated, about a minute.
3. **Skip to the deadline.** It ends both shows: Juniper Vale fills up, every hold is charged and one PayPal payout batch pays the room, the opener and the artist; Marlow Finch ends as it stands, and short of its target every hold is cancelled.
4. **Start your own show.** Type one sentence, the AI drafts it, code computes the fan target and checks every amount against your sentence, and you hold to sign the money rules. "Use example emails" fills the payee emails if you have no sandbox accounts to hand. You get a share link and QR code.

Then open **Juniper Vale's show page**: the settlement ledger (AG Grid: sort, filter, CSV) lists every hold, charge, cancellation and payout with its PayPal sandbox id, and the agent log shows what the agent saw, what it did and which signed rule allowed it.

## How it works

- **The model proposes, the mandate decides.** Every money action (capture, void, payout, refund) passes a plain-code guard that checks it against the frozen, hashed mandate the artist signed. The model writes drafts, explanations and notes; it never moves money, and no money step depends on it being available. Code checks what the model wrote (every amount in a draft against the sentence, the numbers in an explanation against its own figures), and a built-in template takes over when a check fails or the daily AI budget is spent.
- **Charging happens at tipping, which can be after day 3.** PayPal holds are valid for 29 days, but PayPal only guarantees the funds for the first 3 ([PayPal: authorize and capture later](https://developer.paypal.com/docs/checkout/standard/customize/authorization/)). A show is charged when it tips, so a late capture can fail; that is recorded as a failed charge, and reauthorizing is not relied on. The 21-day campaign cap is our own design choice, to stay well inside the 29 days. Payouts go out at the deadline in one batch.
- **Every money call is idempotent** (`PayPal-Request-Id`, a deterministic payout `sender_batch_id`), and the runtime reconciles with PayPal (GET) before retrying anything whose answer was lost.

## Tools used

- **PayPal (sandbox):** JS SDK v6 button; Orders v2 (`intent: AUTHORIZE`); Payments v2 authorizations (authorize, capture, void, get); captures (refund); Payouts v1 (one batch per show); Webhooks with signature verification.
- **PayPal Agent Toolkit:** evaluated (`@paypal/agent-toolkit` 1.11.0). It bundles on Cloudflare Workers but its OAuth step fails there (`Unsupported cache mode: default`), so the verdict was NO-GO and the agent's tools are thin wrappers over a small REST client in `src/paypal/` with the same mandate guard. Details: [`docs/superpowers/spikes/2026-10-05-paypal-sandbox.md`](docs/superpowers/spikes/2026-10-05-paypal-sandbox.md).
- **Cloudflare Workers AI:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for all three jobs (sentence to draft, pace proposals, settlement notes), JSON mode, with a hard daily budget of 8,000 neurons (the [free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/) is 10,000 a day). The 3B model is still named in the code but no call uses it.
- **Cloudflare Workers + Durable Objects** (one SQLite-backed object per show, alarms for pace checks and deadlines; [free-plan limits](https://developers.cloudflare.com/durable-objects/platform/pricing/)) and **Cloudflare Pages** for the site.
- **AG Grid Community** for the settlement ledger; **three.js** and **GSAP** for the marquee signs; TypeScript, Vite, Vitest, Playwright.
- **Qloo-free:** this entry uses no Qloo data or API, and no taste or recommendation data of any kind.

## Run it locally

Needs Node 22.13+ and a PayPal **sandbox** app (US business account, Payouts enabled).

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
npm test                         # unit tests, no network
npm run sandbox:check            # real sandbox: hold, charge, refund, hold, cancel, payouts (needs .dev.vars)
npm run worker:check             # the real Worker locally (wrangler dev) end to end against the sandbox, about 10 min
npm run e2e:local                # the judge flow in a browser against the local Worker and a production build
npm run worker:dev               # API on http://127.0.0.1:8788 (one terminal)
VITE_API_BASE=http://127.0.0.1:8788 npm run dev   # site on http://127.0.0.1:5173 (another terminal)
```

`npm run test:gpu` (needs a GPU) checks the marquee pixel by pixel against the approved reference in `reference/v2/`.

## Production path (not built)

Real artists would be onboarded through PayPal's multiparty platform, so money goes straight to the room, opener and artist as sellers, with a platform fee set per order instead of payouts from one account ([PayPal multiparty](https://developer.paypal.com/docs/multiparty/)). PayPal's page says to apply for live credentials once your platform or marketplace has been approved. This demo is sandbox-only and pays out from one sandbox business account.

## Known limits

- **Sandbox only.** Fictional shows; play money.
- **Demo capacity.** Each visitor gets a private demo copy that lasts 24 hours. Copies are capped at 12 an hour and 25 a day per visitor, and 50 a day for everyone together. Heavy public traffic can use up the day's copies.
- **Read limit.** Show reads are limited per visitor, using a counter held in memory in each Worker isolate, so the cap is per isolate and resets when the isolate restarts. An edge cache (3 seconds) is configured on public show reads; we have not measured whether it takes effect on the hosting domain. Heavy traffic can use up the free daily quota, and the site stops answering until the daily reset.
- **Agent toolkit: NO-GO on Workers.** The PayPal Agent Toolkit does not run its OAuth step on Cloudflare Workers, so this project calls PayPal's REST API directly (see Tools used).
- **Reauthorizing holds is unverified.** On the sandbox account used, card holds offer no reauthorize link, and a reauthorize on day 0 is refused. We did not verify the day 4 to day 29 reauthorize path. Real fans' holds are not renewed: a show is charged when it tips, within the 21-day campaign cap. Only the demo's simulated fans get a fresh hold in place of one near expiry.
- **Demo payouts need sandbox receivers.** The sample shows pay three sandbox personal accounts set as receivers (the live site has them configured). With none set, the shows pay example addresses and those payouts stay pending.
- **Webhooks** are capped per sender (1,000 an hour), per show (200 an hour) and overall (2,000 an hour); PayPal retries refused deliveries for days, and no money step depends on a webhook (the agent reads PayPal itself).
- **Calling off** is only possible after a show tips and before its deadline (fans are refunded); a show that hasn't tipped simply misses at its deadline.

## Build log

Which model wrote and reviewed what: [`docs/build-log.md`](docs/build-log.md).

## License

[MIT](LICENSE)

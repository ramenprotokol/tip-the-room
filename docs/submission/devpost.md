# Devpost submission draft (paste into the form)

**Project name:** Tip the Room

**Tagline (60 chars max):** Nobody's charged unless the show happens.

**Links:** Demo {{SITE_ORIGIN}} · Video {{VIDEO_URL}} · Code https://github.com/ramenprotokol/tip-the-room

## Inspiration
Small shows die on risk: someone fronts the room fee and nobody knows if 15 or 50 people will come. Side Door, which had been behind about 3,300 shows connecting touring artists with DIY venues since 2017, closed at the end of 2025 (Exclaim!, Nov 4, 2025: https://exclaim.ca/music/article/dan-mangan-s-side-door-concert-company-is-shutting-down). In a 2024 survey of 1,700 artists, 72% said they were making no profit from their tours (Pirate: https://pirate.com/en/blog/touring-fees-survey/). "Only happens if enough people commit" already works for film screenings: on Gathr, an event that misses its threshold by the deadline is cancelled at no cost to the host (https://support.gathr.com/how-to-host-a-theatrical-on-demand-film-screening). We wanted that for gigs, with an agent that settles the money itself.

## What it does
Fans hold a spot with a PayPal hold, not a charge. The artist signs the money rules once: the fan target, the deadline and the payout split. An agent watches the show: it proposes fixes when pledging is behind (the artist approves), charges every hold the moment the target is reached, and at the deadline pays the room, the opener and the artist in one PayPal payout batch. If the target is missed, it cancels every hold and nobody pays. Every step shows in an agent log that names the signed rule that allowed it, and in a settlement ledger with real PayPal sandbox ids.

## How we built it
- PayPal JS SDK v6 + Orders v2 (`intent: AUTHORIZE`), Payments v2 authorizations (capture, void, get), refunds, Payouts v1 and Webhooks with signature verification, all in the sandbox, through a small idempotent REST client.
- Cloudflare Workers AI (Llama 3.3 70B fp8-fast and Llama 3.1 8B fp8, JSON mode) turns the artist's sentence into a draft, explains pace and proposes options, and writes settlement notes. Code computes every number; a plain-code guard checks every money action against the signed, hashed mandate.
- Cloudflare Workers and SQLite Durable Objects (one per show, alarms for the deadline and pace checks), Cloudflare Pages, AG Grid Community for the ledger, three.js and GSAP for the marquee.
- We evaluated the PayPal Agent Toolkit; its OAuth step doesn't run on Workers, so the agent's tools wrap our REST client with the same guard.

## Challenges
Hold timing shaped the whole design. PayPal holds are valid for 29 days, but PayPal only guarantees the funds for the first 3, and we charge when a show tips, which can be after day 3. A late capture can fail; we record it as a failed charge and do not rely on reauthorizing. The 21-day campaign cap is our own choice, to stay well inside the 29 days. Every money call also had to survive lost answers and retries without double-charging or double-paying, so each one is idempotent and reconciled with PayPal before any retry.

## Accomplishments
The model proposes, the mandate decides: the AI can explain and suggest, but it can never move money outside the rules the artist signed, and the show still settles when the AI budget runs out.

## What we learned
Simulated fans can be real sandbox holds (server-side card authorizations), so the demo never fakes a PayPal id.

## What's next
Onboard real artists through PayPal's multiparty platform so money goes straight to each payee, and add opener and venue profiles.

## Known limits
Sandbox only, play money. Payouts to the sample shows' example receivers stay pending until real sandbox payees are set. Reauthorizing a hold near expiry is unverified, so the agent voids it and places a fresh hold. The PayPal Agent Toolkit was a NO-GO on Workers, so we use REST. Show reads are limited per visitor in memory per Worker isolate.

## Built with
paypal-orders-v2, paypal-payments-v2, paypal-payouts, paypal-webhooks, paypal-js-sdk-v6, cloudflare-workers, cloudflare-durable-objects, cloudflare-workers-ai, cloudflare-pages, ag-grid, three.js, gsap, typescript, vite, vitest, playwright

## For judges (testing instructions field)
Paste the judge link and the sandbox buyer login into Devpost's private 'testing instructions for judges' field, not here.

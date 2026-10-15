# Devpost submission draft (paste into the form)

**Project name:** Tip the Room

**Tagline (60 chars max):** Nobody's charged unless the show happens.

**Links:** Demo https://tip-the-room.pages.dev · Video https://youtu.be/g3QXUhDtc4Y · Code https://github.com/ramenprotokol/tip-the-room

## Inspiration
Small shows die on risk: someone fronts the room fee and nobody knows if 15 or 50 people will come. Side Door, which had been behind about 3,300 shows connecting touring artists with DIY venues since 2017, closed at the end of 2025 (Exclaim!, Nov 4, 2025: https://exclaim.ca/music/article/dan-mangan-s-side-door-concert-company-is-shutting-down). In a 2024 survey of 1,700 artists, 72% said they were making no profit from their tours (Pirate: https://pirate.com/en/blog/touring-fees-survey/). "Only happens if enough people commit" already works for film screenings: on Gathr, an event that misses its threshold by the deadline is cancelled at no cost to the host (https://support.gathr.com/how-to-host-a-theatrical-on-demand-film-screening). We wanted that for gigs, with an agent that settles the money itself.

## What it does
Fans hold a spot with a PayPal hold, not a charge. The artist signs the money rules once: the fan target, the deadline and the payout split. An agent watches the show: it proposes fixes when pledging is behind (the artist approves), charges every hold the moment the target is reached, and at the deadline pays the room, the opener and the artist in one PayPal payout batch. If the target is missed, it cancels every hold and nobody pays. Every step shows in an agent log that names the signed rule that allowed it, and in a settlement ledger with real PayPal sandbox ids.

## How we built it
- PayPal JS SDK v6 + Orders v2 (`intent: AUTHORIZE`), Payments v2 authorizations (capture, void, get), refunds, Payouts v1 and Webhooks with signature verification, all in the sandbox, through a small idempotent REST client.
- Cloudflare Workers AI (Llama 3.3 70B fp8-fast, JSON mode) turns the artist's sentence into a draft, explains pace and proposes options, and writes settlement notes. Code computes every number and checks every amount in a draft against the sentence; a built-in template takes over when a check fails or the daily AI budget runs out. A plain-code guard checks every money action against the signed, hashed mandate.
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
Sandbox only, play money. Demo payouts go to sandbox personal accounts set as receivers; without them they stay pending. Reauthorizing a hold is unverified: real fans' holds are not renewed (a show is charged when it tips, within a 21-day cap), and only the demo's simulated fans get a fresh hold near expiry. The PayPal Agent Toolkit was a NO-GO on Workers, so we use REST. Show reads are limited per visitor in memory per Worker isolate. Each visitor can open 25 demo copies a day.

## Built with
paypal-orders-v2, paypal-payments-v2, paypal-payouts, paypal-webhooks, paypal-js-sdk-v6, cloudflare-workers, cloudflare-durable-objects, cloudflare-workers-ai, cloudflare-pages, ag-grid, three.js, gsap, typescript, vite, vitest, playwright

## Testing instructions for judges (paste into the testing instructions field)
Site: https://tip-the-room.pages.dev. No sign-up. Everything is PayPal sandbox play money.

The PayPal sandbox login for the checkout popup is on the home page, in the "For judges" box, with Copy buttons for the email and the password.

1. Hold a spot on Juniper Vale: click it in the "For judges" box and pay with the sandbox login; your bulb lights and the money is held, not charged.
2. Check pace now: the agent checks both shows, and Marlow Finch is behind, so it proposes a fix and asks the artist; open that show's page to approve it (the button unlocks about a minute after the page loads).
3. Skip to the deadline: Juniper Vale tips, every hold is charged and one PayPal payout batch pays the room, the opener and the artist; Marlow Finch falls short and every hold is cancelled.
4. Start your own show: type one sentence, let the AI draft it, hold to sign the money rules ("Use example emails" fills the payee emails if you have none).

Then open Juniper Vale's show page for the settlement ledger and the agent log.

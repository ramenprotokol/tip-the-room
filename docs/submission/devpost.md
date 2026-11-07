# Devpost submission (paste into the form)

**Project name:** Tip the Room

**Tagline (60 chars max):** No show, no charge. An AI agent settles inside your rules.

**Links:** Demo https://tip-the-room.pages.dev · Video https://youtu.be/g3QXUhDtc4Y · Code https://github.com/ramenprotokol/tip-the-room

## What it does
**The model proposes, the mandate decides.** Tip the Room is an AI settlement agent for small live shows that can only move money inside rules the artist signed.

- **Fans hold a spot with a PayPal hold, not a charge.**
- **The artist signs five money rules once:**
  1. fans are only held until the target is reached;
  2. then every hold is charged;
  3. everyone is paid exactly the split they signed;
  4. if the deadline passes short, every hold is cancelled;
  5. the agent asks the artist before changing the target or deadline, or refunding.

  The rules are frozen and hashed.
- **From then on the agent runs the money:**
  - it charges every hold the moment the show tips;
  - it pays the room, the opener and the artist in one PayPal payout batch at the deadline;
  - or it cancels every hold, and nobody pays.

**What judges see in the demo:**
- **When pledging falls behind** (Marlow Finch in the demo), the AI proposes a fix: lower the target, or extend the deadline. Plain code has already checked each option against rule 5 and the show's cost floor, and nothing happens until the artist presses and holds to approve.
- **The agent can't step outside the rules.** It cannot charge, cancel or pay outside rules 1–4, and if the AI is down or its budget is spent, the show still settles.
- **Every decision is visible.** A pinned **Decisions** strip above the agent log names the money rule behind each decision, and the per-fan lines fold into one row. A settlement ledger built on AG Grid shows real PayPal sandbox ids.

## Inspiration
Small shows die on risk: someone fronts the room fee, and nobody knows if 15 or 50 people will come.
- Side Door, which had been behind about 3,300 shows connecting touring artists with DIY venues since 2017, closed at the end of 2025 (Exclaim!, Nov 4, 2025: https://exclaim.ca/music/article/dan-mangan-s-side-door-concert-company-is-shutting-down).
- In a 2024 survey of 1,700 artists, 72% said they made no profit from touring (Pirate: https://pirate.com/en/blog/touring-fees-survey/).
- Rooms are squeezed too: UK grassroots venues ran on an average profit margin of 0.48%, and 43.8% reported a loss (Music Venue Trust 2024 report, via TPi: https://www.tpimagazine.com/music-venue-trust-releases-2024-annual-report/).

## Who it's for, and who pays
- **Who it's for:** independent artists and the rooms that host them. House concerts, record-store and café gigs, back rooms for 25 to 80 people. These are the shows nobody can afford to front.
- **Fans** pay only if the show happens.
- **The artist and the room** pay nothing up front, and they get paid in the same batch as everyone else.
- **The business (planned, not built):** a small platform fee taken only on shows that tip, through PayPal's multiparty platform. No show, no fee.

## How it's different
Threshold-funded shows have been tried before (Songkick Detour, Queremos/WeDemand), and Gathr runs pre-authorize-then-charge for film screenings. What's new here is **who runs the money**: an AI agent with a signed, hashed mandate it cannot step outside.
- The model writes drafts, explanations and proposals. It never moves money.
- Every capture, void, payout and refund passes a plain-code guard that checks it against the mandate.
- Code checks what the model wrote: every amount in a draft is checked against the artist's sentence, and every number in an explanation against its own figures.

## How we built it
- **PayPal (sandbox):**
  - JS SDK v6 button;
  - Orders v2 (`intent: AUTHORIZE`);
  - Payments v2 authorizations (capture, void, get) and refunds;
  - Payouts v1 (one batch per show);
  - Webhooks with signature verification.

  All of it goes through a small, idempotent REST client: every money call carries a `PayPal-Request-Id`, and payouts use a deterministic `sender_batch_id`. We tried the PayPal Agent Toolkit first, but its OAuth step doesn't run on Cloudflare Workers yet, so the agent's tools wrap the same REST calls behind the guard.
- **AI:** Cloudflare Workers AI (Llama 3.3 70B, JSON mode) turns the artist's one sentence into a draft, explains pace and proposes fixes, and writes settlement notes. Code computes every number, and a template takes over when a check fails or the daily AI budget runs out.
- **AG Grid (Community)** runs the settlement ledger and the payout batch:
  - **Live updates:** `getRowId` + `applyTransaction` with `enableCellChangeFlash`, so a hold's row flashes when it turns into a charge or a cancel, without re-rendering the grid.
  - **Totals:** `pinnedBottomRowData` keeps live totals pinned under the ledger (held, charged, cancelled, refunded, paid out), in whole cents.
  - **Search and status chips:** `quickFilterText` for search, and `setFilterModel` / `onFilterChanged` for the status chips.
  - **Ask the ledger:** type "which holds were cancelled?" and the model returns a small filter-and-sort spec. Code checks it against an allowlist of the real columns and statuses before calling `setFilterModel` / `applyColumnState`. If the AI is out, a keyword matcher takes over. The model never sees the ledger rows and can't touch money.
  - **Payout batch:** a second grid lists one line per payee, with the PayPal payout item id. Both grids export CSV (`exportDataAsCsv`, formula-safe).
- **Platform:** Cloudflare Workers and SQLite Durable Objects (one per show, with alarms for pace checks and deadlines), Cloudflare Pages, three.js and GSAP for the marquee signs.
- **Tests:** TypeScript, Vitest (876 unit tests), and Playwright for the judge flow.

## Challenges
Hold timing shaped the whole design. PayPal holds are valid for 29 days, but the funds are only guaranteed for the first 3, and a show is charged when it tips, which can be after day 3. A late capture can fail. We record that as a failed charge and do not rely on reauthorizing. The 21-day campaign cap is our own choice, to stay well inside 29 days. Every money call also had to survive lost answers and retries without double-charging or double-paying, so each is idempotent and reconciled with PayPal before any retry.

## Accomplishments
- An agent that settles real (sandbox) money end to end, and still settles correctly when the AI is switched off.
- The demo's starting fans are real PayPal sandbox card holds, so the demo never fakes a PayPal id.

## What we learned
Letting a model near money is safe when the model only proposes and a signed, machine-checkable mandate decides. The hard part isn't the AI. It's the money edge cases: expiring holds, lost responses, retries and partial payouts.

## What's next
Onboard real artists through PayPal's multiparty platform, so money goes straight to each payee and the platform fee is taken only on shows that tip. Then add opener and venue profiles, so a room can list open dates and an artist can claim one.

## Known limits
- Sandbox only; play money.
- Demo payouts go to sandbox accounts set up as receivers.
- Reauthorizing an expired hold isn't relied on. A show is charged when it tips, within a 21-day cap, and a late capture is recorded as failed.

## Built with
paypal-orders-v2, paypal-payments-v2, paypal-payouts, paypal-webhooks, paypal-js-sdk-v6, cloudflare-workers, cloudflare-durable-objects, cloudflare-workers-ai, cloudflare-pages, ag-grid, three.js, gsap, typescript, vite, vitest, playwright

## Testing instructions for judges (paste into the private testing-instructions field)
Site: https://tip-the-room.pages.dev. No sign-up. Everything is PayPal sandbox play money.

**Judge pass:** enter `JUDGE_CODE_HERE` in the "For judges" box on the home page. It gives judges their own daily demo copies and AI share, so public traffic can't use up yours.

The PayPal sandbox login for the checkout popup is in the "For judges" box on the home page, with Copy buttons.

1. **Hold a spot on Juniper Vale.** Click it in the "For judges" box and pay with the sandbox login. Your bulb lights, and the money is held, not charged.
2. **Check pace now.** The agent checks both shows. Marlow Finch is behind, so it proposes a fix and asks the artist; open that show's page to approve it. The button unlocks about 30 seconds after the page loads, once the starting fans are seated.
3. **Skip to the deadline.** Juniper Vale tips: every hold is charged, and one PayPal payout batch pays the room, the opener and the artist. Marlow Finch falls short, and every hold is cancelled.
4. **Start your own show.** Type one sentence, let the AI draft it, then hold to sign the money rules. "Use example emails" fills in the payee emails if you have none.

Then open Juniper Vale's show page for the settlement ledger, the payout batch and the agent log.

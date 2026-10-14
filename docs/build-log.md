# Build log

How Tip the Room was built, and which AI model did what. No session or conversation ids are published.

## Roles

- **Owner (Ramen Protocol):** the idea, every product decision, the PayPal sandbox and Cloudflare accounts, deploys and pushes, the video upload and the submission.
- **Claude Opus 5.5:** design spec and roadmap with the owner; wrote each implementation plan; controller for every plan; reviewed every task (spec compliance, then code quality); took over any task that failed review twice.
- **Claude Sonnet 5.5:** implementer, one task at a time, for every plan; ran each task's tests and QA.
- **Fable 5.1:** final whole-branch reviews of Plans 1 and 2, and the independent review of the security fixes after launch.
- Final reviews of Plans 3, 4, 5 and 6: Claude Opus 5.5 (see the table).

## Plans

| Plan | What it delivered | Merge | Checks at merge | Final review |
|---|---|---|---|---|
| 1 · Foundation + money core | The money rules, the mandate guard and the pure settlement logic, with the fixes from review | `2180720` | Task reviews clean; final fixes applied | Fable 5.1 |
| 2 · Marquee port + visual parity | The marquee signs ported to TypeScript, pixel-compared to the approved reference | `1af6b32` | GPU 39/39 | Fable 5.1 |
| 3 · PayPal sandbox | A small REST client, webhook verification, a live sandbox run, and the Agent Toolkit evaluation (NO-GO on Workers) | `201ebfb` | live sandbox:check 11/11 | Claude Opus 5.5 |
| 4 · Agent runtime | The Worker API, one Durable Object per show, the money executor, payouts, AI with template fallbacks, the judge demo | `b61ea83` | 565 unit tests; GPU 39/39; worker:check 19/19 | Claude Opus 5.5 |
| 5 · Product surfaces | The start, pledge (PayPal v6) and manage pages with the AG Grid ledger, wired to the real API and pixel-locked to the reference | `10fb6c5` | 622 unit tests; GPU 100; e2e:local PASS | Claude Opus 5.5 |
| 6 · Ship | Abandoned-order and held-order fixes, judge pool and limits, lost-answer retry on the pledge page, live check scripts, docs, video recorder | `6f6144e` | complete; final run at submission: 784 unit tests, GPU 183 | Claude Opus 5.5 |

## Commits by co-author

Counts come from `git log` trailers on the submission branch, including the commit that wrote this table (180 commits in all).

| Model | Commits |
|---|---|
| Claude Sonnet 5.5 | 115 |
| Claude Opus 5.5 | 65 |

## After launch

After Plan 6 merged and the site went live, the work went on in small branches. Claude Sonnet 5.5 built each change and ran its tests; Claude Opus 5.5 planned the work, wrote the specs and reviewed every diff; a two-part security audit ran on Claude Opus 5.5, and Fable 5.1 independently reviewed the fixes. The owner deployed every change.

- **Fixes from reviewing the demo video:** the sign screen no longer lists stale email warnings; the agent's pace note speaks to the artist, names the options and reads the same time left as the countdown; a draft reads "pledges close Oct 16" as the pledge deadline and keeps it out of the show date; the ledger and the payout cards use one vocabulary (Sent until PayPal reports success, then Paid).
- **Security and rate limits (the audit found no way to move money or read private data, only nuisance abuse):** a daily cap on public demo copies and a key check before a reset spends quota; limits that count an IPv6 /64 as one visitor; a daily cap on new shows; a daily pool for AI drafts with a built-in fallback; a share of the AI budget for judge links (later returned to the public); order limits per visitor per show; webhook checks (signature headers, known show, per-show cap) before the shared cap; model notes with links or markup are refused; a short blocklist for fan initials. Fable 5.1's review of these fixes found three gaps, now fixed (a separate judge pool for new shows, a cap on reset attempts, a looser order limit), and the per-visitor daily demo cap was raised from 10 to 25.
- **Judge-walk rounds (fresh agents using the live site cold):** round 1 added the header links, the "try it in this order" list, working-button labels, copyable login lines and the Use example emails button; round 2 added the pointer to the show page while the agent is asking the artist, labels saying who wrote a draft or a question, and fan-page wording; round 3 was about the AI and is the next item.
- **AI draft accuracy:** the model's roles are cross-checked against the sentence's own words (a draft once gave the artist's $200 to a made-up host); drafts moved to the larger model with one worked example; the show year now comes from code, never the model; the built-in reader understands more phrasings and the start page warns when it finds no payees; the agent's question gets a second try; an extension can never land on or after the show; settlement notes that contradict the outcome are dropped.
- **Rough edges:** the sign's payout plates now say PAYING, SENT, PAID or FAILED per payee instead of always PAID; the payout box is filled when a page loads mid-payout; Check pace now waits for the starting fans; a calm confirmation shows when the artist approves a change; a show that ended without paying out keeps its fan count after a reload.

## How the work was checked

- Unit tests (Vitest), property tests on the mandate guard (fast-check), GPU pixel-parity tests against the approved reference (Playwright + pixelmatch, 0.5% max), a live sandbox script, a live Worker script, and an end-to-end judge flow in a browser.
- A privacy gate runs before every push.

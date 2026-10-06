# Build log

How Tip the Room was built, and which AI model did what. No session or conversation ids are published.

## Roles

- **Owner (Ramen Protocol):** the idea, every product decision, the PayPal sandbox and Cloudflare accounts, deploys and pushes, the video upload and the submission.
- **Claude Opus 5.5:** design spec and roadmap with the owner; wrote each implementation plan; controller for every plan; reviewed every task (spec compliance, then code quality); took over any task that failed review twice.
- **Claude Sonnet 5.5:** implementer, one task at a time, for every plan; ran each task's tests and QA.
- **Fable 5.1:** final whole-branch reviews of Plans 1 and 2.
- Final reviews of Plans 3, 4, 5 and 6: Claude Opus 5.5 (see the table).

## Plans

| Plan | What it delivered | Merge | Checks at merge | Final review |
|---|---|---|---|---|
| 1 · Foundation + money core | The money rules, the mandate guard and the pure settlement logic, with the fixes from review | `0f055b6` | Task reviews clean; final fixes applied | Fable 5.1 |
| 2 · Marquee port + visual parity | The marquee signs ported to TypeScript, pixel-compared to the approved reference | `0938522` | GPU 39/39 | Fable 5.1 |
| 3 · PayPal sandbox | A small REST client, webhook verification, a live sandbox run, and the Agent Toolkit evaluation (NO-GO on Workers) | `f693340` | live sandbox:check 11/11 | Claude Opus 5.5 |
| 4 · Agent runtime | The Worker API, one Durable Object per show, the money executor, payouts, AI with template fallbacks, the judge demo | `5a4ec21` | 565 unit tests; GPU 39/39; worker:check 19/19 | Claude Opus 5.5 |
| 5 · Product surfaces | The start, pledge (PayPal v6) and manage pages with the AG Grid ledger, wired to the real API and pixel-locked to the reference | `32685e1` | 622 unit tests; GPU 100; e2e:local PASS | Claude Opus 5.5 |
| 6 · Ship | Abandoned-order and held-order fixes, judge pool and limits, lost-answer retry on the pledge page, live check scripts, docs | in progress | 670 unit tests on the branch when this was written; completed at merge | Claude Opus 5.5 |

## Commits by co-author

Counts come from `git log` trailers on the Plan 6 branch at the time of writing (119 commits including the merge commits).

| Model | Commits |
|---|---|
| Claude Sonnet 5.5 | 94 |
| Claude Opus 5.5 | 25 |

## How the work was checked

- Unit tests (Vitest), property tests on the mandate guard (fast-check), GPU pixel-parity tests against the approved reference (Playwright + pixelmatch, 0.5% max), a live sandbox script, a live Worker script, and an end-to-end judge flow in a browser.
- A privacy gate runs before every push.

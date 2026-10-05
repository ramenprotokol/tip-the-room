# Marquee v2 reference pack

The visual source of truth for Tip the Room (spec §2d). The app is diffed against these pages at frozen clock times.

Serve the folder over HTTP (ES modules don't load from `file://`), for example `python3 -m http.server` from `reference/`, then open `/v2/demo.html`.

## Files

| File | What it is |
|---|---|
| `demo.html` | Try the demo: two sample shows side by side (A tips and pays out, B is called off). |
| `start.html` | Start a show: one sentence, a draft, the money rules, hold to sign, then the share link and QR. |
| `pledge.html` | The fan page for one show: Hold my spot · $15, the PayPal button slot, the confirmation. |
| `manage.html` | The artist's show page: sign, status, agent proposal and log, share box, who gets paid, the ledger. |
| `shared/styles.css` | Every token and component. |
| `shared/ui.js` | Ticker (the one rAF clock), Cues, Odo, Snd, AgentLog, PayoutStrip, Placeholder, HoldButton, QR encoder, `GRID_THEME`. |
| `shared/sign.js` | `SignHost` (one WebGL renderer for every sign on the page) and `SignView` (one marquee). |

## Choreography (seconds from the start of each beat)

The 3D in `sign.js` and the DOM cues in each page are both scheduled from these tables.

| Beat | When it runs | Cues |
|---|---|---|
| PLEDGE | each new fan before tipping | bulb k lands at `k × 0.24 + 0.38` |
| TIP | the moment fans reach the target | chaser 0 → flare 0.62 (status "It's on!", money charged) → sparks 1.0 → gather 1.78 → IT'S ON 2.38 → name wipes back 3.1 → done 4.3 |
| BONUS | each fan after tipping (charged straight away) | lap of light every 0.3, done `(n−1) × 0.3 + 0.7` |
| PAY OUT | the deadline, if tipped | signs drop 0–0.6 → money streams 0.5 → "Everyone's paid" 1.6 → done 2.6 |
| MISS | the deadline, if short | wave off 0–0.9 → status "Deadline passed" 0.12 → lights float home → CALLED OFF / $0 CHARGED 2.05 → "Called off" → done 3.1 |

"Skip to the deadline" runs the countdown down over 1.15 s, then starts PAY OUT or MISS. Reduced motion swaps every beat for a switch and one pulse (0.7 s; MISS 1.3 s).

## Parity checkpoints (spec §9)

| Page | Checkpoints |
|---|---|
| demo | rest · tip 0.7 / 2.4 / 3.1 / 4.8 · pay out 1.0 / 2.6 · miss 1.0 / 3.2 · 400 px |
| start | initial · filled · live |
| pledge | initial · on hold |
| manage | initial · tipped · paid · called off |

How to freeze a frame (this is how the reference screenshots were made):

1. `page.clock.install({ time })`, then `page.clock.pauseAt(time + 1 s)`, **before** `goto`. `install()` on its own lets time keep flowing.
2. Poll `window.__marquee.ready` with `page.evaluate`, not `waitForFunction` (its rAF polling never fires on a paused clock).
3. `runFor(1200)` so the sign finishes fading in.
4. Trigger the beat (a key or a `__marquee` call), then step to exactly *t*: `runFor(view.anim.t0 + t·1000 − performance.now())`.
5. Wait about 300 ms of real time, then screenshot.

Measured on Apple M5 Pro / ANGLE Metal: two fresh loads frozen at the same instant are pixel-identical at tip 2.4 and miss 1.0. At tip 0.7, 286 pixels (≤19/255) differ, at the status chip's blurred glow mid-pop and the 1.5 px header rule. That is compositor raster noise, far under the 0.5 % gate.

Mask or remove `[data-ref-only]` elements when diffing against the app: the reference-page nav, "Simulate PayPal approval" and the manage page's demo controls.

## Sample data

Fictional people and rooms only. Weekdays follow the 2026 calendar: Fri Nov 20 is a Friday. Maya's show runs Fri Nov 20 at Lucky's Café, deadline Thu Nov 12 6 pm, 21 fans at $15. That works out as `ceil((100 + 200) × 1.05 / 15) = 21`, and her payout is Room $100 then her $215. "Now" is Mon Nov 9 on the fan and show pages, and Mon Nov 16 on the demo. PayPal refs are labelled `SAMPLE-…` and must never be mistaken for real IDs.

## Porting notes

- No CSS transitions or keyframes. Every moving thing runs on `Ticker` (rAF + `performance.now()`). GSAP handles DOM entrances only, with `lagSmoothing(0)`. Status lamps breathe through a `--tk` custom property and CSS `sin()`.
- The ledger is a static table that copies AG Grid's class names and look. The real grid keeps pinned columns in a separate container. Here the status column is a sticky cell in one scroller, so diff the grid as a whole. Theme AG Grid v33+ with `themeQuartz.withParams(GRID_THEME)` from `ui.js`, pin Status `'right'`, and render it with the `.pill` markup. Columns: When · What happened · Who · Amount · PayPal ref · Status.
- Ledger model: one row per hold, whose Status changes (On hold → Charged / Cancelled), plus event rows for the capture batch, the payout items and the cancel batch.
- Payout signs: 2–4 of them, laid out automatically. The lattice rows grow until every amount fits with its "$".
- `window.__marquee` on every page exposes `ready`, `views` (each has `anim.tHold` to pin a frame) and page helpers: `ctls` on demo; `fill`, `setEmails`, `holdTo`, `sign` on start; `approve`, `setFans`, `setInitials` on pledge; `addFans`, `skip`, `reset`, `approve`, `decline`, `holdTo` on manage.

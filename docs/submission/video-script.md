# Submission video script

| # | Shot | Caption | Speed |
|---|------|---------|-------|
| 1 | Demo page, two shows | Tip the Room: fans hold a spot with PayPal. Nobody's charged unless the show happens. | 1x |
| 2 | Demo page, bulbs | Two sample shows. Each bulb is a fan whose $15 is on hold in the PayPal sandbox, not charged. | 1x |
| 3 | Demo page, fans arriving | The starting fans are real sandbox card holds, seated by each show's agent (sped up). | squeezed |
| 4 | Pledge page and PayPal popup (popup inset, top right) | A judge holds a spot with the real PayPal sandbox popup (sped up 2x). | 2x |
| 5 | Pledge confirmation | PayPal holds the money. Nothing is charged unless the show happens. | 1x |
| 6 | Check pace | Check pace now: show B is behind (sped up). | squeezed |
| 7 | Show B's page, approval card | The agent proposes a fix and explains it. The artist must approve: the signed rules decide. | 1x |
| 8 | Add fans to show B | Add fans to show B (sped up). | squeezed |
| 9 | Skip to the deadline | Skip to the deadline (sped up). | squeezed |
| 10 | Show A reaches its target | Show A reached its target: the agent charges every hold at once. | 1x |
| 11 | Show B falls short | Show B fell short: every hold is cancelled. Nobody pays. | 1x |
| 12 | Payouts | At the deadline, one PayPal payout batch pays the room, the opener and the artist. | 1x |
| 13 | Show A's ledger | The settlement ledger (AG Grid): every hold, charge, cancel and payout, with real PayPal sandbox ids. | 1x |
| 14 | Show A's agent log | The agent log: what it saw, what it did, and which signed rule allowed it. | 1x |
| 15 | Start page, sentence and draft | An artist starts a show in one sentence. Workers AI drafts it; code computes the fan target. | 1x |
| 16 | Hold to sign | Hold to sign the money rules. That signature is the mandate the agent must follow. | 1x |
| 17 | Share link and QR | A share link and QR code for fans. | 1x |
| 18 | End card | Tip the Room · PayPal Orders, Authorizations, Payouts, Webhooks · Cloudflare Workers AI · AG Grid · Cloudflare Workers, Durable Objects, Pages · github.com/ramenprotokol/tip-the-room | 1x |

No voice. No music (the video has no audio track). Captions are burned in. Target length 2:30-2:55.

The sandbox buyer login line on the demo page is hidden while recording, and typed fields on PayPal's own pages are shown as dots. A recording against the local stack skips rows 4 and 5's popup (the local build has no PayPal client id); film the deployed site for the final cut. The recorder nudges the pointer every 45 seconds so the demo never shows its "Paused" line.

Record: `npm run video:record` (local stack) or `VIDEO_BASE_URL=https://<site> npm run video:record`. Build: `npm run video:build`.

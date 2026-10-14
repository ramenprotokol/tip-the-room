# Submission video script (v6)

Length 2:44 (164.6 s, 1920x1080, 30 fps). Narrated with an AI voice (Kokoro, voice `af_heart`), with burned-in captions that match the narration, and an original soundtrack composed in code (no third-party music). The video is composed with Remotion from screen captures of the deployed site. The narration lines, in order (scene 0 is the intro; its two lines are spoken first, then scenes 1 to 10):

| Scene | Line | Seconds |
|---|---|---|
| 0 | Tip the Room is an app for small live shows. | 2.4 |
| 0 | Fans hold a spot with PayPal, and nobody is charged unless enough fans join. | 5.0 |
| 1 | Here's an example: a band called Juniper Vale, playing a small back room. | 4.3 |
| 1 | The room wants eighty dollars. The opener wants a hundred. | 3.1 |
| 1 | To cover it, they need thirty-four fans at fifteen dollars each. | 3.7 |
| 2 | So who takes the risk? | 1.3 |
| 2 | Sell tickets early, and a cancelled night means refunds. | 3.2 |
| 2 | Don't, and the band eats the bill. | 1.8 |
| 3 | With Tip the Room, nobody buys a ticket up front. Fans just hold a spot. | 4.7 |
| 3 | Thirty-four holds by the deadline, and the show tips: everyone is charged at once. | 5.0 |
| 3 | Fewer, and every hold is voided. A second show, Marlow Finch, shows that ending. | 4.9 |
| 4 | Holding a spot takes one tap. | 1.7 |
| 4 | PayPal checkout opens, the fan approves, | 2.6 |
| 4 | and fifteen dollars is authorized. Not captured. Just held. | 3.8 |
| 4 | Every bulb and every number here is a real PayPal hold. | 3.6 |
| 5 | Each show has its own AI agent, on Cloudflare Workers AI. | 4.1 |
| 5 | Marlow Finch is behind pace, so the agent proposes a fix: lower the target to twenty-five. | 6.3 |
| 5 | It can't change the deal on its own. The artist approves it, with a press and hold. | 4.7 |
| 5 | Every move the agent makes is checked in code against the rules the artist signed. | 4.5 |
| 6 | Back at Juniper Vale, the last five fans join. | 3.0 |
| 6 | Thirty-four. | 0.8 |
| 6 | The moment it tips, every hold is captured at once. | 3.0 |
| 6 | Thirty-four captures, each confirmed by a verified PayPal webhook. | 4.2 |
| 7 | Two more fans join before the deadline. Then one PayPal Payouts batch pays the room, the opener, and the band. | 7.1 |
| 7 | All three payouts share one PayPal batch ID, right there in the ledger. | 4.3 |
| 7 | Marlow Finch ends one fan short. So every hold is voided. | 3.9 |
| 7 | Zero dollars charged. | 1.5 |
| 8 | None of this is a mock-up. | 1.5 |
| 8 | Every hold, capture, void and payout lands in an AG Grid ledger, with its real PayPal ID. | 6.5 |
| 8 | And the agent log names the signed rule behind every move. | 3.5 |
| 9 | Starting a show takes one sentence. | 1.9 |
| 9 | The AI drafts it, code checks the math, | 2.4 |
| 9 | and the artist signs the money rules. That signature is the agent's mandate. | 4.3 |
| 9 | Then share the link. | 1.1 |
| 10 | Tip the Room. | 0.8 |
| 10 | Fans back the show. | 1.2 |
| 10 | The show happens, or nobody pays. | 2.2 |

The lines add up to 124 seconds of speech; the rest of the 2:44 is the pauses between lines and the on-screen moments.

What the video shows, in the order of the scenes: the two sample shows and their bulbs (scenes 1 to 3), a fan holding a spot through the PayPal sandbox popup (scene 4), the agent proposing a fix that the artist approves (scene 5), show A tipping and charging every hold (scene 6), the payout batch and show B's cancelled holds (scene 7), the AG Grid ledger and the agent log (scene 8), starting a show from one sentence and signing it (scene 9), and the end card (scene 10).

Privacy rules the video was made under (from its brief): the sandbox login box on the page is hidden while capturing, typed fields in PayPal's popup are masked, private show-page links are blurred, and the only identity shown is `ramenprotokol` / `github.com/ramenprotokol/tip-the-room`.

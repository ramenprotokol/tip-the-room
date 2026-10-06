# Tip the Room

Fans hold a spot for a small show with PayPal. Nobody is charged unless enough fans join by the deadline. When they do, an agent charges every hold and pays the room, the opener and the artist the split the artist signed. When they don't, every hold is cancelled and nobody pays.

Built for the PayPal AI Hackathon (2026). Work in progress.

## Develop

    npm install
    npm test
    npm run dev

## Visual parity

The Marquee look is locked to `reference/v2/`. `npm run test:gpu` (local, needs a GPU) freezes the reference and the app at the same moments and fails if more than 0.5% of pixels differ.

## Sandbox check

`npm run sandbox:check` runs the real PayPal **sandbox** flows end to end: hold → charge → refund, hold → cancel, the day-0 reauthorize refusal, and one payout batch (sent once, refused the second time). It needs a `.dev.vars` file with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`. The client refuses any non-sandbox URL.

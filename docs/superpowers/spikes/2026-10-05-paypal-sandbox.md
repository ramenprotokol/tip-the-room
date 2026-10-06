# PayPal sandbox spike, 2026-10-05 (US account re-run)

Live run against `https://api-m.sandbox.paypal.com` (run id `spike-1791256675621`). Fixtures are in `tests/paypal/fixtures/` (personal fields redacted).

Account: a US sandbox business account reached through a Platform-type app, with Payouts enabled. This run replaces the first run, which used a CAD account (see "First run (CAD account)" below).

| Check | Result | Evidence |
|---|---|---|
| token | PASS | token issued |
| card hold (server-side, no buyer login) | PASS | Visa test card (card 1); authorization status `CREATED`, created 2026-10-06T03:17:57Z, expires 2026-11-04T03:17:57Z (29 days) |
| capture | PASS | status `COMPLETED`; gross 15.00 USD, fee 0.88 USD, net 14.12 USD, `exchange_rate` absent |
| capture replay, same PayPal-Request-Id | PASS | same capture id returned |
| void | PASS | response had a body with status `VOIDED` |
| reauthorize on day 0 | PASS (refused as expected) | 422 `UNPROCESSABLE_ENTITY`, issue `REAUTHORIZATION_TOO_SOON` |
| refund | PASS | status `COMPLETED`; body has `seller_payable_breakdown` |
| payouts | PASS | batch status `PENDING` |
| duplicate `sender_batch_id` | PASS (refused) | 400 `USER_BUSINESS_ERROR`, message "Batch with given sender_batch_id already exists" |
| payout batch readable | PASS | batch fetched, status read |

## Decisions

1. **Simulated fans:** use spec 6.3 option 1. A server-side card order (`intent: AUTHORIZE` with `payment_source.card`) works with no buyer login, so simulated fans can be real sandbox holds. It worked on the first test card; the fallback card was not needed. It also works on the Platform-type app.
2. **Order shape:** a card order comes back with status `COMPLETED` and `purchase_units[0].payments.authorizations[0]` straight away. No separate `/authorize` call is needed, so `authorize-order.json` does not exist. The authorization status is `CREATED` (not `PENDING`), and it carries `expiration_time` (29 days out).
3. **Idempotent capture replay:** yes. Replaying the capture with the same `PayPal-Request-Id` returned the same capture id (`capture-replay.json`).
4. **Reauthorize:** on day 0 PayPal returns 422 `UNPROCESSABLE_ENTITY` with issue `REAUTHORIZATION_TOO_SOON`. The error text says a reauthorization is allowed once from day 4 to day 29 after the original authorization; that text comes from the live API, and the docs page we fetched does not confirm it. Treat the day 4 to day 29 window as **unverified live until a hold is 4+ days old**. It is ALSO unverified whether a card authorization (as opposed to a PayPal-wallet one) can be reauthorized at all: a day-0 `REAUTHORIZATION_TOO_SOON` only proves the timing check ran first, not that the card path would pass the later checks.
5. **Payouts:** works with these keys. Create returns `batch_header.batch_status` `PENDING`. GET returns `batch_header` (`funding_source: BALANCE`, `amount`) and `items[]` with `transaction_status` `PENDING`. A duplicate `sender_batch_id` returns 400, name `USER_BUSINESS_ERROR`, message/issue text "Batch with given sender_batch_id already exists" (free text, not a code; match on that text or the `SENDER_BATCH_ID` field). The receiver is an unclaimed example address, so we have not seen a final state (`SUCCESS`, `UNCLAIMED`, etc.).
6. **Fees and refunds:**
   - Capture: `seller_receivable_breakdown` holds `gross_amount` 15.00 USD, `paypal_fee` 0.88 USD, `net_amount` 14.12 USD, no `exchange_rate`. On this US account everything is USD and net == gross - fee (15.00 - 0.88 = 14.12).
   - Refund: the body uses `seller_payable_breakdown` (not `seller_receivable_breakdown`). A `paypal_fee` field is present but 0.00 USD (the original 0.88 fee is not returned on a full refund). gross 15.00 USD, net 15.00 USD, `total_refunded_amount` 15.00 USD; top-level `amount` is 15.00 USD.

## First run (CAD account)

The first run used a sandbox merchant account in CAD. There `net_amount` was `(gross - fee) x exchange_rate` in CAD (CAD 19.17 at rate 1.34131725, with gross and fee in USD), so net did not equal gross - fee in one currency. The account was switched to a US sandbox account for this re-run, and fixtures were regenerated.

## Surprises

- Even on USD, still read `net_amount` and its `currency_code` from the response rather than assuming a subtraction; a non-USD seller account would produce a converted net with an `exchange_rate`.
- Refunds return the breakdown under `seller_payable_breakdown`, a different key from capture's `seller_receivable_breakdown`. Code that parses both must handle each name.
- Void returned a body, not an empty response, with timestamps in a `-07:00` offset while other responses use `Z`.
- `payout-duplicate` fixture has no stable error code to match on; match the `SENDER_BATCH_ID` field or the issue text.

# PayPal sandbox spike, 2026-10-05

Live run against `https://api-m.sandbox.paypal.com` (run id `spike-1791245968714`). Fixtures are in `tests/paypal/fixtures/` (personal fields redacted).

| Check | Result | Evidence |
|---|---|---|
| token | PASS | 200, sandbox OAuth token issued |
| card hold (server-side, no buyer login) | PASS | Visa test card `4111111111111111`; authorization status `CREATED`, expires about 29 days after creation |
| capture | PASS | status `COMPLETED`, `final_capture: true` |
| capture replay, same PayPal-Request-Id | PASS | same capture id returned |
| void | PASS | 200 with body, status `VOIDED` |
| reauthorize on day 0 | PASS (refused as expected) | 422 `UNPROCESSABLE_ENTITY`, issue `REAUTHORIZATION_TOO_SOON` |
| refund | PASS | status `COMPLETED` |
| payouts | PASS | batch status `PENDING`, no permission error |
| duplicate `sender_batch_id` | PASS (refused) | 400 `USER_BUSINESS_ERROR`, issue text "Batch with given sender_batch_id already exists", field `SENDER_BATCH_ID` |
| payout batch readable | PASS | GET after 5 s still `PENDING`; item `transaction_status` `PENDING` |

## Decisions

1. **Simulated fans:** use spec 6.3 option 1. A server-side card order (`intent: AUTHORIZE` with `payment_source.card`) works with no buyer login, so simulated fans can be real sandbox holds. Only the first test card was needed (the fallback card was never tried).
2. **Order shape:** a card order comes back with status `COMPLETED` and `purchase_units[0].payments.authorizations[0]` straight away. No separate `/authorize` call is needed, so `authorize-order.json` does not exist. The authorization status is `CREATED` (not `PENDING`), and it carries `expiration_time`.
3. **Idempotent capture replay:** yes. Replaying the capture with the same `PayPal-Request-Id` returned the same capture id (`capture-replay.json`).
4. **Reauthorize:** on day 0 PayPal returns 422 `UNPROCESSABLE_ENTITY` with issue `REAUTHORIZATION_TOO_SOON` and the description "A reauthorization is only allowed once from Day 4 to Day 29 since the date of the original authorization." That sentence comes from the live API response. Doc confirmation: **not confirmed from docs** (the fetched reference page at https://developer.paypal.com/docs/api/payments/v2/ lists the endpoint but not the rule). Treat the day 4 to day 29 window as **unverified live until a hold is 4+ days old**.
5. **Payouts:** works with these keys (no Payouts permission error). Create returns `batch_header.batch_status` `PENDING` plus a self link. GET returns `batch_header` (with `funding_source: BALANCE`, `amount`) and `items[]` with `transaction_status` `PENDING`. A duplicate `sender_batch_id` returns 400 `USER_BUSINESS_ERROR` with the issue text above (the issue is free text, not a code, and its `link` points at the existing batch). Receiver was an unclaimed example address, so we have not seen a final `SUCCESS` or `UNCLAIMED` state.
6. **Fees:** in the capture response, `seller_receivable_breakdown` holds `gross_amount` (USD 15.00), `paypal_fee` (USD 0.71), `net_amount` and `receivable_amount`, and `exchange_rate`.

## Surprises

- **Currency:** the sandbox merchant account is in CAD. `net_amount` and `receivable_amount` came back as CAD 19.17 (rate 1.34131725), while `gross_amount` and `paypal_fee` are USD. Net is NOT `gross - fee` in the same currency. Task 3-6 code must not compute net as a subtraction; read `net_amount` and check its `currency_code`.
- Void returned a body (not 204), with timestamps in a `-07:00` offset while other responses use `Z`.
- `payout-duplicate` fixture has no stable error code to match on; match the `SENDER_BATCH_ID` field or the issue text.

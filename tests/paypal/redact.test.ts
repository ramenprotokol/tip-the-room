import { expect, it } from "vitest";
import { redact } from "../../scripts/lib/redact";

it("redacts personal fields at any depth and keeps everything else", () => {
  const input = { id: "A1", payee: { email_address: "sb-x@business.example.com", merchant_id: "M1" }, list: [{ payer_id: "P", account_id: "Q", amount: "1.00" }] };
  expect(redact(input)).toEqual({ id: "A1", payee: { email_address: "REDACTED", merchant_id: "REDACTED" }, list: [{ payer_id: "REDACTED", account_id: "REDACTED", amount: "1.00" }] });
});

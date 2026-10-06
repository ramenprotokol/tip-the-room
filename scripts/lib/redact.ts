const PERSONAL = new Set(["email_address", "merchant_id", "payer_id", "account_id", "receiver", "phone_number", "national_number"]);

/** Deep copy with personal fields replaced by "REDACTED", for saving sandbox responses as test fixtures. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, PERSONAL.has(k) ? "REDACTED" : redact(v)]));
  }
  return value;
}

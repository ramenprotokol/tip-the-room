export interface PayPalIssue {
  issue: string;
  description?: string;
  field?: string;
}

/** Our own checks on a response that may already have succeeded, or that a retry cannot fix. */
const NOT_RETRYABLE = new Set(["UNEXPECTED_CURRENCY", "BAD_AMOUNT", "BAD_RESPONSE_BODY", "BAD_TOKEN_RESPONSE", "EMPTY_RESPONSE_BODY"]);

export class PayPalError extends Error {
  readonly status: number;
  readonly paypalName: string;
  readonly debugId?: string;
  readonly issues: PayPalIssue[];
  /** Set when the order already existed at PayPal but its answer was unreadable, so callers can look it up (GET). */
  orderId?: string;

  constructor(status: number, paypalName: string, message: string, debugId?: string, issues: PayPalIssue[] = []) {
    super(`PayPal ${status} ${paypalName}: ${message}${debugId ? ` (debug_id ${debugId})` : ""}`);
    this.name = "PayPalError";
    this.status = status;
    this.paypalName = paypalName;
    this.debugId = debugId;
    this.issues = issues;
  }

  /** Network failures (status 0), rate limits and PayPal-side errors are worth retrying with the same request id. */
  get retryable(): boolean {
    if (NOT_RETRYABLE.has(this.paypalName)) return false;
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  hasIssue(code: string): boolean {
    return this.issues.some((i) => i.issue === code);
  }
}

interface ErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: PayPalIssue[];
  error?: string;
  error_description?: string;
}

export async function errorFromResponse(res: Response): Promise<PayPalError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    // Non-JSON body: keep the status only.
  }
  const name = body.name ?? body.error ?? `HTTP_${res.status}`;
  const message = body.message ?? body.error_description ?? res.statusText ?? "request failed";
  return new PayPalError(res.status, name, message, body.debug_id, Array.isArray(body.details) ? body.details : []);
}

/** A 2xx with no body where we need one. The call may have succeeded, so callers reconcile instead of retrying blindly. */
export function requireBody<T>(body: T | undefined, what: string): T {
  if (body === undefined || body === null) throw new PayPalError(502, "EMPTY_RESPONSE_BODY", `PayPal returned no ${what}`);
  return body;
}

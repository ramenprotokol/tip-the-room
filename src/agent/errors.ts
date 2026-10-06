import type { ErrorCode } from "../worker/api-types";

/** A refusal with an HTTP status and a plain-English message that is safe to show. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly problems?: string[],
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

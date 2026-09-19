/**
 * Custom AI error classes (§7.5, §7.7).
 */

export class ModelUnavailableError extends Error {
  constructor(
    public readonly model: string,
    message?: string,
  ) {
    super(message ?? `Model "${model}" is unavailable (404 / not found).`);
    this.name = 'ModelUnavailableError';
  }
}

export class AuthenticationError extends Error {
  constructor(message?: string) {
    super(message ?? 'API authentication failed (HTTP 401/403: Invalid or missing API key).');
    this.name = 'AuthenticationError';
  }
}

export class DailyQuotaExhaustedError extends Error {
  constructor(
    message?: string,
    public readonly model?: string,
  ) {
    super(message ?? 'Daily API quota exhausted (RPD limit reached).');
    this.name = 'DailyQuotaExhaustedError';
  }
}

export class RpmLimitError extends Error {
  constructor(
    message?: string,
    public readonly model?: string,
  ) {
    super(message ?? 'Requests per minute (RPM) rate limit reached.');
    this.name = 'RpmLimitError';
  }
}

/**
 * A non-OK HTTP response, carrying the status and raw body so error
 * classification never has to scrape `String(err)`.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'HttpError';
  }
}

export class NoAvailableModelError extends Error {
  constructor(public readonly triedModels: string[]) {
    super(`All models in fallback chain failed: ${triedModels.join(', ')}.`);
    this.name = 'NoAvailableModelError';
  }
}

export class AiResponseValidationError extends Error {
  constructor(
    public readonly details: string,
    public readonly rawResponse?: string,
  ) {
    super(`AI response validation failed: ${details}`);
    this.name = 'AiResponseValidationError';
  }
}

/**
 * Thrown when a call is torn down by its own caller (match halted/abandoned) rather than by any
 * transport failure. Distinct from a plain `AbortError` so `classifyError` can tell "the network
 * timed out, try again" from "nobody wants this answer any more, stop" — the former is retryable,
 * the latter must never be retried into more billed calls for a game that already stopped.
 */
export class RequestCancelledError extends Error {
  constructor(message = 'request cancelled') {
    super(message);
    this.name = 'RequestCancelledError';
  }
}

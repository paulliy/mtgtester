/**
 * Exponential backoff with jitter and error classification (§7.5).
 */

import type { AiConfig } from './config';
import { AuthenticationError, DailyQuotaExhaustedError, ModelUnavailableError, RpmLimitError } from './errors';

/** Flattens an unknown error into the status + text we classify against. */
function errorFacts(err: unknown): { status: number | undefined; text: string } {
  const parts = [String(err)];
  let status: number | undefined;

  if (typeof err === 'object' && err !== null) {
    const e = err as { status?: number; statusCode?: number; message?: unknown; body?: unknown };
    status = e.status ?? e.statusCode;
    if (e.message !== undefined) parts.push(String(e.message));
    if (e.body !== undefined) parts.push(String(e.body));
  }

  return { status, text: parts.join('\n').toLowerCase() };
}

/**
 * True for any quota / rate-limit rejection, whether or not we can tell which
 * window it belongs to. Gemini reports both RPM, TPM, and RPD as 429 RESOURCE_EXHAUSTED.
 */
export function isQuotaError(err: unknown): boolean {
  const { status, text } = errorFacts(err);
  return (
    status === 429 ||
    text.includes('429') ||
    text.includes('resource_exhausted') ||
    text.includes('rate_limit') ||
    text.includes('too many requests') ||
    text.includes('quota')
  );
}

/**
 * True only when the payload identifies a genuinely **hard** barrier — a per-DAY quota, which
 * does not refill until tomorrow and so should retire the model for this game.
 *
 * The window matters, not the resource being metered. Gemini's per-minute token quota is
 * `GenerateTokensPerMinutePerProjectPerModel-FreeTier`: it refills in about a minute, exactly
 * like the per-minute *request* quota, and the caller's RPM path (cycle the chain, wait for the
 * bucket) already handles it correctly. Treating it as a hard barrier retired every model in the
 * chain and abandoned a game after five calls, reporting "daily quota exhausted" for a limit
 * that had already reset — so the per-minute test runs FIRST and wins, because that metric
 * name contains "token" and would otherwise read as a token barrier.
 */
export function isHardBarrierQuota(text: string): boolean {
  const isPerMinute =
    text.includes('perminute') ||
    text.includes('per_minute') ||
    text.includes('per minute') ||
    text.includes('rpm') ||
    text.includes('tpm');
  if (isPerMinute) return false;

  return (
    text.includes('perday') ||
    text.includes('per_day') ||
    text.includes('requests per day') ||
    text.includes('daily') ||
    text.includes('rpd')
  );
}

export function classifyError(
  err: unknown,
): 'model_unavailable' | 'daily_quota' | 'rpm_quota' | 'retryable' | 'fatal' {
  if (err instanceof AuthenticationError) return 'fatal';
  if (err instanceof ModelUnavailableError) return 'model_unavailable';
  if (err instanceof DailyQuotaExhaustedError) return 'daily_quota';
  if (err instanceof RpmLimitError) return 'rpm_quota';

  const { status, text } = errorFacts(err);

  if (status === 401 || status === 403 || text.includes('api_key_invalid') || text.includes('unauthenticated')) {
    return 'fatal';
  }

  // Model unavailable (404, model_not_found)
  if (status === 404 || text.includes('404') || text.includes('not_found')) {
    return 'model_unavailable';
  }

  /**
   * A JSON-mode provider that rejects its own malformed generation. Groq returns
   * `HTTP 400 json_validate_failed` instead of handing back the unparseable content, so this
   * never reaches `validateResponse` — which only ever sees a body that arrived successfully.
   *
   * It is a stochastic generation failure, not a permanent one: the same prompt usually
   * succeeds on the next attempt. Classifying it `fatal` (the default for an unrecognized
   * 400) killed a game at turn 22.
   */
  if (text.includes('json_validate_failed') || text.includes('failed to validate json')) {
    return 'retryable';
  }

  if (isQuotaError(err)) {
    return isHardBarrierQuota(text) ? 'daily_quota' : 'rpm_quota';
  }

  // Server errors (500, 502, 503, 504)
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return 'retryable';
  }

  return 'fatal';
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Pick<AiConfig, 'maxRetries' | 'baseBackoffMs' | 'maxBackoffMs'>,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const category = classifyError(err);

      if (category === 'model_unavailable') {
        const modelName = err instanceof ModelUnavailableError ? err.model : 'unknown';
        throw new ModelUnavailableError(modelName, String(err));
      }

      if (category === 'daily_quota') {
        throw new DailyQuotaExhaustedError(String(err));
      }

      if (category === 'rpm_quota') {
        throw new RpmLimitError(String(err));
      }

      attempt++;
      if (attempt > config.maxRetries || category === 'fatal') {
        throw err;
      }

      // Exponential backoff + jitter: min(base * 2^(attempt-1) + jitter, maxBackoff)
      const baseDelay = config.baseBackoffMs * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 500);
      const delay = Math.min(baseDelay + jitter, config.maxBackoffMs);

      await sleepFn(delay);
    }
  }
}

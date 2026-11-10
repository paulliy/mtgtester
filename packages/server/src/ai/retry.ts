/**
 * Exponential backoff with jitter and error classification (§7.5).
 */

import type { AiConfig } from './config';
import { DEFAULT_AI_CONFIG } from './config';
import {
  AiResponseValidationError,
  AuthenticationError,
  DailyQuotaExhaustedError,
  ModelUnavailableError,
  RequestCancelledError,
  RpmLimitError,
  RequestTimeoutError,
} from './errors';

/** Flattens an unknown error into the status + text we classify against. */
function errorFacts(err: unknown): { status: number | undefined; text: string } {
  const parts = [String(err)];
  let status: number | undefined;

  if (typeof err === 'object' && err !== null) {
    const e = err as {
      status?: number;
      statusCode?: number;
      name?: unknown;
      code?: unknown;
      message?: unknown;
      body?: unknown;
      cause?: unknown;
    };
    status = e.status ?? e.statusCode;
    // `name`, `code`, and `cause` are where a transport failure keeps its identity: a
    // `TimeoutError` DOMException carries nothing else, and `fetch` buries the real reason
    // for "TypeError: fetch failed" in `cause`.
    if (e.name !== undefined) parts.push(String(e.name));
    if (e.code !== undefined) parts.push(String(e.code));
    if (e.message !== undefined) parts.push(String(e.message));
    if (e.body !== undefined) parts.push(String(e.body));
    if (e.cause !== undefined) parts.push(String(e.cause));
  }

  return { status, text: parts.join('\n').toLowerCase() };
}

/**
 * A transport failure — the request timed out, the socket dropped, DNS blipped. These carry no
 * HTTP status, so they fell through to the `fatal` default and retired the decision after a
 * single attempt; every one of them is worth trying again.
 */
export function isTransportError(err: unknown): boolean {
  const { status, text } = errorFacts(err);
  if (status !== undefined) return false;
  return (
    text.includes('timeouterror') ||
    text.includes('aborterror') ||
    text.includes('the operation was aborted') ||
    text.includes('timed out') ||
    text.includes('fetch failed') ||
    text.includes('network error') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('etimedout') ||
    text.includes('enotfound') ||
    text.includes('socket hang up')
  );
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
):
  | 'model_unavailable'
  | 'daily_quota'
  | 'rpm_quota'
  | 'retryable'
  | 'retryable_generation'
  | 'fatal' {
  if (err instanceof AuthenticationError) return 'fatal';
  if (err instanceof ModelUnavailableError) return 'model_unavailable';
  if (err instanceof DailyQuotaExhaustedError) return 'daily_quota';
  if (err instanceof RpmLimitError) return 'rpm_quota';
  // A deliberate cancellation (match halted/abandoned), not a transport hiccup — retrying it
  // would just place more billed calls for a game nobody is waiting on any more.
  if (err instanceof RequestCancelledError) return 'fatal';
  // Our own deadline: retrying pays for the slow answer again (ADR 0040). Fall back instead.
  if (err instanceof RequestTimeoutError) return err.retryable ? 'retryable' : 'fatal';

  /**
   * The call succeeded and the model answered — the answer was just not something we could
   * read (truncated JSON, prose instead of an object, an empty completion). That is a
   * stochastic generation failure, not a permanent one, and the same prompt usually works on
   * the next attempt; as `fatal` it burned the whole decision on one unlucky sample.
   */
  if (err instanceof AiResponseValidationError) return 'retryable_generation';

  const { status, text } = errorFacts(err);

  if (
    status === 401 ||
    status === 403 ||
    text.includes('api_key_invalid') ||
    text.includes('unauthenticated')
  ) {
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
    return 'retryable_generation';
  }

  if (isQuotaError(err)) {
    return isHardBarrierQuota(text) ? 'daily_quota' : 'rpm_quota';
  }

  // Server errors (500, 502, 503, 504)
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return 'retryable';
  }

  if (isTransportError(err)) return 'retryable';

  return 'fatal';
}

/**
 * Generation failures get a tighter budget than transport failures. A model that cannot
 * produce readable JSON twice usually cannot produce it on the sixth try either, every
 * attempt is a full-price call, and the provider's corrective retry (§7.7 step 1) — which
 * shows the model its own bad output — is the better next move anyway.
 */
const GENERATION_RETRY_CAP = 2;

/**
 * A plain function call, not inlined at each call site: TS's control-flow narrowing otherwise
 * treats `signal.aborted` as permanently `false` after the first exclusionary check in a
 * function, even across an `await` where the signal legitimately flips to `true` in between.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Pick<AiConfig, 'maxRetries' | 'baseBackoffMs' | 'maxBackoffMs'>,
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  /** When aborted, stop immediately rather than spend a backoff cycle discovering it via `fn()`. */
  signal?: AbortSignal,
): Promise<T> {
  // A missing or non-numeric budget must not read as "retry forever": every comparison
  // against `undefined` is false, so the loop below would never find its exit.
  const maxRetries = Number.isFinite(config.maxRetries)
    ? Math.max(0, config.maxRetries)
    : DEFAULT_AI_CONFIG.maxRetries;

  let attempt = 0;
  let generationAttempt = 0;
  for (;;) {
    if (isAborted(signal)) throw new RequestCancelledError();
    try {
      return await fn();
    } catch (err) {
      if (isAborted(signal)) throw new RequestCancelledError();
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

      if (category === 'fatal') {
        throw err;
      }

      let step: number;
      if (category === 'retryable_generation') {
        generationAttempt++;
        if (generationAttempt > Math.min(maxRetries, GENERATION_RETRY_CAP)) throw err;
        step = generationAttempt;
      } else {
        attempt++;
        if (attempt > maxRetries) throw err;
        step = attempt;
      }

      // Exponential backoff + jitter: min(base * 2^(step-1) + jitter, maxBackoff)
      const baseDelay = config.baseBackoffMs * Math.pow(2, step - 1);
      const jitter = Math.floor(Math.random() * 500);
      const delay = Math.min(baseDelay + jitter, config.maxBackoffMs);

      await sleepFn(delay);
    }
  }
}

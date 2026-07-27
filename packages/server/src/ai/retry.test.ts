import { describe, expect, it, vi } from 'vitest';
import { classifyError, withRetry } from './retry';
import {
  AiResponseValidationError,
  DailyQuotaExhaustedError,
  HttpError,
  ModelUnavailableError,
  RpmLimitError,
} from './errors';

/** Verbatim shape of a Gemini free-tier RPD rejection. */
const GEMINI_RPD_BODY = JSON.stringify([
  {
    error: {
      code: 429,
      message:
        'You exceeded your current quota, please check your plan and billing details. ' +
        'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
        'limit: 500, model: gemini-3.5-flash-lite\nPlease retry in 34.708978074s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
              quotaValue: '500',
            },
          ],
        },
      ],
    },
  },
]);

const GEMINI_RPM_BODY = GEMINI_RPD_BODY.replace(
  'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
  'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
);

const GEMINI_TPM_BODY = GEMINI_RPD_BODY.replace(
  'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
  'GenerateTokensPerMinutePerProjectPerModel-FreeTier',
);

describe('Error Classification & Retry', () => {
  it('classifies errors accurately', () => {
    expect(classifyError(new ModelUnavailableError('m1'))).toBe('model_unavailable');
    expect(classifyError({ status: 404 })).toBe('model_unavailable');
    expect(classifyError(new DailyQuotaExhaustedError())).toBe('daily_quota');
    expect(classifyError({ status: 429 })).toBe('rpm_quota');
    expect(classifyError({ status: 503 })).toBe('retryable');
    expect(classifyError(new Error('something bad'))).toBe('fatal');
  });

  it('classifies a Gemini per-day quota rejection as daily_quota (hard barrier)', () => {
    expect(classifyError(new HttpError(429, GEMINI_RPD_BODY))).toBe('daily_quota');
  });

  // A per-minute TOKEN quota refills in about a minute, exactly like a per-minute request
  // quota — the window is what decides recoverability, not the resource being metered.
  // Classifying it as a hard barrier would retire a model from the chain for a whole game
  // over a limit that clears in seconds. (This was a latent bug: the failure that prompted
  // the audit turned out to be a genuine per-DAY exhaustion, asserted in the test above.)
  it('classifies a Gemini per-minute token quota rejection (TPM) as rpm_quota (recoverable)', () => {
    expect(classifyError(new HttpError(429, GEMINI_TPM_BODY))).toBe('rpm_quota');
  });

  it('still treats a per-DAY token quota as a hard barrier', () => {
    const perDayTokens = GEMINI_RPD_BODY.replace(
      'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
      'GenerateTokensPerDayPerProjectPerModel-FreeTier',
    );
    expect(classifyError(new HttpError(429, perDayTokens))).toBe('daily_quota');
  });

  it('classifies per-minute request quota rejections as rpm_quota', () => {
    expect(classifyError(new HttpError(429, GEMINI_RPM_BODY))).toBe('rpm_quota');
  });

  it('treats a provider rejecting its own malformed JSON as retryable, not fatal', () => {
    // Groq returns this instead of handing back unparseable content, so it never reaches
    // `validateResponse`. Classified fatal (the default for an unrecognized 400) it ended a
    // real game at turn 22; it is a stochastic generation failure and usually succeeds next try.
    const body =
      '{"error":{"message":"Failed to validate JSON. Please adjust your prompt.",' +
      '"type":"invalid_request_error","code":"json_validate_failed","failed_generation":""}}';
    expect(classifyError(new HttpError(400, body))).toBe('retryable_generation');
  });

  // Same failure seen from the other side: the provider handed the content back and we could
  // not read it. `fatal` spent the entire decision on one unlucky sample.
  it('treats an unreadable completion as a retryable generation failure', () => {
    expect(classifyError(new AiResponseValidationError('Invalid JSON format', '{"actionId":'))).toBe(
      'retryable_generation',
    );
    expect(classifyError(new AiResponseValidationError('Empty content received'))).toBe(
      'retryable_generation',
    );
  });

  it('retries a generation failure, but on a tighter budget than a server error', async () => {
    const fn = vi.fn().mockRejectedValue(new AiResponseValidationError('Invalid JSON format'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(fn, { maxRetries: 6, baseBackoffMs: 10, maxBackoffMs: 100 }, sleep),
    ).rejects.toThrow(AiResponseValidationError);

    // The 6-retry budget belongs to transport failures; an unreadable answer gets 2.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // A timeout from `AbortSignal.timeout` and a dropped socket carry no HTTP status, so they
  // fell through to `fatal` and retired the decision on the first attempt.
  it('classifies transport failures as retryable', () => {
    const timeout = new DOMException('The operation was aborted', 'TimeoutError');
    expect(classifyError(timeout)).toBe('retryable');
    expect(classifyError(new TypeError('fetch failed'))).toBe('retryable');
    expect(classifyError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(
      'retryable',
    );
  });

  it('never loops forever when the retry budget is missing from the config', async () => {
    const fn = vi.fn().mockRejectedValue(new AiResponseValidationError('Invalid JSON format'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(
        fn,
        { baseBackoffMs: 10, maxBackoffMs: 100 } as unknown as Parameters<typeof withRetry>[1],
        sleep,
      ),
    ).rejects.toThrow(AiResponseValidationError);

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not back off on an exhausted daily quota (hard barrier)', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(429, GEMINI_RPD_BODY));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(fn, { maxRetries: 6, baseBackoffMs: 10, maxBackoffMs: 100 }, sleep),
    ).rejects.toThrow(DailyQuotaExhaustedError);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws RpmLimitError immediately on RPM so client can fall back without delay', async () => {
    const fn = vi.fn().mockRejectedValue(new HttpError(429, GEMINI_RPM_BODY));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      withRetry(fn, { maxRetries: 2, baseBackoffMs: 10, maxBackoffMs: 100 }, sleep),
    ).rejects.toThrow(RpmLimitError);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on retryable server errors up to maxRetries', async () => {
    let attempts = 0;
    const dummyFn = async () => {
      attempts++;
      if (attempts < 3) {
        throw { status: 503, message: 'service unavailable' };
      }
      return 'ok';
    };

    const dummySleep = vi.fn().mockResolvedValue(undefined);
    const result = await withRetry(dummyFn, { maxRetries: 5, baseBackoffMs: 10, maxBackoffMs: 100 }, dummySleep);

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(dummySleep).toHaveBeenCalledTimes(2);
  });

  it('throws ModelUnavailableError immediately without retry', async () => {
    const fn = async () => {
      throw { status: 404, message: 'model not found' };
    };

    await expect(withRetry(fn, { maxRetries: 3, baseBackoffMs: 10, maxBackoffMs: 100 })).rejects.toThrow(
      ModelUnavailableError,
    );
  });
});

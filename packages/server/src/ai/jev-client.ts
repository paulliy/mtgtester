import { OpenRouter } from '@openrouter/sdk';
import type { AiAttemptObserver, AiNetworkAttempt } from './client';
import type { JevActionRequest, JevChoiceAnswer, JevDecisionsRequest } from './jev-context';

export interface JevDecisionsTransport {
  create(
    request: { decisionsRequest: JevDecisionsRequest },
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  requestTimeoutMs: number;
}

export interface JevCallMeta {
  requestedModel: string;
  responseModel: string;
  provider?: string;
  providerRequestId?: string;
  promptTokens: number;
  responseTokens: number;
  costUsd?: number;
  latencyMs: number;
  rawResponse: string;
}

export interface JevActionResult {
  answer: JevChoiceAnswer;
  meta: JevCallMeta;
}

export class JevResponseValidationError extends Error {
  constructor(
    readonly details: string,
    readonly rawResponse: string,
  ) {
    super(`Invalid Jev response: ${details}`);
    this.name = 'JevResponseValidationError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseResponse(value: unknown): {
  answer: JevChoiceAnswer;
  responseModel: string;
  provider?: string;
  providerRequestId?: string;
  promptTokens: number;
  responseTokens: number;
  costUsd?: number;
} {
  const rawResponse = JSON.stringify(value);
  const fail = (details: string): never => {
    throw new JevResponseValidationError(details, rawResponse);
  };
  if (!record(value)) return fail('response must be an object');
  if (typeof value['model'] !== 'string' || value['model'].length === 0) {
    return fail('response model is required');
  }
  const answers = value['answers'];
  if (!record(answers)) return fail('answers must be an object');
  const action = answers['action'];
  if (!record(action) || action['type'] !== 'choice') {
    return fail('answers.action must be a choice answer');
  }
  if (typeof action['choice'] !== 'string') return fail('action choice must be a string');
  // The Decisions API marks confidence and probabilities optional; absent is not malformed.
  const confidence = action['confidence'];
  if (confidence !== undefined && (!finiteNonNegative(confidence) || confidence > 1)) {
    return fail('action confidence must be a finite value from 0 to 1');
  }
  const rawProbabilities = action['probabilities'];
  if (rawProbabilities !== undefined && !record(rawProbabilities)) {
    return fail('action probabilities must be an object');
  }
  let probabilities: Record<string, number> | undefined;
  if (rawProbabilities !== undefined) {
    probabilities = {};
    for (const [key, probability] of Object.entries(rawProbabilities)) {
      if (!finiteNonNegative(probability) || probability > 1) {
        return fail(`probability for ${key} must be a finite value from 0 to 1`);
      }
      probabilities[key] = probability;
    }
  }
  const usage = value['usage'];
  if (!record(usage)) return fail('usage must be an object');
  if (!finiteNonNegative(usage['inputTokens']) || !finiteNonNegative(usage['outputTokens'])) {
    return fail('usage token counts must be finite non-negative numbers');
  }
  if (usage['cost'] !== undefined && !finiteNonNegative(usage['cost'])) {
    return fail('usage cost must be a finite non-negative number when present');
  }

  return {
    answer: {
      type: 'choice',
      choice: action['choice'],
      ...(confidence === undefined ? {} : { confidence }),
      ...(probabilities === undefined ? {} : { probabilities }),
    },
    responseModel: value['model'],
    ...(typeof value['provider'] === 'string' ? { provider: value['provider'] } : {}),
    ...(typeof value['id'] === 'string' ? { providerRequestId: value['id'] } : {}),
    promptTokens: usage['inputTokens'],
    responseTokens: usage['outputTokens'],
    ...(typeof usage['cost'] === 'number' ? { costUsd: usage['cost'] } : {}),
  };
}

export class OpenRouterJevTransport implements JevDecisionsTransport {
  private readonly client: OpenRouter;

  constructor(options: JevClientOptions) {
    this.client = new OpenRouter({
      apiKey: options.apiKey,
      ...(options.baseUrl === undefined ? {} : { serverURL: options.baseUrl }),
      timeoutMs: options.requestTimeoutMs,
      retryConfig: { strategy: 'none' },
    });
  }

  async create(
    request: { decisionsRequest: JevDecisionsRequest },
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    return await this.client.alpha.decisions.create(request, options);
  }
}

/** Dedicated typed-decisions client. It intentionally does not implement the chat `AiClient`. */
export class JevClient {
  private readonly transport: JevDecisionsTransport;
  private readonly attemptCountsByRequest = new Map<string, number>();
  private attemptObserver: AiAttemptObserver | undefined;

  constructor(
    private readonly options: JevClientOptions,
    transport?: JevDecisionsTransport,
    attemptObserver?: AiAttemptObserver,
  ) {
    this.transport = transport ?? new OpenRouterJevTransport(options);
    this.attemptObserver = attemptObserver;
  }

  setAttemptObserver(observer: AiAttemptObserver | undefined): void {
    this.attemptObserver = observer;
  }

  async requestAction(built: JevActionRequest, signal?: AbortSignal): Promise<JevActionResult> {
    const attemptIndex = this.attemptCountsByRequest.get(built.logicalRequestId) ?? 0;
    this.attemptCountsByRequest.set(built.logicalRequestId, attemptIndex + 1);
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    let raw: unknown;
    let recorded = false;
    const recordAttempt = async (
      attempt: Pick<AiNetworkAttempt, 'status' | 'usage'> &
        Partial<
          Pick<
            AiNetworkAttempt,
            'responseModel' | 'backend' | 'providerRequestId' | 'rawResponse' | 'error'
          >
        >,
    ): Promise<void> => {
      if (recorded) return;
      recorded = true;
      if (this.attemptObserver === undefined) return;
      const endedMs = Date.now();
      await this.attemptObserver({
        schemaVersion: 1,
        kind: 'decision',
        logicalRequestId: built.logicalRequestId,
        attemptIndex,
        requestedModel: built.request.model,
        startedAt,
        endedAt: new Date(endedMs).toISOString(),
        durationMs: endedMs - startedMs,
        messages: [],
        decisionRequest: built.request,
        effectiveConfig: {
          endpoint: 'alpha/decisions',
          model: built.request.model,
          timeoutMs: this.options.requestTimeoutMs,
          retryStrategy: 'none',
        },
        ...attempt,
      });
    };

    try {
      raw = await this.transport.create(
        { decisionsRequest: built.request },
        {
          timeoutMs: this.options.requestTimeoutMs,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const parsed = parseResponse(raw);
      await recordAttempt({
        status: 'accepted',
        responseModel: parsed.responseModel,
        ...(parsed.provider === undefined ? {} : { backend: parsed.provider }),
        ...(parsed.providerRequestId === undefined
          ? {}
          : { providerRequestId: parsed.providerRequestId }),
        rawResponse: JSON.stringify(raw),
        usage: {
          promptTokens: parsed.promptTokens,
          responseTokens: parsed.responseTokens,
          ...(parsed.costUsd === undefined ? {} : { costUsd: parsed.costUsd }),
          promptTokenSource: 'reported',
          responseTokenSource: 'reported',
          costSource: parsed.costUsd === undefined ? 'unknown' : 'reported',
          cacheStatus: 'unknown',
        },
      });
      return {
        answer: parsed.answer,
        meta: {
          requestedModel: built.request.model,
          responseModel: parsed.responseModel,
          ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
          ...(parsed.providerRequestId === undefined
            ? {}
            : { providerRequestId: parsed.providerRequestId }),
          promptTokens: parsed.promptTokens,
          responseTokens: parsed.responseTokens,
          ...(parsed.costUsd === undefined ? {} : { costUsd: parsed.costUsd }),
          latencyMs: Date.now() - startedMs,
          rawResponse: JSON.stringify(raw),
        },
      };
    } catch (error) {
      await recordAttempt({
        status: error instanceof JevResponseValidationError ? 'rejected' : 'transport_error',
        ...(raw === undefined ? {} : { rawResponse: JSON.stringify(raw) }),
        error: error instanceof Error ? error.message : String(error),
        usage: {
          promptTokenSource: 'unknown',
          responseTokenSource: 'unknown',
          costSource: 'unknown',
          cacheStatus: 'unknown',
        },
      });
      throw error;
    }
  }
}

/**
 * Provider-agnostic OpenAI-compatible Client Abstraction (§7.2, §7.3).
 * Interacts with any OpenAI Chat Completions API endpoint (Groq, DeepSeek, Gemini OpenAI endpoint, OpenAI, OpenRouter, local Ollama).
 */

import type { DecisionRequest, DecisionResponse } from '@mtg/shared';
import type { AiConfig } from './config';
import type { AiPrompt } from './context';
import type { ContextBudgetReport } from './context-budget';
import type { PromptCacheMetadata } from './prompt-cache';
import {
  AiResponseValidationError,
  AuthenticationError,
  DailyQuotaExhaustedError,
  HttpError,
  ModelUnavailableError,
  NoAvailableModelError,
  RequestCancelledError,
  RpmLimitError,
} from './errors';
import { DEFAULT_AI_CONFIG } from './config';
import { getNonCachingProviders } from './openrouter-provider-filter';
import { withRetry } from './retry';

export interface CallMeta {
  model: string;
  /** Model requested on the successful attempt; kept separate from response-reported identity. */
  requestedModel?: string;
  responseModel?: string;
  backend?: string;
  providerRequestId?: string;
  finishReason?: string;
  promptTokens: number;
  responseTokens: number;
  promptTokenSource?: 'reported' | 'estimated' | 'unknown';
  responseTokenSource?: 'reported' | 'estimated' | 'unknown';
  latencyMs: number;
  wasRetry: boolean;
  wasFallback: boolean;
  rawResponse: string;
  /** Provider-reported request cost when the OpenAI-compatible endpoint supplies it. */
  costUsd?: number;
  costSource?: 'reported' | 'estimated' | 'unknown' | 'not_applicable';
  contextReport?: ContextBudgetReport;
  promptCache?: PromptCacheMetadata;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheStatus?: 'observed_hit' | 'observed_miss' | 'unknown';
}

export type AiAttemptStatus = 'accepted' | 'rejected' | 'http_error' | 'transport_error';

/** One physical provider request. Corrective retries and transport retries are separate rows. */
export interface AiNetworkAttempt {
  schemaVersion: 1;
  kind?: 'chat' | 'decision';
  logicalRequestId: string;
  attemptIndex: number;
  requestedModel: string;
  responseModel?: string;
  backend?: string;
  providerRequestId?: string;
  status: AiAttemptStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  messages: AiPrompt['messages'];
  decisionRequest?: unknown;
  effectiveConfig: Record<string, unknown>;
  contextReport?: ContextBudgetReport;
  promptCache?: PromptCacheMetadata;
  rawResponse?: string;
  finishReason?: string;
  error?: string;
  usage: {
    promptTokens?: number;
    responseTokens?: number;
    costUsd?: number;
    promptTokenSource: 'reported' | 'estimated' | 'unknown';
    responseTokenSource: 'reported' | 'estimated' | 'unknown';
    costSource: 'reported' | 'estimated' | 'unknown';
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheStatus?: 'observed_hit' | 'observed_miss' | 'unknown';
  };
  /** Present only for benchmark artifacts so combined reports can attribute physical attempts. */
  benchmark?: {
    runId: string;
    variantId: string;
    caseId: string;
    trial: number;
    role: 'tactician' | 'strategist';
    mode: 'raw' | 'production';
  };
}

export type AiAttemptObserver = (attempt: AiNetworkAttempt) => void | Promise<void>;

/**
 * Effort levels the wire accepts. `max` is this project's vocabulary, not the API's — the
 * OpenAI-compatible enum stops at `high`, and sending `max` is a 400 on every provider.
 */
const WIRE_EFFORT: Record<Exclude<AiConfig['reasoningEffort'], 'none'>, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',
};

/**
 * `max_tokens` bounds reasoning tokens and answer tokens TOGETHER. A thinking model given the
 * answer budget alone can spend all of it mid-thought and return empty `content`, so a
 * reasoning run gets headroom on top of the budget the answer itself needs.
 */
/**
 * The reasoning controls for one request. Vendors spell this two different ways and the two
 * spellings must never both appear: OpenRouter folds a top-level `reasoning_effort` into
 * `reasoning.effort`, so a body carrying `reasoning_effort` *and* `reasoning.max_tokens`
 * collides with itself and every single request comes back
 * `400 Only one of "reasoning.effort" and "reasoning.max_tokens" can be specified`.
 */
export function reasoningParams(
  config: Pick<AiConfig, 'reasoningEnabled' | 'reasoningEffort'>,
  isOpenRouter: boolean,
): Record<string, unknown> {
  const effort = config.reasoningEffort ?? 'low';
  const on = config.reasoningEnabled === true && effort !== 'none';

  if (isOpenRouter) {
    // OpenRouter's unified object. `effort` and `max_tokens` are mutually exclusive here, so
    // only ever one of them goes on the wire — and "off" is `enabled: false`, never
    // `max_tokens: 0`, which is out of range and rejected on its own.
    return { reasoning: on ? { effort: WIRE_EFFORT[effort], exclude: true } : { enabled: false } };
  }

  // Every other OpenAI-compatible vendor takes `reasoning_effort` and rejects body fields it
  // does not recognise, so there is nothing portable to send when reasoning is off: omit it.
  return on ? { reasoning_effort: WIRE_EFFORT[effort] } : {};
}

export interface AiClient {
  readonly activeModel: string;
  setAttemptObserver?(observer: AiAttemptObserver | undefined): void;
  requestDecision(
    prompt: AiPrompt,
    request: DecisionRequest,
    /** Aborts the call (and skips further retries/model fallback) once the caller stops waiting. */
    signal?: AbortSignal,
  ): Promise<{ response: DecisionResponse; meta: CallMeta }>;
}

export class OpenAiCompatibleClient implements AiClient {
  private modelIndex = 0;
  private readonly hardBarrierModels = new Set<string>();
  private readonly attemptCountsByRequest = new Map<string, number>();
  private attemptObserver: AiAttemptObserver | undefined;

  constructor(
    private readonly config: AiConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleepImpl: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    attemptObserver?: AiAttemptObserver,
  ) {
    this.attemptObserver = attemptObserver;
  }

  setAttemptObserver(observer: AiAttemptObserver | undefined): void {
    this.attemptObserver = observer;
  }

  get activeModel(): string {
    return this.config.models[this.modelIndex] ?? 'gemini-3.5-flash-lite';
  }

  private advanceModelIndex(): void {
    if (this.config.models.length === 0) return;
    this.modelIndex = (this.modelIndex + 1) % this.config.models.length;
  }

  private resolveEndpoint(): string {
    const base = this.config.baseUrl.endsWith('/')
      ? this.config.baseUrl
      : `${this.config.baseUrl}/`;
    return base.endsWith('chat/completions/') ? base.slice(0, -1) : `${base}chat/completions`;
  }

  async requestDecision(
    prompt: AiPrompt,
    request: DecisionRequest,
    signal?: AbortSignal,
  ): Promise<{ response: DecisionResponse; meta: CallMeta }> {
    const endpoint = this.resolveEndpoint();
    const rpmModelsThisAttempt = new Set<string>();
    let rpmWaitCycles = 0;
    let lastHardError: Error | null = null;

    for (;;) {
      if (signal?.aborted === true) throw new RequestCancelledError();
      const availableModels = this.config.models.filter((m) => !this.hardBarrierModels.has(m));

      if (availableModels.length === 0) {
        if (lastHardError instanceof DailyQuotaExhaustedError) {
          throw new DailyQuotaExhaustedError(
            `Daily quota exhausted for every model in the chain (${this.config.models.join(', ')}). ` +
              `Quotas reset at midnight Pacific; last error: ${lastHardError.message}`,
          );
        }
        throw new NoAvailableModelError(this.config.models);
      }

      const nonRpmAvailable = availableModels.filter((m) => !rpmModelsThisAttempt.has(m));
      if (nonRpmAvailable.length === 0) {
        rpmWaitCycles++;
        if (rpmWaitCycles > 2) {
          throw new DailyQuotaExhaustedError(
            `Rate limits / RPM ceiling persisted across multiple reset cycles for all models (${availableModels.join(', ')}).`,
          );
        }
        console.warn(
          `  ⚠ All available models (${availableModels.join(', ')}) hit RPM ceiling — waiting 60s for RPM reset (cycle ${rpmWaitCycles}/2)...`,
        );
        await this.sleepImpl(60000);
        rpmModelsThisAttempt.clear();
        continue;
      }

      let currentModel = this.activeModel;
      if (this.hardBarrierModels.has(currentModel) || rpmModelsThisAttempt.has(currentModel)) {
        currentModel = nonRpmAvailable[0]!;
        this.modelIndex = this.config.models.indexOf(currentModel);
      }

      const startTime = Date.now();
      const isOpenRouter = this.config.baseUrl.includes('openrouter.ai');
      const ignoreProviders =
        isOpenRouter &&
        this.config.filterNonCachingProviders !== false &&
        currentModel.includes('/')
          ? await getNonCachingProviders(currentModel, this.fetchImpl, this.config.baseUrl)
          : [];

      try {
        const metaResult = await withRetry(
          async () => {
            const thisAttempt = this.attemptCountsByRequest.get(request.requestId) ?? 0;
            this.attemptCountsByRequest.set(request.requestId, thisAttempt + 1);
            const attemptStartedMs = Date.now();
            const startedAt = new Date(attemptStartedMs).toISOString();
            let attemptRecorded = false;
            let attemptRawResponse: string | undefined;
            let attemptResponseModel: string | undefined;
            let attemptBackend: string | undefined;
            let attemptProviderRequestId: string | undefined;
            let attemptFinishReason: string | undefined;
            let attemptUsage: AiNetworkAttempt['usage'] = {
              promptTokenSource: 'unknown',
              responseTokenSource: 'unknown',
              costSource: 'unknown',
              cacheStatus: 'unknown',
            };
            const reasoningOn =
              this.config.reasoningEnabled === true && this.config.reasoningEffort !== 'none';
            const answerTokens = this.config.maxOutputTokens ?? DEFAULT_AI_CONFIG.maxOutputTokens;

            const bodyPayload: Record<string, unknown> = {
              model: currentModel,
              messages: prompt.messages,
              temperature: 0.1,
              max_tokens: reasoningOn
                ? answerTokens + (this.config.reasoningTokenHeadroom ?? 0)
                : answerTokens,
              response_format: { type: 'json_object' },
              ...reasoningParams(this.config, isOpenRouter),
            };
            if (isOpenRouter) {
              const provider: Record<string, unknown> = {};
              if (ignoreProviders.length > 0) provider['ignore'] = ignoreProviders;
              if (this.config.preferredMaxLatencySeconds > 0) {
                provider['preferred_max_latency'] = this.config.preferredMaxLatencySeconds;
              }
              if (this.config.preferredMinThroughput > 0) {
                provider['preferred_min_throughput'] = this.config.preferredMinThroughput;
              }
              if (Object.keys(provider).length > 0) bodyPayload['provider'] = provider;
            }
            const effectiveConfig = {
              endpoint,
              model: currentModel,
              temperature: bodyPayload['temperature'],
              maxTokens: bodyPayload['max_tokens'],
              responseFormat: bodyPayload['response_format'],
              reasoning: bodyPayload['reasoning'] ?? bodyPayload['reasoning_effort'] ?? 'omitted',
              provider: bodyPayload['provider'] ?? 'default',
              promptCache: prompt.promptCache ?? 'disabled',
              timeoutMs: this.config.requestTimeoutMs ?? DEFAULT_AI_CONFIG.requestTimeoutMs,
            };
            const recordAttempt = async (
              attempt: Omit<
                AiNetworkAttempt,
                | 'schemaVersion'
                | 'logicalRequestId'
                | 'attemptIndex'
                | 'requestedModel'
                | 'startedAt'
                | 'endedAt'
                | 'durationMs'
                | 'messages'
                | 'effectiveConfig'
              >,
            ): Promise<void> => {
              if (attemptRecorded) return;
              attemptRecorded = true;
              if (this.attemptObserver === undefined) return;
              const endedMs = Date.now();
              await this.attemptObserver({
                schemaVersion: 1,
                logicalRequestId: request.requestId,
                attemptIndex: thisAttempt,
                requestedModel: currentModel,
                startedAt,
                endedAt: new Date(endedMs).toISOString(),
                durationMs: endedMs - attemptStartedMs,
                messages: prompt.messages,
                effectiveConfig,
                ...(prompt.contextReport === undefined
                  ? {}
                  : { contextReport: prompt.contextReport }),
                ...(prompt.promptCache === undefined ? {} : { promptCache: prompt.promptCache }),
                ...attempt,
              });
            };

            try {
              const timeoutSignal = AbortSignal.timeout(
                this.config.requestTimeoutMs ?? DEFAULT_AI_CONFIG.requestTimeoutMs,
              );
              const res = await this.fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
                },
                body: JSON.stringify(bodyPayload),
                signal:
                  signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
              });

              if (!res.ok) {
                const errorText = await res.text();
                attemptRawResponse = errorText;
                await recordAttempt({
                  status: 'http_error',
                  rawResponse: errorText,
                  error: `HTTP ${res.status}`,
                  usage: {
                    promptTokenSource: 'unknown',
                    responseTokenSource: 'unknown',
                    costSource: 'unknown',
                    cacheStatus: 'unknown',
                  },
                });
                if (
                  res.status === 401 ||
                  res.status === 403 ||
                  errorText.includes('API_KEY_INVALID') ||
                  errorText.includes('UNAUTHENTICATED') ||
                  errorText.includes('invalid_api_key')
                ) {
                  throw new AuthenticationError(
                    `API authentication failed (HTTP ${res.status}): ${errorText}`,
                  );
                }
                if (
                  res.status === 404 ||
                  errorText.includes('model_not_found') ||
                  errorText.includes('NOT_FOUND')
                ) {
                  throw new ModelUnavailableError(currentModel, errorText);
                }
                throw new HttpError(res.status, errorText);
              }

              const data = (await res.json()) as {
                id?: string;
                model?: string;
                provider?: string;
                choices?: Array<{
                  finish_reason?: string;
                  message?: { content?: string; reasoning?: string; reasoning_content?: string };
                }>;
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  cost?: number;
                  prompt_tokens_details?: { cached_tokens?: number };
                  cache_read_input_tokens?: number;
                  cache_write_input_tokens?: number;
                };
              };

              const choice = data.choices?.[0];
              const message = choice?.message;
              attemptResponseModel = data.model;
              attemptBackend = data.provider;
              attemptProviderRequestId = data.id;
              attemptFinishReason = choice?.finish_reason;
              /**
               * A thinking model that runs out of budget mid-thought returns empty `content` with
               * everything it wrote in `reasoning` — and the decision JSON is usually in there.
               * Reading it back is free and turns a dead call into an answered one.
               */
              const rawContent =
                (message?.content ?? '').trim().length > 0
                  ? (message?.content as string)
                  : (message?.reasoning ?? message?.reasoning_content ?? '');

              attemptRawResponse = rawContent;
              const promptTokenSource =
                typeof data.usage?.prompt_tokens === 'number' ? 'reported' : 'estimated';
              const responseTokenSource =
                typeof data.usage?.completion_tokens === 'number' ? 'reported' : 'estimated';
              const cacheReadTokens =
                data.usage?.cache_read_input_tokens ??
                data.usage?.prompt_tokens_details?.cached_tokens;
              const cacheWriteTokens = data.usage?.cache_write_input_tokens;
              const cacheStatus =
                cacheReadTokens === undefined && cacheWriteTokens === undefined
                  ? 'unknown'
                  : (cacheReadTokens ?? 0) > 0
                    ? 'observed_hit'
                    : 'observed_miss';
              attemptUsage = {
                promptTokens: data.usage?.prompt_tokens ?? prompt.estimatedTokens,
                responseTokens: data.usage?.completion_tokens ?? Math.ceil(rawContent.length / 4),
                ...(typeof data.usage?.cost === 'number' ? { costUsd: data.usage.cost } : {}),
                promptTokenSource,
                responseTokenSource,
                costSource: typeof data.usage?.cost === 'number' ? 'reported' : 'unknown',
                ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
                ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
                cacheStatus,
              };
              if (!rawContent.trim()) {
                const finish = choice?.finish_reason;
                throw new AiResponseValidationError(
                  `Empty content received from AI provider` +
                    (finish !== undefined ? ` (finish_reason: ${finish})` : ''),
                  rawContent,
                );
              }

              const latencyMs = Date.now() - startTime;
              const parsed = parseJsonResponse(rawContent, request);
              await recordAttempt({
                status: 'accepted',
                ...(data.model !== undefined ? { responseModel: data.model } : {}),
                ...(data.provider !== undefined ? { backend: data.provider } : {}),
                ...(data.id !== undefined ? { providerRequestId: data.id } : {}),
                rawResponse: rawContent,
                ...(choice?.finish_reason !== undefined
                  ? { finishReason: choice.finish_reason }
                  : {}),
                usage: attemptUsage,
              });

              const meta: CallMeta = {
                model: currentModel,
                requestedModel: currentModel,
                ...(data.model !== undefined ? { responseModel: data.model } : {}),
                ...(data.provider !== undefined ? { backend: data.provider } : {}),
                ...(data.id !== undefined ? { providerRequestId: data.id } : {}),
                ...(choice?.finish_reason !== undefined
                  ? { finishReason: choice.finish_reason }
                  : {}),
                promptTokens: data.usage?.prompt_tokens ?? prompt.estimatedTokens,
                responseTokens: data.usage?.completion_tokens ?? Math.ceil(rawContent.length / 4),
                promptTokenSource,
                responseTokenSource,
                latencyMs,
                wasRetry: false,
                wasFallback: false,
                rawResponse: rawContent,
                ...(typeof data.usage?.cost === 'number' ? { costUsd: data.usage.cost } : {}),
                costSource: typeof data.usage?.cost === 'number' ? 'reported' : 'unknown',
                ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
                ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
                cacheStatus,
                ...(prompt.contextReport === undefined
                  ? {}
                  : { contextReport: prompt.contextReport }),
                ...(prompt.promptCache === undefined ? {} : { promptCache: prompt.promptCache }),
              };

              return { response: parsed, meta };
            } catch (error) {
              const status: AiAttemptStatus =
                error instanceof HttpError
                  ? 'http_error'
                  : error instanceof AiResponseValidationError
                    ? 'rejected'
                    : 'transport_error';
              await recordAttempt({
                status,
                ...(attemptResponseModel !== undefined
                  ? { responseModel: attemptResponseModel }
                  : {}),
                ...(attemptBackend !== undefined ? { backend: attemptBackend } : {}),
                ...(attemptProviderRequestId !== undefined
                  ? { providerRequestId: attemptProviderRequestId }
                  : {}),
                ...(attemptFinishReason !== undefined ? { finishReason: attemptFinishReason } : {}),
                ...(attemptRawResponse !== undefined ? { rawResponse: attemptRawResponse } : {}),
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                usage: attemptUsage,
              });
              throw error;
            }
          },
          this.config,
          undefined,
          signal,
        );

        return metaResult;
      } catch (err) {
        if (err instanceof ModelUnavailableError || err instanceof DailyQuotaExhaustedError) {
          lastHardError = err;
          const reason =
            err instanceof DailyQuotaExhaustedError ? 'daily quota exhausted' : 'unavailable';
          this.hardBarrierModels.add(currentModel);
          this.advanceModelIndex();
          console.warn(`  ⚠ ${currentModel} ${reason} — falling back to ${this.activeModel}`);
          continue;
        }

        if (err instanceof RpmLimitError) {
          rpmModelsThisAttempt.add(currentModel);
          this.advanceModelIndex();
          console.warn(`  ⚠ ${currentModel} hit RPM — falling back to ${this.activeModel}`);
          continue;
        }

        throw err;
      }
    }
  }
}

/** Keys models have been observed to use for the chosen action, in order of preference. */
const ACTION_ID_KEYS = [
  'actionId',
  'action_id',
  'action',
  'choice',
  'id',
  'selected_action',
  'index',
  'actionIndex',
  'action_index',
  'decision',
] as const;

/** Every balanced `{...}` slice in `text`, outermost first, string- and escape-aware. */
function* balancedObjects(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        if (inString) escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          yield text.slice(i, j + 1);
          break;
        }
      }
    }
  }
}

/**
 * Pull the decision object out of whatever the model wrapped it in — markdown fences, a prose
 * preamble, or reasoning text that itself contains braces.
 *
 * The greedy `/\{[\s\S]*\}/` this replaces spanned from the first brace anywhere in the reply
 * to the last brace anywhere in it, so one sentence like "I considered {A} and {B}" made an
 * otherwise perfect fenced response unparseable. Fenced blocks are tried first, then every
 * balanced object in reading order, and an object that actually names an action wins over an
 * earlier one that parses but says nothing (a model narrating its thinking in JSON).
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(raw); m !== null; m = fence.exec(raw)) {
    const body = m[1];
    if (body !== undefined) candidates.push(body);
  }
  candidates.push(raw);

  let firstParsed: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    for (const slice of balancedObjects(candidate)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(slice);
      } catch {
        continue; // Not the object — keep scanning.
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;

      const obj = parsed as Record<string, unknown>;
      if (ACTION_ID_KEYS.some((k) => obj[k] !== undefined)) return obj;
      firstParsed ??= obj;
    }
  }
  return firstParsed;
}

/** Helper to strip markdown code blocks, extract JSON object, and parse JSON response. */
function parseJsonResponse(raw: string, request: DecisionRequest): DecisionResponse {
  const obj = extractJsonObject(raw);
  if (obj === null) {
    throw new AiResponseValidationError('No JSON object {...} found in AI response', raw);
  }

  const key = ACTION_ID_KEYS.find((k) => obj[k] !== undefined);
  const rawActionId = key === undefined ? undefined : obj[key];

  let actionId =
    typeof rawActionId === 'number'
      ? Math.floor(rawActionId)
      : Number.parseInt(String(rawActionId), 10);

  if (Number.isNaN(actionId) && typeof rawActionId === 'string') {
    const rawStr = rawActionId.trim().toLowerCase();
    const matched = request.legalActions.find(
      (a) =>
        a.description.trim().toLowerCase() === rawStr ||
        a.type.trim().toLowerCase() === rawStr ||
        a.description.trim().toLowerCase().includes(rawStr) ||
        rawStr.includes(a.description.trim().toLowerCase()),
    );
    if (matched !== undefined) {
      actionId = matched.id;
    }
  }

  if (Number.isNaN(actionId)) {
    throw new AiResponseValidationError('Missing or invalid actionId in response', raw);
  }

  const response: DecisionResponse = {
    requestId: (obj['requestId'] as string) || request.requestId,
    actionId,
  };

  if (Array.isArray(obj['targets'])) {
    response.targets = obj['targets'];
  }
  if (Array.isArray(obj['plannedActions'])) {
    response.plannedActions = obj['plannedActions'];
  }
  if (
    typeof obj['manaSplit'] === 'object' &&
    obj['manaSplit'] !== null &&
    !Array.isArray(obj['manaSplit'])
  ) {
    response.manaSplit = obj['manaSplit'] as Record<string, number>;
  }
  if (
    typeof obj['combatDamageSplit'] === 'object' &&
    obj['combatDamageSplit'] !== null &&
    !Array.isArray(obj['combatDamageSplit'])
  ) {
    response.combatDamageSplit = obj['combatDamageSplit'] as Record<string, number>;
  }
  if (
    typeof obj['turnStrategy'] === 'object' &&
    obj['turnStrategy'] !== null &&
    !Array.isArray(obj['turnStrategy'])
  ) {
    response.turnStrategy = obj['turnStrategy'] as NonNullable<DecisionResponse['turnStrategy']>;
  }
  if (typeof obj['note'] === 'string') {
    response.note = obj['note'];
  }

  return response;
}

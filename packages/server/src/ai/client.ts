/**
 * Provider-agnostic OpenAI-compatible Client Abstraction (§7.2, §7.3).
 * Interacts with any OpenAI Chat Completions API endpoint (Groq, DeepSeek, Gemini OpenAI endpoint, OpenAI, OpenRouter, local Ollama).
 */

import type { DecisionRequest, DecisionResponse } from '@mtg/shared';
import type { AiConfig } from './config';
import type { AiPrompt } from './context';
import {
  AiResponseValidationError,
  AuthenticationError,
  DailyQuotaExhaustedError,
  HttpError,
  ModelUnavailableError,
  NoAvailableModelError,
  RpmLimitError,
} from './errors';
import { DEFAULT_AI_CONFIG } from './config';
import { getNonCachingProviders } from './openrouter-provider-filter';
import { withRetry } from './retry';

export interface CallMeta {
  model: string;
  promptTokens: number;
  responseTokens: number;
  latencyMs: number;
  wasRetry: boolean;
  wasFallback: boolean;
  rawResponse: string;
}

export interface AiClient {
  readonly activeModel: string;
  requestDecision(
    prompt: AiPrompt,
    request: DecisionRequest,
  ): Promise<{ response: DecisionResponse; meta: CallMeta }>;
}

export class OpenAiCompatibleClient implements AiClient {
  private modelIndex = 0;
  private readonly hardBarrierModels = new Set<string>();

  constructor(
    private readonly config: AiConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleepImpl: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

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
    return base.endsWith('chat/completions/')
      ? base.slice(0, -1)
      : `${base}chat/completions`;
  }

  async requestDecision(
    prompt: AiPrompt,
    request: DecisionRequest,
  ): Promise<{ response: DecisionResponse; meta: CallMeta }> {
    const endpoint = this.resolveEndpoint();
    const rpmModelsThisAttempt = new Set<string>();
    let rpmWaitCycles = 0;
    let lastHardError: Error | null = null;

    for (;;) {
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
        const metaResult = await withRetry(async () => {
          const bodyPayload: Record<string, unknown> = {
            model: currentModel,
            messages: prompt.messages,
            temperature: 0.1,
            response_format: { type: 'json_object' },
          };
          if (ignoreProviders.length > 0) {
            bodyPayload['provider'] = { ignore: ignoreProviders };
          }

          const res = await this.fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
            },
            body: JSON.stringify(bodyPayload),
            signal: AbortSignal.timeout(
              this.config.requestTimeoutMs ?? DEFAULT_AI_CONFIG.requestTimeoutMs,
            ),
          });

          if (!res.ok) {
            const errorText = await res.text();
            if (
              res.status === 401 ||
              res.status === 403 ||
              errorText.includes('API_KEY_INVALID') ||
              errorText.includes('UNAUTHENTICATED') ||
              errorText.includes('invalid_api_key')
            ) {
              throw new AuthenticationError(`API authentication failed (HTTP ${res.status}): ${errorText}`);
            }
            if (res.status === 404 || errorText.includes('model_not_found') || errorText.includes('NOT_FOUND')) {
              throw new ModelUnavailableError(currentModel, errorText);
            }
            throw new HttpError(res.status, errorText);
          }

          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };

          const rawContent = data.choices?.[0]?.message?.content ?? '';
          if (!rawContent.trim()) {
            throw new AiResponseValidationError('Empty content received from AI provider', rawContent);
          }

          const latencyMs = Date.now() - startTime;
          const parsed = parseJsonResponse(rawContent, request);

          const meta: CallMeta = {
            model: currentModel,
            promptTokens: data.usage?.prompt_tokens ?? prompt.estimatedTokens,
            responseTokens: data.usage?.completion_tokens ?? Math.ceil(rawContent.length / 4),
            latencyMs,
            wasRetry: false,
            wasFallback: false,
            rawResponse: rawContent,
          };

          return { response: parsed, meta };
        }, this.config);

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

/** Helper to strip markdown code blocks, extract JSON object, and parse JSON response. */
function parseJsonResponse(raw: string, request: DecisionRequest): DecisionResponse {
  let cleaned = raw.trim();

  // Extract JSON object if surrounded by markdown code fences or conversational text
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match !== null) {
    cleaned = match[0];
  } else {
    throw new AiResponseValidationError('No JSON object {...} found in AI response', raw);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new AiResponseValidationError(`Invalid JSON format: ${String(err)}`, raw);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new AiResponseValidationError('Response JSON is not an object', raw);
  }

  const obj = parsed as Record<string, unknown>;
  const rawActionId =
    obj['actionId'] ??
    obj['action_id'] ??
    obj['action'] ??
    obj['choice'] ??
    obj['id'] ??
    obj['selected_action'] ??
    obj['index'] ??
    obj['actionIndex'] ??
    obj['action_index'] ??
    obj['decision'];

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
  if (typeof obj['note'] === 'string') {
    response.note = obj['note'];
  }

  return response;
}

/**
 * The lineup: which players sit in the tested seat. A model entry is run through the production
 * tactician pipeline itself (`OpenAiDecisionProvider`: prompt assembly, primer, parser, validator,
 * corrective retry, heuristic fallback), so the benchmark measures what a live game would get and
 * follows that code when it changes. Local entries cost nothing and give a floor and a reference.
 */
import { readFileSync } from 'node:fs';
import { HeuristicDecisionProvider } from '../../packages/bot/src';
import { RandomDecisionProvider, chooseFirst, type Engine } from '../../packages/engine/src';
import {
  OpenAiCompatibleClient,
  type AiNetworkAttempt,
  type CallMeta,
} from '../../packages/server/src/ai/client';
import {
  PROVIDERS,
  configForRole,
  loadAiConfig,
  type AiConfig,
} from '../../packages/server/src/ai/config';
import {
  AiCallLogger,
  type CallResult,
  type DecisionSource,
} from '../../packages/server/src/ai/logger';
import { OpenAiDecisionProvider } from '../../packages/server/src/ai/provider';
import { RequestQueue } from '../../packages/server/src/ai/queue';
import type { DecisionRequest } from '../../packages/shared/src';
import type { BenchCase } from './case';
import {
  localActor,
  type Actor,
  type ActorAnswer,
  type ActorFactory,
  type AnswerSource,
} from './play';

export type LocalPolicy = 'heuristic' | 'first-legal' | 'random';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface LocalEntry {
  id: string;
  label?: string;
  kind: 'local';
  policy: LocalPolicy;
}

export interface LlmEntry {
  id: string;
  label?: string;
  kind: 'llm';
  /** A provider preset from `ai/config.ts` (openrouter, groq, gemini, deepseek, openai). */
  provider?: string;
  /** Any OpenAI-compatible endpoint; overrides the preset's. */
  baseUrl?: string;
  /** The environment variable that holds the key; overrides the preset's. Never the key itself. */
  apiKeyEnv?: string;
  model: string;
  /** Thinking effort; `none` (the tactician default) turns reasoning off. */
  reasoning?: ReasoningEffort;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  /** USD per million tokens, used only when the provider does not report a cost. */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
}

export type LineupEntry = LocalEntry | LlmEntry;

/** `raw`: every decision goes to the model. `production`: dominated decisions are answered locally first. */
export type RunMode = 'raw' | 'production';

const ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function entryError(index: number, message: string): never {
  throw new Error(`lineup entry ${index + 1}: ${message}`);
}

/** Validate a lineup file's entries. Unknown fields are refused so a typo cannot change a run. */
export function parseLineup(json: unknown): LineupEntry[] {
  const list =
    typeof json === 'object' && json !== null && 'models' in json
      ? (json as { models: unknown }).models
      : json;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error('a lineup is a non-empty list of models');
  const entries: LineupEntry[] = [];
  list.forEach((raw: unknown, index) => {
    if (typeof raw !== 'object' || raw === null) entryError(index, 'must be an object');
    const entry = raw as Record<string, unknown>;
    const allowed =
      entry['kind'] === 'local'
        ? ['id', 'label', 'kind', 'policy']
        : [
            'id',
            'label',
            'kind',
            'provider',
            'baseUrl',
            'apiKeyEnv',
            'model',
            'reasoning',
            'maxOutputTokens',
            'requestTimeoutMs',
            'pricing',
          ];
    for (const key of Object.keys(entry))
      if (!allowed.includes(key)) entryError(index, `unknown field "${key}"`);
    if (typeof entry['id'] !== 'string' || !ID_PATTERN.test(entry['id']))
      entryError(index, 'id must be lowercase letters, digits, dots and hyphens');
    if (entries.some((existing) => existing.id === entry['id']))
      entryError(index, `repeats id ${entry['id']}`);
    if (entry['kind'] === 'local') {
      if (!['heuristic', 'first-legal', 'random'].includes(entry['policy'] as string))
        entryError(index, 'policy must be heuristic, first-legal or random');
    } else if (entry['kind'] === 'llm') {
      if (typeof entry['model'] !== 'string' || entry['model'] === '')
        entryError(index, 'model must be a non-empty string');
      if (entry['provider'] !== undefined && PROVIDERS[entry['provider'] as string] === undefined)
        entryError(index, `provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
      if (
        entry['reasoning'] !== undefined &&
        !['none', 'low', 'medium', 'high'].includes(entry['reasoning'] as string)
      )
        entryError(index, 'reasoning must be none, low, medium or high');
      for (const key of ['maxOutputTokens', 'requestTimeoutMs'])
        if (
          entry[key] !== undefined &&
          !(Number.isSafeInteger(entry[key]) && (entry[key] as number) > 0)
        )
          entryError(index, `${key} must be a positive whole number`);
      const pricing = entry['pricing'] as Record<string, unknown> | undefined;
      if (
        pricing !== undefined &&
        !(
          typeof pricing === 'object' &&
          pricing !== null &&
          typeof pricing['inputPerMTok'] === 'number' &&
          typeof pricing['outputPerMTok'] === 'number' &&
          pricing['inputPerMTok'] >= 0 &&
          pricing['outputPerMTok'] >= 0
        )
      )
        entryError(index, 'pricing needs inputPerMTok and outputPerMTok in USD');
    } else {
      entryError(index, 'kind must be local or llm');
    }
    entries.push(entry as unknown as LineupEntry);
  });
  return entries;
}

export function loadLineupFile(path: string): LineupEntry[] {
  return parseLineup(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * `--models` shorthand, comma separated: `local:heuristic`, `openrouter:vendor/model`,
 * `groq:model-name`, each optionally followed by `@low|medium|high` for reasoning.
 */
export function parseModelList(text: string): LineupEntry[] {
  const entries = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part): Record<string, unknown> => {
      const colon = part.indexOf(':');
      if (colon <= 0) throw new Error(`"${part}" must be provider:model or local:policy`);
      const provider = part.slice(0, colon);
      const [model = '', effort] = part.slice(colon + 1).split('@');
      if (provider === 'local') return { id: `local-${model}`, kind: 'local', policy: model };
      return {
        id: slug(effort === undefined ? model : `${model}-${effort}`),
        kind: 'llm',
        provider,
        model,
        ...(effort !== undefined && { reasoning: effort }),
      };
    });
  return parseLineup(entries);
}

export function entryLabel(entry: LineupEntry): string {
  if (entry.label !== undefined) return entry.label;
  if (entry.kind === 'local') return `${entry.policy} (local, no model)`;
  return entry.reasoning !== undefined && entry.reasoning !== 'none'
    ? `${entry.model} (reasoning ${entry.reasoning})`
    : entry.model;
}

/** What is safe to print about an entry: everything but where its key comes from. */
export function publicEntry(entry: LineupEntry): Record<string, unknown> {
  if (entry.kind === 'local') return { ...entry, label: entryLabel(entry) };
  const { apiKeyEnv: _apiKeyEnv, ...rest } = entry;
  return { ...rest, label: entryLabel(entry) };
}

/** Records how the production provider answered each request, in memory only. */
class CapturingLogger extends AiCallLogger {
  private readonly byRequest = new Map<string, { source: DecisionSource; meta: CallMeta }>();

  constructor(gameId: string) {
    super(null, gameId);
  }

  override log(
    request: DecisionRequest,
    result: CallResult,
    wasRetry: boolean,
    wasFallback: boolean,
    source: DecisionSource = 'primary',
  ): void {
    super.log(request, result, wasRetry, wasFallback, source);
    this.byRequest.set(request.requestId, { source, meta: result.meta });
  }

  take(requestId: string): { source: DecisionSource; meta: CallMeta } | undefined {
    const entry = this.byRequest.get(requestId);
    this.byRequest.delete(requestId);
    return entry;
  }
}

const SOURCE: Partial<Record<DecisionSource, AnswerSource>> = {
  primary: 'model',
  retry: 'model-retry',
  fallback: 'fallback',
  heuristic: 'heuristic',
  cache: 'cache',
  plan: 'plan',
};

export interface LlmRuntime {
  env: Record<string, string | undefined>;
  mode: RunMode;
  /** Test seam: every provider request goes through this instead of the network. */
  fetchImpl?: typeof fetch;
  /** Test seam: how the client waits between retries. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Called for every physical provider request, for the transcript. */
  onAttempt?: (attempt: AiNetworkAttempt, context: { caseId: string }) => void;
}

/** The effective tactician configuration for one model, with the key resolved but never logged. */
export function resolveLlmConfig(entry: LlmEntry, runtime: LlmRuntime): AiConfig {
  const base = loadAiConfig(runtime.env);
  const role = configForRole(base, 'tactician');
  const preset = entry.provider === undefined ? undefined : PROVIDERS[entry.provider];
  const keyEnv = entry.apiKeyEnv ?? preset?.keyEnv;
  const apiKey = keyEnv === undefined ? base.apiKey : (runtime.env[keyEnv] ?? '');
  const baseUrl = entry.baseUrl ?? preset?.baseUrl ?? base.baseUrl;
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(baseUrl);
  if (apiKey === '' && !local && runtime.fetchImpl === undefined)
    throw new Error(
      `${entry.id}: no API key (set ${keyEnv ?? 'a provider key such as OPENROUTER_API_KEY'} in the environment or .env)`,
    );
  const reasoning = entry.reasoning ?? (role.reasoningEnabled ? role.reasoningEffort : 'none');
  return {
    ...role,
    baseUrl,
    apiKey,
    models: [entry.model],
    reasoningEnabled: reasoning !== 'none',
    reasoningEffort: reasoning === 'max' ? 'high' : reasoning,
    // A thinking model needs room to think before its answer (the client adds this on top).
    reasoningTokenHeadroom:
      reasoning === 'none'
        ? role.reasoningTokenHeadroom
        : Math.max(role.reasoningTokenHeadroom, 4000),
    ...(entry.maxOutputTokens !== undefined && { maxOutputTokens: entry.maxOutputTokens }),
    ...(entry.requestTimeoutMs !== undefined && { requestTimeoutMs: entry.requestTimeoutMs }),
    // The benchmark measures the tactician alone, and one model at a time. The model plays every
    // tactical decision itself: AI_TACTICAL_MODE=bot (ADR 0039) would hand them to the bot and
    // quietly benchmark the bot instead.
    tacticalMode: 'model',
    strategistEnabled: false,
    heuristicsEnabled: runtime.mode === 'production',
    decisionCacheEnabled: false,
    filterNonCachingProviders: false,
    jevEnabled: false,
    jevShadowEnabled: false,
    strategyRouterShadowEnabled: false,
  };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** A model in the tested seat, played through the production provider. */
export function llmActorFactory(entry: LlmEntry, runtime: LlmRuntime): ActorFactory {
  const config = resolveLlmConfig(entry, runtime);
  // One queue per model, shared by its cases: the client-side rate limit is per model.
  const queue = new RequestQueue({ rpmLimit: config.rpmLimit, concurrency: 1 });
  return (engine: Engine, benchCase: BenchCase): Actor => {
    let attempts: AiNetworkAttempt[] = [];
    const client = new OpenAiCompatibleClient(
      config,
      runtime.fetchImpl,
      runtime.sleepImpl,
      (attempt) => {
        attempts.push(attempt);
        runtime.onAttempt?.(attempt, { caseId: benchCase.id });
      },
    );
    const logger = new CapturingLogger(`bot-bench-${benchCase.id}`);
    const provider = new OpenAiDecisionProvider(client, queue, engine, config, logger);
    return {
      async decide(request): Promise<ActorAnswer> {
        attempts = [];
        const started = performance.now();
        const response = await provider.decide(request);
        const latencyMs = round(performance.now() - started, 1);
        const logged = logger.take(request.requestId);
        const source = (logged && SOURCE[logged.source]) ?? 'model';

        const promptTokens = attempts.reduce((sum, a) => sum + (a.usage.promptTokens ?? 0), 0);
        const responseTokens = attempts.reduce((sum, a) => sum + (a.usage.responseTokens ?? 0), 0);
        const reported = attempts.filter((attempt) => attempt.usage.costUsd !== undefined);
        let costUsd: number | undefined;
        let costSource: ActorAnswer['costSource'] = 'unknown';
        if (attempts.length === 0) {
          costUsd = 0;
          costSource = 'not_applicable';
        } else if (
          reported.length ===
            attempts.filter((a) => a.status === 'accepted' || a.status === 'rejected').length &&
          reported.length > 0
        ) {
          costUsd = reported.reduce((sum, attempt) => sum + (attempt.usage.costUsd ?? 0), 0);
          costSource = 'reported';
        } else if (entry.pricing !== undefined) {
          costUsd =
            (promptTokens * entry.pricing.inputPerMTok +
              responseTokens * entry.pricing.outputPerMTok) /
            1_000_000;
          costSource = 'estimated';
        }

        const last = attempts.at(-1);
        const answered = attempts.some((attempt) => attempt.status === 'accepted');
        const failure =
          source === 'fallback'
            ? attempts.length > 0 && !answered && attempts.every((a) => a.status !== 'rejected')
              ? `provider error: ${last?.error ?? 'no response'}`
              : `no legal answer: ${last?.error ?? logged?.meta.rawResponse.slice(0, 200) ?? 'model failed'}`
            : undefined;
        return {
          response,
          source,
          latencyMs,
          requests: attempts.length,
          costSource,
          ...(attempts.length > 0 && { promptTokens, responseTokens }),
          ...(costUsd !== undefined && { costUsd: round(costUsd, 8) }),
          ...(last?.rawResponse !== undefined && { raw: last.rawResponse }),
          ...(failure !== undefined && { failure }),
        };
      },
    };
  };
}

/** A free local player: the heuristic bot (the production fallback), first legal option, or random. */
export function localActorFactory(entry: LocalEntry): ActorFactory {
  return (engine, benchCase) => {
    if (entry.policy === 'heuristic') {
      const bot = new HeuristicDecisionProvider(`bot-bench-actor:${benchCase.id}`, () =>
        engine.view(benchCase.actor),
      );
      return localActor('local', (request) => bot.decide(request));
    }
    if (entry.policy === 'random') {
      const random = new RandomDecisionProvider(`bot-bench-actor:${benchCase.id}`);
      return localActor('local', (request) => random.decide(request));
    }
    const first = chooseFirst();
    return localActor('local', (request) => first(request));
  };
}

export function actorFactory(entry: LineupEntry, runtime: LlmRuntime): ActorFactory {
  return entry.kind === 'local' ? localActorFactory(entry) : llmActorFactory(entry, runtime);
}

/**
 * The lineup: which players sit in the tested seat. A chat model entry (`llm`) is run through the
 * production tactician pipeline itself (`OpenAiDecisionProvider`: prompt assembly, primer, parser,
 * validator, corrective retry, heuristic fallback), so the benchmark measures what a live game
 * would get and follows that code when it changes. A decision model entry (`decision`) is run
 * through the production typed-decision lane instead (`JevActionPolicy` and `JevClient`: the
 * compact state, one Choice option per legal action, target expansion, the answer adapter and the
 * validator), the same code that puts Jev in a live seat (ADRs 0041, 0046). Local entries cost
 * nothing and give a floor and a reference.
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
import { tryHeuristic } from '../../packages/server/src/ai/heuristics';
import { JevClient, type JevDecisionsTransport } from '../../packages/server/src/ai/jev-client';
import { JevActionPolicy } from '../../packages/server/src/ai/jev-policy';
import { OPENROUTER_BASE_URL } from '../../packages/server/src/ai/jev-runtime';
import { OpenAiDecisionProvider } from '../../packages/server/src/ai/provider';
import { RequestQueue } from '../../packages/server/src/ai/queue';
import { JEV_MAX_CHOICE_OPTIONS } from '../../packages/server/src/ai/tactical-decision-shape';
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

/**
 * What a decision model's seat does with a decision it cannot express as one typed Choice
 * (declaring attackers or blockers, combat damage, X, modes, ordering, distributions).
 * `bot`: the heuristic bot answers it, as a live decision-model seat does (ADR 0041's `jev`
 * preset), and the run says so. `hold`: the seat holds still, so only the model's own answers
 * count.
 */
export type UnsupportedPolicy = 'bot' | 'hold';

export interface DecisionEntry {
  id: string;
  label?: string;
  kind: 'decision';
  /** A Decisions API model, e.g. `typesafe/jev-1.14` or `google/gemini-decision-1`. */
  model: string;
  /** A Decisions API server; defaults to OpenRouter. */
  baseUrl?: string;
  /** The environment variable that holds the key. Default: AI_JEV_API_KEY, then OPENROUTER_API_KEY. */
  apiKeyEnv?: string;
  requestTimeoutMs?: number;
  /** USD per million tokens, used only when the provider does not report a cost. */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  /** Offer a targeted action once per legal target (ADR 0041). Default: true. */
  expandTargets?: boolean;
  /** Default: `bot`. */
  unsupported?: UnsupportedPolicy;
}

export type LineupEntry = LocalEntry | LlmEntry | DecisionEntry;

/** Entries that call a remote model and are scored as candidates. */
export function isRemoteKind(kind: string): boolean {
  return kind === 'llm' || kind === 'decision';
}

/**
 * A decision model's request timeout when the lineup does not set one. The production Jev lane
 * uses 2 s (`jevRequestTimeoutMs`); a benchmark run from a laptop allows for a slow first call.
 */
export const DEFAULT_DECISION_TIMEOUT_MS = 10_000;

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
        : entry['kind'] === 'decision'
          ? [
              'id',
              'label',
              'kind',
              'model',
              'baseUrl',
              'apiKeyEnv',
              'requestTimeoutMs',
              'pricing',
              'expandTargets',
              'unsupported',
            ]
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
    } else if (entry['kind'] === 'llm' || entry['kind'] === 'decision') {
      if (typeof entry['model'] !== 'string' || entry['model'] === '')
        entryError(index, 'model must be a non-empty string');
      if (entry['kind'] === 'decision') {
        if (
          entry['unsupported'] !== undefined &&
          !['bot', 'hold'].includes(entry['unsupported'] as string)
        )
          entryError(index, 'unsupported must be bot or hold');
        if (entry['expandTargets'] !== undefined && typeof entry['expandTargets'] !== 'boolean')
          entryError(index, 'expandTargets must be true or false');
      }
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
      entryError(index, 'kind must be local, llm or decision');
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
 * `groq:model-name`, each optionally followed by `@low|medium|high` for reasoning, and
 * `decision:vendor/model` for a Decisions API model, optionally followed by `@hold` (or `@bot`,
 * the default) for what happens to a decision it cannot express.
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
      if (provider === 'decision')
        return {
          id: slug(effort === undefined ? model : `${model}-${effort}`),
          kind: 'decision',
          model,
          ...(effort !== undefined && { unsupported: effort }),
        };
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
  if (entry.kind === 'decision')
    return entry.unsupported === 'hold'
      ? `${entry.model} (decision model, holds on combat)`
      : `${entry.model} (decision model)`;
  return entry.reasoning !== undefined && entry.reasoning !== 'none'
    ? `${entry.model} (reasoning ${entry.reasoning})`
    : entry.model;
}

/** What is safe to print about an entry: everything but where its key comes from. */
export function publicEntry(entry: LineupEntry): Record<string, unknown> {
  if (entry.kind === 'local') return { ...entry, label: entryLabel(entry) };
  if (entry.kind === 'decision') {
    const { apiKeyEnv: _apiKeyEnv, ...rest } = entry;
    // The effective server and settings, so a blind bundle can redact the host and a reader can
    // see how the seat was configured.
    return {
      ...rest,
      baseUrl: entry.baseUrl ?? OPENROUTER_BASE_URL,
      expandTargets: entry.expandTargets ?? true,
      unsupported: entry.unsupported ?? 'bot',
      label: entryLabel(entry),
    };
  }
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
  /** Test seam: every Decisions API request goes through this instead of the network. */
  decisionTransport?: JevDecisionsTransport;
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

/**
 * What a decision's provider requests cost. An attempt may have been billed once a generation
 * started: it was answered, or it got a generation id or token counts before failing (a timeout
 * or a broken stream, which the client records for later settlement). Only when every such
 * attempt reports its charge is the decision's cost known; otherwise it stays unknown rather
 * than looking cheaper. Reported charges are always kept. Only attempts with no reported charge
 * are estimated from the lineup's price list; without one, the decision's cost stays unknown.
 */
export function settleAttempts(
  attempts: readonly AiNetworkAttempt[],
  pricing: { inputPerMTok: number; outputPerMTok: number } | undefined,
): {
  promptTokens: number;
  responseTokens: number;
  costUsd: number | undefined;
  costSource: ActorAnswer['costSource'];
} {
  const promptTokens = attempts.reduce((sum, a) => sum + (a.usage.promptTokens ?? 0), 0);
  const responseTokens = attempts.reduce((sum, a) => sum + (a.usage.responseTokens ?? 0), 0);
  const billed = attempts.filter(
    (attempt) =>
      attempt.usage.costUsd !== undefined ||
      attempt.status === 'accepted' ||
      attempt.status === 'rejected' ||
      attempt.providerRequestId !== undefined ||
      attempt.usage.promptTokens !== undefined ||
      attempt.usage.responseTokens !== undefined,
  );
  const reported = billed.filter((attempt) => attempt.usage.costUsd !== undefined);
  const reportedUsd = reported.reduce((sum, a) => sum + (a.usage.costUsd ?? 0), 0);
  const unpriced = billed.filter((attempt) => attempt.usage.costUsd === undefined);
  let costUsd: number | undefined;
  let costSource: ActorAnswer['costSource'] = 'unknown';
  if (billed.length === 0) {
    // No request, or every attempt failed before any generation started: unbilled.
    costUsd = 0;
    costSource = 'not_applicable';
  } else if (unpriced.length === 0) {
    costUsd = reportedUsd;
    costSource = 'reported';
  } else if (pricing !== undefined) {
    costUsd =
      reportedUsd +
      unpriced.reduce(
        (sum, a) =>
          sum +
          ((a.usage.promptTokens ?? 0) * pricing.inputPerMTok +
            (a.usage.responseTokens ?? 0) * pricing.outputPerMTok) /
            1_000_000,
        0,
      );
    costSource = 'estimated';
  }
  return { promptTokens, responseTokens, costUsd, costSource };
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

        const { promptTokens, responseTokens, costUsd, costSource } = settleAttempts(
          attempts,
          entry.pricing,
        );

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

/** The key for a decision model, resolved but never logged. */
export function resolveDecisionKey(entry: DecisionEntry, runtime: LlmRuntime): string {
  const env = runtime.env;
  const apiKey =
    entry.apiKeyEnv !== undefined
      ? (env[entry.apiKeyEnv]?.trim() ?? '')
      : env['AI_JEV_API_KEY']?.trim() || env['OPENROUTER_API_KEY']?.trim() || '';
  if (apiKey === '' && runtime.decisionTransport === undefined)
    throw new Error(
      `${entry.id}: no API key (set ${entry.apiKeyEnv ?? 'OPENROUTER_API_KEY or AI_JEV_API_KEY'} in the environment or .env)`,
    );
  return apiKey;
}

function decisionNote(confidence: number | null, margin: number | null): string {
  const parts = [
    confidence === null ? 'confidence not reported' : `confidence ${confidence.toFixed(2)}`,
    ...(margin === null ? [] : [`margin over the runner-up ${margin.toFixed(2)}`]),
  ];
  return parts.join(', ');
}

/**
 * A Decisions API model in the tested seat, played through the production typed-decision lane
 * (`JevActionPolicy`): each legal action (and, with target expansion, each legal target) is one
 * Choice option, and the chosen option is mapped back to the engine's own action. Thresholds are
 * zero, so the model's answer is always the one played: the benchmark measures its choices, and
 * records its confidence beside each one for calibration.
 *
 * A decision that cannot be expressed as one Choice (an attack or block assignment, X, modes,
 * ordering, a distribution) is never sent. With `unsupported: "bot"` the heuristic bot answers it
 * and the record says `bot`; with `"hold"` the seat holds still.
 */
export function decisionActorFactory(entry: DecisionEntry, runtime: LlmRuntime): ActorFactory {
  const apiKey = resolveDecisionKey(entry, runtime);
  const base = loadAiConfig(runtime.env);
  const unsupported = entry.unsupported ?? 'bot';
  const requestTimeoutMs = entry.requestTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  // One queue per model, shared by its cases: the client-side rate limit is per model.
  const queue = new RequestQueue({ rpmLimit: base.rpmLimit, concurrency: 1 });
  return (engine: Engine, benchCase: BenchCase): Actor => {
    let attempts: AiNetworkAttempt[] = [];
    const client = new JevClient(
      { apiKey, baseUrl: entry.baseUrl ?? OPENROUTER_BASE_URL, requestTimeoutMs },
      runtime.decisionTransport,
      (attempt) => {
        attempts.push(attempt);
        runtime.onAttempt?.(attempt, { caseId: benchCase.id });
      },
    );
    const policy = new JevActionPolicy(client, queue, {
      model: entry.model,
      minConfidence: 0,
      minTopTwoMargin: 0,
      maxActions: JEV_MAX_CHOICE_OPTIONS,
      expandTargets: entry.expandTargets ?? true,
      mode: 'active',
      contextOptions: {
        includeMemory: base.contextMemoryEnabled,
        includeFeatures: base.contextFeaturesEnabled,
        useBudgeter: base.contextBudgeterEnabled,
        useCardSummaries: base.contextCardSummariesEnabled,
        inputTokenBudget: base.contextInputTokenBudget,
      },
    });
    const bot = new HeuristicDecisionProvider(`bot-bench-decision:${benchCase.id}`, () =>
      engine.view(benchCase.actor),
    );
    return {
      async decide(request, view): Promise<ActorAnswer> {
        attempts = [];
        const started = performance.now();
        const elapsed = (): number => round(performance.now() - started, 1);
        if (runtime.mode === 'production') {
          // As in a live seat, a decision with one sensible answer is settled before any call.
          const local = tryHeuristic(request, view);
          if (local !== null)
            return {
              response: local,
              source: 'heuristic',
              latencyMs: elapsed(),
              requests: 0,
              costSource: 'not_applicable',
              costUsd: 0,
            };
        }
        const outcome = await policy.decide(request, view);
        const latencyMs = elapsed();
        const { promptTokens, responseTokens, costUsd, costSource } = settleAttempts(
          attempts,
          entry.pricing,
        );
        const last = attempts.at(-1);
        const paid = {
          latencyMs,
          requests: attempts.length,
          costSource,
          ...(attempts.length > 0 && { promptTokens, responseTokens }),
          ...(costUsd !== undefined && { costUsd: round(costUsd, 8) }),
          ...(last?.rawResponse !== undefined && { raw: last.rawResponse }),
        };
        if (outcome.kind === 'answered')
          return {
            ...paid,
            response: {
              ...outcome.response,
              note: decisionNote(outcome.confidence, outcome.topTwoMargin),
            },
            source: 'model',
          };

        const botAnswer = await bot.decide(request);
        if (outcome.reason === 'unsupported_shape') {
          // Nothing was sent: the shape is one no Choice can express.
          const why = `a decision model cannot express this (${outcome.detail})`;
          return unsupported === 'bot'
            ? { ...paid, response: { ...botAnswer, note: `bot: ${why}` }, source: 'bot' }
            : { ...paid, response: botAnswer, source: 'fallback', failure: `unsupported: ${why}` };
        }
        // The provider answered but the answer was unusable (a refusal, an unknown option, a
        // malformed distribution), or the provider never answered. Only the second counts
        // towards stopping a model whose provider keeps failing.
        const rejected = attempts.some((attempt) => attempt.status === 'rejected');
        const refused = attempts.some((attempt) =>
          /"type":"refusal"/.test(attempt.rawResponse ?? ''),
        );
        const failure =
          outcome.reason === 'invalid_response' || rejected
            ? `no legal answer: ${refused ? 'the model refused to answer; ' : ''}${outcome.detail}`
            : `provider error: ${last?.error ?? outcome.detail}`;
        return { ...paid, response: botAnswer, source: 'fallback', failure };
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
  if (entry.kind === 'local') return localActorFactory(entry);
  if (entry.kind === 'decision') return decisionActorFactory(entry, runtime);
  return llmActorFactory(entry, runtime);
}

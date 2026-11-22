/**
 * The strategist half of a lineup entry: who plans the tested seat's turn before its tactician
 * plays it (ADR 0016, ADR 0039). A strategist is a chat model called once per turn through the
 * production `StrategyCoordinator`, so the benchmark sends the prompt a live seat would send and
 * installs the plan or knobs a live seat would install. What it returns depends on the tactician
 * it sits behind, as in production: a bot-led tactician gets knobs only (`BOT_STRATEGIST_PRIMER`),
 * a chat or decision model gets an intent, a threat order and planned steps.
 *
 * Three kinds:
 * - `none`: no strategy at all, even when the case carries a hand-written one (its deals stay:
 *   they are table facts, not the strategist's opinion).
 * - `case`: the case's own hand-written `context`, as every entry without a strategist gets.
 * - `llm`: a live strategist model.
 */
import type { Engine } from '../../packages/engine/src';
import { OpenAiCompatibleClient, type AiNetworkAttempt } from '../../packages/server/src/ai/client';
import {
  PROVIDERS,
  configForRole,
  loadAiConfig,
  type AiConfig,
} from '../../packages/server/src/ai/config';
import {
  seatDiplomacyContext,
  type DiplomacySource,
  type SeatDiplomacyContext,
} from '../../packages/server/src/ai/diplomacy-context';
import { StrategyCoordinator } from '../../packages/server/src/ai/strategy-coordinator';
import type { RequestQueue } from '../../packages/server/src/ai/queue';
import type {
  DecisionRequest,
  DecisionResponse,
  PlayerId,
  TurnStrategy,
} from '../../packages/shared/src';
import { round, settleAttempts } from './billing';
import type { BenchCase } from './case';
import type { RecordedStrategy, StrategistCall } from './play';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/** Fields that name a chat model and how to reach it. */
export interface EndpointFields {
  /** A provider preset from `ai/config.ts` (openrouter, groq, gemini, deepseek, openai). */
  provider?: string;
  /** Any OpenAI-compatible endpoint; overrides the preset's. */
  baseUrl?: string;
  /** The environment variable that holds the key; overrides the preset's. Never the key itself. */
  apiKeyEnv?: string;
  reasoning?: ReasoningEffort;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  /** USD per million tokens, used only when the provider does not report a cost. */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
}

export interface NoStrategist {
  id: string;
  label?: string;
  kind: 'none';
}

export interface CaseStrategist {
  id: string;
  label?: string;
  kind: 'case';
}

export interface LlmStrategist extends EndpointFields {
  id: string;
  label?: string;
  kind: 'llm';
  model: string;
  /**
   * How often a bot-led seat's strategist is asked (`AI_STRATEGIST_REPLAN`). Omitted keeps the
   * configured default. A chat or decision-model tactician's strategist plans every turn.
   */
  replan?: 'everyTurn' | 'onChange';
}

export type StrategistSpec = NoStrategist | CaseStrategist | LlmStrategist;

export const STRATEGIST_KINDS = ['none', 'case', 'llm'] as const;

const ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const ENDPOINT_FIELDS = [
  'provider',
  'baseUrl',
  'apiKeyEnv',
  'reasoning',
  'maxOutputTokens',
  'requestTimeoutMs',
  'pricing',
];

/** Validates the fields that reach a chat model; `fail` names where the problem is. */
export function checkEndpointFields(
  entry: Record<string, unknown>,
  fail: (message: string) => never,
): void {
  if (entry['provider'] !== undefined && PROVIDERS[entry['provider'] as string] === undefined)
    fail(`provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
  if (
    entry['reasoning'] !== undefined &&
    !['none', 'low', 'medium', 'high'].includes(entry['reasoning'] as string)
  )
    fail('reasoning must be none, low, medium or high');
  for (const key of ['maxOutputTokens', 'requestTimeoutMs'])
    if (
      entry[key] !== undefined &&
      !(Number.isSafeInteger(entry[key]) && (entry[key] as number) > 0)
    )
      fail(`${key} must be a positive whole number`);
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
    fail('pricing needs inputPerMTok and outputPerMTok in USD');
}

/**
 * A strategist from a lineup file. `id` may be left out of an entry's inline `strategist`:
 * `none` and `case` name themselves, a model is named by its model string and effort.
 */
export function parseStrategist(raw: unknown, where: string): StrategistSpec {
  const fail = (message: string): never => {
    throw new Error(`${where}: ${message}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('must be an object');
  const entry = raw as Record<string, unknown>;
  const kind = entry['kind'];
  if (!(STRATEGIST_KINDS as readonly unknown[]).includes(kind))
    fail(`kind must be ${STRATEGIST_KINDS.join(', ')}`);
  const allowed =
    kind === 'llm'
      ? ['id', 'label', 'kind', 'model', 'replan', ...ENDPOINT_FIELDS]
      : ['id', 'label', 'kind'];
  for (const key of Object.keys(entry)) if (!allowed.includes(key)) fail(`unknown field "${key}"`);
  if (entry['label'] !== undefined && typeof entry['label'] !== 'string')
    fail('label must be a string');
  if (kind === 'llm') {
    if (typeof entry['model'] !== 'string' || entry['model'] === '')
      fail('model must be a non-empty string');
    if (
      entry['replan'] !== undefined &&
      !['everyTurn', 'onChange'].includes(entry['replan'] as string)
    )
      fail('replan must be everyTurn or onChange');
    checkEndpointFields(entry, fail);
  }
  const reasoning = entry['reasoning'] as string | undefined;
  const id =
    entry['id'] ??
    (kind === 'llm'
      ? slug(
          reasoning === undefined ? (entry['model'] as string) : `${entry['model']}-${reasoning}`,
        )
      : kind);
  if (typeof id !== 'string' || !ID_PATTERN.test(id))
    fail('id must be lowercase letters, digits, dots and hyphens');
  return { ...entry, id } as unknown as StrategistSpec;
}

/**
 * `--strategists` shorthand, comma separated: `none`, `case`, or `provider:vendor/model`
 * optionally followed by `@none|low|medium|high`.
 */
export function parseStrategistList(text: string): StrategistSpec[] {
  const specs = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part, index): StrategistSpec => {
      const where = `strategist ${index + 1} ("${part}")`;
      if (part === 'none' || part === 'case') return parseStrategist({ kind: part }, where);
      const colon = part.indexOf(':');
      if (colon <= 0) throw new Error(`${where}: must be none, case or provider:model[@effort]`);
      const [model = '', effort] = part.slice(colon + 1).split('@');
      return parseStrategist(
        {
          kind: 'llm',
          provider: part.slice(0, colon),
          model,
          ...(effort !== undefined && { reasoning: effort }),
        },
        where,
      );
    });
  const ids = specs.map((spec) => spec.id);
  const clash = ids.find((id, i) => ids.indexOf(id) !== i);
  if (clash !== undefined) throw new Error(`strategist ${clash} is listed twice`);
  if (specs.length === 0) throw new Error('--strategists names no strategist');
  return specs;
}

export function strategistLabel(spec: StrategistSpec): string {
  if (spec.label !== undefined) return spec.label;
  if (spec.kind === 'none') return 'no strategist';
  if (spec.kind === 'case') return "the case's own strategy";
  return spec.reasoning !== undefined && spec.reasoning !== 'none'
    ? `${spec.model} (reasoning ${spec.reasoning})`
    : spec.model;
}

/** What is safe to print about a strategist: everything but where its key comes from. */
export function publicStrategist(spec: StrategistSpec): Record<string, unknown> {
  const { apiKeyEnv: _apiKeyEnv, ...rest } = spec as LlmStrategist;
  return { ...rest, label: strategistLabel(spec) };
}

export interface EndpointRuntime {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** Where a chat model lives and its key, resolved but never logged. */
export function resolveEndpoint(
  id: string,
  fields: EndpointFields,
  base: AiConfig,
  runtime: EndpointRuntime,
): { baseUrl: string; apiKey: string } {
  const preset = fields.provider === undefined ? undefined : PROVIDERS[fields.provider];
  const keyEnv = fields.apiKeyEnv ?? preset?.keyEnv;
  const apiKey = keyEnv === undefined ? base.apiKey : (runtime.env[keyEnv] ?? '');
  const baseUrl = fields.baseUrl ?? preset?.baseUrl ?? base.baseUrl;
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(baseUrl);
  if (apiKey === '' && !local && runtime.fetchImpl === undefined)
    throw new Error(
      `${id}: no API key (set ${keyEnv ?? 'a provider key such as OPENROUTER_API_KEY'} in the environment or .env)`,
    );
  return { baseUrl, apiKey };
}

/**
 * The strategist client's settings: the production strategist profile (its timeout, retries,
 * output budget and thinking headroom) with the lineup's model, endpoint and effort.
 */
export function resolveStrategistClientConfig(
  spec: LlmStrategist,
  runtime: EndpointRuntime,
): AiConfig {
  const base = loadAiConfig(runtime.env);
  const role = configForRole(base, 'strategist');
  const { baseUrl, apiKey } = resolveEndpoint(spec.id, spec, base, runtime);
  const reasoning = spec.reasoning ?? (role.reasoningEnabled ? role.reasoningEffort : 'none');
  return {
    ...role,
    baseUrl,
    apiKey,
    models: [spec.model],
    reasoningEnabled: reasoning !== 'none',
    reasoningEffort: reasoning === 'max' ? 'high' : reasoning,
    reasoningTokenHeadroom:
      reasoning === 'none'
        ? role.reasoningTokenHeadroom
        : Math.max(role.reasoningTokenHeadroom, 4000),
    ...(spec.maxOutputTokens !== undefined && { maxOutputTokens: spec.maxOutputTokens }),
    ...(spec.requestTimeoutMs !== undefined && { requestTimeoutMs: spec.requestTimeoutMs }),
  };
}

/**
 * The coordinator's settings: the tactician's pipeline (its tactical mode decides whether the
 * strategist answers with knobs or a plan) with the strategist switched on. No shadow request is
 * asked of it: the benchmark measures play, not the ADR 0045 flag.
 */
export function coordinatorConfig(tactician: AiConfig, spec: LlmStrategist): AiConfig {
  return {
    ...tactician,
    strategistEnabled: true,
    strategistTacticianFlag: 'off',
    ...(spec.replan !== undefined && { strategistReplan: spec.replan }),
  };
}

/** A case's deals as a seat sees them, for one role; null without deals (ADR 0035). */
export function caseDealsContext(
  benchCase: BenchCase,
  role: 'strategist' | 'tactician',
): SeatDiplomacyContext | null {
  const deals = benchCase.context?.deals ?? [];
  if (deals.length === 0) return null;
  return seatDiplomacyContext(
    benchCase.actor,
    {
      deals: deals.map((deal, i) => ({
        id: `case-deal-${i + 1}`,
        parties: [...deal.parties],
        obligations: deal.obligations.map((o) => ({ ...o })),
        rounds: deal.rounds,
        status: 'active',
      })) as unknown as DiplomacySource['deals'],
      records: [],
      canPropose: false,
      maxRounds: 2,
      maxObligationsPerSide: 2,
    },
    role,
  );
}

function recordedStrategy(
  strategy: TurnStrategy | null,
  steering: TurnStrategy['steering'],
): RecordedStrategy | undefined {
  if (strategy === null && steering === undefined) return undefined;
  const planned = (strategy?.plannedActions ?? []).map(
    (step) =>
      step.description ?? (step.name === undefined ? step.type : `${step.type} ${step.name}`),
  );
  return {
    intent: strategy?.intent ?? '',
    ...(strategy?.threatOrder !== undefined && { threatOrder: [...strategy.threatOrder] }),
    ...(steering !== undefined && { steering: structuredClone(steering) }),
    ...(planned.length > 0 && { plannedActions: planned }),
  };
}

/**
 * A live strategist for one case's tested seat. It plans that seat's turns only: every other seat
 * is the table, which a live strategist never plans for. Before each of the seat's decisions the
 * harness waits for the call in flight, so the tactician always plays with the plan (in a live
 * game the call races the tactician; a benchmark that let it race would measure the race).
 */
export class StrategistLane {
  readonly coordinator: StrategyCoordinator;
  private attempts: AiNetworkAttempt[] = [];
  /** Set when a call installs a plan or changes the knobs, cleared by `take`. */
  private installed = false;
  private lastSteeringKey = 'null';
  /** A call `before` reported for a decision that then threw, so it was never recorded. */
  private returned: StrategistCall[] = [];

  constructor(
    engine: Engine,
    private readonly benchCase: BenchCase,
    private readonly spec: LlmStrategist,
    config: AiConfig,
    clientConfig: AiConfig,
    queue: RequestQueue,
    runtime: EndpointRuntime & {
      sleepImpl?: (ms: number) => Promise<void>;
      onAttempt?: (attempt: AiNetworkAttempt) => void;
    },
  ) {
    const client = new OpenAiCompatibleClient(
      clientConfig,
      runtime.fetchImpl,
      runtime.sleepImpl,
      (attempt) => {
        this.attempts.push(attempt);
        runtime.onAttempt?.(attempt);
      },
    );
    const others = new Set<PlayerId>(
      engine
        .getState()
        .players.map((player) => player.id as PlayerId)
        .filter((seat) => seat !== benchCase.actor),
    );
    this.coordinator = new StrategyCoordinator(client, queue, engine, config, undefined, others);
    this.coordinator.onStrategy = () => {
      this.installed = true;
    };
    if ((benchCase.context?.deals ?? []).length > 0)
      this.coordinator.diplomacyFor = (seat, role) =>
        seat === benchCase.actor ? caseDealsContext(benchCase, role) : null;
  }

  /** Starts this turn's call if it has none, and waits for whatever is in flight. */
  async before(request: DecisionRequest): Promise<StrategistCall | undefined> {
    const started = performance.now();
    this.coordinator.prepare(request);
    await this.coordinator.settled();
    return this.take(round(performance.now() - started, 1));
  }

  /** Feeds an accepted decision to the coordinator, as a live table's shared coordinator sees it. */
  observe(request: DecisionRequest, response: DecisionResponse, by: 'actor' | 'table'): void {
    this.coordinator.recordAcceptedDecision(request, response);
    // The seat's own decisions are recorded by its pipeline; the table's are not, and one that is
    // not a pass invalidates the seat's plan and may start a re-plan (ADR 0016 decision 1).
    if (by === 'table' && request.decidingPlayer !== this.benchCase.actor)
      this.coordinator.recordDecision(request, response, 'bot');
  }

  /** A decision threw after `before` reported its call; `close` reports it instead. */
  giveBack(call: StrategistCall | undefined): void {
    if (call !== undefined) this.returned.push(call);
  }

  /**
   * Every call no decision recorded: one given back, and one still in flight when the case ended,
   * which is cancelled. A cancelled call is ours, not the provider's failure.
   */
  async close(): Promise<StrategistCall[]> {
    this.coordinator.cancel();
    await this.coordinator.drained();
    const tail = this.take(0, true);
    const calls = [...this.returned, ...(tail === undefined ? [] : [tail])];
    this.returned = [];
    return calls;
  }

  /** The strategist requests made since the last call to `take`, settled into one record. */
  private take(waitMs: number, cancelled = false): StrategistCall | undefined {
    const attempts = this.attempts;
    if (attempts.length === 0) return undefined;
    this.attempts = [];
    const { promptTokens, responseTokens, costUsd, costSource } = settleAttempts(
      attempts,
      this.spec.pricing,
    );
    const actor = this.benchCase.actor;
    const steering = this.coordinator.steeringFor(actor);
    // Bot-led knobs install even when the plan itself is dropped as stale, without `onStrategy`.
    const steeringKey = JSON.stringify(steering ?? null);
    const fresh = this.installed || steeringKey !== this.lastSteeringKey;
    this.installed = false;
    this.lastSteeringKey = steeringKey;
    const strategy = fresh
      ? recordedStrategy(this.coordinator.guidanceFor(actor).strategy ?? null, steering)
      : undefined;
    const answered = attempts.some((attempt) => attempt.status === 'accepted');
    const last = attempts.at(-1);
    const failure = !answered
      ? cancelled
        ? 'cancelled: the case ended before the strategist answered'
        : attempts.some((attempt) => attempt.status === 'rejected')
          ? `no usable plan: ${last?.error ?? 'rejected'}`
          : `provider error: ${last?.error ?? 'no response'}`
      : !fresh
        ? 'no usable plan: answered, but the coordinator installed nothing (unparseable, or dropped as stale)'
        : undefined;
    return {
      requests: attempts.length,
      promptTokens,
      responseTokens,
      ...(costUsd !== undefined && { costUsd: round(costUsd, 8) }),
      costSource,
      waitMs,
      ...(failure !== undefined && { failure }),
      ...(strategy !== undefined && { strategy }),
      ...(last?.rawResponse !== undefined && { raw: last.rawResponse }),
    };
  }
}

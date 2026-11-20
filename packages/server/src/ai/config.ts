/**
 * AI Configuration (§7.2). Single source of truth for AI endpoints, keys, models,
 * rate limits, and backoff settings across all OpenAI-compatible providers (ADR 0011).
 *
 * A provider is picked as a WHOLE — endpoint, model chain, and key together. Resolving those
 * three from independent env chains (the previous shape) let a Groq key be paired with
 * Google's endpoint and Gemini model names, which cannot authenticate and reports as a
 * confusing auth failure rather than a misconfiguration.
 */

import { WAKE_RULES, type WakeRule } from './steering';

export interface AiModelProfile {
  models: string[];
  reasoningEnabled: boolean;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'max';
  maxOutputTokens: number;
  reasoningTokenHeadroom: number;
  /** Per-call timeout for this role. */
  requestTimeoutMs: number;
  /** Retry budget for transient failures in this role. */
  maxRetries: number;
  /** OpenRouter preference, in seconds; zero disables the preference. */
  preferredMaxLatencySeconds: number;
  /** OpenRouter preference, in tokens/second; zero disables the preference. */
  preferredMinThroughput: number;
  /**
   * OpenRouter provider names this role must never be routed to (`provider.ignore`), on top of
   * the non-caching providers `filterNonCachingProviders` already skips.
   */
  ignoreProviders: string[];
}

export interface AiConfig {
  /** API Base URL (OpenAI-compatible). */
  baseUrl: string;
  /** API Key for authentication. */
  apiKey: string;
  /**
   * Ordered model fallback chain — highest priority first.
   * The client cascades to the next model on unavailability (404), daily quota, or RPM.
   */
  models: string[];
  /** Client-side RPM ceiling (token-bucket). Default: 30. */
  rpmLimit: number;
  /** Max retries on HTTP 429 / 5xx before giving up. Default: 6. */
  maxRetries: number;
  /** Request timeout in ms for AI calls. Default: 45000. */
  requestTimeoutMs: number;
  /**
   * Token budget for the decision JSON itself. Default: 1000. When reasoning is enabled the
   * client adds headroom on top of this, because `max_tokens` caps thinking and answer
   * together and a model that spends the lot mid-thought returns empty content.
   */
  maxOutputTokens: number;
  /** Base backoff in ms for exponential retry. Default: 1000. */
  baseBackoffMs: number;
  /** Max backoff cap in ms. Default: 32000. */
  maxBackoffMs: number;
  /** Request concurrency (sequential decisions → 1). Default: 1. */
  concurrency: number;
  /**
   * Concurrency of the strategist's OWN request queue lane, separate from `concurrency` (the
   * tactician's). A strategist call must never block a tactical decision behind it; keeping it
   * on its own queue instance (rather than raising global concurrency) means tactical calls stay
   * strictly serial, which the decision cache and turn plan assume. Default: 1 — only one active
   * turn is ever being planned at a time.
   */
  strategistConcurrency: number;
  /**
   * Answer dominated decisions locally instead of calling the model (see `heuristics.ts`).
   * Default: true. Disable to measure the savings, or if a rule is suspected of misfiring.
   */
  heuristicsEnabled: boolean;
  /**
   * Reuse a previous answer when the game state and menu are byte-identical
   * (see `decision-cache.ts`). Default: true.
   */
  decisionCacheEnabled: boolean;
  /**
   * Stream OpenRouter responses (ADR 0040). An aborted stream stops generation and billing at
   * supported providers; an aborted plain request is billed in full. Default: true.
   */
  streamResponses: boolean;
  /**
   * Retry a call that hit our own deadline. Default: false, because the provider may have billed
   * the slow attempt and the bot can answer the decision for free.
   */
  retryOnTimeout: boolean;
  /**
   * Who answers tactical decisions the local plan, heuristics and cache leave (ADR 0039).
   * `model`: the tactician LLM, as before. `bot`: the card-aware heuristic bot, steered by the
   * strategist's knobs, with the model asked only as `botEscalation` allows.
   * Env: `AI_TACTICAL_MODE`. Default: `model`; bot seats missed the win bar in the 2026-11-19 duel
   * (ADR 0039).
   */
  tacticalMode: 'model' | 'bot';
  /**
   * In `bot` mode, the named triggers that ask the tactician model (ADR 0044); empty is never.
   * `uncertain`: the bot's top two options score within `botEscalationMargin` LEP on a decision
   * that changes the board. `scarce-answer`: the bot would cast its last counterspell, wipe or
   * hard removal with no public lethal at stake. `unknown-card`: a noncreature, nonland spell or
   * ability the bot would use, or must respond to, is unclassified. `lethal` is shadow-only.
   * Env: `AI_BOT_ESCALATION`, `never` or a comma-separated list. Default: none.
   */
  botEscalation: readonly LiveEscalationTrigger[];
  /**
   * Triggers that are evaluated and logged but ask nothing (ADR 0044 step 1). Env:
   * `AI_BOT_ESCALATION_SHADOW`, a comma-separated list. Default: none.
   */
  botEscalationShadow: readonly EscalationTrigger[];
  /** Score margin, in LEP, under which `uncertain` escalation asks the model. Default 1. */
  botEscalationMargin: number;
  /**
   * In `bot` mode, how often the strategist is called for a seat. `everyTurn`: each of its turns.
   * `onChange`: only when the table's coarse state has moved since its last knobs, or after
   * `strategistMaxReuseTurns` of its turns. Env: `AI_STRATEGIST_REPLAN`. Default: `onChange`.
   */
  strategistReplan: 'everyTurn' | 'onChange';
  /** Most own turns a seat's knobs are reused before the strategist is asked again. Default 3. */
  strategistMaxReuseTurns: number;
  /**
   * Hill-climb S6: in `bot` mode, send the strategist its last intent and knobs plus what changed,
   * instead of the whole board again (`strategist-delta.ts`). Env:
   * `AI_STRATEGIST_DELTA_ENABLED`. Default: on since 2026-11-18, after a paid duel (delta seats won
   * both games, prompts 33% smaller per call); `AI_STRATEGIST_DELTA_ENABLED=false` turns it off.
   */
  strategistDeltaEnabled: boolean;
  /** Delta prompts a seat may get in a row before a full one. Env: `AI_STRATEGIST_DELTA_REFRESH`. Default 3. */
  strategistDeltaRefreshEvery: number;
  /**
   * Under `onChange`, which table changes count (see `WakeRule` in `ai/steering.ts`). `table-v2`
   * ignores changes the seat's knobs already expected: its own board growing and any commander
   * arriving. Env: `AI_STRATEGIST_WAKE_RULE`. Default: `table-v2`.
   */
  strategistWakeRule: WakeRule;
  /**
   * ADR 0045 decision 5: whether the bot-led strategist's primer offers the typed
   * `tacticianRequest` field. `shadow` adds it and logs every request (it is never acted on);
   * `off` keeps the primer as it was, so knob quality can be compared with and without it.
   * Env: `AI_STRATEGIST_TACTICIAN_FLAG`. Default: `off`.
   */
  strategistTacticianFlag: 'off' | 'shadow';
  /**
   * Filter out OpenRouter providers that do not support prompt caching.
   * Default: true.
   */
  filterNonCachingProviders: boolean;
  /**
   * OpenRouter only: per model, the providers a call may be routed to (sent as
   * `provider.only`). A model with no entry may go to any provider. Keys are model ids as they
   * appear in a model chain. Env: `AI_OPENROUTER_PROVIDER_ONLY`, `model=slug,slug;model=slug`,
   * or `off` for no allowlist. Default: GLM 5.3 Flash on the providers that served it at normal
   * reasoning length and price in the 2026-11-19 paid duels.
   */
  openRouterProviderOnly: Record<string, string[]>;
  /**
   * Enable/disable reasoning (thinking tokens) for AI requests.
   * Default: false (disabled).
   */
  reasoningEnabled: boolean;
  /**
   * Reasoning effort level for thinking models ('none' | 'low' | 'medium' | 'high' | 'max').
   * Default: 'low'.
   */
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'max';
  /** Extra completion budget reserved for thinking before the JSON answer. */
  reasoningTokenHeadroom: number;
  /** OpenRouter routing preference; role profiles override this in configForRole. */
  preferredMaxLatencySeconds: number;
  /** OpenRouter routing preference; role profiles override this in configForRole. */
  preferredMinThroughput: number;
  /** OpenRouter providers never to route to; role profiles override this in configForRole. */
  ignoreProviders: string[];
  /** Larger, reasoning-enabled call made once per active turn. */
  strategist: AiModelProfile;
  /** Small menu-pick call used for decisions the local plan cannot answer. */
  tactician: AiModelProfile;
  /** One tiny import-time call that refines the heuristic archetype tag (ADR 0022 §5). */
  archetype: AiModelProfile;
  /** One post-game call per AI seat, reviewing the game it just played (ADR 0022 §7). */
  reflection: AiModelProfile;
  /** Master switch for the turn-start strategist tier. */
  strategistEnabled: boolean;
  /**
   * Master switch for AI archetype refinement. Off by default: the deterministic classifier is
   * the product, and this only polishes its wording. Never gates the heuristic itself.
   */
  archetypeInferenceEnabled: boolean;
  /**
   * Default for post-game reflection. Off, because it is the only recurring per-game cost in this
   * file that buys nothing during play. The setup screen sends an explicit per-game choice which
   * overrides this; the env var governs anything that does not (tests, CLIs).
   */
  reflectionEnabled: boolean;
  /** Number of the seat's own recent decisions included in strategy/tactical context. */
  strategyRecentDecisionLimit: number;
  /** Independent Milestone-4 context experiments. Off until benchmark promotion. */
  contextMemoryEnabled: boolean;
  contextFeaturesEnabled: boolean;
  contextBudgeterEnabled: boolean;
  contextCardSummariesEnabled: boolean;
  /** Input estimate at which the budgeter requests a larger-context route. */
  contextInputTokenBudget: number;
  /** Evidence-scoped plan invalidation. Legacy blanket invalidation remains the rollout default. */
  planLifecycleScopedInvalidationEnabled: boolean;
  /** Log an interpretable route while retaining the fixed production policy. */
  strategyRouterShadowEnabled: boolean;
  /**
   * Use the stable-prefix prompt layout: per-game constants (commander texts, strategy task and
   * profile) ahead of the changing observation, so provider prefix caches can serve them. Off
   * until a paid run shows provider cache reads worth more than the extra prefix tokens; the
   * hill-climb `botCached` census mode measures it offline.
   */
  providerPromptCacheLayoutEnabled: boolean;
  /** Reserved feature flag for exact engine-derived combat previews. */
  combatRolloutsEnabled: boolean;
  /** Allow Jev to answer supported tactical choices. Off until benchmark promotion. */
  jevEnabled: boolean;
  /** Run Jev non-authoritatively beside the chat tactician for evidence collection. */
  jevShadowEnabled: boolean;
  /** Reproducible pinned decision-model id. */
  jevModel: string;
  /** Per-request deadline for the typed Decisions endpoint. */
  jevRequestTimeoutMs: number;
  /** Maximum menu size admitted to Jev, capped by the model's Choice limit. */
  jevMaxActions: number;
  /**
   * What answers a decision Jev was asked but did not settle (unsupported shape, low confidence,
   * transport failure). `model`: the chat tactician, as before. `bot`: the card-aware bot's own
   * answer, which costs nothing. Env: `AI_JEV_FALLBACK`. Default: `model`.
   */
  jevFallback: 'model' | 'bot';
  /**
   * In shadow mode, which decisions Jev is asked about beside the seat's real answerer. `all`:
   * every decision the bot or chat tactician answers. `uncertain`: only the bot's close calls.
   * Env: `AI_JEV_SHADOW_SCOPE`. Default: `all`.
   */
  jevShadowScope: 'all' | 'uncertain';
  /**
   * On a bot close call, what Jev chooses from. `top2`: only the bot's two best options, and its
   * answer is always used, since a paid pass is waste. `full`: the whole menu, with thresholds.
   * Env: `AI_JEV_CLOSE_CALL_MENU`. Default: `top2`.
   */
  jevCloseCallMenu: 'top2' | 'full';
  /**
   * Offer a targeted action once per legal target, so Jev can answer menus with a target choice
   * (one undecided slot per action, at most `jevMaxActions` options in all). Env:
   * `AI_JEV_EXPAND_TARGETS`. Default: true.
   */
  jevExpandTargets: boolean;
  /** Calibrated acceptance thresholds. Required before authoritative Jev is enabled. */
  jevMinConfidence: number | null;
  jevMinTopTwoMargin: number | null;
}

/** A vendor: its endpoint, its default chain, and the env var holding its key. */
export interface ProviderPreset {
  baseUrl: string;
  models: string[];
  keyEnv: string;
  /** Env var prefix for per-provider overrides, e.g. `GROQ_MODELS`. */
  envPrefix: string;
}

/**
 * Groq's free tier, quality-first. Verified callable with `response_format: json_object`
 * on 2026-07-25; per-model limits from Groq's published free-tier table.
 *
 * The binding constraint is TOKENS, not requests. At the ~2K-token decision prompts this
 * project sends, `llama-3.3-70b-versatile`'s 100K TPD is ~50 calls/day and its 12K TPM is
 * ~6 calls/minute — far short of the ~370 calls a full game needs (ADR 0010). The chain is
 * therefore ordered by play quality, and `llama-3.1-8b-instant` is appended last as a
 * capacity backstop: 500K TPD / 14.4K RPD, the only entry that can carry a game alone.
 */
const OPENROUTER: ProviderPreset = {
  baseUrl: 'https://openrouter.ai/api/v1',
  models: [
    'deepseek/deepseek-v4-flash',
    'google/gemma-4-26b-a4b-it',
    'google/gemma-4-31b-it',
    'meta-llama/llama-3.3-70b-instruct',
    'deepseek/deepseek-chat',
    'google/gemini-2.5-flash-lite',
  ],
  keyEnv: 'OPENROUTER_API_KEY',
  envPrefix: 'OPENROUTER',
};

const GROQ: ProviderPreset = {
  baseUrl: 'https://api.groq.com/openai/v1',
  models: [
    'llama-3.3-70b-versatile', // 1K RPD, 12K TPM, 100K TPD
    'openai/gpt-oss-120b', //     1K RPD,  8K TPM, 200K TPD
    'openai/gpt-oss-20b', //      1K RPD,  8K TPM, 200K TPD
    'qwen/qwen3.6-27b', //        1K RPD,  8K TPM, 200K TPD
    'llama-3.1-8b-instant', //   14.4K RPD, 6K TPM, 500K TPD — capacity backstop
  ],
  keyEnv: 'GROQ_API_KEY',
  envPrefix: 'GROQ',
};

/**
 * Google, via its OpenAI-compatible shim. Free tier is 500 requests/day/model — less than
 * one game (ADR 0011), so this is not the default. `gemini-2.5-flash-lite` is deliberately
 * absent: it 404s with "no longer available to new users" despite appearing in `GET /models`.
 */
const GEMINI: ProviderPreset = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'],
  keyEnv: 'GEMINI_API_KEY',
  envPrefix: 'GEMINI',
};

const DEEPSEEK: ProviderPreset = {
  baseUrl: 'https://api.deepseek.com/v1',
  models: ['deepseek-chat'],
  keyEnv: 'DEEPSEEK_API_KEY',
  envPrefix: 'DEEPSEEK',
};

const OPENAI: ProviderPreset = {
  baseUrl: 'https://api.openai.com/v1',
  models: ['gpt-4o-mini'],
  keyEnv: 'OPENAI_API_KEY',
  envPrefix: 'OPENAI',
};

/** Auto-detection order when `AI_PROVIDER` is unset: first one with a key present wins. */
export const PROVIDERS: Record<string, ProviderPreset> = {
  openrouter: OPENROUTER,
  groq: GROQ,
  gemini: GEMINI,
  deepseek: DEEPSEEK,
  openai: OPENAI,
};

export const DEFAULT_PROVIDER = 'openrouter';
export const DEFAULT_MODEL_CHAIN = OPENROUTER.models;

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: OPENROUTER.baseUrl,
  apiKey: '',
  models: OPENROUTER.models,
  rpmLimit: 10000,
  maxRetries: 6,
  requestTimeoutMs: 45000,
  maxOutputTokens: 1000,
  baseBackoffMs: 1000,
  maxBackoffMs: 32000,
  concurrency: 1,
  strategistConcurrency: 1,
  heuristicsEnabled: true,
  decisionCacheEnabled: true,
  tacticalMode: 'model',
  botEscalation: [],
  botEscalationShadow: [],
  botEscalationMargin: 1,
  strategistReplan: 'onChange',
  strategistMaxReuseTurns: 3,
  strategistDeltaEnabled: true,
  strategistDeltaRefreshEvery: 3,
  strategistWakeRule: 'table-v2',
  strategistTacticianFlag: 'off',
  filterNonCachingProviders: true,
  // Cohere and OpenInference spent about 8x the reasoning tokens of the others at effort low,
  // and Makora none; see docs/reviews/strategist-wake-rule-s7-2026-11-19.md.
  openRouterProviderOnly: {
    'z-ai/glm-5.3-flash': [
      'wafer',
      'inference-net',
      'coreweave',
      'particle-ai',
      'together',
      'modal',
      'mistral',
      'reka',
    ],
  },
  streamResponses: true,
  retryOnTimeout: false,
  reasoningEnabled: false,
  reasoningEffort: 'low',
  reasoningTokenHeadroom: 4000,
  preferredMaxLatencySeconds: 0,
  preferredMinThroughput: 0,
  ignoreProviders: [],
  strategist: {
    // Paul's pick (2026-11-10): GLM 5.3 Flash at low effort. The strategist is most of the
    // per-game bill, and its thinking tokens are most of each call (ADR 0040).
    models: ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4-flash'],
    reasoningEnabled: true,
    reasoningEffort: 'low',
    maxOutputTokens: 1000,
    reasoningTokenHeadroom: 4000,
    requestTimeoutMs: 45000,
    maxRetries: 2,
    preferredMaxLatencySeconds: 30,
    preferredMinThroughput: 100,
    ignoreProviders: [],
  },
  tactician: {
    // Particle-1 first (low reasoning), DeepSeek V4 Flash as the backup. Checked on OpenRouter
    // 2026-11-19: particle-ai/particle-1 is listed and takes `reasoning_effort`.
    models: ['particle-ai/particle-1', 'deepseek/deepseek-v4-flash'],
    reasoningEnabled: true,
    reasoningEffort: 'low',
    // 256 tokens of answer, plus headroom for the low-effort thinking that `max_tokens` also caps.
    maxOutputTokens: 256,
    reasoningTokenHeadroom: 1024,
    requestTimeoutMs: 10000,
    maxRetries: 1,
    preferredMaxLatencySeconds: 10,
    preferredMinThroughput: 10,
    // Never routed to these providers (requested 2026-11-19).
    ignoreProviders: ['CoreWeave', 'Modal', 'Cohere'],
  },
  archetype: {
    // Import-time only, one call per deck, and a heuristic tag already exists to fall back on —
    // so this is the cheapest, fastest profile in the file rather than the smartest.
    models: ['qwen/qwen3.7-flash', 'deepseek/deepseek-v4-flash'],
    reasoningEnabled: false,
    reasoningEffort: 'none',
    maxOutputTokens: 60,
    reasoningTokenHeadroom: 0,
    requestTimeoutMs: 8000,
    maxRetries: 1,
    preferredMaxLatencySeconds: 10,
    preferredMinThroughput: 10,
    ignoreProviders: [],
  },
  reflection: {
    // Prose, not a menu pick, so the output budget is the largest here — but reasoning stays off:
    // the game is over, nothing downstream depends on the answer, and thinking tokens on a
    // once-per-seat retrospective are the easiest cost in the file to not spend.
    models: ['deepseek/deepseek-v4-flash', 'tencent/hy3'],
    reasoningEnabled: false,
    reasoningEffort: 'none',
    maxOutputTokens: 700,
    reasoningTokenHeadroom: 0,
    requestTimeoutMs: 30000,
    maxRetries: 1,
    preferredMaxLatencySeconds: 0,
    preferredMinThroughput: 0,
    ignoreProviders: [],
  },
  strategistEnabled: true,
  archetypeInferenceEnabled: false,
  reflectionEnabled: false,
  strategyRecentDecisionLimit: 8,
  contextMemoryEnabled: false,
  contextFeaturesEnabled: false,
  contextBudgeterEnabled: false,
  contextCardSummariesEnabled: false,
  contextInputTokenBudget: 6_000,
  planLifecycleScopedInvalidationEnabled: false,
  strategyRouterShadowEnabled: false,
  providerPromptCacheLayoutEnabled: false,
  combatRolloutsEnabled: false,
  jevEnabled: false,
  jevShadowEnabled: false,
  jevModel: 'typesafe/jev-1.13',
  jevRequestTimeoutMs: 2_000,
  jevMaxActions: 255,
  jevFallback: 'model',
  jevShadowScope: 'all',
  jevCloseCallMenu: 'top2',
  jevExpandTargets: true,
  jevMinConfidence: null,
  jevMinTopTwoMargin: null,
};

/** Env booleans are opt-OUT: anything but an explicit falsey word leaves the default alone. */
function parseBoolean(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined) return fallback;
  const normalized = val.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  return fallback;
}

/** Every ADR 0044 escalation trigger, in the order a live call is attributed. */
export const ESCALATION_TRIGGERS = [
  'scarce-answer',
  'unknown-card',
  'uncertain',
  'lethal',
] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];
/** Triggers that may go live; `lethal` starts in shadow only (ADR 0044 decision 1). */
export const LIVE_ESCALATION_TRIGGERS = ['scarce-answer', 'unknown-card', 'uncertain'] as const;
export type LiveEscalationTrigger = (typeof LIVE_ESCALATION_TRIGGERS)[number];

/**
 * A comma-separated trigger list; empty or `never` is none. An unknown name throws: before ADR
 * 0044 an unknown value silently meant `never`, which hid typos.
 */
export function parseTriggerList(raw: string | undefined, name: string): EscalationTrigger[] {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'never') return [];
  const names = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  for (const trigger of names)
    if (!(ESCALATION_TRIGGERS as readonly string[]).includes(trigger))
      throw new Error(
        `Unknown escalation trigger "${trigger}" in ${name}. Supported: ${ESCALATION_TRIGGERS.join(', ')} (or never).`,
      );
  return [...new Set(names)] as EscalationTrigger[];
}

function parseLiveTriggers(raw: string | undefined): LiveEscalationTrigger[] {
  const triggers = parseTriggerList(raw, 'AI_BOT_ESCALATION');
  if (triggers.includes('lethal'))
    throw new Error(
      'AI_BOT_ESCALATION: lethal is shadow-only until its shadow logs justify it (ADR 0044); put it in AI_BOT_ESCALATION_SHADOW',
    );
  return triggers as LiveEscalationTrigger[];
}

function parseChoice<T extends string>(
  val: string | undefined,
  choices: readonly T[],
  fallback: T,
): T {
  const trimmed = val?.trim();
  return trimmed !== undefined && (choices as readonly string[]).includes(trimmed)
    ? (trimmed as T)
    : fallback;
}

/** `model=slug,slug;model=slug`, or `off`; unset keeps the default. */
export function parseProviderOnly(
  raw: string | undefined,
  fallback: Record<string, string[]>,
): Record<string, string[]> {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw.trim().toLowerCase() === 'off') return {};
  const out: Record<string, string[]> = {};
  for (const entry of raw.split(';')) {
    if (entry.trim() === '') continue;
    const [model, list, ...rest] = entry.split('=');
    const providers = (list ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    if (model === undefined || model.trim() === '' || rest.length > 0 || providers.length === 0) {
      throw new Error(
        `AI_OPENROUTER_PROVIDER_ONLY: expected model=slug,slug;... or off, got "${entry}"`,
      );
    }
    out[model.trim()] = providers;
  }
  return out;
}

function parseNumber(val: string | undefined, fallback: number): number {
  if (val === undefined) return fallback;
  const parsed = Number.parseInt(val, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/** A number of at least 0, fractions allowed (`0.5`); anything else keeps the fallback. */
function parseNonNegative(val: string | undefined, fallback: number): number {
  if (val === undefined || val.trim() === '') return fallback;
  const parsed = Number(val);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** A whole number of at least 0 (`0` is meaningful, e.g. "never reuse"). */
function parseNonNegativeInt(val: string | undefined, fallback: number): number {
  const parsed = parseNonNegative(val, fallback);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseOptionalProbability(val: string | undefined, fallback: number | null): number | null {
  if (val === undefined || val.trim() === '') return fallback;
  const parsed = Number(val);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function parseModels(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const models = raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return models.length > 0 ? models : null;
}

function parseEffort(
  raw: string | undefined,
  fallback: AiModelProfile['reasoningEffort'],
): AiModelProfile['reasoningEffort'] {
  const normalized = raw?.trim().toLowerCase();
  return normalized !== undefined && ['none', 'low', 'medium', 'high', 'max'].includes(normalized)
    ? (normalized as AiModelProfile['reasoningEffort'])
    : fallback;
}

/**
 * Which vendor to talk to: an explicit `AI_PROVIDER`, else the first provider whose key is
 * present, else the default. Returns the preset plus the resolved name (for logging).
 */
export function resolveProvider(env: Record<string, string | undefined>): {
  name: string;
  preset: ProviderPreset;
} {
  const explicit = env['AI_PROVIDER']?.trim().toLowerCase();
  if (explicit !== undefined && explicit.length > 0) {
    const preset = PROVIDERS[explicit];
    if (preset === undefined) {
      throw new Error(
        `Unknown AI_PROVIDER "${explicit}". Supported: ${Object.keys(PROVIDERS).join(', ')}.`,
      );
    }
    return { name: explicit, preset };
  }

  for (const [name, preset] of Object.entries(PROVIDERS)) {
    const key = env[preset.keyEnv];
    if (key !== undefined && key.trim().length > 0) return { name, preset };
  }

  return { name: DEFAULT_PROVIDER, preset: PROVIDERS[DEFAULT_PROVIDER] as ProviderPreset };
}

/**
 * Load AI config from environment variables (or an explicit map for testing).
 *
 * Precedence, per field: vendor-neutral `AI_*` → provider-scoped `<PREFIX>_*` → preset default.
 * The vendor-neutral vars still win outright, so an arbitrary OpenAI-compatible endpoint needs
 * no preset at all.
 */
export function loadAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const { name: providerName, preset } = resolveProvider(env);

  const baseUrl = env['AI_BASE_URL'] || env[`${preset.envPrefix}_BASE_URL`] || preset.baseUrl;
  const apiKey = env['AI_API_KEY'] || env[preset.keyEnv] || '';
  const models =
    parseModels(env['AI_MODELS']) ??
    parseModels(env[`${preset.envPrefix}_MODELS`]) ??
    preset.models;

  const rpmLimit = parseNumber(
    env['AI_RPM_LIMIT'] || env[`${preset.envPrefix}_RPM_LIMIT`],
    DEFAULT_AI_CONFIG.rpmLimit,
  );

  const rawEffort = (
    env['AI_REASONING_EFFORT'] ||
    env[`${preset.envPrefix}_REASONING_EFFORT`] ||
    DEFAULT_AI_CONFIG.reasoningEffort
  )
    .trim()
    .toLowerCase();
  const reasoningEffort = (
    ['none', 'low', 'medium', 'high', 'max'].includes(rawEffort)
      ? rawEffort
      : DEFAULT_AI_CONFIG.reasoningEffort
  ) as AiConfig['reasoningEffort'];

  const globalModelsExplicit =
    parseModels(env['AI_MODELS']) ?? parseModels(env[`${preset.envPrefix}_MODELS`]);
  const defaultStrategistModels =
    providerName === 'openrouter' ? DEFAULT_AI_CONFIG.strategist.models : models;
  const defaultTacticianModels =
    providerName === 'openrouter' ? DEFAULT_AI_CONFIG.tactician.models : models;
  const strategist: AiModelProfile = {
    models:
      parseModels(env['AI_STRATEGIST_MODELS']) ?? globalModelsExplicit ?? defaultStrategistModels,
    reasoningEnabled: parseBoolean(
      env['AI_STRATEGIST_REASONING_ENABLED'],
      DEFAULT_AI_CONFIG.strategist.reasoningEnabled,
    ),
    reasoningEffort: parseEffort(
      env['AI_STRATEGIST_REASONING_EFFORT'],
      DEFAULT_AI_CONFIG.strategist.reasoningEffort,
    ),
    maxOutputTokens: parseNumber(
      env['AI_STRATEGIST_MAX_OUTPUT_TOKENS'],
      DEFAULT_AI_CONFIG.strategist.maxOutputTokens,
    ),
    reasoningTokenHeadroom: parseNumber(
      env['AI_STRATEGIST_REASONING_TOKEN_HEADROOM'],
      DEFAULT_AI_CONFIG.strategist.reasoningTokenHeadroom,
    ),
    requestTimeoutMs: parseNumber(
      env['AI_STRATEGIST_REQUEST_TIMEOUT_MS'],
      DEFAULT_AI_CONFIG.strategist.requestTimeoutMs,
    ),
    maxRetries: parseNumber(
      env['AI_STRATEGIST_MAX_RETRIES'],
      DEFAULT_AI_CONFIG.strategist.maxRetries,
    ),
    preferredMaxLatencySeconds: parseNumber(
      env['AI_STRATEGIST_PREFERRED_MAX_LATENCY_SECONDS'],
      DEFAULT_AI_CONFIG.strategist.preferredMaxLatencySeconds,
    ),
    preferredMinThroughput: parseNumber(
      env['AI_STRATEGIST_PREFERRED_MIN_THROUGHPUT'],
      DEFAULT_AI_CONFIG.strategist.preferredMinThroughput,
    ),
    ignoreProviders:
      parseModels(env['AI_STRATEGIST_IGNORE_PROVIDERS']) ??
      DEFAULT_AI_CONFIG.strategist.ignoreProviders,
  };
  const tactician: AiModelProfile = {
    models:
      parseModels(env['AI_TACTICIAN_MODELS']) ?? globalModelsExplicit ?? defaultTacticianModels,
    reasoningEnabled: parseBoolean(
      env['AI_TACTICIAN_REASONING_ENABLED'],
      DEFAULT_AI_CONFIG.tactician.reasoningEnabled,
    ),
    reasoningEffort: parseEffort(
      env['AI_TACTICIAN_REASONING_EFFORT'],
      DEFAULT_AI_CONFIG.tactician.reasoningEffort,
    ),
    maxOutputTokens: parseNumber(
      env['AI_TACTICIAN_MAX_OUTPUT_TOKENS'],
      DEFAULT_AI_CONFIG.tactician.maxOutputTokens,
    ),
    reasoningTokenHeadroom: parseNumber(
      env['AI_TACTICIAN_REASONING_TOKEN_HEADROOM'],
      DEFAULT_AI_CONFIG.tactician.reasoningTokenHeadroom,
    ),
    requestTimeoutMs: parseNumber(
      env['AI_TACTICIAN_REQUEST_TIMEOUT_MS'],
      DEFAULT_AI_CONFIG.tactician.requestTimeoutMs,
    ),
    maxRetries: parseNumber(
      env['AI_TACTICIAN_MAX_RETRIES'],
      DEFAULT_AI_CONFIG.tactician.maxRetries,
    ),
    preferredMaxLatencySeconds: parseNumber(
      env['AI_TACTICIAN_PREFERRED_MAX_LATENCY_SECONDS'],
      DEFAULT_AI_CONFIG.tactician.preferredMaxLatencySeconds,
    ),
    preferredMinThroughput: parseNumber(
      env['AI_TACTICIAN_PREFERRED_MIN_THROUGHPUT'],
      DEFAULT_AI_CONFIG.tactician.preferredMinThroughput,
    ),
    ignoreProviders:
      parseModels(env['AI_TACTICIAN_IGNORE_PROVIDERS']) ??
      DEFAULT_AI_CONFIG.tactician.ignoreProviders,
  };
  const archetype: AiModelProfile = {
    ...DEFAULT_AI_CONFIG.archetype,
    models:
      parseModels(env['AI_ARCHETYPE_MODELS']) ??
      globalModelsExplicit ??
      (providerName === 'openrouter' ? DEFAULT_AI_CONFIG.archetype.models : models),
    requestTimeoutMs: parseNumber(
      env['AI_ARCHETYPE_REQUEST_TIMEOUT_MS'],
      DEFAULT_AI_CONFIG.archetype.requestTimeoutMs,
    ),
  };
  const reflection: AiModelProfile = {
    ...DEFAULT_AI_CONFIG.reflection,
    models:
      parseModels(env['AI_REFLECTION_MODELS']) ??
      globalModelsExplicit ??
      (providerName === 'openrouter' ? DEFAULT_AI_CONFIG.reflection.models : models),
    maxOutputTokens: parseNumber(
      env['AI_REFLECTION_MAX_OUTPUT_TOKENS'],
      DEFAULT_AI_CONFIG.reflection.maxOutputTokens,
    ),
    requestTimeoutMs: parseNumber(
      env['AI_REFLECTION_REQUEST_TIMEOUT_MS'],
      DEFAULT_AI_CONFIG.reflection.requestTimeoutMs,
    ),
  };

  return {
    ...DEFAULT_AI_CONFIG,
    baseUrl,
    apiKey,
    models,
    rpmLimit,
    maxRetries: parseNumber(env['AI_MAX_RETRIES'], DEFAULT_AI_CONFIG.maxRetries),
    requestTimeoutMs: parseNumber(
      env['AI_REQUEST_TIMEOUT_MS'] || env[`${preset.envPrefix}_REQUEST_TIMEOUT_MS`],
      DEFAULT_AI_CONFIG.requestTimeoutMs,
    ),
    maxOutputTokens: parseNumber(
      env['AI_MAX_OUTPUT_TOKENS'] || env[`${preset.envPrefix}_MAX_OUTPUT_TOKENS`],
      DEFAULT_AI_CONFIG.maxOutputTokens,
    ),
    strategistConcurrency: parseNumber(
      env['AI_STRATEGIST_CONCURRENCY'],
      DEFAULT_AI_CONFIG.strategistConcurrency,
    ),
    heuristicsEnabled: parseBoolean(
      env['AI_HEURISTICS_ENABLED'],
      DEFAULT_AI_CONFIG.heuristicsEnabled,
    ),
    decisionCacheEnabled: parseBoolean(
      env['AI_DECISION_CACHE_ENABLED'],
      DEFAULT_AI_CONFIG.decisionCacheEnabled,
    ),
    tacticalMode: parseChoice(
      env['AI_TACTICAL_MODE'],
      ['model', 'bot'] as const,
      DEFAULT_AI_CONFIG.tacticalMode,
    ),
    botEscalation: parseLiveTriggers(env['AI_BOT_ESCALATION']),
    botEscalationShadow: parseTriggerList(
      env['AI_BOT_ESCALATION_SHADOW'],
      'AI_BOT_ESCALATION_SHADOW',
    ),
    botEscalationMargin: parseNonNegative(
      env['AI_BOT_ESCALATION_MARGIN'],
      DEFAULT_AI_CONFIG.botEscalationMargin,
    ),
    strategistReplan: parseChoice(
      env['AI_STRATEGIST_REPLAN'],
      ['everyTurn', 'onChange'] as const,
      DEFAULT_AI_CONFIG.strategistReplan,
    ),
    strategistTacticianFlag: parseChoice(
      env['AI_STRATEGIST_TACTICIAN_FLAG'],
      ['off', 'shadow'] as const,
      DEFAULT_AI_CONFIG.strategistTacticianFlag,
    ),
    strategistMaxReuseTurns: parseNonNegativeInt(
      env['AI_STRATEGIST_MAX_REUSE_TURNS'],
      DEFAULT_AI_CONFIG.strategistMaxReuseTurns,
    ),
    strategistDeltaEnabled: parseBoolean(
      env['AI_STRATEGIST_DELTA_ENABLED'],
      DEFAULT_AI_CONFIG.strategistDeltaEnabled,
    ),
    strategistDeltaRefreshEvery: parseNonNegativeInt(
      env['AI_STRATEGIST_DELTA_REFRESH'],
      DEFAULT_AI_CONFIG.strategistDeltaRefreshEvery,
    ),
    strategistWakeRule: parseChoice(
      env['AI_STRATEGIST_WAKE_RULE'],
      WAKE_RULES,
      DEFAULT_AI_CONFIG.strategistWakeRule,
    ),
    filterNonCachingProviders: parseBoolean(
      env['AI_FILTER_NON_CACHING_PROVIDERS'] || env['OPENROUTER_FILTER_NON_CACHING'],
      DEFAULT_AI_CONFIG.filterNonCachingProviders,
    ),
    openRouterProviderOnly: parseProviderOnly(
      env['AI_OPENROUTER_PROVIDER_ONLY'],
      DEFAULT_AI_CONFIG.openRouterProviderOnly,
    ),
    streamResponses: parseBoolean(env['AI_STREAM_RESPONSES'], DEFAULT_AI_CONFIG.streamResponses),
    retryOnTimeout: parseBoolean(env['AI_RETRY_ON_TIMEOUT'], DEFAULT_AI_CONFIG.retryOnTimeout),
    reasoningEnabled: parseBoolean(
      env['AI_REASONING_ENABLED'] || env[`${preset.envPrefix}_REASONING_ENABLED`],
      DEFAULT_AI_CONFIG.reasoningEnabled,
    ),
    reasoningEffort,
    reasoningTokenHeadroom: parseNumber(
      env['AI_REASONING_TOKEN_HEADROOM'],
      DEFAULT_AI_CONFIG.reasoningTokenHeadroom,
    ),
    preferredMaxLatencySeconds: parseNumber(
      env['AI_PREFERRED_MAX_LATENCY_SECONDS'],
      DEFAULT_AI_CONFIG.preferredMaxLatencySeconds,
    ),
    preferredMinThroughput: parseNumber(
      env['AI_PREFERRED_MIN_THROUGHPUT'],
      DEFAULT_AI_CONFIG.preferredMinThroughput,
    ),
    strategist,
    tactician,
    archetype,
    reflection,
    archetypeInferenceEnabled: parseBoolean(
      env['AI_ARCHETYPE_INFERENCE'],
      DEFAULT_AI_CONFIG.archetypeInferenceEnabled,
    ),
    reflectionEnabled: parseBoolean(
      env['AI_REFLECTION_ENABLED'],
      DEFAULT_AI_CONFIG.reflectionEnabled,
    ),
    strategistEnabled: parseBoolean(
      env['AI_STRATEGIST_ENABLED'],
      DEFAULT_AI_CONFIG.strategistEnabled,
    ),
    strategyRecentDecisionLimit: parseNumber(
      env['AI_STRATEGY_RECENT_DECISIONS'],
      DEFAULT_AI_CONFIG.strategyRecentDecisionLimit,
    ),
    contextMemoryEnabled: parseBoolean(
      env['AI_CONTEXT_MEMORY_ENABLED'],
      DEFAULT_AI_CONFIG.contextMemoryEnabled,
    ),
    contextFeaturesEnabled: parseBoolean(
      env['AI_CONTEXT_FEATURES_ENABLED'],
      DEFAULT_AI_CONFIG.contextFeaturesEnabled,
    ),
    contextBudgeterEnabled: parseBoolean(
      env['AI_CONTEXT_BUDGETER_ENABLED'],
      DEFAULT_AI_CONFIG.contextBudgeterEnabled,
    ),
    contextCardSummariesEnabled: parseBoolean(
      env['AI_CONTEXT_CARD_SUMMARIES_ENABLED'],
      DEFAULT_AI_CONFIG.contextCardSummariesEnabled,
    ),
    contextInputTokenBudget: parseNumber(
      env['AI_CONTEXT_INPUT_TOKEN_BUDGET'],
      DEFAULT_AI_CONFIG.contextInputTokenBudget,
    ),
    planLifecycleScopedInvalidationEnabled: parseBoolean(
      env['AI_PLAN_SCOPED_INVALIDATION_ENABLED'],
      DEFAULT_AI_CONFIG.planLifecycleScopedInvalidationEnabled,
    ),
    strategyRouterShadowEnabled: parseBoolean(
      env['AI_STRATEGY_ROUTER_SHADOW_ENABLED'],
      DEFAULT_AI_CONFIG.strategyRouterShadowEnabled,
    ),
    providerPromptCacheLayoutEnabled: parseBoolean(
      env['AI_PROVIDER_PROMPT_CACHE_LAYOUT_ENABLED'],
      DEFAULT_AI_CONFIG.providerPromptCacheLayoutEnabled,
    ),
    combatRolloutsEnabled: parseBoolean(
      env['AI_COMBAT_ROLLOUTS_ENABLED'],
      DEFAULT_AI_CONFIG.combatRolloutsEnabled,
    ),
    jevEnabled: parseBoolean(env['AI_JEV_ENABLED'], DEFAULT_AI_CONFIG.jevEnabled),
    jevShadowEnabled: parseBoolean(
      env['AI_JEV_SHADOW_ENABLED'],
      DEFAULT_AI_CONFIG.jevShadowEnabled,
    ),
    jevModel: env['AI_JEV_MODEL']?.trim() || DEFAULT_AI_CONFIG.jevModel,
    jevRequestTimeoutMs: parseNumber(
      env['AI_JEV_REQUEST_TIMEOUT_MS'],
      DEFAULT_AI_CONFIG.jevRequestTimeoutMs,
    ),
    jevMaxActions: Math.min(
      255,
      parseNumber(env['AI_JEV_MAX_ACTIONS'], DEFAULT_AI_CONFIG.jevMaxActions),
    ),
    jevFallback: parseChoice(
      env['AI_JEV_FALLBACK'],
      ['model', 'bot'] as const,
      DEFAULT_AI_CONFIG.jevFallback,
    ),
    jevShadowScope: parseChoice(
      env['AI_JEV_SHADOW_SCOPE'],
      ['all', 'uncertain'] as const,
      DEFAULT_AI_CONFIG.jevShadowScope,
    ),
    jevCloseCallMenu: parseChoice(
      env['AI_JEV_CLOSE_CALL_MENU'],
      ['top2', 'full'] as const,
      DEFAULT_AI_CONFIG.jevCloseCallMenu,
    ),
    jevExpandTargets: parseBoolean(
      env['AI_JEV_EXPAND_TARGETS'],
      DEFAULT_AI_CONFIG.jevExpandTargets,
    ),
    jevMinConfidence: parseOptionalProbability(
      env['AI_JEV_MIN_CONFIDENCE'],
      DEFAULT_AI_CONFIG.jevMinConfidence,
    ),
    jevMinTopTwoMargin: parseOptionalProbability(
      env['AI_JEV_MIN_TOP_TWO_MARGIN'],
      DEFAULT_AI_CONFIG.jevMinTopTwoMargin,
    ),
  };
}

/** Flatten one role's profile for the existing OpenAI-compatible client. */
export function configForRole(
  config: AiConfig,
  role: 'strategist' | 'tactician' | 'archetype' | 'reflection',
): AiConfig {
  const profile = config[role];
  return {
    ...config,
    models: [...profile.models],
    reasoningEnabled: profile.reasoningEnabled,
    reasoningEffort: profile.reasoningEffort,
    maxOutputTokens: profile.maxOutputTokens,
    reasoningTokenHeadroom: profile.reasoningTokenHeadroom,
    requestTimeoutMs: profile.requestTimeoutMs,
    maxRetries: profile.maxRetries,
    preferredMaxLatencySeconds: profile.preferredMaxLatencySeconds,
    preferredMinThroughput: profile.preferredMinThroughput,
    ignoreProviders: [...profile.ignoreProviders],
  };
}

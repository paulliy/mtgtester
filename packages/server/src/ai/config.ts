/**
 * AI Configuration (§7.2). Single source of truth for AI endpoints, keys, models,
 * rate limits, and backoff settings across all OpenAI-compatible providers (ADR 0011).
 *
 * A provider is picked as a WHOLE — endpoint, model chain, and key together. Resolving those
 * three from independent env chains (the previous shape) let a Groq key be paired with
 * Google's endpoint and Gemini model names, which cannot authenticate and reports as a
 * confusing auth failure rather than a misconfiguration.
 */

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
   * Filter out OpenRouter providers that do not support prompt caching.
   * Default: true.
   */
  filterNonCachingProviders: boolean;
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
  heuristicsEnabled: true,
  decisionCacheEnabled: true,
  filterNonCachingProviders: true,
  reasoningEnabled: false,
  reasoningEffort: 'low',
};

/** Env booleans are opt-OUT: anything but an explicit falsey word leaves the default alone. */
function parseBoolean(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined) return fallback;
  const normalized = val.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  return fallback;
}

function parseNumber(val: string | undefined, fallback: number): number {
  if (val === undefined) return fallback;
  const parsed = Number.parseInt(val, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function parseModels(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const models = raw
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return models.length > 0 ? models : null;
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
  const { preset } = resolveProvider(env);

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
    heuristicsEnabled: parseBoolean(
      env['AI_HEURISTICS_ENABLED'],
      DEFAULT_AI_CONFIG.heuristicsEnabled,
    ),
    decisionCacheEnabled: parseBoolean(
      env['AI_DECISION_CACHE_ENABLED'],
      DEFAULT_AI_CONFIG.decisionCacheEnabled,
    ),
    filterNonCachingProviders: parseBoolean(
      env['AI_FILTER_NON_CACHING_PROVIDERS'] || env['OPENROUTER_FILTER_NON_CACHING'],
      DEFAULT_AI_CONFIG.filterNonCachingProviders,
    ),
    reasoningEnabled: parseBoolean(
      env['AI_REASONING_ENABLED'] || env[`${preset.envPrefix}_REASONING_ENABLED`],
      DEFAULT_AI_CONFIG.reasoningEnabled,
    ),
    reasoningEffort,
  };
}

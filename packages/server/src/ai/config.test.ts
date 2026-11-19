import { describe, expect, it } from 'vitest';
import {
  configForRole,
  DEFAULT_AI_CONFIG,
  DEFAULT_MODEL_CHAIN,
  PROVIDERS,
  loadAiConfig,
  parseProviderOnly,
} from './config';

describe('AI Config', () => {
  it('loads default config when env is empty', () => {
    const config = loadAiConfig({});
    expect(config).toEqual(DEFAULT_AI_CONFIG);
    expect(config.models).toEqual(DEFAULT_MODEL_CHAIN);
  });

  it('defaults to OpenRouter (ADR 0011)', () => {
    const config = loadAiConfig({});
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(config.models[0]).toBe('deepseek/deepseek-v4-flash');
    expect(config.filterNonCachingProviders).toBe(true);
  });

  it("never pairs one vendor's key with another vendor's endpoint or models", () => {
    // The bug this shape prevents: resolving key/endpoint/models from independent env
    // chains produced a Groq key aimed at Google's endpoint with Gemini model names.
    const groq = loadAiConfig({ GROQ_API_KEY: 'gsk_123' });
    expect(groq.baseUrl).toBe(PROVIDERS['groq']!.baseUrl);
    expect(groq.models).toEqual(PROVIDERS['groq']!.models);

    const gemini = loadAiConfig({ GEMINI_API_KEY: 'aiza_456' });
    expect(gemini.baseUrl).toBe(PROVIDERS['gemini']!.baseUrl);
    expect(gemini.models).toEqual(PROVIDERS['gemini']!.models);
  });

  it('AI_PROVIDER selects the vendor explicitly, even when another key is present', () => {
    const config = loadAiConfig({
      AI_PROVIDER: 'gemini',
      GROQ_API_KEY: 'gsk_123',
      GEMINI_API_KEY: 'aiza_456',
    });
    expect(config.apiKey).toBe('aiza_456');
    expect(config.baseUrl).toBe(PROVIDERS['gemini']!.baseUrl);
  });

  it('rejects an unknown AI_PROVIDER rather than silently using a default', () => {
    expect(() => loadAiConfig({ AI_PROVIDER: 'not-a-vendor' })).toThrow(/Unknown AI_PROVIDER/);
  });

  it('excludes gemini-2.5-flash-lite, which 404s despite being listed by GET /models', () => {
    expect(PROVIDERS['gemini']!.models).not.toContain('gemini-2.5-flash-lite');
  });

  it('keeps a high-capacity backstop last in the Groq chain', () => {
    // The quality-first models are token-starved (llama-3.3-70b: 100K TPD ≈ 50 calls/day).
    // llama-3.1-8b-instant carries 500K TPD / 14.4K RPD and keeps a game alive after they run out.
    const chain = PROVIDERS['groq']!.models;
    expect(chain[chain.length - 1]).toBe('llama-3.1-8b-instant');
  });

  it('supports vendor-neutral AI_* env vars', () => {
    const config = loadAiConfig({
      AI_BASE_URL: 'https://api.groq.com/openai/v1',
      AI_API_KEY: 'groq-secret-key',
      AI_MODELS: 'llama-3.1-8b-instant, llama-3.3-70b-versatile',
      AI_RPM_LIMIT: '60',
      AI_REQUEST_TIMEOUT_MS: '120000',
    });

    expect(config.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(config.apiKey).toBe('groq-secret-key');
    expect(config.models).toEqual(['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']);
    expect(config.rpmLimit).toBe(60);
    expect(config.requestTimeoutMs).toBe(120000);
  });

  it('falls back to provider-specific env keys (OPENROUTER_API_KEY, GROQ_API_KEY, GEMINI_API_KEY, etc.)', () => {
    const configOpenRouter = loadAiConfig({ OPENROUTER_API_KEY: 'sk-or-123' });
    expect(configOpenRouter.apiKey).toBe('sk-or-123');
    expect(configOpenRouter.baseUrl).toBe(PROVIDERS['openrouter']!.baseUrl);

    const configGroq = loadAiConfig({ GROQ_API_KEY: 'gsk_123' });
    expect(configGroq.apiKey).toBe('gsk_123');

    const configGemini = loadAiConfig({ GEMINI_API_KEY: 'aiza_456' });
    expect(configGemini.apiKey).toBe('aiza_456');
  });

  it('prefers OpenRouter when OPENROUTER_API_KEY is present', () => {
    const config = loadAiConfig({ GEMINI_API_KEY: 'aiza_456', OPENROUTER_API_KEY: 'sk-or-123' });
    expect(config.apiKey).toBe('sk-or-123');
    expect(config.baseUrl).toBe(PROVIDERS['openrouter']!.baseUrl);
  });

  it('handles invalid numeric env values by falling back to default', () => {
    const config = loadAiConfig({
      AI_RPM_LIMIT: 'not-a-number',
      AI_MAX_RETRIES: '-5',
      AI_REQUEST_TIMEOUT_MS: '0',
    });

    expect(config.rpmLimit).toBe(DEFAULT_AI_CONFIG.rpmLimit);
    expect(config.maxRetries).toBe(DEFAULT_AI_CONFIG.maxRetries);
    expect(config.requestTimeoutMs).toBe(DEFAULT_AI_CONFIG.requestTimeoutMs);
  });

  it('configures reasoningEnabled and reasoningEffort from environment', () => {
    const defaultConfig = loadAiConfig({});
    expect(defaultConfig.reasoningEnabled).toBe(false);
    expect(defaultConfig.reasoningEffort).toBe('low');

    const customConfig = loadAiConfig({
      AI_REASONING_ENABLED: 'true',
      AI_REASONING_EFFORT: 'none',
    });
    expect(customConfig.reasoningEnabled).toBe(true);
    expect(customConfig.reasoningEffort).toBe('none');

    const invalidConfig = loadAiConfig({ AI_REASONING_EFFORT: 'invalid-effort' });
    expect(invalidConfig.reasoningEnabled).toBe(false);
    expect(invalidConfig.reasoningEffort).toBe('low');
  });

  it('configures independent strategist and tactician OpenRouter profiles', () => {
    const config = loadAiConfig({
      OPENROUTER_API_KEY: 'sk-or-123',
      AI_STRATEGIST_MODELS: 'deepseek/deepseek-v4-flash',
      AI_STRATEGIST_REASONING_ENABLED: 'true',
      AI_STRATEGIST_REASONING_EFFORT: 'medium',
      AI_TACTICIAN_MODELS: 'qwen/qwen3.7-flash',
      AI_TACTICIAN_REASONING_ENABLED: 'false',
      AI_TACTICIAN_MAX_OUTPUT_TOKENS: '65',
    });

    expect(configForRole(config, 'strategist')).toMatchObject({
      models: ['deepseek/deepseek-v4-flash'],
      reasoningEnabled: true,
      reasoningEffort: 'medium',
      requestTimeoutMs: 45000,
      maxRetries: 2,
    });
    expect(configForRole(config, 'tactician')).toMatchObject({
      models: ['qwen/qwen3.7-flash'],
      reasoningEnabled: false,
      reasoningEffort: 'none',
      maxOutputTokens: 65,
      requestTimeoutMs: 10000,
      maxRetries: 1,
    });
  });

  it('allows independent role timeout, retry, and OpenRouter routing preferences', () => {
    const config = loadAiConfig({
      AI_STRATEGIST_REQUEST_TIMEOUT_MS: '60000',
      AI_STRATEGIST_MAX_RETRIES: '3',
      AI_STRATEGIST_PREFERRED_MAX_LATENCY_SECONDS: '20',
      AI_TACTICIAN_REQUEST_TIMEOUT_MS: '8000',
      AI_TACTICIAN_MAX_RETRIES: '1',
      AI_TACTICIAN_PREFERRED_MIN_THROUGHPUT: '20',
    });
    expect(config.strategist).toMatchObject({
      requestTimeoutMs: 60000,
      maxRetries: 3,
      preferredMaxLatencySeconds: 20,
    });
    expect(config.tactician).toMatchObject({
      requestTimeoutMs: 8000,
      maxRetries: 1,
      preferredMinThroughput: 20,
    });
  });

  it('keeps role-specific capacity fallbacks in the default OpenRouter chains', () => {
    const config = loadAiConfig({ OPENROUTER_API_KEY: 'sk-or-123' });
    expect(config.strategist.models).toEqual(['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4-flash']);
    expect(config.tactician.models).toEqual([
      'qwen/qwen3.7-flash',
      'sao10k/l3-lunaris-8b:nitro',
      'poolside/laguna-s-2.1',
    ]);
  });

  it('keeps Jev pinned and disabled until explicitly configured', () => {
    const config = loadAiConfig({});
    expect(config).toMatchObject({
      jevEnabled: false,
      jevShadowEnabled: false,
      jevModel: 'typesafe/jev-1.13',
      jevRequestTimeoutMs: 2000,
      jevMaxActions: 255,
      jevMinConfidence: null,
      jevMinTopTwoMargin: null,
    });
  });

  it('loads independent Jev rollout and calibration settings', () => {
    const config = loadAiConfig({
      AI_JEV_ENABLED: 'true',
      AI_JEV_SHADOW_ENABLED: 'true',
      AI_JEV_MODEL: 'typesafe/jev-1.13',
      AI_JEV_REQUEST_TIMEOUT_MS: '3500',
      AI_JEV_MAX_ACTIONS: '48',
      AI_JEV_MIN_CONFIDENCE: '0.78',
      AI_JEV_MIN_TOP_TWO_MARGIN: '0.15',
    });
    expect(config).toMatchObject({
      jevEnabled: true,
      jevShadowEnabled: true,
      jevRequestTimeoutMs: 3500,
      jevMaxActions: 48,
      jevMinConfidence: 0.78,
      jevMinTopTwoMargin: 0.15,
    });
    expect(configForRole(config, 'tactician').jevMinConfidence).toBe(0.78);
  });

  it('fails closed to unset Jev thresholds and caps the Choice limit', () => {
    const config = loadAiConfig({
      AI_JEV_MAX_ACTIONS: '999',
      AI_JEV_MIN_CONFIDENCE: 'not-a-probability',
      AI_JEV_MIN_TOP_TWO_MARGIN: '2',
    });
    expect(config.jevMaxActions).toBe(255);
    expect(config.jevMinConfidence).toBeNull();
    expect(config.jevMinTopTwoMargin).toBeNull();
  });

  it('loads Jev placement settings and ignores unknown values (ADR 0041)', () => {
    expect(loadAiConfig({})).toMatchObject({
      jevFallback: 'model',
      jevShadowScope: 'all',
      jevExpandTargets: true,
    });
    expect(
      loadAiConfig({
        AI_JEV_FALLBACK: 'bot',
        AI_JEV_SHADOW_SCOPE: 'uncertain',
        AI_JEV_EXPAND_TARGETS: '0',
      }),
    ).toMatchObject({ jevFallback: 'bot', jevShadowScope: 'uncertain', jevExpandTargets: false });
    expect(loadAiConfig({ AI_JEV_FALLBACK: 'human' }).jevFallback).toBe('model');
  });
});

describe('bot-led tactics settings (ADR 0039)', () => {
  it('takes a fractional escalation margin and a reuse cap of 0', () => {
    const config = loadAiConfig({
      AI_BOT_ESCALATION_MARGIN: '0.5',
      AI_STRATEGIST_MAX_REUSE_TURNS: '0',
    });
    expect(config.botEscalationMargin).toBe(0.5);
    expect(config.strategistMaxReuseTurns).toBe(0);
  });

  it('keeps the defaults for negative or malformed values', () => {
    const config = loadAiConfig({
      AI_BOT_ESCALATION_MARGIN: '-1',
      AI_STRATEGIST_MAX_REUSE_TURNS: '1.5',
    });
    expect(config.botEscalationMargin).toBe(1);
    expect(config.strategistMaxReuseTurns).toBe(3);
  });
});

describe('escalation triggers (ADR 0044)', () => {
  it('reads a trigger list, and never or nothing as none', () => {
    expect(loadAiConfig({}).botEscalation).toEqual([]);
    expect(loadAiConfig({ AI_BOT_ESCALATION: 'never' }).botEscalation).toEqual([]);
    expect(loadAiConfig({ AI_BOT_ESCALATION: 'uncertain' }).botEscalation).toEqual(['uncertain']);
    expect(
      loadAiConfig({ AI_BOT_ESCALATION: 'scarce-answer, unknown-card,scarce-answer' })
        .botEscalation,
    ).toEqual(['scarce-answer', 'unknown-card']);
    expect(
      loadAiConfig({ AI_BOT_ESCALATION_SHADOW: 'lethal,uncertain' }).botEscalationShadow,
    ).toEqual(['lethal', 'uncertain']);
  });

  it('refuses an unknown trigger instead of silently meaning never', () => {
    expect(() => loadAiConfig({ AI_BOT_ESCALATION: 'uncertian' })).toThrow(/uncertian/);
    expect(() => loadAiConfig({ AI_BOT_ESCALATION_SHADOW: 'telepathy' })).toThrow(/telepathy/);
  });

  it('keeps lethal in shadow', () => {
    expect(() => loadAiConfig({ AI_BOT_ESCALATION: 'lethal' })).toThrow(/shadow-only/);
  });
});

describe('AI_OPENROUTER_PROVIDER_ONLY', () => {
  it('defaults GLM 5.3 Flash to its allowlist and leaves other models open', () => {
    const config = loadAiConfig({ OPENROUTER_API_KEY: 'k' });
    expect(config.openRouterProviderOnly['z-ai/glm-5.3-flash']).toContain('wafer');
    expect(config.openRouterProviderOnly['z-ai/glm-5.3-flash']).not.toContain('cohere');
    expect(config.openRouterProviderOnly['deepseek/deepseek-v4-flash']).toBeUndefined();
  });

  it('parses model=slug,slug pairs, off, and rejects a malformed entry', () => {
    expect(parseProviderOnly('a/b=x, y;c/d=z', {})).toEqual({ 'a/b': ['x', 'y'], 'c/d': ['z'] });
    expect(parseProviderOnly('off', { 'a/b': ['x'] })).toEqual({});
    expect(parseProviderOnly(undefined, { 'a/b': ['x'] })).toEqual({ 'a/b': ['x'] });
    expect(() => parseProviderOnly('a/b=', {})).toThrow(/AI_OPENROUTER_PROVIDER_ONLY/);
    expect(() => parseProviderOnly('a/b', {})).toThrow(/AI_OPENROUTER_PROVIDER_ONLY/);
  });
});

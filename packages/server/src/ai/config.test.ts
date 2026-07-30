import { describe, expect, it } from 'vitest';
import {
  configForRole,
  DEFAULT_AI_CONFIG,
  DEFAULT_MODEL_CHAIN,
  PROVIDERS,
  loadAiConfig,
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
    expect(config.strategist.models).toEqual(['deepseek/deepseek-v4-flash', 'tencent/hy3']);
    expect(config.tactician.models).toEqual([
      'qwen/qwen3.7-flash',
      'sao10k/l3-lunaris-8b:nitro',
      'poolside/laguna-s-2.1',
    ]);
  });
});

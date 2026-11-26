import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import { OpenAiCompatibleClient, type AiNetworkAttempt } from './client';
import { configForRole, DEFAULT_AI_CONFIG, loadAiConfig, type AiConfig } from './config';
import { anthropicRequest } from './anthropic';
import { AuthenticationError } from './errors';
import type { AiPrompt } from './context';

const prompt: AiPrompt = {
  messages: [
    { role: 'system', content: 'primer' },
    { role: 'user', content: 'state' },
  ],
  estimatedTokens: 100,
};

const request: DecisionRequest = {
  requestId: 'req-1',
  gameId: 'g1',
  turn: 1,
  activePlayer: 'P1',
  decidingPlayer: 'P1',
  phase: 'precombatMain',
  step: null,
  decisionType: 'priority',
  prompt: 'You have priority.',
  legalActions: [{ id: 0, type: 'pass', description: 'Pass' }],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function message(text: string, model = 'claude-sonnet-5-5'): Response {
  return json(200, {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 20,
      output_tokens: 12,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 0,
    },
  });
}

const anthropicConfig: AiConfig = {
  ...DEFAULT_AI_CONFIG,
  apiFormat: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
  maxRetries: 0,
};

describe('Anthropic provider config', () => {
  it('is picked by AI_PROVIDER and carries current Claude models per role', () => {
    const config = loadAiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(config.apiFormat).toBe('anthropic');
    expect(config.baseUrl).toBe('https://api.anthropic.com');
    expect(config.apiKey).toBe('sk-ant-x');
    expect(config.strategist.models).toEqual(['claude-sonnet-5-5']);
    expect(config.tactician.models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
  });

  it('turns the stable-prefix cache layout on for Claude only, and lets the env turn it off', () => {
    expect(
      loadAiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' })
        .providerPromptCacheLayoutEnabled,
    ).toBe(true);
    expect(
      loadAiConfig({
        AI_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'k',
        AI_PROVIDER_PROMPT_CACHE_LAYOUT_ENABLED: 'false',
      }).providerPromptCacheLayoutEnabled,
    ).toBe(false);
    expect(loadAiConfig({ AI_PROVIDER: 'openrouter' }).providerPromptCacheLayoutEnabled).toBe(
      false,
    );
  });

  it('is auto-detected from ANTHROPIC_API_KEY alone, but never ahead of another key', () => {
    expect(loadAiConfig({ ANTHROPIC_API_KEY: 'sk-ant-x' }).apiFormat).toBe('anthropic');
    const both = loadAiConfig({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENROUTER_API_KEY: 'sk-or' });
    expect(both.apiFormat).toBe('openai');
    expect(both.apiKey).toBe('sk-or');
  });

  it('honours the ANTHROPIC_* and AI_* overrides', () => {
    const config = loadAiConfig({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
      AI_STRATEGIST_MODELS: 'claude-sonnet-5-5',
    });
    expect(config.baseUrl).toBe('https://proxy.example/anthropic');
    expect(config.strategist.models).toEqual(['claude-sonnet-5-5']);
  });

  it('lets AI_API_FORMAT point any base URL at either protocol, and rejects unknown formats', () => {
    const custom = loadAiConfig({
      AI_BASE_URL: 'https://llm.example/v1',
      AI_API_KEY: 'k',
      AI_MODELS: 'local-model',
    });
    expect(custom.apiFormat).toBe('openai');
    expect(custom.models).toEqual(['local-model']);
    expect(loadAiConfig({ AI_PROVIDER: 'anthropic', AI_API_FORMAT: 'openai' }).apiFormat).toBe(
      'openai',
    );
    expect(() => loadAiConfig({ AI_API_FORMAT: 'grpc' })).toThrow(/AI_API_FORMAT/);
  });

  it('leaves the existing providers on the OpenAI format', () => {
    for (const provider of ['openrouter', 'groq', 'gemini', 'deepseek', 'openai']) {
      expect(loadAiConfig({ AI_PROVIDER: provider }).apiFormat).toBe('openai');
    }
  });
});

describe('anthropicRequest', () => {
  it('moves system messages to `system`, caches the primer and sends no temperature', () => {
    const body = anthropicRequest(anthropicConfig, 'claude-sonnet-5-5', prompt, 256);
    expect(body.system).toEqual([
      { type: 'text', text: 'primer', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'state' }] }]);
    expect(body).not.toHaveProperty('temperature');
    expect(body.fallbacks).toBe('default');
  });

  it('sends no server-side fallback to Haiku, which has none', () => {
    const body = anthropicRequest(anthropicConfig, 'claude-haiku-5-5', prompt, 256);
    expect(body).not.toHaveProperty('fallbacks');
    expect(body).not.toHaveProperty('betas');
  });

  it('maps reasoning off to low effort and still leaves room to think', () => {
    const off = anthropicRequest(
      { ...anthropicConfig, reasoningEnabled: false, reasoningTokenHeadroom: 0 },
      'claude-opus-5-5',
      prompt,
      256,
    );
    expect(off.output_config).toEqual({ effort: 'low' });
    expect(off.max_tokens).toBe(256 + 2048);

    const high = anthropicRequest(
      {
        ...anthropicConfig,
        reasoningEnabled: true,
        reasoningEffort: 'high',
        reasoningTokenHeadroom: 4000,
      },
      'claude-opus-5-5',
      prompt,
      1000,
    );
    expect(high.output_config).toEqual({ effort: 'high' });
    expect(high.max_tokens).toBe(5000);
  });

  it('puts the breakpoint on the last stable-prefix message when the cache layout is on', () => {
    const layered: AiPrompt = {
      messages: [
        { role: 'system', content: 'primer' },
        { role: 'user', content: 'game constants' },
        { role: 'user', content: 'observation' },
      ],
      estimatedTokens: 10,
      promptCache: {
        version: 'stable-prefix-v2',
        role: 'strategist',
        prefixHash: 'h',
        prefixMessageCount: 2,
        coldStatus: 'unverified',
        completeResponseCacheAllowed: false,
      },
    };
    const body = anthropicRequest(anthropicConfig, 'claude-opus-5-5', layered, 100);
    expect(body.system).toEqual([{ type: 'text', text: 'primer' }]);
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: 'game constants', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages[1]?.content).toEqual([{ type: 'text', text: 'observation' }]);
  });
});

describe('OpenAiCompatibleClient over the Messages API', () => {
  it('calls /v1/messages through the SDK and parses the text block', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(message('{"actionId":0,"note":"pass"}'));
    const attempts: AiNetworkAttempt[] = [];
    const client = new OpenAiCompatibleClient(
      configForRole(
        {
          ...anthropicConfig,
          tactician: { ...DEFAULT_AI_CONFIG.tactician, models: ['claude-sonnet-5-5'] },
        },
        'tactician',
      ),
      fetchImpl as unknown as typeof fetch,
      async () => {},
      (attempt) => {
        attempts.push(attempt);
      },
    );
    const { response, meta } = await client.requestDecision(prompt, request);

    expect(response.actionId).toBe(0);
    expect(meta.backend).toBe('anthropic');
    expect(meta.promptTokens).toBe(100);
    expect(meta.responseTokens).toBe(12);
    expect(meta.cacheStatus).toBe('observed_hit');

    const [url, init] = fetchImpl.mock.calls[0] as [string | URL | Request, RequestInit];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    const headers = new Headers(init.headers);
    // SDK 1.x sends the key as a bearer token, with the API version header beside it.
    expect(headers.get('authorization')).toBe('Bearer sk-ant-test');
    expect(headers.get('anthropic-version')).not.toBeNull();
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent['model']).toBe('claude-sonnet-5-5');
    expect(sent).not.toHaveProperty('response_format');
    expect(attempts[0]?.status).toBe('accepted');
    expect(attempts[0]?.effectiveConfig['apiFormat']).toBe('anthropic');
  });

  it('falls back to the next model when one is not found', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json(404, {
          type: 'error',
          error: { type: 'not_found_error', message: 'model: claude-sonnet-5-5' },
        }),
      )
      .mockResolvedValueOnce(message('{"actionId":0}', 'claude-opus-5-5'));
    const client = new OpenAiCompatibleClient(
      anthropicConfig,
      fetchImpl as unknown as typeof fetch,
      async () => {},
    );
    const { meta } = await client.requestDecision(prompt, request);
    expect(meta.model).toBe('claude-opus-5-5');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports a bad key as an authentication error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    );
    const client = new OpenAiCompatibleClient(
      anthropicConfig,
      fetchImpl as unknown as typeof fetch,
      async () => {},
    );
    await expect(client.requestDecision(prompt, request)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });
});

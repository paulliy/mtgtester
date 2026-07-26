import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import { OpenAiCompatibleClient } from './client';
import { DEFAULT_AI_CONFIG } from './config';
import { DailyQuotaExhaustedError, NoAvailableModelError } from './errors';
import type { AiPrompt } from './context';

function fixturePrompt(): AiPrompt {
  return {
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ],
    estimatedTokens: 100,
  };
}

function fixtureRequest(): DecisionRequest {
  return {
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
}

describe('OpenAiCompatibleClient', () => {
  it('parses valid OpenAI chat completion responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ requestId: 'req-1', actionId: 0, note: 'Passing priority' }),
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 15 },
      }),
    });

    const client = new OpenAiCompatibleClient(DEFAULT_AI_CONFIG, mockFetch as unknown as typeof fetch);
    const { response, meta } = await client.requestDecision(fixturePrompt(), fixtureRequest());

    expect(response.actionId).toBe(0);
    expect(response.note).toBe('Passing priority');
    // The head of the configured chain, whatever the default vendor currently is.
    expect(meta.model).toBe(DEFAULT_AI_CONFIG.models[0]);
    expect(meta.promptTokens).toBe(120);
    expect(meta.responseTokens).toBe(15);
  });

  it('extracts JSON object from conversational text or markdown codeblocks', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'Sure! Here is the JSON response:\n```json\n{\n  "action_id": 1,\n  "note": "Casting spell"\n}\n```\nHope that helps!',
            },
          },
        ],
      }),
    });

    const client = new OpenAiCompatibleClient(DEFAULT_AI_CONFIG, mockFetch as unknown as typeof fetch);
    const { response } = await client.requestDecision(fixturePrompt(), fixtureRequest());

    expect(response.actionId).toBe(1);
    expect(response.note).toBe('Casting spell');
  });

  it('cascades to next model when current model is unavailable (404)', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      callCount++;
      const body = JSON.parse(init.body);
      if (body.model === 'gemini-3.5-flash-lite') {
        return { ok: false, status: 404, text: async () => 'model_not_found' };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ actionId: 0 }) } }],
        }),
      };
    });

    const client = new OpenAiCompatibleClient(
      { ...DEFAULT_AI_CONFIG, models: ['gemini-3.5-flash-lite', 'llama-3.1-8b-instant'] },
      mockFetch as unknown as typeof fetch,
    );

    const { response, meta } = await client.requestDecision(fixturePrompt(), fixtureRequest());
    expect(response.actionId).toBe(0);
    expect(meta.model).toBe('llama-3.1-8b-instant');
    expect(client.activeModel).toBe('llama-3.1-8b-instant');
    expect(callCount).toBe(2);
  });

  it('cascades to the next model when the daily quota for one is exhausted', async () => {
    const rpdBody = JSON.stringify([
      {
        error: {
          code: 429,
          message: 'You exceeded your current quota, limit: 500, model: model-a',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
        },
      },
    ]);

    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === 'model-a') {
        return { ok: false, status: 429, text: async () => rpdBody };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ actionId: 0 }) } }] }),
      };
    });

    const client = new OpenAiCompatibleClient(
      { ...DEFAULT_AI_CONFIG, models: ['model-a', 'model-b'] },
      mockFetch as unknown as typeof fetch,
    );

    const { meta } = await client.requestDecision(fixturePrompt(), fixtureRequest());
    expect(meta.model).toBe('model-b');
    // One doomed call on model-a — no backoff loop against a spent daily budget.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws DailyQuotaExhaustedError when every model in the chain is out of quota', async () => {
    const rpdBody = 'RESOURCE_EXHAUSTED GenerateRequestsPerDayPerProjectPerModel-FreeTier';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => rpdBody,
    });

    const client = new OpenAiCompatibleClient(
      { ...DEFAULT_AI_CONFIG, models: ['model-a', 'model-b'] },
      mockFetch as unknown as typeof fetch,
    );

    await expect(client.requestDecision(fixturePrompt(), fixtureRequest())).rejects.toThrow(
      DailyQuotaExhaustedError,
    );
  });

  it('throws NoAvailableModelError if all models in fallback chain fail', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'model_not_found',
    });

    const client = new OpenAiCompatibleClient(
      { ...DEFAULT_AI_CONFIG, models: ['model-a', 'model-b'] },
      mockFetch as unknown as typeof fetch,
    );

    await expect(client.requestDecision(fixturePrompt(), fixtureRequest())).rejects.toThrow(
      NoAvailableModelError,
    );
  });

  it('cascades to next model when model hits RPM', async () => {
    const rpmBody = JSON.stringify([
      {
        error: {
          code: 429,
          message: 'Quota exceeded for metric: requests, limit: 15',
          status: 'RESOURCE_EXHAUSTED',
          details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }],
        },
      },
    ]);

    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === 'model-a') {
        return { ok: false, status: 429, text: async () => rpmBody };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ actionId: 0 }) } }] }),
      };
    });

    const client = new OpenAiCompatibleClient(
      { ...DEFAULT_AI_CONFIG, models: ['model-a', 'model-b'] },
      mockFetch as unknown as typeof fetch,
    );

    const { meta } = await client.requestDecision(fixturePrompt(), fixtureRequest());
    expect(meta.model).toBe('model-b');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('cycles and waits for RPM reset when all available models hit RPM', async () => {
    const rpmBody = 'RESOURCE_EXHAUSTED GenerateRequestsPerMinutePerProjectPerModel-FreeTier';
    let attempts = 0;
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
      attempts++;
      const _body = JSON.parse(init.body);
      // Both model-a and model-b hit RPM on first attempt; on cycle 2, model-a succeeds
      if (attempts <= 2) {
        return { ok: false, status: 429, text: async () => rpmBody };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ actionId: 0 }) } }] }),
      };
    });

    const client = new OpenAiCompatibleClient(
      { ...DEFAULT_AI_CONFIG, models: ['model-a', 'model-b'] },
      mockFetch as unknown as typeof fetch,
      mockSleep,
    );

    const { meta } = await client.requestDecision(fixturePrompt(), fixtureRequest());
    expect(meta.model).toBe('model-a');
    expect(attempts).toBe(3);
    expect(mockSleep).toHaveBeenCalledWith(60000);
  });

  it('includes provider.ignore in POST body for non-caching providers when using OpenRouter', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/models/') && url.includes('/endpoints')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              endpoints: [
                { provider_name: 'CachingProvider', supports_implicit_caching: true },
                { provider_name: 'NonCachingProvider', supports_implicit_caching: false },
              ],
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ actionId: 0 }) } }],
        }),
      };
    });

    const client = new OpenAiCompatibleClient(
      {
        ...DEFAULT_AI_CONFIG,
        baseUrl: 'https://openrouter.ai/api/v1',
        models: ['vendor/test-model'],
        filterNonCachingProviders: true,
      },
      mockFetch as unknown as typeof fetch,
    );

    await client.requestDecision(fixturePrompt(), fixtureRequest());

    const chatCall = mockFetch.mock.calls.find((c) => (c[0] as string).includes('/chat/completions'));
    expect(chatCall).toBeDefined();
    const sentBody = JSON.parse((chatCall![1] as RequestInit).body as string);
    expect(sentBody.provider).toEqual({ ignore: ['NonCachingProvider'] });
  });
});


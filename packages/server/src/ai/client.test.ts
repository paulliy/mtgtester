import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import { OpenAiCompatibleClient } from './client';
import type { AiConfig } from './config';
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

  it('sends configured OpenRouter routing preferences with the request', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ actionId: 0 }) } }] }),
    });
    const client = new OpenAiCompatibleClient(
      {
        ...DEFAULT_AI_CONFIG,
        preferredMaxLatencySeconds: 7,
        preferredMinThroughput: 15,
      },
      mockFetch as unknown as typeof fetch,
    );

    await client.requestDecision(fixturePrompt(), fixtureRequest());
    const call = mockFetch.mock.calls.find((entry) => (entry[0] as string).includes('/chat/completions'))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.provider).toMatchObject({
      preferred_max_latency: 7,
      preferred_min_throughput: 15,
    });
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

  /**
   * The regression this whole group exists for. OpenRouter folds a top-level
   * `reasoning_effort` into `reasoning.effort`, so a body carrying `reasoning_effort` *and*
   * `reasoning: { max_tokens: 0 }` contradicted itself and every request in every game came
   * back `400 Only one of "reasoning.effort" and "reasoning.max_tokens" can be specified`.
   */
  describe('reasoning parameters', () => {
    function bodyOf(mockFetch: ReturnType<typeof vi.fn>): Record<string, unknown> {
      const chatCall = mockFetch.mock.calls.find((c) => (c[0] as string).includes('/chat/completions'));
      return JSON.parse((chatCall![1] as RequestInit).body as string) as Record<string, unknown>;
    }

    function okFetch() {
      return vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ actionId: 0 }) } }] }),
      });
    }

    async function send(overrides: Partial<AiConfig>): Promise<Record<string, unknown>> {
      const mockFetch = okFetch();
      const client = new OpenAiCompatibleClient(
        { ...DEFAULT_AI_CONFIG, models: ['vendor/model'], filterNonCachingProviders: false, ...overrides },
        mockFetch as unknown as typeof fetch,
      );
      await client.requestDecision(fixturePrompt(), fixtureRequest());
      return bodyOf(mockFetch);
    }

    it('never sends both spellings of the reasoning control at once', async () => {
      for (const reasoningEnabled of [false, true]) {
        const body = await send({ reasoningEnabled });
        const hasBoth = body['reasoning'] !== undefined && body['reasoning_effort'] !== undefined;
        expect(hasBoth).toBe(false);
      }
    });

    it('turns reasoning off with `enabled: false` — never a zero max_tokens', async () => {
      const body = await send({ reasoningEnabled: false });
      expect(body['reasoning']).toEqual({ enabled: false });
      expect(body['reasoning_effort']).toBeUndefined();
    });

    it('sends effort alone when reasoning is on, since effort and max_tokens are exclusive', async () => {
      const body = await send({ reasoningEnabled: true, reasoningEffort: 'medium' });
      expect(body['reasoning']).toEqual({ effort: 'medium', exclude: true });
      expect((body['reasoning'] as Record<string, unknown>)['max_tokens']).toBeUndefined();
    });

    it('treats effort "none" as reasoning off even when the flag is on', async () => {
      const body = await send({ reasoningEnabled: true, reasoningEffort: 'none' });
      expect(body['reasoning']).toEqual({ enabled: false });
    });

    it('maps our "max" effort onto the highest level the wire enum actually has', async () => {
      const body = await send({ reasoningEnabled: true, reasoningEffort: 'max' });
      expect(body['reasoning']).toEqual({ effort: 'high', exclude: true });
    });

    it('uses OpenAI\'s reasoning_effort — and omits it entirely when off — off OpenRouter', async () => {
      const groq = { baseUrl: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b'] };

      const on = await send({ ...groq, reasoningEnabled: true, reasoningEffort: 'low' });
      expect(on['reasoning_effort']).toBe('low');
      expect(on['reasoning']).toBeUndefined();

      // There is no portable "off" value, and these vendors reject unknown body fields.
      const off = await send({ ...groq, reasoningEnabled: false });
      expect(off['reasoning_effort']).toBeUndefined();
      expect(off['reasoning']).toBeUndefined();
    });

    it('gives a reasoning run token headroom, because max_tokens caps thinking and answer together', async () => {
      const off = await send({ reasoningEnabled: false, maxOutputTokens: 1000 });
      expect(off['max_tokens']).toBe(1000);

      const on = await send({ reasoningEnabled: true, maxOutputTokens: 1000 });
      expect(on['max_tokens']).toBeGreaterThan(1000);
    });
  });

  it('reads the answer out of `reasoning` when a thinking model leaves content empty', async () => {
    // Budget spent mid-thought: `content` comes back empty with everything the model wrote in
    // `reasoning`. The decision JSON is usually in there, and recovering it is free.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            finish_reason: 'length',
            message: {
              content: '',
              reasoning: 'Board is empty, nothing worth doing.\n{"actionId": 0, "note": "Pass"}',
            },
          },
        ],
      }),
    });

    const client = new OpenAiCompatibleClient(
      { ...DEFAULT_AI_CONFIG, models: ['model-a'] },
      mockFetch as unknown as typeof fetch,
    );

    const { response } = await client.requestDecision(fixturePrompt(), fixtureRequest());
    expect(response.actionId).toBe(0);
  });

  it('names the finish_reason when there is genuinely nothing to read', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '' } }] }),
    });

    const client = new OpenAiCompatibleClient(
      { ...DEFAULT_AI_CONFIG, models: ['model-a'], maxRetries: 0 },
      mockFetch as unknown as typeof fetch,
    );

    await expect(client.requestDecision(fixturePrompt(), fixtureRequest())).rejects.toThrow(
      /finish_reason: length/,
    );
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


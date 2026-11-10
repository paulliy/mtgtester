import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import { OpenAiCompatibleClient, type AiNetworkAttempt } from './client';
import { DEFAULT_AI_CONFIG, type AiConfig } from './config';
import type { AiPrompt } from './context';
import { RequestTimeoutError } from './errors';
import { lookupGenerationCost, newStreamProgress, readChatCompletionStream } from './streaming';

const encoder = new TextEncoder();

function sse(events: unknown[], options: { hangAfter?: boolean } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\n'));
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      if (options.hangAfter !== true) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** A stream that delivers its first chunks, then stalls until the request's signal aborts. */
function stallingSse(events: unknown[], signal: AbortSignal | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      signal?.addEventListener('abort', () => controller.error(signal.reason));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function prompt(): AiPrompt {
  return {
    messages: [{ role: 'user', content: 'Pick an action.' }],
    estimatedTokens: 50,
  } as AiPrompt;
}

function request(): DecisionRequest {
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

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    ...DEFAULT_AI_CONFIG,
    apiKey: 'sk-or-test',
    models: ['m1'],
    filterNonCachingProviders: false,
    maxRetries: 2,
    baseBackoffMs: 1,
    maxBackoffMs: 1,
    ...overrides,
  };
}

const answerChunks = [
  { id: 'gen-1', model: 'm1', provider: 'P', choices: [{ delta: { content: '{"actionId"' } }] },
  { id: 'gen-1', choices: [{ delta: { content: ': 0}' }, finish_reason: 'stop' }] },
  {
    id: 'gen-1',
    choices: [],
    usage: { prompt_tokens: 40, completion_tokens: 6, cost: 0.000123 },
  },
];

describe('readChatCompletionStream', () => {
  it('rebuilds the non-streamed body from SSE chunks, ignoring keep-alive comments', async () => {
    const progress = newStreamProgress();
    const body = await readChatCompletionStream(sse(answerChunks), progress);
    expect(body.id).toBe('gen-1');
    expect(body.choices?.[0]?.message?.content).toBe('{"actionId": 0}');
    expect(body.choices?.[0]?.finish_reason).toBe('stop');
    expect(body.usage?.cost).toBe(0.000123);
    expect(progress.chars).toBe('{"actionId": 0}'.length);
  });

  it('turns an error chunk inside a 200 stream into a thrown error', async () => {
    const res = sse([{ error: { code: 429, message: 'slow down' } }]);
    await expect(readChatCompletionStream(res, newStreamProgress())).rejects.toThrow(/slow down/);
  });
});

describe('OpenAiCompatibleClient streaming', () => {
  it('asks OpenRouter for a stream and takes cost from the usage chunk', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sse(answerChunks);
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient(config(), fetchImpl);

    const { response, meta } = await client.requestDecision(prompt(), request());

    expect(bodies[0]?.['stream']).toBe(true);
    expect(response.actionId).toBe(0);
    expect(meta.costUsd).toBe(0.000123);
    expect(meta.providerRequestId).toBe('gen-1');
    expect(client.unsettledAttempts()).toHaveLength(0);
  });

  it('does not stream when streaming is switched off', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"actionId":0}' } }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient(config({ streamResponses: false }), fetchImpl);
    await client.requestDecision(prompt(), request());
    expect(bodies[0]?.['stream']).toBeUndefined();
  });

  it('does not retry a timed-out call, and keeps its generation id to look up the bill', async () => {
    let calls = 0;
    const attempts: AiNetworkAttempt[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls++;
      return stallingSse(
        [{ id: 'gen-slow', choices: [{ delta: { content: '{"actionId":' } }] }],
        init.signal ?? undefined,
      );
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient(
      config({ requestTimeoutMs: 30 }),
      fetchImpl,
      undefined,
      (attempt) => {
        attempts.push(attempt);
      },
    );

    await expect(client.requestDecision(prompt(), request())).rejects.toBeInstanceOf(
      RequestTimeoutError,
    );

    expect(calls).toBe(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('transport_error');
    expect(attempts[0]?.providerRequestId).toBe('gen-slow');
    expect(attempts[0]?.usage.responseTokens).toBeGreaterThan(0);
    expect(attempts[0]?.usage.costUsd).toBeUndefined();
    expect(client.unsettledAttempts().map((a) => a.generationId)).toEqual(['gen-slow']);
  });

  it('retries a timeout when retryOnTimeout is set', async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) return stallingSse([], init.signal ?? undefined);
      return sse(answerChunks);
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient(
      config({ requestTimeoutMs: 30, retryOnTimeout: true }),
      fetchImpl,
      async () => {},
    );
    const { response } = await client.requestDecision(prompt(), request());
    expect(response.actionId).toBe(0);
    expect(calls).toBe(2);
  });

  it('settles unknown costs from the generation endpoint', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      urls.push(url);
      if (url.includes('/generation?id=')) {
        return new Response(
          JSON.stringify({ data: { id: 'gen-slow', total_cost: 0.0021, tokens_completion: 900 } }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return stallingSse(
        [{ id: 'gen-slow', choices: [{ delta: { content: '{' } }] }],
        init.signal ?? undefined,
      );
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient(config({ requestTimeoutMs: 30 }), fetchImpl);
    await expect(client.requestDecision(prompt(), request())).rejects.toThrow();

    const settlement = await client.settleUnknownCosts({ sleep: async () => {} });

    expect(settlement.settledUsd).toBeCloseTo(0.0021);
    expect(settlement.unresolved).toBe(0);
    expect(settlement.attempts[0]?.billed?.responseTokens).toBe(900);
    expect(urls.some((u) => u.endsWith('/generation?id=gen-slow'))).toBe(true);
    expect(client.unsettledAttempts()).toHaveLength(0);
  });
});

describe('OpenAiCompatibleClient streaming edge cases', () => {
  it('reads the decision from streamed reasoning when the answer content is empty', async () => {
    const fetchImpl = (async () =>
      sse([
        { id: 'gen-r', choices: [{ delta: { reasoning: 'thinking... {"actionId": 0}' } }] },
        { id: 'gen-r', choices: [{ delta: {}, finish_reason: 'length' }] },
        {
          id: 'gen-r',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 9, cost: 1e-5 },
        },
      ])) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient(config(), fetchImpl);
    const { response } = await client.requestDecision(prompt(), request());
    expect(response.actionId).toBe(0);
  });

  it('keeps a real error that lands after the deadline instead of calling it a timeout', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      // Ignores the abort signal, answers after the deadline has passed.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response('upstream exploded', { status: 500 });
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient(
      config({ requestTimeoutMs: 10, maxRetries: 1 }),
      fetchImpl,
      async () => {},
    );
    const error = await client.requestDecision(prompt(), request()).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RequestTimeoutError);
    expect(calls).toBe(2); // a 500 is still retried
  });

  it('moves later requests to the next model after repeated timeouts', async () => {
    const models: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string };
      models.push(body.model);
      if (body.model === 'slow') return stallingSse([], init.signal ?? undefined);
      return sse(answerChunks);
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient(
      config({ models: ['slow', 'fast'], requestTimeoutMs: 20 }),
      fetchImpl,
    );
    for (let i = 0; i < 3; i++) {
      await expect(client.requestDecision(prompt(), request())).rejects.toBeInstanceOf(
        RequestTimeoutError,
      );
    }
    expect(client.activeModel).toBe('fast');
    const { response } = await client.requestDecision(prompt(), request());
    expect(response.actionId).toBe(0);
    expect(models).toEqual(['slow', 'slow', 'slow', 'fast']);
  });

  it('a cancelled request is not reported as a timeout', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      setTimeout(() => controller.abort(), 5);
      return stallingSse(
        [{ id: 'gen-c', choices: [{ delta: { content: '{' } }] }],
        init.signal ?? undefined,
      );
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatibleClient(config({ requestTimeoutMs: 5000 }), fetchImpl);
    const error = await client
      .requestDecision(prompt(), request(), controller.signal)
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RequestTimeoutError);
    expect(client.unsettledAttempts().map((a) => a.generationId)).toEqual(['gen-c']);
  });
});

describe('lookupGenerationCost', () => {
  it('waits for stats that are not ready yet, then gives up with null', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const result = await lookupGenerationCost('gen-x', {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      fetchImpl,
      sleep: async () => {},
      delaysMs: [1, 1],
    });
    expect(result).toBeNull();
    expect(calls).toBe(3);
  });
});

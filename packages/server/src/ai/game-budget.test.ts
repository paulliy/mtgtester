import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import type { AiClient, AiNetworkAttempt } from './client';
import type { AiPrompt } from './context';
import {
  BudgetExhaustedError,
  GameAiBudget,
  isKeyLimitFailure,
  limitedClient,
} from './game-budget';
import { assertPriced, estimateCostUsd, priceKey } from './pricing';

function attempt(overrides: Partial<AiNetworkAttempt> = {}): AiNetworkAttempt {
  return {
    schemaVersion: 1,
    logicalRequestId: 'r1',
    attemptIndex: 0,
    requestedModel: 'claude-haiku-5-5',
    status: 'accepted',
    startedAt: '2026-11-26T00:00:00Z',
    endedAt: '2026-11-26T00:00:01Z',
    durationMs: 1000,
    messages: [],
    effectiveConfig: {},
    usage: {
      promptTokens: 10_000,
      responseTokens: 1_000,
      promptTokenSource: 'reported',
      responseTokenSource: 'reported',
      costSource: 'unknown',
    },
    ...overrides,
  };
}

const prompt: AiPrompt = { messages: [{ role: 'user', content: 'state' }], estimatedTokens: 1 };
const request = { requestId: 'r1', decidingPlayer: 'P2' } as DecisionRequest;

describe('pricing', () => {
  it("prices Haiku 5.5 from Anthropic's table, with cache reads and writes split out", () => {
    // 6,000 fresh input at $0.10/M, 3,000 cache reads at $0.01/M, 1,000 cache writes at $0.125/M,
    // 1,000 output at $0.50/M.
    const cost = estimateCostUsd('claude-haiku-5-5', {
      promptTokens: 10_000,
      cacheReadTokens: 3_000,
      cacheWriteTokens: 1_000,
      responseTokens: 1_000,
    });
    expect(cost).toBeCloseTo(0.0006 + 0.00003 + 0.000125 + 0.0005, 10);
  });

  it('charges a prompt over 100,000 tokens at the long-context rates throughout', () => {
    const cost = estimateCostUsd('claude-haiku-5-5', {
      promptTokens: 200_000,
      responseTokens: 1_000,
    });
    expect(cost).toBeCloseTo(200_000 * 0.5e-6 + 1_000 * 2.5e-6, 10);
  });

  it("reads OpenRouter's spelling of the same model", () => {
    expect(priceKey('anthropic/claude-haiku-5.5')).toBe('claude-haiku-5-5');
    expect(estimateCostUsd('anthropic/claude-haiku-5.5', { promptTokens: 100_000 })).toBeCloseTo(
      0.01,
      10,
    );
  });

  it('has no estimate for an unpriced model or an attempt with no tokens', () => {
    expect(estimateCostUsd('claude-sonnet-5-5', { promptTokens: 1000 })).toBeUndefined();
    expect(estimateCostUsd('claude-haiku-5-5', {})).toBeUndefined();
    expect(() => assertPriced(['claude-haiku-5-5'])).not.toThrow();
    expect(() => assertPriced(['claude-haiku-5-5', 'claude-sonnet-5-5'])).toThrow(
      'no price for claude-sonnet-5-5',
    );
  });
});

describe('GameAiBudget', () => {
  it("prefers the provider's reported cost and stops once the cap is reached", () => {
    const budget = new GameAiBudget(0.01);
    const onStop = vi.fn();
    budget.onStop = onStop;
    budget.charge(attempt({ usage: { ...attempt().usage, costUsd: 0.004 } }));
    expect(budget.spentUsd).toBeCloseTo(0.004);
    expect(budget.stopped).toBeNull();
    budget.charge(attempt({ usage: { ...attempt().usage, costUsd: 0.007 } }));
    expect(budget.stopped).toBe('cap');
    expect(onStop).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledWith('cap', expect.closeTo(0.011, 6));
    expect(() => budget.check()).toThrow(BudgetExhaustedError);
  });

  it('estimates an unreported cost from tokens, and counts what it cannot price', () => {
    const budget = new GameAiBudget(1);
    budget.charge(attempt());
    expect(budget.spentUsd).toBeCloseTo(10_000 * 0.1e-6 + 1_000 * 0.5e-6, 10);
    budget.charge(attempt({ requestedModel: 'some-unpriced-model' }));
    expect(budget.unpricedAttempts).toBe(1);
  });

  it("stops for the key's own limit, but not for an ordinary rate limit", () => {
    const failed = (status: number, body: string) =>
      attempt({ status: 'http_error', error: `HTTP ${status}`, rawResponse: body });
    expect(isKeyLimitFailure(failed(402, '{}'))).toBe(true);
    expect(isKeyLimitFailure(failed(401, '{"type":"authentication_error"}'))).toBe(true);
    expect(
      isKeyLimitFailure(
        failed(400, '{"error":{"message":"Your credit balance is too low to access the API."}}'),
      ),
    ).toBe(true);
    expect(isKeyLimitFailure(failed(429, '{"error":{"type":"rate_limit_error"}}'))).toBe(false);
    expect(isKeyLimitFailure(failed(500, 'overloaded'))).toBe(false);

    const budget = new GameAiBudget(1);
    budget.charge(failed(400, 'Your credit balance is too low'));
    expect(budget.stopped).toBe('key');
  });

  it('refuses a non-positive cap', () => {
    expect(() => new GameAiBudget(0)).toThrow(RangeError);
  });
});

describe('limitedClient', () => {
  it('refuses a call once the budget has stopped, without sending it', async () => {
    const requestDecision = vi.fn();
    const inner: AiClient = { activeModel: 'claude-haiku-5-5', requestDecision };
    const budget = new GameAiBudget(1);
    budget.stop('cap');
    const client = limitedClient(inner, budget, 15_000);
    await expect(client.requestDecision(prompt, request)).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('aborts a call that runs past its deadline', async () => {
    const inner: AiClient = {
      activeModel: 'claude-haiku-5-5',
      requestDecision: (_prompt, _request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason as Error));
        }),
    };
    const client = limitedClient(inner, new GameAiBudget(1), 20);
    await expect(client.requestDecision(prompt, request)).rejects.toThrow();
  });

  it('settles at its deadline even when the inner client ignores the signal', async () => {
    // The client's rate-limit wait sleeps 60 s without watching its signal (PR review, #164).
    const inner: AiClient = {
      activeModel: 'claude-haiku-5-5',
      requestDecision: () => new Promise(() => undefined),
    };
    const started = Date.now();
    const client = limitedClient(inner, new GameAiBudget(1), 30);
    await expect(client.requestDecision(prompt, request)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('sends no retry once an attempt inside the same call crosses the cap', async () => {
    // A retry loop like `withRetry`: it checks the signal before each billed attempt.
    let observe: ((a: AiNetworkAttempt) => void | Promise<void>) | undefined;
    let attempts = 0;
    const inner: AiClient = {
      activeModel: 'claude-haiku-5-5',
      setAttemptObserver: (observer) => {
        observe = observer;
      },
      requestDecision: async (_prompt, _request, signal) => {
        for (let i = 0; i < 3; i++) {
          if (signal?.aborted === true) throw new Error('cancelled');
          attempts++;
          await observe?.(
            attempt({ status: 'rejected', usage: { ...attempt().usage, costUsd: 0.6 } }),
          );
        }
        throw new Error('every attempt was rejected');
      },
    };
    const budget = new GameAiBudget(0.5);
    const client = limitedClient(inner, budget, 15_000);
    await expect(client.requestDecision(prompt, request)).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBe(1);
    expect(budget.stopped).toBe('cap');
  });

  it("aborts another seat's call in flight when the budget stops", async () => {
    const budget = new GameAiBudget(1);
    const waiting: AiClient = {
      activeModel: 'claude-haiku-5-5',
      requestDecision: (_prompt, _request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const call = limitedClient(waiting, budget, 15_000).requestDecision(prompt, request);
    budget.stop('cap');
    await expect(call).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it("charges every attempt the inner client reports and passes it to the caller's observer", async () => {
    let observe: ((a: AiNetworkAttempt) => void | Promise<void>) | undefined;
    const inner: AiClient = {
      activeModel: 'claude-haiku-5-5',
      setAttemptObserver: (observer) => {
        observe = observer;
      },
      requestDecision: async () => {
        await observe?.(attempt({ usage: { ...attempt().usage, costUsd: 0.25 } }));
        return {
          response: { requestId: 'r1', actionId: 0 },
          meta: {} as never,
        };
      },
    };
    const budget = new GameAiBudget(1);
    const client = limitedClient(inner, budget, 15_000);
    const outer = vi.fn();
    client.setAttemptObserver?.(outer);
    await client.requestDecision(prompt, request);
    expect(budget.spentUsd).toBeCloseTo(0.25);
    expect(outer).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import type { AiAttemptObserver, AiNetworkAttempt, OpenAiCompatibleClient } from '../ai/client';
import type { AiPrompt } from '../ai/context';
import { budgetedFetch, counting, emptyTally, type Budget } from './ai-mode-duel';

const request = { requestId: 'r1', decidingPlayer: 'P2' } as DecisionRequest;
const prompt = { messages: [] } as unknown as AiPrompt;

describe('ai-mode-duel spend accounting', () => {
  it('charges a billed completion the client rejected to the seat mode and the budget', async () => {
    let observer: AiAttemptObserver | undefined;
    const inner = {
      activeModel: 'm',
      setAttemptObserver(o: AiAttemptObserver | undefined) {
        observer = o;
      },
      async requestDecision() {
        await observer?.({
          logicalRequestId: 'r1',
          status: 'rejected',
          usage: { promptTokens: 100, responseTokens: 50, costUsd: 0.01 },
        } as AiNetworkAttempt);
        throw new Error('malformed JSON');
      },
    } as unknown as OpenAiCompatibleClient;
    const tallies = { bot: emptyTally(), model: emptyTally() };
    const budget: Budget = { maxUsd: 1, maxCalls: 10, spentUsd: 0, calls: 0, capped: false };
    const client = counting(inner, 'tactician', () => 'model', tallies, budget);
    await expect(client.requestDecision(prompt, request)).rejects.toThrow('malformed JSON');
    expect(tallies.model).toMatchObject({ promptTokens: 100, responseTokens: 50, failedCalls: 1 });
    expect(budget.spentUsd).toBeCloseTo(0.01);
    expect(tallies.bot.promptTokens).toBe(0);
  });

  it('counts an unpriced failed attempt apart instead of making the cost unknown', async () => {
    let observer: AiAttemptObserver | undefined;
    const inner = {
      activeModel: 'm',
      setAttemptObserver(o: AiAttemptObserver | undefined) {
        observer = o;
      },
      async requestDecision() {
        await observer?.({
          logicalRequestId: 'r1',
          status: 'transport_error',
          usage: { promptTokens: 80 },
        } as AiNetworkAttempt);
        throw new Error('timeout');
      },
    } as unknown as OpenAiCompatibleClient;
    const tallies = { bot: emptyTally(), model: emptyTally() };
    const budget: Budget = { maxUsd: 1, maxCalls: 10, spentUsd: 0, calls: 0, capped: false };
    const client = counting(inner, 'tactician', () => 'model', tallies, budget);
    await expect(client.requestDecision(prompt, request)).rejects.toThrow('timeout');
    expect(tallies.model).toMatchObject({ costKnown: true, unpricedAttempts: 1, promptTokens: 80 });
  });

  it('caps every physical request, so client retries cannot spend past the budget', async () => {
    let sent = 0;
    const inner = (async () => {
      sent++;
      return new Response('{}');
    }) as unknown as typeof fetch;
    const budget: Budget = { maxUsd: 1, maxCalls: 1, spentUsd: 0, calls: 0, capped: false };
    const guarded = budgetedFetch(budget, inner);
    await guarded('https://x/models');
    await guarded('https://x/chat', { method: 'POST' });
    // A retry of the same logical request is the second POST: refused before it is sent.
    await expect(guarded('https://x/chat', { method: 'POST' })).rejects.toThrow('spend cap');
    expect(sent).toBe(2);
    expect(budget).toMatchObject({ calls: 1, capped: true });

    const spent: Budget = { maxUsd: 0.01, maxCalls: 10, spentUsd: 0.04, calls: 0, capped: false };
    await expect(budgetedFetch(spent, inner)('https://x/chat', { method: 'POST' })).rejects.toThrow(
      'spend cap',
    );
    expect(sent).toBe(2);
  });
});

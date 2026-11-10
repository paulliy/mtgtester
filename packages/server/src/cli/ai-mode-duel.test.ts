import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import type { AiAttemptObserver, AiNetworkAttempt, OpenAiCompatibleClient } from '../ai/client';
import type { AiPrompt } from '../ai/context';
import { counting, emptyTally, type Budget } from './ai-mode-duel';

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
});

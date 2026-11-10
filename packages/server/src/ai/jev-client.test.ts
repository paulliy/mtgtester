import { describe, expect, it } from 'vitest';
import type { AiNetworkAttempt } from './client';
import type { JevActionRequest } from './jev-context';
import { JevClient, JevResponseValidationError, type JevDecisionsTransport } from './jev-client';

function built(): JevActionRequest {
  return {
    kind: 'ready',
    logicalRequestId: 'request-1',
    classification: {
      shape: 'action_only',
      jevSupported: true,
      reason: 'supported_action_only',
      actionCount: 2,
      targetSlotCount: 0,
    },
    optionToActionId: { action_0: 0, action_1: 1 },
    request: {
      model: 'typesafe/jev-1.13',
      state: { turn: 1 },
      questions: {
        action: {
          type: 'choice',
          instructions: 'Choose.',
          criteria: {
            action_0: { type: 'pass', description: 'Pass' },
            action_1: { type: 'castSpell', description: 'Cast spell' },
          },
        },
      },
    },
  };
}

describe('JevClient', () => {
  it('calls the typed Decisions transport once with the configured timeout', async () => {
    const calls: Array<{ request: unknown; options: unknown }> = [];
    const transport: JevDecisionsTransport = {
      create: async (request, options) => {
        calls.push({ request, options });
        return {
          id: 'decision-1',
          model: 'typesafe/jev-1.13',
          provider: 'TypeSafe',
          answers: {
            action: {
              type: 'choice',
              choice: 'action_1',
              confidence: 0.8,
              probabilities: { action_0: 0.1, action_1: 0.9 },
            },
          },
          usage: { inputTokens: 120, outputTokens: 8, cost: 0.000005 },
        };
      },
    };
    const client = new JevClient({ apiKey: 'not-logged', requestTimeoutMs: 2_000 }, transport);

    const controller = new AbortController();
    const result = await client.requestAction(built(), controller.signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      request: { decisionsRequest: { model: 'typesafe/jev-1.13' } },
      options: { timeoutMs: 2_000, signal: controller.signal },
    });
    expect(result).toMatchObject({
      answer: { choice: 'action_1', confidence: 0.8 },
      meta: {
        requestedModel: 'typesafe/jev-1.13',
        responseModel: 'typesafe/jev-1.13',
        provider: 'TypeSafe',
        providerRequestId: 'decision-1',
        promptTokens: 120,
        responseTokens: 8,
        costUsd: 0.000005,
      },
    });
    expect(result.meta.rawResponse).not.toContain('not-logged');
  });

  it('records accepted and rejected physical Decisions attempts', async () => {
    const attempts: AiNetworkAttempt[] = [];
    const acceptedTransport: JevDecisionsTransport = {
      create: async () => ({
        id: 'decision-1',
        model: 'typesafe/jev-1.13',
        answers: {
          action: {
            type: 'choice',
            choice: 'action_0',
            confidence: 1,
            probabilities: { action_0: 1, action_1: 0 },
          },
        },
        usage: { inputTokens: 10, outputTokens: 1, cost: 0.000001 },
      }),
    };
    const client = new JevClient(
      { apiKey: 'secret', requestTimeoutMs: 2_000 },
      acceptedTransport,
      (attempt) => {
        attempts.push(attempt);
      },
    );
    await client.requestAction(built());

    expect(attempts[0]).toMatchObject({
      kind: 'decision',
      logicalRequestId: 'request-1',
      attemptIndex: 0,
      status: 'accepted',
      messages: [],
      decisionRequest: { model: 'typesafe/jev-1.13' },
      usage: { costSource: 'reported' },
    });

    const rejected = new JevClient(
      { apiKey: 'secret', requestTimeoutMs: 2_000 },
      {
        create: async () => ({
          model: 'typesafe/jev-1.13',
          answers: { action: { type: 'choice', choice: 'action_0', confidence: 2 } },
          usage: { inputTokens: 10, outputTokens: 1 },
        }),
      },
      (attempt) => {
        attempts.push(attempt);
      },
    );
    await expect(rejected.requestAction(built())).rejects.toBeInstanceOf(
      JevResponseValidationError,
    );
    expect(attempts[1]).toMatchObject({ kind: 'decision', status: 'rejected' });
  });

  it('accepts an answer without confidence or probabilities, which the API marks optional', async () => {
    const transport: JevDecisionsTransport = {
      create: async () => ({
        model: 'typesafe/jev-1.13',
        answers: { action: { type: 'choice', choice: 'action_1' } },
        usage: { inputTokens: 10, outputTokens: 1 },
      }),
    };
    const client = new JevClient({ apiKey: 'secret', requestTimeoutMs: 2_000 }, transport);

    const result = await client.requestAction(built());
    expect(result.answer).toEqual({ type: 'choice', choice: 'action_1' });
  });

  it('rejects malformed probabilities', async () => {
    const transport: JevDecisionsTransport = {
      create: async () => ({
        model: 'typesafe/jev-1.13',
        answers: { action: { type: 'choice', choice: 'action_1', probabilities: { action_1: 3 } } },
        usage: { inputTokens: 10, outputTokens: 1 },
      }),
    };
    const client = new JevClient({ apiKey: 'secret', requestTimeoutMs: 2_000 }, transport);

    await expect(client.requestAction(built())).rejects.toBeInstanceOf(JevResponseValidationError);
  });

  it('preserves unknown cost instead of estimating it', async () => {
    const transport: JevDecisionsTransport = {
      create: async () => ({
        model: 'typesafe/jev-1.13',
        answers: {
          action: {
            type: 'choice',
            choice: 'action_0',
            confidence: 1,
            probabilities: { action_0: 1, action_1: 0 },
          },
        },
        usage: { inputTokens: 10, outputTokens: 1 },
      }),
    };
    const client = new JevClient({ apiKey: 'secret', requestTimeoutMs: 2_000 }, transport);

    expect((await client.requestAction(built())).meta.costUsd).toBeUndefined();
  });
});

import type { DecisionRequest, PlayerView } from '@mtg/shared';
import { describe, expect, it, vi } from 'vitest';
import type { JevActionResult } from './jev-client';
import { JevActionPolicy, type JevActionClient, type JevDecisionTrace } from './jev-policy';

const request: DecisionRequest = {
  requestId: 'r1',
  gameId: 'g1',
  turn: 1,
  activePlayer: 'P1',
  decidingPlayer: 'P1',
  phase: 'precombatMain',
  step: null,
  decisionType: 'priority',
  prompt: 'Choose.',
  legalActions: [
    { id: 0, type: 'pass', description: 'Pass' },
    { id: 2, type: 'castSpell', description: 'Cast spell' },
  ],
};

const view: PlayerView = {
  seat: 'P1',
  life: 20,
  hand: [],
  deck: [],
  graveyard: [],
  commanders: [],
  availableMana: {},
  manaSources: [],
  opponents: [],
  revealedLibraryTops: [],
  battlefield: [],
  exile: [],
  stack: [],
  recentLog: [],
};

function result(confidence = 0.9): JevActionResult {
  return {
    answer: {
      type: 'choice',
      choice: 'action_2',
      confidence,
      probabilities: { action_0: 0.1, action_2: 0.9 },
    },
    meta: {
      requestedModel: 'typesafe/jev-1.13',
      responseModel: 'typesafe/jev-1.13',
      promptTokens: 100,
      responseTokens: 5,
      latencyMs: 200,
      rawResponse: '{}',
    },
  };
}

function policy(
  client: JevActionClient,
  minConfidence = 0.5,
  onTrace?: (trace: JevDecisionTrace) => void,
): JevActionPolicy {
  return new JevActionPolicy(
    client,
    { enqueue: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()) },
    {
      model: 'typesafe/jev-1.13',
      minConfidence,
      minTopTwoMargin: 0.1,
      ...(onTrace === undefined ? {} : { onTrace }),
    },
  );
}

describe('JevActionPolicy', () => {
  it('returns a validated engine response for a confident action choice', async () => {
    const client = { requestAction: vi.fn().mockResolvedValue(result()) };

    await expect(policy(client).decide(request, view)).resolves.toMatchObject({
      kind: 'answered',
      response: { requestId: 'r1', actionId: 2 },
      confidence: 0.9,
      meta: { model: 'typesafe/jev-1.13', costSource: 'unknown' },
    });
  });

  it('falls through without a network call for an unsupported shape', async () => {
    const client = { requestAction: vi.fn().mockResolvedValue(result()) };
    const ambiguous: DecisionRequest = {
      ...request,
      legalActions: [
        {
          id: 2,
          type: 'castSpell',
          description: 'Cast spell',
          targets: [{ slot: 0, options: ['a', 'b'] }],
        },
      ],
    };

    await expect(policy(client).decide(ambiguous, view)).resolves.toMatchObject({
      kind: 'fallthrough',
      reason: 'unsupported_shape',
    });
    expect(client.requestAction).not.toHaveBeenCalled();
  });

  it('falls through on low confidence and transport failure', async () => {
    const uncertain = { requestAction: vi.fn().mockResolvedValue(result(0.2)) };
    await expect(policy(uncertain, 0.5).decide(request, view)).resolves.toMatchObject({
      kind: 'fallthrough',
      reason: 'low_confidence',
    });

    const failed = { requestAction: vi.fn().mockRejectedValue(new Error('unavailable')) };
    await expect(policy(failed).decide(request, view)).resolves.toMatchObject({
      kind: 'fallthrough',
      reason: 'transport_failure',
      detail: 'unavailable',
    });
  });

  it('emits reconstructable policy traces for accepted and bypassed decisions', async () => {
    const traces: JevDecisionTrace[] = [];
    const client = { requestAction: vi.fn().mockResolvedValue(result()) };
    await policy(client, 0.5, (trace) => traces.push(trace)).decide(request, view);

    const ambiguous: DecisionRequest = {
      ...request,
      requestId: 'r2',
      legalActions: [
        {
          id: 2,
          type: 'castSpell',
          description: 'Cast spell',
          targets: [{ slot: 0, options: ['a', 'b'] }],
        },
      ],
    };
    await policy(client, 0.5, (trace) => traces.push(trace)).decide(ambiguous, view);

    expect(traces).toEqual([
      expect.objectContaining({
        logicalRequestId: 'r1',
        outcome: 'accepted',
        confidence: 0.9,
        topTwoMargin: 0.8,
        validationResult: 'valid',
        engineAcceptance: 'not_checked',
      }),
      expect.objectContaining({
        logicalRequestId: 'r2',
        outcome: 'fallthrough',
        fallbackReason: 'unsupported_shape',
        networkAttempted: false,
      }),
    ]);
  });

  it('reports cancellation distinctly so the provider does not start a chat fallback', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = { requestAction: vi.fn().mockResolvedValue(result()) };
    const cancelled = new JevActionPolicy(
      client,
      {
        enqueue: vi.fn().mockRejectedValue(new Error('request cancelled')),
      },
      {
        model: 'typesafe/jev-1.13',
        minConfidence: 0,
        minTopTwoMargin: 0,
        signal: controller.signal,
      },
    );

    await expect(cancelled.decide(request, view)).resolves.toMatchObject({
      kind: 'fallthrough',
      reason: 'cancelled',
    });
    expect(client.requestAction).not.toHaveBeenCalled();
  });
});

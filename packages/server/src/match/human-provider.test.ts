import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '@mtg/shared';
import {
  HumanDecisionProvider,
  PersistentAbilityYieldProvider,
  PlayerConnectionGate,
} from './human-provider';

function request(): DecisionRequest {
  return {
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
      { id: 0, type: 'pass', description: 'Pass', interaction: { kind: 'immediate' } },
      {
        id: 1,
        type: 'castSpell',
        description: 'Cast',
        targets: [{ slot: 0, options: ['target-1', 'target-2'] }],
        interaction: {
          kind: 'source',
          sourceId: 'card-1',
          sourceCardId: 'card-1',
          abilityIndex: 0,
          targetSlots: [{ slot: 0, options: ['target-1', 'target-2'] }],
        },
      },
    ],
  };
}

describe('HumanDecisionProvider', () => {
  it('waits indefinitely and releases only for the matching request and revision', async () => {
    const surfaced = vi.fn();
    const provider = new HumanDecisionProvider(() => 7, surfaced);
    const pending = provider.decide(request());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    expect(provider.submit({ requestId: 'old', actionId: 0, revision: 7 })).toContain('stale');
    expect(provider.submit({ requestId: 'r1', actionId: 0, revision: 6 })).toContain(
      'board changed',
    );
    expect(provider.submit({ requestId: 'r1', actionId: 0, revision: 7 })).toBeNull();
    await expect(pending).resolves.toEqual({ requestId: 'r1', actionId: 0 });
  });

  it('rejects missing and illegal targets without releasing the engine', () => {
    const provider = new HumanDecisionProvider(() => 2, () => {});
    void provider.decide(request());
    expect(provider.submit({ requestId: 'r1', actionId: 1, revision: 2 })).toContain(
      'needs a choice',
    );
    expect(
      provider.submit({
        requestId: 'r1',
        actionId: 1,
        revision: 2,
        targets: [{ slot: 0, choice: 'illegal' }],
      }),
    ).toContain('no longer legal');
    expect(
      provider.submit({
        requestId: 'r1',
        actionId: 1,
        revision: 2,
        targets: [{ slot: 4, choice: 'target-1' }],
      }),
    ).toContain('not expected');
    expect(
      provider.submit({
        requestId: 'r1',
        actionId: 1,
        revision: 2,
        targets: [
          { slot: 0, choice: 'target-1' },
          { slot: 0, choice: 'target-2' },
        ],
      }),
    ).toContain('submitted twice');
  });
});

describe('PlayerConnectionGate', () => {
  it('blocks new bot work until reconnect', async () => {
    const gate = new PlayerConnectionGate();
    gate.setConnected(false);
    let passed = false;
    const wait = gate.wait().then(() => {
      passed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(passed).toBe(false);
    gate.setConnected(true);
    await wait;
    expect(passed).toBe(true);
  });
});

describe('PersistentAbilityYieldProvider', () => {
  it('stops offering a declined sacrifice activation to a bot across later turns', async () => {
    const requests: DecisionRequest[] = [];
    const inner = {
      decide: async (request: DecisionRequest) => {
        requests.push(request);
        return { requestId: request.requestId, actionId: 0 };
      },
    };
    const provider = new PersistentAbilityYieldProvider(inner);
    const ability = {
      id: 1,
      type: 'activateAbility',
      description: 'Commander Sphere: Sacrifice Commander Sphere: Draw a card.',
      data: { abilityCosts: [{ kind: 'sacrificeSelf' }] },
      interaction: {
        kind: 'source' as const,
        sourceId: 'sphere-object',
        sourceCardId: 'sphere-card',
        abilityIndex: 0,
      },
    };
    const first = {
      ...request(),
      requestId: 'first',
      legalActions: [request().legalActions[0]!, ability],
    };
    await provider.decide(first);
    await provider.decide({ ...first, requestId: 'second' });

    expect(requests[0]?.legalActions.map((action) => action.id)).toEqual([0, 1]);
    expect(requests[1]?.legalActions.map((action) => action.id)).toEqual([0]);
    expect(provider.ignoredKeys()).toEqual(['sphere-card:0']);
  });
});

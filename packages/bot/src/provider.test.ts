import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, PlayerView } from '@mtg/shared';
import { HeuristicDecisionProvider } from './provider';
import { Rng, type RandomSource } from './rng';

function view(): PlayerView {
  return {
    seat: 'P1',
    life: 20,
    hand: [],
    deck: [],
    graveyard: [],
    exile: [],
    availableMana: {},
    manaSources: [],
    commanders: [],
    battlefield: [],
    stack: [],
    recentLog: [],
    opponents: [],
  };
}

function requestFor(turn: number, requestId: string, legalActions: LegalAction[]): DecisionRequest {
  return {
    requestId,
    gameId: 'g1',
    turn,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose action',
    legalActions,
  };
}

const PASS: LegalAction = { id: 0, type: 'pass', description: 'Pass priority' };
const PING_ABILITY: LegalAction = {
  id: 1,
  type: 'activateAbility',
  description: 'Pay 1 life: draw a card',
  data: { abilityCosts: [{ kind: 'payLife', amount: 1 }] },
  interaction: { kind: 'source', sourceId: 'perm-1', abilityIndex: 0 },
};

describe('HeuristicDecisionProvider', () => {
  it('drops into a DecisionProvider-shaped call site (structural, no @mtg/engine import)', () => {
    const provider = new HeuristicDecisionProvider('seed', view);
    const response = provider.decide(requestFor(1, 'r1', [PASS, PING_ABILITY]));
    expect(response.requestId).toBe('r1');
    expect(typeof response.actionId).toBe('number');
  });

  it('eventually decays a repeatedly-chosen ability to passing, within the same turn', () => {
    const provider = new HeuristicDecisionProvider('seed', view);
    let lastResponse = provider.decide(requestFor(1, 'r0', [PASS, PING_ABILITY]));
    let passed = lastResponse.actionId === PASS.id;
    for (let i = 1; i < 15 && !passed; i++) {
      lastResponse = provider.decide(requestFor(1, `r${i}`, [PASS, PING_ABILITY]));
      passed = lastResponse.actionId === PASS.id;
    }
    expect(passed).toBe(true);
  });

  it('resets the repeat count on a new turn', () => {
    const provider = new HeuristicDecisionProvider('seed', view);
    // Exhaust the ability's appeal within turn 1.
    for (let i = 0; i < 15; i++) {
      provider.decide(requestFor(1, `t1-${i}`, [PASS, PING_ABILITY]));
    }
    // Turn 2: the same ability should be fresh again — attractive, not decayed.
    const response = provider.decide(requestFor(2, 't2-0', [PASS, PING_ABILITY]));
    expect(response.actionId).toBe(PING_ABILITY.id);
  });

  describe('an injected random source', () => {
    const TIED: LegalAction[] = [
      { id: 0, type: 'pass', description: 'Pass priority' },
      { id: 1, type: 'pass', description: 'Pass priority again' },
    ];

    it('breaks ties through the injected source, not a seeded Rng', () => {
      const bounds: number[] = [];
      const source: RandomSource = {
        nextInt: (bound) => {
          bounds.push(bound);
          return bound - 1;
        },
      };
      const provider = new HeuristicDecisionProvider(source, view);
      const response = provider.decide(requestFor(1, 'r1', TIED));
      expect(bounds).toEqual([2]);
      expect(response.actionId).toBe(1);
    });

    it('answers a string seed exactly as the same seed injected as an Rng', () => {
      const requests = Array.from({ length: 12 }, (_, i) => requestFor(i + 1, `r${i}`, TIED));
      const viaString = new HeuristicDecisionProvider('table-seed', view);
      const viaRng = new HeuristicDecisionProvider(new Rng('table-seed'), view);
      expect(requests.map((r) => viaRng.decide(r).actionId)).toEqual(
        requests.map((r) => viaString.decide(r).actionId),
      );
    });
  });
});

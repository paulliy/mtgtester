import { describe, expect, it } from 'vitest';
import { Engine } from '@mtg/engine';
import type { LegalAction, PlayerBoardState, ServerToClientMessage } from '@mtg/shared';
import { createCardTestScenario } from '../cards/card-test-scenarios';
import { isPlayerActionYielded, playerYieldKey, smartYieldStops } from './player-yield';
import { MatchSession } from './session';

function scenario() {
  const fixture = createCardTestScenario('kogla-viewer-bounce-and-attack', 'g-smart-yield');
  if (fixture === null) throw new Error('missing combat fixture');
  return fixture;
}

const spell: LegalAction = {
  id: 1,
  type: 'castSpell',
  description: 'Cast Combat Trick',
  interaction: { kind: 'source', sourceId: 'trick' },
};

describe('smart player yield', () => {
  it('groups spell modes by instance and abilities by printed source/index', () => {
    expect(playerYieldKey(spell)).toBe('spell:trick');
    expect(playerYieldKey({ ...spell, id: 2, data: { x: 4 } })).toBe('spell:trick');
    expect(
      playerYieldKey({ ...spell, interaction: { kind: 'source', sourceId: 'another' } }),
    ).not.toBe(playerYieldKey(spell));
    expect(
      playerYieldKey({
        ...spell,
        type: 'activateAbility',
        interaction: {
          kind: 'source',
          sourceId: 'object',
          sourceCardId: 'card',
          abilityIndex: 0,
        },
      }),
    ).toBe('card:0');
    expect(playerYieldKey({ id: 3, type: 'pass', description: 'Pass' })).toBeNull();
  });

  it('stops before your attacks, when you attack or defend, and for opponent stack activity', () => {
    const board = scenario().engine.playerState('P1');
    const preferences = new Map([
      ['spell:trick', { key: 'spell:trick', label: 'Combat Trick', mode: 'smart' as const }],
    ]);
    expect(isPlayerActionYielded(spell, preferences, board)).toBe(true);
    const combat: PlayerBoardState = { ...board, phase: 'combat', step: 'beginCombat' };
    expect(smartYieldStops(combat)).toBe(true);
    expect(smartYieldStops({ ...combat, activePlayer: 'P2' })).toBe(false);
    const creature = board.battlefield.find((p) => p.controller === 'P1')!;
    expect(
      smartYieldStops({
        ...combat,
        step: 'declareBlockers',
        battlefield: [{ ...creature, attacking: 'P2' }],
      }),
    ).toBe(true);
    expect(
      smartYieldStops({
        ...combat,
        activePlayer: 'P2',
        step: 'declareBlockers',
        battlefield: [{ ...creature, controller: 'P2', attacking: 'P1' }],
      }),
    ).toBe(true);
    expect(
      smartYieldStops({
        ...combat,
        activePlayer: 'P2',
        step: 'declareBlockers',
        battlefield: [{ ...creature, controller: 'P2', attacking: 'P3' }],
      }),
    ).toBe(false);
    for (const targets of [[], ['P1'], [creature.id]]) {
      const stack = [
        {
          id: 'stack',
          controller: 'P2',
          kind: 'spell',
          description: 'Interaction',
          targets,
          scryfallId: null,
        },
      ];
      expect(isPlayerActionYielded(spell, preferences, { ...board, stack })).toBe(false);
    }
    expect(
      smartYieldStops({
        ...board,
        stack: [
          {
            id: 'stack',
            controller: 'P1',
            kind: 'ability',
            description: 'Target yours',
            targets: [creature.id],
            scryfallId: null,
          },
        ],
      }),
    ).toBe(true);
    expect(isPlayerActionYielded(spell, preferences, board)).toBe(true);
    expect(isPlayerActionYielded({ ...spell, type: 'playLand' }, preferences, board)).toBe(false);
    preferences.clear();
    expect(isPlayerActionYielded(spell, preferences, board)).toBe(false);
  });

  it('auto-passes quiet windows through the real session and offers the spell before combat', async () => {
    const fixture = scenario();
    const basic = fixture.seats[0]!.config.cards.find((card) => card.name === 'Forest')!;
    const trick = {
      ...basic,
      oracleId: 'test-trick',
      name: 'Combat Trick',
      manaCost: '{G}' as const,
      typeLine: 'Instant',
      supertypes: [],
      types: ['Instant'],
      subtypes: [],
      isBasicLand: false,
      oracleText: 'Target creature gets +2/+2 until end of turn.',
      cmc: 1,
    };
    fixture.seats[0]!.config.cards.push(trick);
    const engine = new Engine(
      {
        gameId: 'g-smart-yield',
        seed: 'smart-yield',
        players: fixture.seats.map((seat) => seat.config),
      },
      {
        preparedScenario: {
          currentTurnPlayer: 'P1',
          phase: 'precombatMain',
          step: null,
          turnNumber: 3,
          hand: [{ playerId: 'P1', cardNames: ['Combat Trick'] }],
          battlefield: [
            { playerId: 'P1', cardNames: ['Kogla, the Titan Ape', 'Forest', 'Forest'] },
          ],
          continueThroughCombat: true,
        },
      },
    );
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      gameId: 'g-smart-yield',
      seed: 'smart-yield',
      seats: fixture.seats,
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      engine,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    const requests = () =>
      sent.filter(
        (m): m is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
          m.type === 'playerActionRequired',
      );
    const wait = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
        await new Promise((r) => setTimeout(r, 10));
      expect(predicate()).toBe(true);
    };
    session.start();
    try {
      await wait(() => requests().length > 0);
      const first = requests().at(-1)!.payload;
      const cast = first.request.legalActions.find((a) => a.type === 'castSpell')!;
      expect(cast).toBeDefined();
      session.yieldPlayerAbility({
        requestId: first.request.requestId,
        revision: first.revision,
        actionId: cast.id,
        mode: 'smart',
      });
      await wait(() => requests().at(-1)?.payload.request.step === 'beginCombat');
      const combat = requests().at(-1)!.payload;
      expect(combat.request.legalActions.some((a) => a.type === 'castSpell')).toBe(true);
      expect(combat.ignoredAbilities[0]?.mode).toBe('smart');
      expect(requests().filter((m) => m.payload.request.phase === 'precombatMain')).toHaveLength(1);
      session.resumePlayerAbility(combat.ignoredAbilities[0]!.key);
      expect(requests().at(-1)!.payload.ignoredAbilities).toEqual([]);
      session.yieldPlayerAbility({
        requestId: combat.request.requestId,
        revision: combat.revision - 1,
        actionId: cast.id,
        mode: 'smart',
      });
      expect(sent.at(-1)?.type).toBe('error');
    } finally {
      session.abandon();
      await session.settled();
    }
  });
});

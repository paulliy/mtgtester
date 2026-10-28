import { describe, expect, it } from 'vitest';
import { Engine } from '@mtg/engine';
import type { LegalAction, PlayerBoardState, ServerToClientMessage } from '@mtg/shared';
import { createCardTestScenario } from '../cards/card-test-scenarios';
import {
  SmartYieldMemory,
  isPlayerActionYielded,
  playerYieldKey,
  smartYieldStops,
} from './player-yield';
import type { GameStore } from '../db';
import { GameRecorder, type SqliteLike } from '../db/games';
import { MatchSession } from './session';
import { testerPolicy } from './disclosure';

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

async function waitFor(predicate: () => boolean, details?: () => unknown): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(predicate(), details === undefined ? undefined : JSON.stringify(details())).toBe(true);
}

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
      disclosure: testerPolicy('singlePlayer'),
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
    session.start();
    try {
      await waitFor(() => requests().length > 0);
      const first = requests().at(-1)!.payload;
      const cast = first.request.legalActions.find((a) => a.type === 'castSpell')!;
      expect(cast).toBeDefined();
      session.yieldPlayerAbility('P1', {
        requestId: first.request.requestId,
        revision: first.revision,
        actionId: cast.id,
        mode: 'smart',
      });
      await waitFor(() => requests().at(-1)?.payload.request.step === 'beginCombat');
      const combat = requests().at(-1)!.payload;
      expect(combat.request.legalActions.some((a) => a.type === 'castSpell')).toBe(true);
      expect(combat.ignoredAbilities[0]?.mode).toBe('smart');
      expect(requests().filter((m) => m.payload.request.phase === 'precombatMain')).toHaveLength(1);
      // Rejected passes cannot consume the opportunity. Reconnection keeps it offered.
      const pass = combat.request.legalActions.find((a) => a.type === 'pass')!;
      session.submitPlayerAction('P1', {
        requestId: combat.request.requestId,
        revision: combat.revision - 1,
        actionId: pass.id,
      });
      expect(sent.at(-1)?.type).toBe('error');
      session.resyncPlayer('P1');
      expect(
        requests()
          .at(-1)!
          .payload.request.legalActions.some((a) => a.type === 'castSpell'),
      ).toBe(true);
      session.submitPlayerAction('P1', {
        requestId: combat.request.requestId,
        revision: combat.revision,
        actionId: pass.id,
      });
      await waitFor(() => requests().at(-1)?.payload.request.decisionType === 'declareAttackers');
      // Yield never suppresses required declarations, even after declining the combat stop.
      expect(
        requests()
          .at(-1)!
          .payload.request.legalActions.some((a) => a.type === 'attackDeclaration'),
      ).toBe(true);
      expect(requests().filter((m) => m.payload.request.decisionType === 'priority')).toHaveLength(
        3,
      );
      session.resumePlayerAbility('P1', combat.ignoredAbilities[0]!.key);
      expect(requests().at(-1)!.payload.ignoredAbilities).toEqual([]);
      session.yieldPlayerAbility('P1', {
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

  it('records a smart-yield pass as auto, the next pass as human, and the bots as bot', async () => {
    const fixture = scenario();
    const basic = fixture.seats[0]!.config.cards.find((card) => card.name === 'Forest')!;
    fixture.seats[0]!.config.cards.push({
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
    });
    const engine = new Engine(
      {
        gameId: 'g-sources',
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
    const written: Array<{ requestId: string; seat: number; source: string }> = [];
    const db: SqliteLike = {
      query: (sql: string) => ({
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT INTO game_decision_sources')) {
            written.push({
              requestId: String(args[1]),
              seat: Number(args[2]),
              source: String(args[3]),
            });
          }
        },
        all: () => [],
        get: () => null,
      }),
    };
    const store = { recorderFor: (id: string) => new GameRecorder(db, id) } as unknown as GameStore;
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId: 'g-sources',
      seed: 'smart-yield',
      seats: fixture.seats,
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      engine,
      store,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    const requests = () =>
      sent.filter(
        (m): m is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
          m.type === 'playerActionRequired',
      );
    session.start();
    try {
      await waitFor(() => requests().length > 0);
      const first = requests().at(-1)!.payload;
      const cast = first.request.legalActions.find((a) => a.type === 'castSpell')!;
      session.yieldPlayerAbility('P1', {
        requestId: first.request.requestId,
        revision: first.revision,
        actionId: cast.id,
        mode: 'smart',
      });
      await waitFor(() => requests().at(-1)?.payload.request.step === 'beginCombat');
      const combat = requests().at(-1)!.payload;
      const pass = combat.request.legalActions.find((a) => a.type === 'pass')!;
      session.submitPlayerAction('P1', {
        requestId: combat.request.requestId,
        revision: combat.revision,
        actionId: pass.id,
      });
      await waitFor(() => requests().at(-1)?.payload.request.decisionType === 'declareAttackers');

      const sourceOf = (requestId: string) =>
        written.find((row) => row.requestId === requestId)?.source;
      expect(sourceOf(first.request.requestId)).toBe('auto');
      expect(sourceOf(combat.request.requestId)).toBe('human');
      // The human seat's rows are human or auto; any other seat's are bot.
      for (const row of written) {
        expect(row.seat === 1 ? ['human', 'auto'] : ['bot']).toContain(row.source);
      }
    } finally {
      session.abandon();
      await session.settled();
    }
  });

  it('remembers declined stack objects through passes and resolutions, but wakes for new interaction', () => {
    const board = scenario().engine.playerState('P1');
    const memory = new SmartYieldMemory();
    const preferences = new Map([
      ['spell:trick', { key: 'spell:trick', label: 'Trick', mode: 'smart' as const }],
    ]);
    const item = {
      id: 'first',
      controller: 'P2',
      kind: 'spell',
      description: 'Interaction',
      targets: [],
      scryfallId: null,
    };
    const stacked = { ...board, stack: [item, { ...item, id: 'second' }] };
    expect(memory.isYielded(spell, preferences, stacked)).toBe(false);
    memory.dismiss([spell], preferences, stacked);
    expect(memory.isYielded(spell, preferences, stacked)).toBe(true);
    expect(memory.isYielded(spell, preferences, { ...stacked, stack: [item] })).toBe(true);
    expect(
      memory.isYielded(spell, preferences, { ...stacked, stack: [item, { ...item, id: 'new' }] }),
    ).toBe(false);
    const another = { ...spell, interaction: { kind: 'source' as const, sourceId: 'another' } };
    preferences.set('spell:another', { key: 'spell:another', label: 'Other', mode: 'smart' });
    expect(memory.isYielded(another, preferences, stacked)).toBe(false);
    memory.resume('spell:trick');
    expect(memory.isYielded(spell, preferences, stacked)).toBe(false);
    memory.dismiss([spell], preferences, stacked);
    expect(
      memory.isYielded(spell, preferences, { ...stacked, turnNumber: board.turnNumber + 1 }),
    ).toBe(false);
  });

  it('keeps utility sacrifices quiet for unrelated targets and combat, but offers threatened sources', () => {
    const board = scenario().engine.playerState('P1');
    const land = board.battlefield.find(
      (p) => p.controller === 'P1' && p.typeLine.includes('Land'),
    )!;
    const creature = board.battlefield.find((p) => p.controller === 'P1' && p.power !== null)!;
    const utility: LegalAction = {
      id: 2,
      type: 'activateAbility',
      description: 'Sacrifice for value',
      interaction: { kind: 'source', sourceId: land.id, sourceCardId: 'utility', abilityIndex: 0 },
      data: { abilityCosts: [{ kind: 'sacrificeSelf' }], abilityEffectOps: ['draw'] },
    };
    const item = {
      id: 'interaction',
      controller: 'P2',
      kind: 'spell',
      description: 'Removal',
      targets: [creature.id],
      scryfallId: null,
    };
    expect(smartYieldStops({ ...board, stack: [item] }, utility)).toBe(false);
    expect(smartYieldStops({ ...board, stack: [{ ...item, targets: [land.id] }] }, utility)).toBe(
      true,
    );
    expect(smartYieldStops({ ...board, stack: [{ ...item, targets: [] }] }, utility)).toBe(true);
    expect(smartYieldStops({ ...board, phase: 'combat', step: 'beginCombat' }, utility)).toBe(
      false,
    );
    expect(
      smartYieldStops(
        {
          ...board,
          phase: 'combat',
          step: 'declareBlockers',
          battlefield: [{ ...creature, attacking: 'P2' }, land],
        },
        utility,
      ),
    ).toBe(false);
    // A noncombatant source may protect or pump the whole team; do not classify
    // its ability as utility merely because it sacrifices the source or has no targets.
    const before: PlayerBoardState = { ...board, phase: 'combat', step: 'beginCombat' };
    expect(
      smartYieldStops(before, {
        ...utility,
        data: { abilityCosts: [{ kind: 'sacrificeSelf' }], abilityEffectOps: ['grantKeywordEach'] },
      }),
    ).toBe(true);
    expect(
      smartYieldStops(before, { ...utility, data: { abilityCosts: [{ kind: 'sacrificeSelf' }] } }),
    ).toBe(true);
  });

  it('offers meaningful combat changes, including blockers and first strike, without post-damage prompts', () => {
    const board = scenario().engine.playerState('P1');
    const creature = board.battlefield.find((p) => p.controller === 'P1' && p.power !== null)!;
    const trick = { ...spell, targets: [{ slot: 0, options: [creature.id] }] };
    const preferences = new Map([
      ['spell:trick', { key: 'spell:trick', label: 'Trick', mode: 'smart' as const }],
    ]);
    const memory = new SmartYieldMemory();
    const before: PlayerBoardState = { ...board, phase: 'combat', step: 'beginCombat' };
    expect(memory.isYielded(trick, preferences, before)).toBe(false);
    memory.dismiss([trick], preferences, before);
    expect(memory.isYielded(trick, preferences, before)).toBe(true);
    const attacks: PlayerBoardState = {
      ...before,
      step: 'declareAttackers',
      battlefield: [{ ...creature, attacking: 'P2' }],
    };
    expect(memory.isYielded(trick, preferences, attacks)).toBe(false);
    memory.dismiss([trick], preferences, attacks);
    expect(memory.isYielded(trick, preferences, attacks)).toBe(true);
    const blocks: PlayerBoardState = {
      ...attacks,
      step: 'declareBlockers',
      battlefield: [{ ...attacks.battlefield[0]!, blockedBy: ['blocker'] }],
    };
    expect(memory.isYielded(trick, preferences, blocks)).toBe(false);
    memory.dismiss([trick], preferences, blocks);
    expect(
      memory.isYielded(trick, preferences, { ...blocks, step: 'firstStrikeCombatDamage' }),
    ).toBe(false);
    expect(memory.isYielded(trick, preferences, { ...blocks, step: 'combatDamage' })).toBe(true);
    expect(memory.isYielded(trick, preferences, { ...blocks, step: 'endCombat' })).toBe(true);
    const irrelevant = { ...trick, targets: [{ slot: 0, options: ['unrelated'] }] };
    expect(memory.isYielded(irrelevant, preferences, attacks)).toBe(true);
    const enemyBlocker = { ...creature, id: 'blocker', controller: 'P2', blocking: creature.id };
    expect(
      smartYieldStops(
        { ...blocks, battlefield: [...blocks.battlefield, enemyBlocker] },
        { ...trick, targets: [{ slot: 0, options: ['blocker'] }] },
      ),
    ).toBe(true);
  });

  it('offers known utility once before your next turn, preserving unknown and team effects', () => {
    const board = scenario().engine.playerState('P1');
    const utility: LegalAction = {
      id: 2,
      type: 'activateAbility',
      description: 'Draw',
      interaction: { kind: 'source', sourceId: 'land', sourceCardId: 'land-card', abilityIndex: 0 },
      data: { abilityEffectOps: ['draw'] },
    };
    const preferences = new Map([
      ['land-card:0', { key: 'land-card:0', label: 'Draw', mode: 'smart' as const }],
    ]);
    const memory = new SmartYieldMemory();
    const end: PlayerBoardState = {
      ...board,
      phase: 'ending',
      step: 'end',
      activePlayer: 'P4',
      turnOrder: ['P1', 'P2', 'P3', 'P4'],
    };
    expect(memory.isYielded(utility, preferences, { ...end, activePlayer: 'P2' })).toBe(true);
    expect(memory.isYielded(utility, preferences, end)).toBe(false);
    memory.dismiss([utility], preferences, end);
    expect(memory.isYielded(utility, preferences, end)).toBe(true);
    expect(memory.isYielded(utility, preferences, { ...end, turnNumber: end.turnNumber + 4 })).toBe(
      false,
    );
    expect(
      memory.isYielded(utility, preferences, {
        ...end,
        turnOrder: ['P1', 'P2'],
        activePlayer: 'P2',
        turnNumber: end.turnNumber + 5,
      }),
    ).toBe(false);
    const kogla = scenario().engine.advance();
    expect(kogla.kind).toBe('decision');
    if (kogla.kind === 'decision') {
      const activation = kogla.request.legalActions.find(
        (action) => action.type === 'activateAbility',
      )!;
      expect(activation.data?.['abilityEffectOps']).toEqual(
        expect.arrayContaining(['returnToHand', 'grantKeywordUntilEot']),
      );
    }
  });

  it('skips utility priority until the last opponent end step, then crosses into your upkeep after one pass', async () => {
    const fixture = createCardTestScenario(
      'war-room-viewer-dynamic-life-activation',
      'g-utility-yield',
    )!;
    const engine = new Engine(
      {
        gameId: 'g-utility-yield',
        seed: 'utility-yield',
        players: fixture.seats.map((seat) => seat.config),
      },
      {
        preparedScenario: {
          currentTurnPlayer: 'P4',
          phase: 'precombatMain',
          step: null,
          turnNumber: 1,
          hand: [],
          battlefield: [{ playerId: 'P1', cardNames: ['War Room', 'Forest', 'Forest', 'Forest'] }],
          continueToEndStep: true,
          continueToNextUpkeep: true,
        },
      },
    );
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId: 'g-utility-yield',
      seed: 'utility-yield',
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
        (message): message is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
          message.type === 'playerActionRequired',
      );
    session.start();
    try {
      await waitFor(() => requests().length > 0);
      const first = requests().at(-1)!.payload;
      const draw = first.request.legalActions.find((action) => action.type === 'activateAbility')!;
      expect(draw.data?.['abilityEffectOps']).toEqual(['draw']);
      session.yieldPlayerAbility('P1', {
        requestId: first.request.requestId,
        revision: first.revision,
        actionId: draw.id,
        mode: 'smart',
      });
      await waitFor(() => requests().at(-1)?.payload.request.step === 'end');
      const lastEnd = requests().at(-1)!.payload;
      expect(lastEnd.state.activePlayer).toBe('P4');
      expect(requests()).toHaveLength(2);
      expect(lastEnd.request.legalActions.some((action) => action.type === 'activateAbility')).toBe(
        true,
      );
      session.submitPlayerAction('P1', {
        requestId: lastEnd.request.requestId,
        revision: lastEnd.revision,
        actionId: lastEnd.request.legalActions.find((action) => action.type === 'pass')!.id,
      });
      // Prepared scenarios deliberately end with no winner; the runner reports that
      // finite fixture as a draw. Check the engine result rather than a victory message.
      await waitFor(
        () => session.runner.getResult() !== null,
        () => session.runner.getHalt(),
      );
      expect(session.runner.getResult()?.halted).toBe(false);
      expect(requests()).toHaveLength(2);
      expect(engine.playerState('P1')).toMatchObject({
        turnNumber: 2,
        activePlayer: 'P1',
        step: 'upkeep',
      });
      expect(engine.playerState('P1').seats.find((seat) => seat.seat === 'P1')!.life).toBe(40);
      const snapshot = sent.findLast((message) => message.type === 'playerStateSnapshot');
      expect(
        snapshot?.type === 'playerStateSnapshot' && snapshot.payload.ignoredAbilities[0]?.mode,
      ).toBe('smart');
    } finally {
      session.abandon();
      await session.settled();
    }
  });
});

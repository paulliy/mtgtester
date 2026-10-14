import { describe, expect, it } from 'vitest';
import type { Ability, Effect } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { constant } from '../src/cards/value';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed = 'discard-player-contract'): GameContext {
  const ctx = createGame(
    gameConfig(Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })), { seed }),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function sourceFor(ctx: GameContext): EnginePermanent {
  return spawn(
    ctx,
    'P1',
    oracle({
      name: 'Discard Contract Source',
      typeLine: 'Enchantment',
      manaCost: null,
      cmc: 0,
      power: null,
      toughness: null,
    }),
  );
}

function handCard(name: string) {
  return oracle({ name, typeLine: 'Sorcery', manaCost: '{1}', power: null, toughness: null });
}

function putInHand(ctx: GameContext, playerId: string, ...names: string[]): void {
  for (const name of names) {
    const player = ctx.state.players.find((candidate) => candidate.id === playerId);
    if (player === undefined) throw new Error(`Missing player ${playerId}`);
    const card = handCard(name);
    const object = {
      id: `discard-test-${playerId}-${name}`,
      cardId: `discard-test-card-${playerId}-${name}`,
      oracleId: card.oracleId,
      ownerId: playerId,
      name: card.name,
      typeLine: card.typeLine,
      oracleText: card.oracleText,
      manaCost: card.manaCost,
      isToken: false,
      isCommander: false,
      zone: 'hand' as const,
    };
    player.hand.push(object);
    ctx.defs.set(card.oracleId, interpretCard(card));
  }
}

function runEffect(
  ctx: GameContext,
  source: EnginePermanent,
  targets: Ability['targets'],
  effect: Effect,
  targetIds: string[] = [],
  answer?: Parameters<typeof pump>[1],
): ReturnType<typeof pump> {
  return pump(
    executeAbility(
      ctx,
      {
        id: source.id,
        cardId: source.cardId,
        name: source.name,
        oracleId: source.oracleId,
        controllerId: source.controllerId,
      },
      { kind: 'spell', targets, effects: [effect] },
      targetIds,
    ),
    answer,
  );
}

function player(ctx: GameContext, playerId: string) {
  const found = ctx.state.players.find((candidate) => candidate.id === playerId);
  if (found === undefined) throw new Error(`Missing player ${playerId}`);
  return found;
}

describe('discard effects with player references', () => {
  it('discardTarget acts on the targeted opponent and can target its controller', () => {
    const ctx = pod();
    const source = sourceFor(ctx);
    putInHand(ctx, 'P1', 'Controller Card', 'Controller Reserve');
    putInHand(ctx, 'P2', 'Opponent Card', 'Opponent Reserve');

    runEffect(
      ctx,
      source,
      [{ kind: 'player' }],
      { op: 'discardTarget', target: 0, count: constant(1) },
      ['P2'],
      (decision) => ({
        index: decision.options.findIndex((option) => option.description === 'Discard Opponent Card'),
        targets: new Map(),
      }),
    );
    expect(player(ctx, 'P2').graveyard.map((card) => card.name)).toEqual(['Opponent Card']);
    expect(player(ctx, 'P1').hand.map((card) => card.name)).toEqual([
      'Controller Card',
      'Controller Reserve',
    ]);

    runEffect(
      ctx,
      source,
      [{ kind: 'player' }],
      { op: 'discardTarget', target: 0, count: constant(1) },
      ['P1'],
      (decision) => ({
        index: decision.options.findIndex(
          (option) => option.description === 'Discard Controller Card',
        ),
        targets: new Map(),
      }),
    );
    expect(player(ctx, 'P1').graveyard.map((card) => card.name)).toEqual(['Controller Card']);
  });

  it('random targeted discard is seed-deterministic and never exceeds the target hand size', () => {
    const result = (seed: string): string[] => {
      const ctx = pod(seed);
      const source = sourceFor(ctx);
      putInHand(ctx, 'P2', 'Random A', 'Random B');
      runEffect(ctx, source, [{ kind: 'player' }], {
        op: 'discardTarget',
        target: 0,
        count: constant(7),
        atRandom: true,
      }, ['P2']);
      expect(player(ctx, 'P2').hand).toHaveLength(0);
      expect(player(ctx, 'P2').graveyard).toHaveLength(2);
      return player(ctx, 'P2').graveyard.map((card) => card.name);
    };

    expect(result('same-discard-seed')).toEqual(result('same-discard-seed'));
  });

  it('collects every player’s hidden choice in APNAP order before moving any card', () => {
    const ctx = pod();
    const source = sourceFor(ctx);
    for (const playerId of ['P1', 'P2', 'P3', 'P4'])
      putInHand(ctx, playerId, `${playerId} First`, `${playerId} Chosen`);

    const order: string[] = [];
    const originalHandSizes = new Map(ctx.state.players.map((entry) => [entry.id, entry.hand.length]));
    const { decisions } = runEffect(
      ctx,
      source,
      [],
      { op: 'discardEachPlayer', scope: 'all', count: constant(1) },
      [],
      (decision) => {
        order.push(decision.player);
        expect(ctx.state.eventLog.some((event) => event.type === 'discard')).toBe(false);
        expect(ctx.state.eventLog.some((event) => event.type === 'zoneChange')).toBe(false);
        for (const [playerId, size] of originalHandSizes)
          expect(player(ctx, playerId).hand).toHaveLength(size);
        const index = decision.options.findIndex(
          (option) => option.description === `Discard ${decision.player} Chosen`,
        );
        return { index, targets: new Map() };
      },
    );

    expect(decisions).toHaveLength(4);
    expect(order).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(ctx.state.eventLog.filter((event) => event.type === 'discard')).toHaveLength(4);
    for (const playerId of order)
      expect(player(ctx, playerId).graveyard.map((card) => card.name)).toEqual([
        `${playerId} Chosen`,
      ]);
  });

  it('opponents scope excludes the controller', () => {
    const ctx = pod();
    const source = sourceFor(ctx);
    putInHand(ctx, 'P1', 'Controller Stays');
    for (const playerId of ['P2', 'P3', 'P4'])
      putInHand(ctx, playerId, `${playerId} Goes`, `${playerId} Reserve`);

    const { decisions } = runEffect(
      ctx,
      source,
      [],
      { op: 'discardEachPlayer', scope: 'opponents', count: constant(1) },
      [],
      (decision) => ({ index: 0, targets: new Map() }),
    );

    expect(decisions.map((decision) => decision.player)).toEqual(['P2', 'P3', 'P4']);
    expect(player(ctx, 'P1').hand.map((card) => card.name)).toEqual(['Controller Stays']);
    for (const playerId of ['P2', 'P3', 'P4'])
      expect(player(ctx, playerId).graveyard.map((card) => card.name)).toEqual([
        `${playerId} Goes`,
      ]);
    for (const playerId of ['P2', 'P3', 'P4'])
      expect(player(ctx, playerId).hand.map((card) => card.name)).toEqual([
        `${playerId} Reserve`,
      ]);
  });

  it('drawForDiscarded draws only for cards actually discarded, despite empty hands and a lost player', () => {
    const ctx = pod();
    const source = sourceFor(ctx);
    putInHand(ctx, 'P1', 'Controller One', 'Controller Two');
    putInHand(ctx, 'P2', 'Opponent One');
    putInHand(ctx, 'P4', 'Lost Player Card');
    player(ctx, 'P4').hasLost = true;
    player(ctx, 'P1').library.splice(0);
    for (let index = 0; index < 4; index++) {
      const card = handCard(`Draw ${index + 1}`);
      const object = {
        id: `discard-test-library-${index}`,
        cardId: `discard-test-library-card-${index}`,
        oracleId: card.oracleId,
        ownerId: 'P1',
        name: card.name,
        typeLine: card.typeLine,
        oracleText: card.oracleText,
        manaCost: card.manaCost,
        isToken: false,
        isCommander: false,
        zone: 'library' as const,
      };
      player(ctx, 'P1').library.push(object);
      ctx.defs.set(card.oracleId, interpretCard(card));
    }

    runEffect(ctx, source, [], {
      op: 'discardEachPlayer',
      scope: 'all',
      count: constant(2),
      drawForDiscarded: true,
    });

    expect(player(ctx, 'P1').graveyard.map((card) => card.name)).toEqual([
      'Controller One',
      'Controller Two',
    ]);
    expect(player(ctx, 'P2').graveyard.map((card) => card.name)).toEqual(['Opponent One']);
    expect(player(ctx, 'P3').hand).toHaveLength(0);
    expect(player(ctx, 'P4').hand.map((card) => card.name)).toEqual(['Lost Player Card']);
    expect(player(ctx, 'P1').hand.map((card) => card.name)).toEqual([
      'Draw 1',
      'Draw 2',
      'Draw 3',
    ]);
  });

  it('skips a lost discardTarget player and accepts an empty target hand', () => {
    const ctx = pod();
    const source = sourceFor(ctx);
    putInHand(ctx, 'P3', 'Lost Target Card');
    player(ctx, 'P3').hasLost = true;

    runEffect(
      ctx,
      source,
      [{ kind: 'player' }],
      { op: 'discardTarget', target: 0, count: constant(2) },
      ['P3'],
    );
    runEffect(
      ctx,
      source,
      [{ kind: 'player' }],
      { op: 'discardTarget', target: 0, count: constant(2) },
      ['P2'],
    );

    expect(player(ctx, 'P3').hand.map((card) => card.name)).toEqual(['Lost Target Card']);
    expect(player(ctx, 'P2').graveyard).toHaveLength(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'discard')).toBe(false);
  });

  it('rejects a creature target for discardTarget during structural reference validation', () => {
    const definition = interpretCard(
      oracle({ name: 'Malformed Discard Spell', typeLine: 'Sorcery', power: null, toughness: null }),
    );
    definition.spellAbility = {
      kind: 'spell',
      targets: [{ kind: 'creature' }],
      effects: [{ op: 'discardTarget', target: 0, count: constant(1) }],
    };

    expect(validateCardDefinition(definition).map((issue) => issue.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('creature is incompatible with effect domains player')]),
    );
  });
});

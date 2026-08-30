import { describe, expect, it } from 'vitest';
import { executeAbility } from '../src/effects/resolve';
import { queueCastTriggers } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { EngineStackObject, GameContext } from '../src/state/types';
import { copies, conjure, forest, gameConfig, oracle, pick, pump, spawn } from './fixtures';

const rhysticStudy = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Rhystic Study',
    typeLine: 'Enchantment',
    manaCost: '{2}{U}',
    oracleText: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.',
  });

const testSpell = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Spell',
    typeLine: 'Instant',
    manaCost: '{0}',
    cmc: 0,
    power: null,
    toughness: null,
  });

function pod(): GameContext {
  return createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed: 'unless-payment' },
    ),
  );
}

function queueOpponentCast(ctx: GameContext) {
  const card = conjure(ctx, 'P2', testSpell(), 'hand');
  const stack: EngineStackObject = {
    id: card.id,
    sourceId: card.id,
    controllerId: 'P2',
    kind: 'spell',
    description: card.name,
    targets: [],
    card,
    ability: null,
    sourceOracleId: card.oracleId,
    sourceCardId: card.cardId,
    isCommanderCast: false,
  };
  ctx.state.stack.push(stack);
  queueCastTriggers(ctx, stack);
  const pending = ctx.state.pendingTriggers[0];
  if (pending === undefined) throw new Error('expected Rhystic Study trigger');
  return pending;
}

function resolvePending(ctx: GameContext, pending: ReturnType<typeof queueOpponentCast>, answer?: Parameters<typeof pump>[1]) {
  return pump(
    executeAbility(
      ctx,
      {
        cardId: pending.sourceCardId,
        name: pending.sourceName,
        oracleId: pending.sourceOracleId,
        controllerId: pending.controllerId,
      },
      pending.ability,
      [],
      undefined,
      pending.scope,
    ),
    answer,
  );
}

describe('unlessPays', () => {
  it('uses the cast-event player and resolves the wrapped effect when they decline', () => {
    const ctx = pod();
    const study = spawn(ctx, 'P1', rhysticStudy());
    const pending = queueOpponentCast(ctx);
    const p1 = ctx.state.players.find((player) => player.id === 'P1');
    const p2 = ctx.state.players.find((player) => player.id === 'P2');
    if (p1 === undefined || p2 === undefined) throw new Error('test players missing');

    expect(pending.ability.optional).toBe(true);
    expect(pending.scope?.eventPlayerId).toBe('P2');
    const cardsBefore = p1.library.length;

    resolvePending(ctx, pending, (decision) => pick(decision, "Don't pay"));

    expect(p1.library).toHaveLength(cardsBefore - 1);
    expect(p2.manaEntries).toHaveLength(0);
    expect(study.controllerId).toBe('P1');
  });

  it('suppresses the wrapped effect after the cast-event player pays', () => {
    const ctx = pod();
    spawn(ctx, 'P1', rhysticStudy());
    const pending = queueOpponentCast(ctx);
    const p1 = ctx.state.players.find((player) => player.id === 'P1');
    const p2 = ctx.state.players.find((player) => player.id === 'P2');
    if (p1 === undefined || p2 === undefined) throw new Error('test players missing');
    p2.manaEntries = [{ symbol: 'C' }];

    const cardsBefore = p1.library.length;
    resolvePending(ctx, pending, (decision) => pick(decision, 'Pay {1}'));

    expect(p1.library).toHaveLength(cardsBefore);
    expect(p2.manaEntries).toHaveLength(0);
  });
});
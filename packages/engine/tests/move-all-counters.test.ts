/**
 * `moveAllCounters` (The Ozolith's "move all counters from ~ onto target creature"): CR 122.5's
 * move is a removal and a placement, and when either half is impossible neither happens.
 */
import { describe, expect, it } from 'vitest';
import type { Ability } from '../src/cards/ability';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pumpStrict, spawn } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const stone = () => oracle({ name: 'Counter Stone', typeLine: 'Artifact', manaCost: '{1}' });
const wolf = () =>
  oracle({ name: 'Counter Wolf', typeLine: 'Creature — Wolf', power: '1', toughness: '1' });

const move: Ability = {
  kind: 'triggered',
  trigger: { when: 'beginningOfCombat', player: 'you' },
  optional: false,
  targets: [{ kind: 'creature' }],
  effects: [{ op: 'moveAllCounters', from: 'source', to: 0 }],
  description: 'Move all counters from ~ onto target creature.',
};

function run(ctx: GameContext, sourceId: string, targetId: string): void {
  const source = ctx.state.battlefield.find((permanent) => permanent.id === sourceId)!;
  pumpStrict(
    executeAbility(
      ctx,
      {
        cardId: source.cardId,
        name: source.name,
        oracleId: source.oracleId,
        controllerId: 'P1',
      },
      move,
      [targetId],
    ),
  );
}

describe('moveAllCounters', () => {
  it('moves every counter of every kind and leaves the source with none', () => {
    const ctx = pod('move-all-every-kind');
    const source = spawn(ctx, 'P1', stone());
    const target = spawn(ctx, 'P1', wolf());
    source.counters = { '+1/+1': 2, flying: 1, charge: 3 };
    target.counters = { '+1/+1': 1 };
    run(ctx, source.id, target.id);
    expect(source.counters).toEqual({});
    expect(target.counters).toEqual({ '+1/+1': 3, flying: 1, charge: 3 });
  });

  it('moves nothing onto the object the counters are already on (CR 122.5)', () => {
    const ctx = pod('move-all-same-object');
    const source = spawn(ctx, 'P1', wolf());
    source.counters = { '+1/+1': 2 };
    run(ctx, source.id, source.id);
    expect(source.counters).toEqual({ '+1/+1': 2 });
  });

  it('removes nothing when the target has left the battlefield (CR 122.5)', () => {
    const ctx = pod('move-all-target-gone');
    const source = spawn(ctx, 'P1', stone());
    const target = spawn(ctx, 'P1', wolf());
    source.counters = { '+1/+1': 2 };
    ctx.state.battlefield = ctx.state.battlefield.filter((permanent) => permanent !== target);
    run(ctx, source.id, target.id);
    expect(source.counters).toEqual({ '+1/+1': 2 });
  });
});

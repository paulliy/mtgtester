/**
 * Demanding Dragon — "When this creature enters, it deals 5 damage to target opponent unless
 * that player sacrifices a creature of their choice." Exercises the new
 * `dealDamageUnlessSacrifice` op — unlike every other "unless" effect in the engine
 * (`counterUnlessPays`, `mayPayLife`), the choice belongs to the TARGET, not the caster.
 */

import { describe, expect, it } from 'vitest';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pick, pump, spawn } from './fixtures';

const dragon = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: 'c8f1e3bd-bbf0-4750-b054-03553fc61850',
    name: 'Demanding Dragon',
    typeLine: 'Creature — Dragon',
    manaCost: '{3}{R}{R}',
    power: '4',
    toughness: '4',
    oracleText:
      'When this creature enters, it deals 5 damage to target opponent unless that player sacrifices a creature of their choice.',
  });

const bear = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{1}{G}',
    power: '2',
    toughness: '2',
  });

function pod(): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(6, forest) })),
      { seed: 'demanding-dragon' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

function fireTrigger(ctx: GameContext, source: ReturnType<typeof spawn>) {
  queueTriggersForEvent(ctx, 'enters', [{ permanent: source }]);
  return ctx.state.pendingTriggers[0]!;
}

describe('Demanding Dragon (dealDamageUnlessSacrifice)', () => {
  it('deals damage when the opponent has no creature to sacrifice', () => {
    const ctx = pod();
    const d = spawn(ctx, 'P1', dragon());
    const p2 = ctx.state.players[1]!;
    const before = p2.life;

    const pending = fireTrigger(ctx, d);
    pump(
      executeAbility(
        ctx,
        {
          cardId: pending.sourceCardId,
          name: pending.sourceName,
          oracleId: pending.sourceOracleId,
          controllerId: pending.controllerId,
        },
        pending.ability,
        [p2.id],
      ),
    );

    expect(p2.life).toBe(before - 5);
  });

  it('deals no damage and sacrifices the chosen creature when the opponent declines to take damage', () => {
    const ctx = pod();
    const d = spawn(ctx, 'P1', dragon());
    const p2 = ctx.state.players[1]!;
    const foe = spawn(ctx, 'P2', bear());
    const before = p2.life;

    const pending = fireTrigger(ctx, d);
    pump(
      executeAbility(
        ctx,
        {
          cardId: pending.sourceCardId,
          name: pending.sourceName,
          oracleId: pending.sourceOracleId,
          controllerId: pending.controllerId,
        },
        pending.ability,
        [p2.id],
      ),
      (dec) => pick(dec, 'Sacrifice'),
    );

    expect(p2.life).toBe(before);
    expect(ctx.state.battlefield.some((p) => p.cardId === foe.cardId)).toBe(false);
  });

  it('deals damage when the opponent has a creature but declines to sacrifice it', () => {
    const ctx = pod();
    const d = spawn(ctx, 'P1', dragon());
    const p2 = ctx.state.players[1]!;
    spawn(ctx, 'P2', bear());
    const before = p2.life;

    const pending = fireTrigger(ctx, d);
    pump(
      executeAbility(
        ctx,
        {
          cardId: pending.sourceCardId,
          name: pending.sourceName,
          oracleId: pending.sourceOracleId,
          controllerId: pending.controllerId,
        },
        pending.ability,
        [p2.id],
      ),
      (dec) => pick(dec, "Don't sacrifice"),
    );

    expect(p2.life).toBe(before - 5);
  });
});

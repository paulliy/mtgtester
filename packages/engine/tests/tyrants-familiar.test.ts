/**
 * Tyrant's Familiar — "As long as you control your commander, this creature gets +2/+2 and
 * has 'Whenever this creature attacks, it deals 7 damage to target creature defending player
 * controls.'" Exercises the new `controlsYourCommander` condition, gating both a `staticEffects`
 * P/T buff and a granted (layer-6 `addTrigger`) attack trigger.
 */

import { describe, expect, it } from 'vitest';
import { executeAbility } from '../src/effects/resolve';
import { computeCharacteristics } from '../src/effects/continuous';
import { triggersOf } from '../src/state/queries';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const familiar = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: '63394e24-a456-4cc6-9885-8c62447b050a',
    name: "Tyrant's Familiar",
    typeLine: 'Creature — Dragon',
    manaCost: '{4}{R}',
    power: '4',
    toughness: '4',
    oracleText:
      'As long as you control your commander, this creature gets +2/+2 and has "Whenever this creature attacks, it deals 7 damage to target creature defending player controls."',
  });

const commander = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Commander', typeLine: 'Legendary Creature — Test', manaCost: '{3}{R}', power: '3', toughness: '3' });

const defender = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Defender', typeLine: 'Creature — Test', manaCost: '{2}', power: '4', toughness: '4' });

function pod(): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(6, forest) })), { seed: 'tyrants-familiar' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe("Tyrant's Familiar (conditional buff + granted attack trigger)", () => {
  it('is a vanilla 4/4 without its commander in play', () => {
    const ctx = pod();
    const fam = spawn(ctx, 'P1', familiar());
    expect(computeCharacteristics(ctx, fam)).toMatchObject({ power: 4, toughness: 4 });
    expect(triggersOf(ctx, fam)).toHaveLength(0);
  });

  it('is a 6/6 with the attack trigger while its controller controls their commander', () => {
    const ctx = pod();
    const fam = spawn(ctx, 'P1', familiar());
    spawn(ctx, 'P1', commander(), { isCommander: true });

    expect(computeCharacteristics(ctx, fam)).toMatchObject({ power: 6, toughness: 6 });
    expect(triggersOf(ctx, fam)).toHaveLength(1);
  });

  it("does not buff off an opponent's commander", () => {
    const ctx = pod();
    const fam = spawn(ctx, 'P1', familiar());
    spawn(ctx, 'P2', commander(), { isCommander: true });

    expect(computeCharacteristics(ctx, fam)).toMatchObject({ power: 4, toughness: 4 });
  });

  it('deals 7 damage to a target creature the defending player controls when it attacks', () => {
    const ctx = pod();
    const fam = spawn(ctx, 'P1', familiar());
    spawn(ctx, 'P1', commander(), { isCommander: true });
    const foe = spawn(ctx, 'P2', defender());

    fam.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: fam, playerId: 'P2' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const pending = ctx.state.pendingTriggers[0]!;

    pump(
      executeAbility(
        ctx,
        { cardId: pending.sourceCardId, name: pending.sourceName, oracleId: pending.sourceOracleId, controllerId: pending.controllerId },
        pending.ability,
        [foe.id],
        pending.triggerObjectCardId,
        pending.scope,
      ),
    );

    expect(foe.damageMarked).toBe(7);
  });
});

/**
 * Frontier Siege — "As this enchantment enters, choose Khans or Dragons. Khans: at the
 * beginning of each of your main phases, add {G}{G}. Dragons: whenever a creature you control
 * with flying enters, you may have it fight target creature you don't control."
 *
 * Reuses the as-enters modal-choice primitive (see `caged-sun.test.ts`) to gate two mutually
 * exclusive ability sets via the new `chosenOptionIs` condition, and needs a new `mainPhase`
 * trigger `when` (fires at BOTH precombat and postcombat main, unlike the single-step triggers
 * `queueStepTriggers` already handled).
 */

import { describe, expect, it } from 'vitest';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent } from '../src/state/objects';
import { queueStepTriggers } from '../src/turn/turn';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const frontierSiege = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: '4cfaa5cf-cc3d-49a7-9544-38a8bb7e9ec1',
    name: 'Frontier Siege',
    typeLine: 'Enchantment',
    manaCost: '{2}{G}',
    power: null,
    toughness: null,
    oracleText:
      'As this enchantment enters, choose Khans or Dragons.\n• Khans — At the beginning of each of your main phases, add {G}{G}.\n• Dragons — Whenever a creature you control with flying enters, you may have it fight target creature you don\'t control.',
  });

const bear = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', power: '2', toughness: '2' });

const flier = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Flier', typeLine: 'Creature — Drake', manaCost: '{2}{G}', power: '3', toughness: '3', oracleText: 'Flying' });

function pod(): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(6, forest) })), { seed: 'frontier-siege' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('Frontier Siege (as-enters modal choice, two mutually exclusive ability sets)', () => {
  it('Khans: adds {G}{G} at the beginning of each of your main phases', () => {
    const ctx = pod();
    const siege = spawn(ctx, 'P1', frontierSiege());
    siege.chosenOption = 'Khans';
    const p1 = ctx.state.players[0]!;

    queueStepTriggers(ctx, 'mainPhase');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const pending = ctx.state.pendingTriggers[0]!;

    pump(
      executeAbility(
        ctx,
        { cardId: pending.sourceCardId, name: pending.sourceName, oracleId: pending.sourceOracleId, controllerId: pending.controllerId },
        pending.ability,
        [],
      ),
    );
    expect(p1.manaPool.G).toBe(2);
  });

  it("Khans mode doesn't queue the Dragons fight trigger", () => {
    const ctx = pod();
    const siege = spawn(ctx, 'P1', frontierSiege());
    siege.chosenOption = 'Khans';
    const dragon = spawn(ctx, 'P1', flier());

    queueTriggersForEvent(ctx, 'enters', [{ permanent: dragon }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('Dragons: a flying creature entering may fight a target creature you don\'t control', () => {
    const ctx = pod();
    const siege = spawn(ctx, 'P1', frontierSiege());
    siege.chosenOption = 'Dragons';
    const dragon = spawn(ctx, 'P1', flier());
    const foe = spawn(ctx, 'P2', bear());

    queueTriggersForEvent(ctx, 'enters', [{ permanent: dragon }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    const pending = ctx.state.pendingTriggers[0]!;
    expect(pending.ability.optional).toBe(true);

    pump(
      executeAbility(
        ctx,
        { cardId: pending.sourceCardId, name: pending.sourceName, oracleId: pending.sourceOracleId, controllerId: pending.controllerId },
        pending.ability,
        [foe.id],
        pending.triggerObjectCardId,
      ),
    );

    expect(foe.damageMarked).toBe(3); // dragon's power
    expect(dragon.damageMarked).toBe(2); // bear's power
  });

  it('a non-flying creature entering under Dragons mode does not trigger', () => {
    const ctx = pod();
    const siege = spawn(ctx, 'P1', frontierSiege());
    siege.chosenOption = 'Dragons';
    const ground = spawn(ctx, 'P1', bear());

    queueTriggersForEvent(ctx, 'enters', [{ permanent: ground }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

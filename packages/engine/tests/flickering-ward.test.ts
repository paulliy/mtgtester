/**
 * Flickering Ward — "As this Aura enters, choose a color. Enchanted creature has protection
 * from the chosen color... {W}: Return this Aura to its owner's hand." Reuses the as-enters
 * modal-choice primitive (see `caged-sun.test.ts`) to drive a dynamic `addProtection` layer-6
 * op via the new `addProtectionFromChosenColor` `ContinuousOp`, resolved in `gatherEffects`
 * rather than baked into the static op data.
 */

import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { conjure, gameConfig, oracle, pick, pump, spawn } from './fixtures';

const flickeringWard = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: '3e2ae59a-40a1-46ca-8f24-3231ebd4e4eb',
    name: 'Flickering Ward',
    typeLine: 'Enchantment — Aura',
    manaCost: '{1}{W}',
    power: null,
    toughness: null,
    oracleText:
      "As this Aura enters, choose a color.\nEnchanted creature has protection from the chosen color. This effect doesn't remove this Aura.\n{W}: Return this Aura to its owner's hand.",
  });

const bear = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Bear', typeLine: 'Creature — Bear', manaCost: '{1}{G}', power: '2', toughness: '2' });

function ctxWithSeats(seats: number): GameContext {
  const ctx = createGame(gameConfig(Array.from({ length: seats }, () => ({ cards: [] })), { seed: 'flickering-ward' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('Flickering Ward (as-enters modal choice, dynamic protection)', () => {
  it('grants the enchanted creature protection from the chosen color', () => {
    const ctx = ctxWithSeats(2);
    const creature = spawn(ctx, 'P1', bear());

    const wardObj = conjure(ctx, 'P1', flickeringWard(), 'hand');
    pump(moveObject(ctx, wardObj, { zone: 'battlefield' }), (d) => pick(d, 'Red'));
    const ward = ctx.state.battlefield.find((p) => p.cardId === wardObj.cardId);
    if (ward === undefined) throw new Error('expected a permanent');
    ward.attachedTo = creature.id;

    expect(ward.chosenOption).toBe('R');
    expect(computeCharacteristics(ctx, creature).protectionFrom).toEqual(['R']);
  });

  it('grants no protection while the color is unresolved (unattached)', () => {
    const ctx = ctxWithSeats(2);
    const creature = spawn(ctx, 'P1', bear());
    expect(computeCharacteristics(ctx, creature).protectionFrom).toEqual([]);
  });
});

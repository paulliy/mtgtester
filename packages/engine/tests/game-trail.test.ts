/**
 * Game Trail — "As this land enters, you may reveal a Mountain or Forest card from your hand.
 * If you don't, this land enters tapped." Also covers Frostboil Snarl / Vineglimmer Snarl /
 * Shineshadow Snarl / Fortified Village, the rest of the reveal-a-land-type dual cycle, via the
 * new `mayRevealCardFromHand` choice condition (parallel to the existing `mayPayLife` shockland
 * condition).
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { moveObject } from '../src/state/objects';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, forest, gameConfig, mountain, oracle, pick, pump } from './fixtures';

const gameTrail = (): ReturnType<typeof oracle> =>
  oracle({
    oracleId: '00de57d2-7cb6-4337-9bc6-f6711e4dfabf',
    name: 'Game Trail',
    typeLine: 'Land',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
    oracleText:
      "As this land enters, you may reveal a Mountain or Forest card from your hand. If you don't, this land enters tapped.",
  });

function ctxWithSeats(seats: number): GameContext {
  const ctx = createGame(gameConfig(Array.from({ length: seats }, () => ({ cards: [] })), { seed: 'game-trail' }));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  return ctx;
}

describe('Game Trail (may-reveal-a-land-from-hand condition)', () => {
  it('parses to a mayRevealCardFromHand condition, not a trigger', () => {
    const def = interpretCard(gameTrail());
    expect(def.entersTappedUnless).toEqual({ kind: 'mayRevealCardFromHand', subtypes: ['Mountain', 'Forest'] });
    expect(def.triggers).toHaveLength(0);
  });

  it('enters tapped with no qualifying card in hand — no decision offered', () => {
    const ctx = ctxWithSeats(2);
    const obj = conjure(ctx, 'P1', gameTrail(), 'hand');
    const { value: perm } = pump(moveObject(ctx, obj, { zone: 'battlefield' }));
    expect((perm as { tapped: boolean }).tapped).toBe(true);
  });

  it('enters untapped when the controller reveals a qualifying card', () => {
    const ctx = ctxWithSeats(2);
    conjure(ctx, 'P1', mountain(), 'hand');
    const obj = conjure(ctx, 'P1', gameTrail(), 'hand');
    const { value: perm } = pump(moveObject(ctx, obj, { zone: 'battlefield' }), (d) => pick(d, 'Reveal'));
    expect((perm as { tapped: boolean }).tapped).toBe(false);
  });

  it('enters tapped when the controller declines to reveal', () => {
    const ctx = ctxWithSeats(2);
    conjure(ctx, 'P1', forest(), 'hand');
    const obj = conjure(ctx, 'P1', gameTrail(), 'hand');
    const { value: perm } = pump(moveObject(ctx, obj, { zone: 'battlefield' }), (d) => pick(d, "Don't reveal"));
    expect((perm as { tapped: boolean }).tapped).toBe(true);
  });
});

/**
 * Layer-4 basic-land-type GRANTS, driven by verbatim printed text (R.4).
 *
 * Two printed shapes, and the difference in scope between them is load-bearing:
 *
 *   "Lands you control are every basic land type in addition to their other types."
 *       — Dryad of the Ilysian Grove, Leyline of the Guildpact. Controller-restricted.
 *   "Each land is a Swamp in addition to its other land types."
 *       — Urborg, Yavimaya. EVERY land in the game, including opponents'.
 *
 * The layer engine already did all of this (`finishLayer4` keeps printed types, `BASIC_LAND_MANA`
 * derives the intrinsic mana ability from the resulting subtypes) — proven by `layers.test.ts`
 * against a HAND-BUILT definition. What was missing was the parse: the only branch that existed
 * matched `'lands you control are every basic land type'`, and no printing ends there. So the
 * mechanism worked and no real card could reach it.
 *
 * These tests therefore assert the MANA consequence, not just the subtype: that is the thing a
 * player actually gets, and it is what a parse-only test would have missed.
 */

import { describe, expect, it } from 'vitest';
import { computeCharacteristics } from '../src/effects/continuous';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, island, oracle, spawn } from './fixtures';

/** Urborg, Tomb of Yawgmoth — oracle text verbatim. */
const urborg = () =>
  oracle({
    name: 'Test Urborg',
    typeLine: 'Legendary Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: 'Each land is a Swamp in addition to its other land types.',
  });

/** Yavimaya, Cradle of Growth — oracle text verbatim. */
const yavimaya = () =>
  oracle({
    name: 'Test Yavimaya',
    typeLine: 'Legendary Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: 'Each land is a Forest in addition to its other land types.',
  });

/** Dryad of the Ilysian Grove — oracle text verbatim. */
const dryad = () =>
  oracle({
    name: 'Test Dryad',
    typeLine: 'Creature — Dryad',
    manaCost: '{1}{G}',
    power: '2',
    toughness: '4',
    oracleText:
      'You may play an additional land on each of your turns.\nLands you control are every basic land type in addition to their other types.',
  });

function ctx4(seed = 'land-types'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(3, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const symbolsFor = (ctx: GameContext, player: 'P1' | 'P2'): string[] =>
  [...new Set(manaSourcesFor(ctx, player).flatMap((s) => s.units.flat()))].sort();

describe('basic land type grants (layer 4)', () => {
  it('models all four printed cards from their real text', () => {
    for (const card of [urborg(), yavimaya(), dryad()]) {
      const def = interpretCard(card);
      expect(def.modeled, `${card.name}: ${JSON.stringify(def.unmodeledReasons)}`).toBe(true);
      expect(def.staticEffects.length).toBeGreaterThan(0);
    }
  });

  it('Urborg makes every land a Swamp — including an opponent\'s', () => {
    const ctx = ctx4();
    const mine = spawn(ctx, 'P1', forest());
    const theirs = spawn(ctx, 'P2', island());
    spawn(ctx, 'P1', urborg());

    expect(computeCharacteristics(ctx, mine).subtypes.sort()).toEqual(['Forest', 'Swamp']);
    expect(computeCharacteristics(ctx, theirs).subtypes.sort()).toEqual(['Island', 'Swamp']);

    // The mana consequence is the point: a Forest that is also a Swamp taps for G or B.
    expect(symbolsFor(ctx, 'P1')).toContain('B');
    expect(symbolsFor(ctx, 'P1')).toContain('G');
    // "Each land" is not controller-restricted.
    expect(symbolsFor(ctx, 'P2')).toEqual(['B', 'U']);
  });

  it('Yavimaya grants Forest, not Swamp', () => {
    const ctx = ctx4();
    const theirs = spawn(ctx, 'P2', island());
    spawn(ctx, 'P1', yavimaya());
    expect(computeCharacteristics(ctx, theirs).subtypes.sort()).toEqual(['Forest', 'Island']);
    expect(symbolsFor(ctx, 'P2')).toEqual(['G', 'U']);
  });

  it("Dryad grants all five basic types, but only to its controller's lands", () => {
    const ctx = ctx4();
    const mine = spawn(ctx, 'P1', forest());
    const theirs = spawn(ctx, 'P2', island());
    spawn(ctx, 'P1', dryad());

    // CR 305.6 lists exactly five basic land types. Wastes is a land type but NOT a basic land
    // type, so {C} must not appear here.
    expect(computeCharacteristics(ctx, mine).subtypes.sort()).toEqual([
      'Forest', 'Island', 'Mountain', 'Plains', 'Swamp',
    ]);
    expect(symbolsFor(ctx, 'P1')).toEqual(['B', 'G', 'R', 'U', 'W']);

    // "Lands you control" — the opponent's Island is untouched.
    expect(computeCharacteristics(ctx, theirs).subtypes).toEqual(['Island']);
    expect(symbolsFor(ctx, 'P2')).toEqual(['U']);
  });
});

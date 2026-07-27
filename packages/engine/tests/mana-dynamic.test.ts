/**
 * Mana abilities whose production is not printed on the card (ADR 0010, Inc 2):
 *
 * - derived from state — "any color in your commander's color identity" (Command Tower),
 *   "any color a land an opponent controls could produce" (Fellwar Stone);
 * - granted by a continuous effect — Chromatic Lantern's layer-6 `addManaAbility`;
 * - gated by a condition — "Activate only if you control a Dragon" (Mox Jasper);
 * - carrying a rider — a painland's "This land deals 1 damage to you".
 *
 * The point of these tests is that the symbols are computed at QUERY time. A source that can
 * currently produce nothing (Fellwar Stone facing no opposing lands) must not be offered as a
 * payment source at all, or the solver would plan a payment that cannot be made.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import {
  commanderFor,
  copies,
  forest,
  gameConfig,
  island,
  mountain,
  oracle,
  spawn,
} from './fixtures';

const artifact = (name: string, oracleText: string): ReturnType<typeof oracle> =>
  oracle({ name, typeLine: 'Artifact', oracleText, manaCost: '{2}', power: null, toughness: null });

const land = (name: string, oracleText: string): ReturnType<typeof oracle> =>
  oracle({ name, typeLine: 'Land', oracleText, manaCost: null, cmc: 0, power: null, toughness: null });

const commandTower = (): ReturnType<typeof oracle> =>
  land('Test Tower', "{T}: Add one mana of any color in your commander's color identity.");

const fellwarStone = (): ReturnType<typeof oracle> =>
  artifact(
    'Test Fellwar',
    '{T}: Add one mana of any color that a land an opponent controls could produce.',
  );

const moxJasper = (): ReturnType<typeof oracle> =>
  artifact('Test Mox', '{T}: Add one mana of any color. Activate only if you control a Dragon.');

const chromaticLantern = (): ReturnType<typeof oracle> =>
  artifact('Test Lantern', 'Lands you control have "{T}: Add one mana of any color."');

const painland = (): ReturnType<typeof oracle> =>
  land('Test Painland', '{T}: Add {G} or {U}. This land deals 1 damage to you.');

const dragon = (): ReturnType<typeof oracle> =>
  oracle({ name: 'Test Dragon', typeLine: 'Creature — Dragon', manaCost: '{4}{R}' });

/** A pod whose seat 1 commander has the given identity. */
function ctxWithCommander(colors: ('W' | 'U' | 'B' | 'R' | 'G')[]): GameContext {
  const cmd = oracle({
    name: 'Test Identity Commander',
    typeLine: 'Legendary Creature — Test Captain',
    manaCost: '{1}{G}',
    colors,
    colorIdentity: colors,
    power: '3',
    toughness: '3',
  });
  const ctx = createGame(
    gameConfig(
      [
        { commander: cmd, cards: copies(4, forest) },
        { commander: commanderFor('U', 'Opp Commander'), cards: copies(4, island) },
      ],
      { seed: 'mana-dynamic' },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

/** The symbol choices `manaSourcesFor` offers for the named permanent. */
function symbolsFor(ctx: GameContext, name: string): string[][] {
  const perm = ctx.state.battlefield.find((p) => p.name === name);
  const source = manaSourcesFor(ctx, 'P1').find((s) => s.cardId === perm?.cardId);
  return (source?.units ?? []).map((u) => [...u]);
}

describe('state-derived mana production', () => {
  it("reads the controller's commander color identity, wherever the commander is", () => {
    const ctx = ctxWithCommander(['B', 'G', 'R']);
    spawn(ctx, 'P1', commandTower());

    // Sorted for a stable assertion — the ability offers one mana, chosen among the identity.
    expect(symbolsFor(ctx, 'Test Tower')[0]?.sort()).toEqual(['B', 'G', 'R']);
  });

  it('narrows with a narrower commander', () => {
    const ctx = ctxWithCommander(['W']);
    spawn(ctx, 'P1', commandTower());

    expect(symbolsFor(ctx, 'Test Tower')).toEqual([['W']]);
  });

  it("Fellwar Stone unions the colors of opponents' lands only", () => {
    const ctx = ctxWithCommander(['G']);
    spawn(ctx, 'P1', fellwarStone());
    spawn(ctx, 'P2', island());
    // The controller's own Mountain must NOT contribute.
    spawn(ctx, 'P1', mountain());

    expect(symbolsFor(ctx, 'Test Fellwar')).toEqual([['U']]);
  });

  it('offers no source at all when a dynamic ability can currently produce nothing', () => {
    const ctx = ctxWithCommander(['G']);
    const stone = spawn(ctx, 'P1', fellwarStone());
    // No opponent lands → no producible colors. Offering it would let the solver plan a
    // payment it cannot make.
    expect(manaSourcesFor(ctx, 'P1').some((s) => s.cardId === stone.cardId)).toBe(false);
  });

  it('does not infinitely recurse when multiple players control Exotic Orchard', () => {
    const exoticOrchard = (): ReturnType<typeof oracle> =>
      land(
        'Exotic Orchard',
        '{T}: Add one mana of any color that a land an opponent controls could produce.',
      );

    const ctx = ctxWithCommander(['G']);
    spawn(ctx, 'P1', exoticOrchard());
    spawn(ctx, 'P2', exoticOrchard());
    spawn(ctx, 'P2', forest());

    // P1's Exotic Orchard evaluates P2's Exotic Orchard and Forest.
    // P2's Exotic Orchard evaluates P1's Exotic Orchard.
    // Must return ['G'] without stack overflow.
    expect(symbolsFor(ctx, 'Exotic Orchard')).toEqual([['G']]);
  });
});

describe('conditional and granted mana abilities', () => {
  it('an "activate only if" ability is unavailable until its condition holds', () => {
    const ctx = ctxWithCommander(['R']);
    const mox = spawn(ctx, 'P1', moxJasper());

    expect(manaSourcesFor(ctx, 'P1').some((s) => s.cardId === mox.cardId)).toBe(false);

    spawn(ctx, 'P1', dragon());
    expect(manaSourcesFor(ctx, 'P1').some((s) => s.cardId === mox.cardId)).toBe(true);
  });

  it('Chromatic Lantern grants every land you control an any-color ability', () => {
    const ctx = ctxWithCommander(['G']);
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P2', island());

    // Before: a Mountain taps for {R} only.
    expect(symbolsFor(ctx, 'Mountain')).toEqual([['R']]);

    spawn(ctx, 'P1', chromaticLantern());

    // After: the granted ability collapses with the intrinsic one into a single source
    // offering every symbol (a permanent can only be tapped once).
    expect(symbolsFor(ctx, 'Mountain')[0]?.sort()).toEqual(['B', 'G', 'R', 'U', 'W']);
    // The opponent's land is untouched — "Lands YOU control".
    const oppIsland = ctx.state.battlefield.find((p) => p.controllerId === 'P2');
    const oppSources = manaSourcesFor(ctx, 'P2').find((s) => s.cardId === oppIsland?.cardId);
    expect(oppSources?.units).toEqual([['U']]);
  });
});

describe('mana ability riders', () => {
  it('parses a painland as one ability with a damage rider, not two abilities', () => {
    const def = interpretCard(painland());

    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toHaveLength(1);
    expect(def.manaAbilities[0]?.units).toEqual([['G', 'U']]);
    expect(def.manaAbilities[0]?.onActivate).toEqual([{ op: 'damageController', amount: 1 }]);
  });
});

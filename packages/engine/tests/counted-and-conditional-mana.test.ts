/**
 * Mana abilities whose AMOUNT or availability is read off the board (R.2).
 *
 * Three separate mechanisms, deliberately kept apart:
 *
 * - **Counted amount** — "Add {G} for each creature you control" (Gaea's Cradle, Itlimoc).
 *   `ManaAbilitySpec` has no amount field of its own: `units.length` IS the mana count
 *   everywhere in the engine, so `amount` expands into units at query time
 *   (`resolveDynamicAmount`) and nothing downstream needs to know the count was computed.
 * - **Activation gate** — "Activate only if you control five or more lands" (Temple of the
 *   False God). `ManaAbilitySpec.condition` already existed and was already honoured; only the
 *   counted phrasing was unparsed.
 * - **Derived symbols** — Reflecting Pool, Mox Amber. The mirror of a counted amount: the count
 *   is fixed at one and the SYMBOL SET is computed.
 *
 * Oracle text below is verbatim (Scryfall bulk, checked 2026-09-04).
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { bear, copies, forest, gameConfig, island, oracle, spawn } from './fixtures';

const gaeasCradle = () =>
  oracle({
    name: 'Test Cradle',
    typeLine: 'Legendary Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add {G} for each creature you control.',
  });

const templeOfTheFalseGod = () =>
  oracle({
    name: 'Test Temple',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add {C}{C}. Activate only if you control five or more lands.',
  });

const reflectingPool = () =>
  oracle({
    name: 'Test Pool',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add one mana of any type that a land you control could produce.',
  });

const moxAmber = () =>
  oracle({
    name: 'Test Amber',
    typeLine: 'Legendary Artifact',
    manaCost: '{0}',
    power: null,
    toughness: null,
    oracleText:
      '{T}: Add one mana of any color among legendary creatures and planeswalkers you control.',
  });

/** A land with no printed basic subtype, so it contributes only what its ability says. */
const colorlessLand = () =>
  oracle({
    name: 'Test Colorless Land',
    typeLine: 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: '{T}: Add {C}.',
  });

const legendaryBear = () =>
  oracle({
    name: 'Test Legend',
    typeLine: 'Legendary Creature — Bear',
    manaCost: '{1}{R}',
    power: '2',
    toughness: '2',
    colors: ['R'],
    oracleText: '',
  });

function pod(seed = 'counted-mana'): GameContext {
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

/** Units of the sources belonging to `name`, as a flat symbol list per source. */
const unitsOf = (ctx: GameContext, name: string): string[][] =>
  manaSourcesFor(ctx, 'P1')
    .filter((s) => ctx.state.battlefield.find((p) => p.cardId === s.cardId)?.name === name)
    .map((s) => [...s.units.flat()]);

describe('counted mana amounts', () => {
  it('Gaea’s Cradle produces one {G} per creature', () => {
    const def = interpretCard(gaeasCradle());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);

    const ctx = pod();
    spawn(ctx, 'P1', gaeasCradle());

    // Zero creatures: the source makes nothing, so it must not be offered at all — offering a
    // source that produces no mana would let the payment solver "tap" it for nothing.
    expect(unitsOf(ctx, 'Test Cradle')).toEqual([]);

    spawn(ctx, 'P1', bear());
    expect(unitsOf(ctx, 'Test Cradle')).toEqual([['G']]);

    spawn(ctx, 'P1', bear());
    spawn(ctx, 'P1', bear());
    expect(unitsOf(ctx, 'Test Cradle')).toEqual([['G', 'G', 'G']]);
  });

  it('counts only the controller’s creatures', () => {
    const ctx = pod();
    spawn(ctx, 'P1', gaeasCradle());
    spawn(ctx, 'P2', bear());
    spawn(ctx, 'P2', bear());
    expect(unitsOf(ctx, 'Test Cradle')).toEqual([]);
  });
});

describe('counted activation gates', () => {
  it('Temple of the False God is unavailable below five lands', () => {
    const def = interpretCard(templeOfTheFalseGod());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);
    expect(def.manaAbilities[0]!.units).toEqual([['C'], ['C']]);

    const ctx = pod();
    spawn(ctx, 'P1', templeOfTheFalseGod());
    for (let i = 0; i < 3; i += 1) spawn(ctx, 'P1', forest());
    expect(unitsOf(ctx, 'Test Temple')).toEqual([]);

    // The Temple counts itself, so one more land reaches five.
    spawn(ctx, 'P1', forest());
    expect(unitsOf(ctx, 'Test Temple')).toEqual([['C', 'C']]);
  });
});

describe('mana symbols derived from your own permanents', () => {
  it('Reflecting Pool offers every type your lands could produce, colorless included', () => {
    const def = interpretCard(reflectingPool());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);

    const ctx = pod();
    spawn(ctx, 'P1', reflectingPool());
    expect(unitsOf(ctx, 'Test Pool')).toEqual([]); // no other lands yet

    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', island());
    // "any TYPE", not "any color" — a colorless-producing land counts too.
    spawn(ctx, 'P1', colorlessLand());
    expect(unitsOf(ctx, 'Test Pool')[0]!.sort()).toEqual(['C', 'G', 'U']);

    // An opponent's land is not "a land you control".
    spawn(ctx, 'P2', oracle({ ...island(), name: 'Their Island' }));
    expect(unitsOf(ctx, 'Test Pool')[0]!.sort()).toEqual(['C', 'G', 'U']);
  });

  it('two Reflecting Pools do not recurse into each other', () => {
    const ctx = pod();
    spawn(ctx, 'P1', reflectingPool());
    // A distinct oracleId, or the second card resolves to the first's cached definition and the
    // two permanents come back indistinguishable.
    spawn(
      ctx,
      'P1',
      oracle({ ...reflectingPool(), oracleId: 'oracle-test-pool-two', name: 'Test Pool Two' }),
    );
    spawn(ctx, 'P1', forest());
    // Terminates (each Pool's recursion is cut by `visited`), and each Pool sees the Forest.
    expect(unitsOf(ctx, 'Test Pool')).toEqual([['G']]);
    expect(unitsOf(ctx, 'Test Pool Two')).toEqual([['G']]);
  });

  it('Mox Amber reads legendary creatures and planeswalkers only', () => {
    const def = interpretCard(moxAmber());
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);

    const ctx = pod();
    spawn(ctx, 'P1', moxAmber());
    // Mox Amber is itself a legendary ARTIFACT, so it never feeds its own ability.
    expect(unitsOf(ctx, 'Test Amber')).toEqual([]);

    // A nonlegendary creature does not count.
    spawn(ctx, 'P1', bear());
    expect(unitsOf(ctx, 'Test Amber')).toEqual([]);

    spawn(ctx, 'P1', legendaryBear());
    expect(unitsOf(ctx, 'Test Amber')).toEqual([['R']]);
  });
});

describe('mana abilities that cost mana', () => {
  it('Cabal Coffers models its counted production and its own {2}', () => {
    // "{2}, {T}: Add {B} for each Swamp you control." Two primitives meet here: the counted
    // AMOUNT this file's other tests cover, and a cost the payment solver has to pay out of the
    // same payment it is planning. Whether the {2} is actually charged is
    // `mana-cost-in-mana-ability.test.ts`'s subject; this pins the parse.
    const def = interpretCard(
      oracle({
        name: 'Test Coffers',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: '{2}, {T}: Add {B} for each Swamp you control.',
      }),
    );
    expect(def.modeled, JSON.stringify(def.unmodeledReasons)).toBe(true);
    expect(def.manaAbilities).toHaveLength(1);
    expect(def.manaAbilities[0]?.costs?.map((c) => c.kind)).toEqual(['mana', 'tap']);
    expect(def.manaAbilities[0]?.amount).toEqual({
      kind: 'countPermanents',
      selector: {
        kind: 'allOf',
        of: [
          { kind: 'controller', who: 'you' },
          { kind: 'subtype', value: 'Swamp' },
        ],
      },
      scope: 'you',
    });
  });
});

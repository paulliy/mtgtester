/**
 * The CR 613 continuous-effect layer engine (ADR 0005, ADR 0006). Proves the individual layers
 * and — the point of a real layer system — their interactions in the correct order:
 *
 *   layer 4 (type) → 6 (abilities) → 7a CDA → 7b set → 7c counters → 7d modify,
 *
 * and, within a layer, CR 613.8 dependency before CR 613.7 timestamp. The two dependency
 * cases below are built so that plain timestamp order gives a *different, wrong* answer —
 * otherwise they would not be evidence that dependency ordering is doing anything.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import type { CardDefinition } from '../src/cards/definition';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import {
  bear,
  bolt,
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  registerCustomDef,
  spawn,
} from './fixtures';
import { effectivePT, isCreaturePermanent, manaSourcesFor } from '../src/state/queries';
import { computeCharacteristics } from '../src/effects/continuous';
import { NONBASIC_LANDS, ofType } from '../src/cards/selector';
import { UnmodeledCardError } from '../src/errors';

function ctx4(): GameContext {
  const c = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(2, forest) })),
      { seed: 'layers' },
    ),
  );
  c.state.currentTurnPlayer = 'P1';
  c.state.turnNumber = 3;
  return c;
}

function customDef(
  partial: Partial<CardDefinition> & { oracleId: string; name: string },
): CardDefinition {
  return {
    typeLine: 'Land',
    supertypes: [],
    types: ['Land'],
    subtypes: [],
    colors: [],
    colorIdentity: [],
    manaCost: null,
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    spellAbility: null,
    triggers: [],
    staticEffects: [],
    modeled: true,
    unmodeledReasons: [],
    ...partial,
  };
}

const bloodMoon = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Blood Moon',
    typeLine: 'Enchantment',
    manaCost: '{2}{R}',
    power: null,
    toughness: null,
    oracleText: 'Nonbasic lands are Mountains.',
  });

/** A land, optionally bound to a hand-written definition via `oracleId`. */
const land = (
  name: string,
  opts: { oracleId?: string; oracleText?: string; typeLine?: string } = {},
): ReturnType<typeof oracle> =>
  oracle({
    name,
    typeLine: opts.typeLine ?? 'Land',
    manaCost: null,
    power: null,
    toughness: null,
    oracleText: opts.oracleText ?? '',
    ...(opts.oracleId !== undefined ? { oracleId: opts.oracleId } : {}),
  });

/**
 * "Each land is a Swamp in addition to its other types" (Urborg, Tomb of Yawgmoth). Hand-built
 * rather than parsed: the interpreter deliberately leaves the real card unmodeled while a land
 * with two mana abilities has no way to ask its controller which to use (proven below).
 */
function urborgDef(oracleId: string): CardDefinition {
  return customDef({
    oracleId,
    name: 'Test Urborg',
    typeLine: 'Legendary Land',
    supertypes: ['Legendary'],
    staticEffects: [{ affects: ofType('Land'), op: { layer: 4, addSubtypes: ['Swamp'] } }],
  });
}

/** "Nonbasic lands are <basic type>" printed on a nonbasic LAND — each one shuts the other off. */
function moonLandDef(oracleId: string, name: string, subtype: string): CardDefinition {
  return customDef({
    oracleId,
    name,
    staticEffects: [
      {
        affects: NONBASIC_LANDS,
        op: { layer: 4, setLandSubtype: subtype, loseAbilities: true },
      },
    ],
  });
}

const tarmogoyf = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Goyf',
    typeLine: 'Creature — Lhurgoyf',
    manaCost: '{1}{G}',
    power: '*',
    toughness: '*',
    oracleText:
      "Test Goyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.",
  });

describe('CR 613 layer engine (ADR 0005)', () => {
  it('layer 7a: a CDA computes P/T from game state, and counters (7c) stack on top', () => {
    // Tarmogoyf's text is now modeled as a layer-7a CDA (its "*" P/T is expected).
    expect(interpretCard(tarmogoyf()).modeled).toBe(true);

    const ctx = ctx4();
    const goyf = spawn(ctx, 'P1', tarmogoyf());
    // Empty graveyards: 0 card types ⇒ 0/1.
    expect(effectivePT(ctx, goyf)).toEqual({ power: 0, toughness: 1 });

    // A creature and an instant in a graveyard ⇒ 2 card types ⇒ 2/3.
    conjure(ctx, 'P1', bear(), 'graveyard');
    conjure(ctx, 'P2', bolt(), 'graveyard');
    expect(effectivePT(ctx, goyf)).toEqual({ power: 2, toughness: 3 });

    // A +1/+1 counter (7c) applies AFTER the CDA (7a): 3/4.
    goyf.counters['+1/+1'] = 1;
    expect(effectivePT(ctx, goyf)).toEqual({ power: 3, toughness: 4 });
  });

  it('layers 4 + 7b + 7c + 7d compose in order (a manland that becomes a creature)', () => {
    const ctx = ctx4();
    // A land with a static "it's a 2/2 creature" (layer 4 add-type + layer 7b set-P/T) —
    // the shape Mutavault's activated ability produces once activated abilities exist.
    registerCustomDef(
      ctx,
      customDef({
        oracleId: 'manland',
        name: 'Test Manland',
        staticEffects: [
          { affects: { kind: 'self' }, op: { layer: 4, addTypes: ['Creature'] } },
          {
            affects: { kind: 'self' },
            op: {
              layer: 7,
              sublayer: 'b',
              power: { kind: 'const', n: 2 },
              toughness: { kind: 'const', n: 2 },
            },
          },
        ],
      }),
    );
    const manland = spawn(ctx, 'P1', land('Test Manland', { oracleId: 'manland' }));

    // Layer 4: it is now a creature. Layer 7b: base 2/2.
    expect(isCreaturePermanent(ctx, manland)).toBe(true);
    expect(effectivePT(ctx, manland)).toEqual({ power: 2, toughness: 2 });

    // 7c counter then 7d pump apply on top of the 7b set, in order: 2/2 → 3/3 → 6/6.
    manland.counters['+1/+1'] = 1;
    expect(effectivePT(ctx, manland)).toEqual({ power: 3, toughness: 3 });
    ctx.state.effects.push({
      id: 'eff-test',
      sourceId: 'x',
      description: 'pump',
      targetCardIds: [manland.cardId],
      kind: 'ptDelta',
      power: 3,
      toughness: 3,
      timestamp: ctx.state.nextTimestamp++,
    });
    expect(effectivePT(ctx, manland)).toEqual({ power: 6, toughness: 6 });
  });

  it('layer 4 over a selected set: Blood Moon turns nonbasic lands into Mountains', () => {
    expect(interpretCard(bloodMoon()).modeled).toBe(true);

    const ctx = ctx4();
    // A nonbasic land that taps for U, plus a basic Forest.
    const tower = spawn(ctx, 'P1', land('Test Tower', { oracleText: '{T}: Add {U}.' }));
    spawn(ctx, 'P1', forest());

    // Before Blood Moon: the tower taps for U, the Forest for G.
    let units = manaSourcesFor(ctx, 'P1').map((s) => s.units.flat().join(''));
    expect(units.sort()).toEqual(['G', 'U']);

    // Blood Moon in play: the nonbasic tower becomes a Mountain (taps for R, loses U); the
    // BASIC Forest is untouched.
    spawn(ctx, 'P2', bloodMoon());
    units = manaSourcesFor(ctx, 'P1').map((s) => s.units.flat().join(''));
    expect(units.sort()).toEqual(['G', 'R']);
    // The tower is still a land, not a creature.
    expect(isCreaturePermanent(ctx, tower)).toBe(false);
  });
});

describe('CR 613.8 dependency ordering (ADR 0006)', () => {
  it('Blood Moon shuts off Urborg regardless of which entered first', () => {
    // Urborg's effect DEPENDS on Blood Moon's: Blood Moon turns Urborg (a nonbasic land) into
    // a Mountain, which removes the rules text generating Urborg's effect (CR 305.7). Blood
    // Moon's effect does not depend on Urborg's. So Blood Moon applies first either way, and
    // Urborg never does — the published ruling. Under plain timestamp order with Urborg first,
    // the basic Forest would wrongly come out a "Forest Swamp".
    for (const urborgFirst of [true, false]) {
      const ctx = ctx4();
      registerCustomDef(ctx, urborgDef('urborg'));
      const putUrborg = (): ReturnType<typeof spawn> =>
        spawn(ctx, 'P1', land('Test Urborg', { oracleId: 'urborg', typeLine: 'Legendary Land' }));
      const putMoon = (): ReturnType<typeof spawn> => spawn(ctx, 'P2', bloodMoon());

      // Timestamps follow entry order; the result must be the same either way.
      const urborg = urborgFirst ? putUrborg() : null;
      const moon = putMoon();
      const urborgPerm = urborg ?? putUrborg();
      const forestPerm = spawn(ctx, 'P1', forest());

      // Urborg is a Mountain with its rules text gone, so its "each land is a Swamp" never runs.
      const urborgChars = computeCharacteristics(ctx, urborgPerm);
      expect(urborgChars.subtypes).toEqual(['Mountain']);
      expect(urborgChars.loseAbilities).toBe(true);
      // The BASIC Forest is untouched by both: Blood Moon skips it, Urborg no longer exists.
      expect(computeCharacteristics(ctx, forestPerm).subtypes).toEqual(['Forest']);
      // Blood Moon itself is an enchantment — unaffected.
      expect(computeCharacteristics(ctx, moon).types).toEqual(['Enchantment']);
    }
  });

  it("a layer-4 effect that widens another's affected set is applied first", () => {
    // "Each artifact is a land in addition to its other types" + Blood Moon. Blood Moon's
    // affected set ("nonbasic lands") grows once the artifact becomes a land, so Blood Moon
    // DEPENDS on the animator and must wait — even though Blood Moon entered first. Under
    // plain timestamp order the artifact would escape Blood Moon entirely.
    const ctx = ctx4();
    const moon = spawn(ctx, 'P2', bloodMoon()); // earlier timestamp
    registerCustomDef(
      ctx,
      customDef({
        oracleId: 'animator',
        name: 'Test Animator',
        typeLine: 'Enchantment',
        types: ['Enchantment'],
        staticEffects: [{ affects: ofType('Artifact'), op: { layer: 4, addTypes: ['Land'] } }],
      }),
    );
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Animator',
        oracleId: 'animator',
        typeLine: 'Enchantment',
        manaCost: '{2}',
        power: null,
        toughness: null,
      }),
    );
    const relic = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Relic',
        typeLine: 'Artifact',
        manaCost: '{2}',
        power: null,
        toughness: null,
        oracleText: '{T}: Add {U}.',
      }),
    );

    const chars = computeCharacteristics(ctx, relic);
    expect(chars.types).toEqual(['Artifact', 'Land']);
    expect(chars.subtypes).toEqual(['Mountain']);
    expect(chars.loseAbilities).toBe(true);
    // Its printed "{T}: Add {U}" is gone; it taps for R like any Mountain.
    expect(manaSourcesFor(ctx, 'P1').map((s) => s.units.flat().join(''))).toEqual(['R']);
    expect(computeCharacteristics(ctx, moon).types).toEqual(['Enchantment']);
  });

  it('CR 613.8c: a dependency loop falls back to timestamp order', () => {
    // Two nonbasic LANDS, each reading "Nonbasic lands are <type>". Each removes the other's
    // rules text, so each depends on the other — an unbreakable loop. 613.8c says to ignore
    // dependency and use timestamps, so the older one applies (and, in applying, extinguishes
    // the newer one's ability). Reversing entry order reverses the winner.
    for (const [first, second, expected] of [
      ['Mountain', 'Island', 'Mountain'],
      ['Island', 'Mountain', 'Island'],
    ] as const) {
      const ctx = ctx4();
      registerCustomDef(ctx, moonLandDef('moon-a', 'Test Moonland A', first));
      registerCustomDef(ctx, moonLandDef('moon-b', 'Test Moonland B', second));
      spawn(ctx, 'P1', land('Test Moonland A', { oracleId: 'moon-a' }));
      spawn(ctx, 'P2', land('Test Moonland B', { oracleId: 'moon-b' }));
      const tower = spawn(ctx, 'P1', land('Test Tower', { oracleText: '{T}: Add {U}.' }));

      expect(computeCharacteristics(ctx, tower).subtypes).toEqual([expected]);
    }
  });

  it('a land given a second basic type taps for either color, as one choice', () => {
    // Urborg alone (no Blood Moon): the basic Forest is a Forest Swamp. Its two intrinsic mana
    // abilities collapse into ONE source offering a choice of symbol — exact, not a guess,
    // because the land can only be tapped once either way (CR 305.6).
    const ctx = ctx4();
    registerCustomDef(ctx, urborgDef('urborg'));
    spawn(ctx, 'P1', land('Test Urborg', { oracleId: 'urborg', typeLine: 'Legendary Land' }));
    const forestPerm = spawn(ctx, 'P1', forest());

    expect(computeCharacteristics(ctx, forestPerm).subtypes).toEqual(['Forest', 'Swamp']);
    const forestSource = manaSourcesFor(ctx, 'P1').find((s) => s.cardId === forestPerm.cardId);
    expect(forestSource).toMatchObject({ cardId: forestPerm.cardId, units: [['G', 'B']] });
  });

  it('halts rather than guessing when mana abilities differ in how much they produce', () => {
    // The collapse above is only sound because each ability makes exactly one mana. A permanent
    // offering "{T}: Add {G}" or "{T}: Add {C}{C}" is a real strategic choice, and picking one
    // silently would be a misplay — so it still halts loudly (brief §6.3).
    const ctx = ctx4();
    registerCustomDef(
      ctx,
      customDef({
        oracleId: 'ambiguous-rock',
        name: 'Test Ambiguous Rock',
        typeLine: 'Artifact',
        types: ['Artifact'],
        manaAbilities: [{ units: [['G']] }, { units: [['C'], ['C']] }],
      }),
    );
    spawn(ctx, 'P1', land('Test Ambiguous Rock', { oracleId: 'ambiguous-rock' }));

    expect(() => manaSourcesFor(ctx, 'P1')).toThrow(UnmodeledCardError);
  });
});

/**
 * The CR 613 continuous-effect layer engine (ADR 0005). Proves the individual layers and —
 * the point of a real layer system — their interactions in the correct order:
 *
 *   layer 4 (type) → 6 (abilities) → 7a CDA → 7b set → 7c counters → 7d modify.
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
    manaCost: null,
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    entersTapped: false,
    spellAbility: null,
    triggers: [],
    staticEffects: [],
    modeled: true,
    unmodeledReasons: [],
    ...partial,
  };
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
    const land = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Manland',
        oracleId: 'manland',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
      }),
    );

    // Layer 4: it is now a creature. Layer 7b: base 2/2.
    expect(isCreaturePermanent(ctx, land)).toBe(true);
    expect(effectivePT(ctx, land)).toEqual({ power: 2, toughness: 2 });

    // 7c counter then 7d pump apply on top of the 7b set, in order: 2/2 → 3/3 → 6/6.
    land.counters['+1/+1'] = 1;
    expect(effectivePT(ctx, land)).toEqual({ power: 3, toughness: 3 });
    ctx.state.effects.push({
      id: 'eff-test',
      sourceId: 'x',
      description: 'pump',
      targetCardId: land.cardId,
      kind: 'ptDelta',
      power: 3,
      toughness: 3,
      timestamp: ctx.state.nextTimestamp++,
    });
    expect(effectivePT(ctx, land)).toEqual({ power: 6, toughness: 6 });
  });

  it('layer 4 over a selected set: Blood Moon turns nonbasic lands into Mountains', () => {
    expect(
      interpretCard(
        oracle({
          name: 'Test Blood Moon',
          typeLine: 'Enchantment',
          manaCost: '{2}{R}',
          power: null,
          toughness: null,
          oracleText: 'Nonbasic lands are Mountains.',
        }),
      ).modeled,
    ).toBe(true);

    const ctx = ctx4();
    // A nonbasic land that taps for U, plus a basic Forest.
    const tower = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Tower',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: '{T}: Add {U}.',
      }),
    );
    spawn(ctx, 'P1', forest());

    // Before Blood Moon: the tower taps for U, the Forest for G.
    let units = manaSourcesFor(ctx, 'P1').map((s) => s.units.flat().join(''));
    expect(units.sort()).toEqual(['G', 'U']);

    // Blood Moon in play: the nonbasic tower becomes a Mountain (taps for R, loses U); the
    // BASIC Forest is untouched.
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Blood Moon',
        typeLine: 'Enchantment',
        manaCost: '{2}{R}',
        power: null,
        toughness: null,
        oracleText: 'Nonbasic lands are Mountains.',
      }),
    );
    units = manaSourcesFor(ctx, 'P1').map((s) => s.units.flat().join(''));
    expect(units.sort()).toEqual(['G', 'R']);
    // The tower is still a land, not a creature.
    expect(isCreaturePermanent(ctx, tower)).toBe(false);
  });
});

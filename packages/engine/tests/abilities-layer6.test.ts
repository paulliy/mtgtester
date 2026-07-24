/**
 * Layer 6 covers *abilities*, not just keywords (ADR 0007). A permanent's triggered and mana
 * abilities are computed characteristics, so removing its abilities removes them — and the
 * removal follows CR 613 ordering, not the printed card.
 */

import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../src/cards/definition';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { queueTriggers } from '../src/state/objects';
import { manaSourcesFor, triggersOf } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, registerCustomDef, spawn } from './fixtures';

function ctx4(): GameContext {
  const c = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(2, forest) })),
      { seed: 'layer6' },
    ),
  );
  c.state.currentTurnPlayer = 'P1';
  c.state.turnNumber = 3;
  return c;
}

/** A permanent whose static ability strips every other permanent's abilities (Humility-ish). */
function humilityDef(oracleId: string): CardDefinition {
  return {
    oracleId,
    name: 'Test Humility',
    typeLine: 'Enchantment',
    supertypes: [],
    types: ['Enchantment'],
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
    staticEffects: [{ affects: { kind: 'others' }, op: { layer: 6, loseAllAbilities: true } }],
    modeled: true,
    unmodeledReasons: [],
  };
}

const sage = (): ReturnType<typeof oracle> =>
  oracle({
    name: 'Test Sage',
    typeLine: 'Creature — Test Wizard',
    manaCost: '{1}{G}',
    power: '1',
    toughness: '1',
    oracleText: 'When Test Sage enters the battlefield, draw a card.',
  });

describe('layer 6 removes abilities, not just keywords (ADR 0007)', () => {
  it('a triggered ability is a computed characteristic, so losing abilities removes it', () => {
    const ctx = ctx4();
    const perm = spawn(ctx, 'P1', sage());
    expect(triggersOf(ctx, perm)).toHaveLength(1);

    registerCustomDef(ctx, humilityDef('humility'));
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Humility',
        oracleId: 'humility',
        typeLine: 'Enchantment',
        manaCost: '{2}{W}',
        power: null,
        toughness: null,
      }),
    );

    expect(triggersOf(ctx, perm)).toHaveLength(0);
    // And the queue honors that — the ETB trigger does not go on the stack.
    queueTriggers(ctx, perm, 'etbSelf');
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('mana abilities are computed too — losing abilities stops mana production', () => {
    const ctx = ctx4();
    spawn(ctx, 'P1', forest());
    expect(manaSourcesFor(ctx, 'P1').map((s) => s.units.flat().join(''))).toEqual(['G']);

    registerCustomDef(ctx, humilityDef('humility'));
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Humility',
        oracleId: 'humility',
        typeLine: 'Enchantment',
        manaCost: '{2}{W}',
        power: null,
        toughness: null,
      }),
    );

    expect(manaSourcesFor(ctx, 'P1')).toEqual([]);
  });

  it("Blood Moon removes a nonbasic land's triggered ability (CR 305.7)", () => {
    const ctx = ctx4();
    const shrine = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Test Shrine',
        typeLine: 'Land',
        manaCost: null,
        power: null,
        toughness: null,
        oracleText: 'At the beginning of your upkeep, you gain 1 life.\n{T}: Add {U}.',
      }),
    );
    expect(triggersOf(ctx, shrine)).toHaveLength(1);

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

    // A Mountain has no upkeep trigger and taps for R, not U.
    const chars = computeCharacteristics(ctx, shrine);
    expect(chars.triggers).toHaveLength(0);
    expect(chars.manaAbilities.map((a) => a.units.flat().join(''))).toEqual(['R']);
  });
});

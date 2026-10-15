/**
 * `TargetSpec.perPlayer`: "for each player, up to one target creature that player controls"
 * (Nils, Discipline Enforcer). The expansion into one slot per player and its resolution are
 * exercised through the card in pr07-card-coverage.test.ts; this pins the authoring contract and
 * the expansion helper on their own.
 */
import { describe, expect, it } from 'vitest';
import type { Ability, TargetSpec } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { CardDefinition } from '../src/cards/definition';
import { onEndStep, triggered } from '../src/cards/templates';
import { createGame } from '../src/state/game';
import { expandPerPlayerTargets, playersInTurnOrderFrom } from '../src/targets/per-player';
import { copies, forest, gameConfig } from './fixtures';

const perPlayer: TargetSpec = { kind: 'creature', count: { min: 0, max: 1 }, perPlayer: true };

function definition(targets: TargetSpec[]): CardDefinition {
  const trigger = triggered(onEndStep('you'), {
    targets,
    effects: [{ op: 'putCountersEachChosen', targetSlot: 0, counter: '+1/+1', count: 1 }],
    description: 'for each player',
  });
  return {
    oracleId: 'per-player-probe',
    name: 'Per-player probe',
    typeLine: 'Enchantment',
    supertypes: [],
    types: ['Enchantment'],
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
    triggers: [trigger],
    staticEffects: [],
    ruleStatics: [],
    modeled: true,
    unmodeledReasons: [],
  };
}

const paths = (targets: TargetSpec[]) =>
  validateCardDefinition(definition(targets)).map((issue) => issue.path);

describe('per-player target slots', () => {
  it('accepts an optional per-player creature slot as the last target', () => {
    expect(validateCardDefinition(definition([perPlayer]))).toEqual([]);
  });

  it('rejects a per-player slot that is not optional, not last, owns a controller, or is hand-expanded', () => {
    expect(paths([{ ...perPlayer, count: { min: 1, max: 1 } }])).toContain(
      'definition.triggers[0].targets[0].perPlayer',
    );
    expect(paths([{ ...perPlayer, count: { min: 0, max: 2 } }]).length).toBeGreaterThan(0);
    expect(paths([{ ...perPlayer, controller: 'opponent' }]).length).toBeGreaterThan(0);
    expect(paths([perPlayer, { kind: 'creature' }]).length).toBeGreaterThan(0);
    expect(paths([{ kind: 'creature', controllerPlayer: 'P2' }]).length).toBeGreaterThan(0);
    expect(paths([{ kind: 'creature', slotGroup: 0 }]).length).toBeGreaterThan(0);
  });

  it('expands into one 0-to-1 slot for each player still in the game, in turn order from the controller', () => {
    const ctx = createGame(
      gameConfig(
        Array.from({ length: 4 }, () => ({ cards: copies(3, forest) })),
        { seed: 'per-player-expansion' },
      ),
    );
    const ability = definition([perPlayer]).triggers[0] as Ability;
    const expanded = expandPerPlayerTargets(ctx, ability, 'P3');
    expect(expanded.targets.map((spec) => spec.controllerPlayer)).toEqual(['P3', 'P4', 'P1', 'P2']);
    expect(
      expanded.targets.every((spec) => spec.slotGroup === 0 && spec.perPlayer === undefined),
    ).toBe(true);
    expect(expanded.targets.every((spec) => spec.count?.min === 0 && spec.count.max === 1)).toBe(
      true,
    );
    // A player who has left the game gets no slot.
    ctx.state.players.find((player) => player.id === 'P4')!.hasLost = true;
    expect(playersInTurnOrderFrom(ctx, 'P3')).toEqual(['P3', 'P1', 'P2']);
    // An ability with no per-player spec is returned as it is.
    const plain = definition([{ kind: 'creature' }]).triggers[0] as Ability;
    expect(expandPerPlayerTargets(ctx, plain, 'P1')).toBe(plain);
  });
});

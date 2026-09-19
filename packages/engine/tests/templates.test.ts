/**
 * The card-template builders (`cards/templates.ts`) and the token catalog (`cards/tokens.ts`).
 *
 * These are the tested surface that per-card overrides are built from. That is the point of the
 * layer: an override that composes `triggered(onEtb(), …)` inherits this file's guarantees about
 * trigger shape and slot indexing, instead of restating them as a hand-typed literal that no test
 * ever looks at.
 *
 * Two properties matter more than they look:
 *
 * - **No key is emitted that the caller did not ask for.** `applyOverride` merges with a shallow
 *   spread, where a key present with value `undefined` still overwrites the interpreted value
 *   while an absent key preserves it. A builder that always wrote `optional: undefined` would
 *   silently clear a parser-derived `optional` on every card it touched.
 * - **Count slots come last.** A wrong slot index does not throw — `resolve.ts` skips the effect
 *   and the card quietly does nothing — so the ordering invariant has to be pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  activated,
  ATTACHED,
  auraBuff,
  costReductionFor,
  loyaltyAbility,
  mana,
  manaCost,
  onCast,
  onEtb,
  onUpkeep,
  spell,
  TAP,
  targetSlots,
  triggered,
  whenEnters,
} from '../src/cards/templates';
import { creatureToken, artifactToken, SOLDIER_1_1_LIFELINK, TREASURE } from '../src/cards/tokens';
import { ofSubtype, ofType, YOURS, allOf } from '../src/cards/selector';
import { constant } from '../src/cards/value';

describe('ability builders', () => {
  it('emits a spell ability with an empty target list rather than omitting the field', () => {
    // `Ability.targets` is required, and the executor indexes it directly.
    expect(spell({ effects: [{ op: 'draw', count: constant(1) }] })).toEqual({
      kind: 'spell',
      targets: [],
      effects: [{ op: 'draw', count: constant(1) }],
    });
  });

  it('does not emit optional/description keys that were not passed', () => {
    const ability = spell({ effects: [{ op: 'shuffle' }] });
    expect(Object.keys(ability).sort()).toEqual(['effects', 'kind', 'targets']);
    expect('optional' in ability).toBe(false);
    expect('description' in ability).toBe(false);
  });

  it('builds an ETB trigger with the self subject', () => {
    const ability = triggered(onEtb(), {
      effects: [{ op: 'gainLife', amount: constant(2) }],
      description: 'Enters — gain 2 life',
    });
    expect(ability.kind).toBe('triggered');
    expect(ability.trigger).toEqual({ when: 'enters', subject: { kind: 'self' } });
    expect(ability.description).toBe('Enters — gain 2 life');
  });

  it('folds an intervening-if condition into the trigger, not the ability', () => {
    // CR 603.4: the condition belongs to the trigger and is checked twice — at trigger time and
    // again on resolution. Hanging it off the ability instead would skip the second check.
    const condition = {
      kind: 'countPermanents',
      selector: ofType('Creature'),
      scope: 'you',
      cmp: '>=',
      n: 1,
    } as const;
    const ability = triggered(onUpkeep(), { effects: [{ op: 'shuffle' }], condition });
    expect(ability.trigger).toEqual({ when: 'upkeep', player: 'you', condition });
    expect('condition' in ability).toBe(false);
  });

  it('watches other permanents via a permanent subject, and carries aggregate', () => {
    const head = whenEnters(allOf(ofSubtype('Dragon'), YOURS), { aggregate: 'byEventPlayer' });
    expect(head).toEqual({
      when: 'enters',
      subject: { kind: 'permanent', selector: allOf(ofSubtype('Dragon'), YOURS) },
      aggregate: 'byEventPlayer',
    });
  });

  it('omits aggregate entirely when not requested', () => {
    expect('aggregate' in whenEnters(ofType('Creature'))).toBe(false);
  });

  it('builds cast triggers with and without a filter', () => {
    expect(onCast('you')).toEqual({ when: 'castsSpell', caster: 'you' });
    expect(onCast('opponent', ofType('Instant'))).toEqual({
      when: 'castsSpell',
      caster: 'opponent',
      filter: ofType('Instant'),
    });
  });

  it('wraps an activated ability with its costs and defaults timing to any', () => {
    const ability = activated({
      costs: [TAP, mana('{2}{R}')],
      effects: [{ op: 'dealDamage', target: 0, amount: constant(2) }],
      targets: [{ kind: 'anyTarget' }],
    });
    expect(ability.timing).toBe('any');
    expect(ability.costs[0]).toEqual({ kind: 'tap' });
    expect(ability.ability.kind).toBe('activated');
    expect(ability.ability.targets).toEqual([{ kind: 'anyTarget' }]);
    expect('oncePerTurn' in ability).toBe(false);
  });

  it('builds a loyalty ability at sorcery speed', () => {
    const ability = loyaltyAbility(-3, {
      effects: [{ op: 'destroy', target: 0 }],
      targets: [{ kind: 'creature' }],
    });
    expect(ability.costs).toEqual([{ kind: 'loyalty', delta: -3 }]);
    expect(ability.timing).toBe('sorcery');
  });
});

describe('mana cost helpers', () => {
  it('parses a cost into an AbilityCost component', () => {
    expect(mana('{4}{R}')).toEqual({ kind: 'mana', cost: manaCost('{4}{R}') });
  });

  it('throws on an unparseable cost rather than silently producing a null cost', () => {
    // The old `parseManaCost(s).cost!` spelling turned an unsupported symbol into `null`, which
    // the payment solver accepts as "free".
    expect(() => mana('{S}')).toThrow(/unparseable mana cost/);
  });
});

describe('targetSlots', () => {
  it('allocates ordinary slots before variable-count slots', () => {
    // `targets` must stay dense over exactly the ordinary slots, so a count slot declared first
    // still lands last — otherwise every EffectRef after it points at the wrong object.
    const { targets, slot } = targetSlots({
      cards: { kind: 'cardInGraveyard', count: { min: 0, max: Infinity } },
      player: { kind: 'player' },
    });
    expect(slot.player).toBe(0);
    expect(slot.cards).toBe(1);
    expect(targets[0]).toEqual({ kind: 'player' });
  });

  it('preserves declaration order among ordinary slots', () => {
    const { slot } = targetSlots({
      creature: { kind: 'creature' },
      artifact: { kind: 'artifact' },
    });
    expect([slot.creature, slot.artifact]).toEqual([0, 1]);
  });
});

describe('static-ability helpers', () => {
  it('builds a lord as a layer 7d modification', () => {
    expect(auraBuff(2, 2)).toEqual([
      { affects: ATTACHED, op: { layer: 7, sublayer: 'd', power: 2, toughness: 2 } },
    ]);
  });

  it('appends one layer 6 static per granted keyword', () => {
    const statics = auraBuff(1, 1, ['flying', 'lifelink']);
    expect(statics).toHaveLength(3);
    expect(statics[1]).toEqual({ affects: ATTACHED, op: { layer: 6, addKeyword: 'flying' } });
    expect(statics[2]).toEqual({ affects: ATTACHED, op: { layer: 6, addKeyword: 'lifelink' } });
  });

  it('builds cost reduction as a rule static with a constant amount', () => {
    expect(costReductionFor(ofType('Artifact'), 1)).toEqual({
      kind: 'costReduction',
      amount: constant(1),
      filter: ofType('Artifact'),
    });
  });
});

describe('token catalog', () => {
  it('derives typeLine from the types and subtypes so they cannot disagree', () => {
    const token = creatureToken({
      name: 'Zombie',
      subtypes: ['Zombie'],
      colors: ['B'],
      power: 2,
      toughness: 2,
    });
    expect(token.typeLine).toBe('Creature — Zombie');
    expect(token.types).toEqual(['Creature']);
    expect(token.subtypes).toEqual(['Zombie']);
  });

  it('puts Artifact ahead of Creature for artifact creature tokens', () => {
    const token = creatureToken({
      name: 'Thopter',
      subtypes: ['Thopter'],
      colors: ['U'],
      power: 1,
      toughness: 1,
      artifact: true,
    });
    expect(token.typeLine).toBe('Artifact Creature — Thopter');
    expect(token.types).toEqual(['Artifact', 'Creature']);
  });

  it('omits keywords entirely when a token has none', () => {
    expect(
      'keywords' in
        creatureToken({ name: 'Bear', subtypes: ['Bear'], colors: ['G'], power: 2, toughness: 2 }),
    ).toBe(false);
  });

  it('gives noncreature artifact tokens null power and toughness', () => {
    const clue = artifactToken({ name: 'Clue', subtypes: ['Clue'] });
    expect(clue.power).toBeNull();
    expect(clue.toughness).toBeNull();
  });

  it('gives Treasure both a tap and a sacrifice cost', () => {
    // Three different Treasures existed across override files before the catalog: one correct,
    // one missing the {T}, and one with no costs at all — a free repeatable any-color source.
    expect(TREASURE.manaAbilities?.[0]?.costs).toEqual([
      { kind: 'tap' },
      { kind: 'sacrificeSelf' },
    ]);
  });

  it('makes the lifelink Soldier white, matching the cards that print it', () => {
    expect(SOLDIER_1_1_LIFELINK.colors).toEqual(['W']);
    expect(SOLDIER_1_1_LIFELINK.keywords).toEqual(['lifelink']);
  });
});

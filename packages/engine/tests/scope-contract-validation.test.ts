// ADR 0034 decision 2: a `Value` that reads the resolution scope (the damage that fired a trigger,
// the energy just paid, the mana spent on this spell) validates only where the ability's trigger
// head, cast path or cost fills that field.
import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { TRIGGER_SCOPE_FIELDS, VALUE_SCOPE_NEEDS } from '../src/cards/scope-contracts';
import { oracle } from './fixtures';

const creature = (oracleText: string): CardDefinition =>
  interpretCard(oracle({ name: 'Scope Probe', oracleText, power: '1', toughness: '1' }));

function withTriggerEffects(definition: CardDefinition, effects: Effect[]): CardDefinition {
  const [trigger] = definition.triggers;
  if (trigger === undefined) throw new Error('probe has no trigger');
  return { ...definition, triggers: [{ ...trigger, effects }] };
}

const scopeIssues = (definition: CardDefinition) =>
  validateCardDefinition(definition).filter((issue) => issue.message.includes('does not provide'));

describe('scope contracts (ADR 0034 decision 2)', () => {
  it('accepts "that many" on a combat damage trigger', () => {
    const definition = creature(
      'Whenever this creature deals combat damage to a player, draw that many cards.',
    );

    expect(definition.modeled).toBe(true);
    expect(definition.triggers[0]?.effects).toEqual([
      { op: 'draw', count: { kind: 'damageDealt' } },
    ]);
    expect(validateCardDefinition(definition)).toEqual([]);
  });

  it('rejects damage dealt read by an enters trigger, which no damage fired', () => {
    const definition = withTriggerEffects(creature('When this creature enters, draw a card.'), [
      { op: 'draw', count: { kind: 'damageDealt' } },
    ]);

    expect(scopeIssues(definition)).toEqual([
      {
        path: 'definition.triggers[0].effects[0].count',
        message:
          "damageDealt reads damageDealt, which this ability's trigger, cast or cost does not provide",
      },
    ]);
  });

  it('rejects energy paid read before any energy payment', () => {
    const definition = withTriggerEffects(creature('When this creature enters, draw a card.'), [
      { op: 'draw', count: { kind: 'energyPaid' } },
    ]);

    expect(scopeIssues(definition).map((issue) => issue.path)).toEqual([
      'definition.triggers[0].effects[0].count',
    ]);
  });

  it('accepts energy paid inside, and after, an energy payment', () => {
    const definition = withTriggerEffects(creature('When this creature enters, draw a card.'), [
      {
        op: 'mayPayEnergyUpTo',
        then: [{ op: 'draw', count: { kind: 'energyPaid' } }],
      },
      { op: 'draw', count: { kind: 'energyPaid' } },
    ] as Effect[]);

    expect(scopeIssues(definition)).toEqual([]);
  });

  it("accepts a spell reading the mana spent to cast it, and rejects a trigger's", () => {
    const spell = interpretCard(
      oracle({ name: 'Spell Probe', typeLine: 'Sorcery', oracleText: 'Draw a card.' }),
    );
    if (spell.spellAbility === null) throw new Error('probe has no spell ability');
    const drawSpent: Effect = { op: 'draw', count: { kind: 'manaSpent' } };

    expect(
      scopeIssues({ ...spell, spellAbility: { ...spell.spellAbility, effects: [drawSpent] } }),
    ).toEqual([]);
    expect(
      scopeIssues(
        withTriggerEffects(creature('When this creature enters, draw a card.'), [drawSpent]),
      ).length,
    ).toBe(1);
  });

  it('accepts a trigger count only on an aggregate or attack-declaration head', () => {
    const base = creature('When this creature enters, draw a card.');
    const [trigger] = base.triggers;
    if (trigger === undefined || trigger.trigger === undefined) throw new Error('no trigger');
    const counted = (head: object): CardDefinition => ({
      ...base,
      triggers: [
        {
          ...trigger,
          trigger: { ...trigger.trigger, ...head } as typeof trigger.trigger,
          effects: [{ op: 'draw', count: { kind: 'triggerCount' } }],
        },
      ],
    });

    expect(scopeIssues(counted({}))).toHaveLength(1);
    expect(scopeIssues(counted({ aggregate: true }))).toEqual([]);
  });

  it('declares a provider for every field some value kind needs', () => {
    const provided = new Set([
      ...Object.values(TRIGGER_SCOPE_FIELDS).flat(),
      'triggerCount',
      'manaSpent',
      'treasureManaSpent',
      'energyPaid',
      'stationPower',
    ]);
    const needed = Object.values(VALUE_SCOPE_NEEDS).filter((field) => field !== null);

    expect(needed.filter((field) => !provided.has(field))).toEqual([]);
  });
});

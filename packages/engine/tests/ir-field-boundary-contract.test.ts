import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../src/cards/definition';
import type { CardOverride } from '../src/cards/overrides';
import {
  assertValidModeledDefinition,
  enforceCardDefinition,
  validateOverrideDefinition,
} from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { bear } from './fixtures';

const patches = [
  { name: 'root', patch: { onResolve: true } },
  {
    name: 'ability',
    patch: { spellAbility: { kind: 'spell', targets: [], effects: [], inventedTiming: true } },
  },
  {
    name: 'effect',
    patch: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 }, drawCards: 1 }],
      },
    },
  },
  {
    name: 'target',
    patch: {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature', ignoreProtection: true }],
        effects: [{ op: 'destroy', target: 0 }],
      },
    },
  },
  {
    name: 'selector',
    patch: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          {
            op: 'destroyEach',
            selector: { kind: 'type', value: 'Creature', ignoreHexproof: true },
          },
        ],
      },
    },
  },
  {
    name: 'value',
    patch: {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1, multiplier: 2 } }],
      },
    },
  },
  {
    name: 'condition',
    patch: {
      manaAbilities: [{ units: [['G']], condition: { kind: 'yourTurn', opponentInstead: true } }],
    },
  },
  {
    name: 'mana ability',
    patch: {
      manaAbilities: [{ units: [['G']], onActivation: [{ op: 'damageController', amount: 1 }] }],
    },
  },
  {
    name: 'cost',
    patch: { manaAbilities: [{ units: [['G']], costs: [{ kind: 'tap', optional: true }] }] },
  },
  {
    name: 'alternative cost',
    patch: {
      alternativeCasts: [{ kind: 'nonMana', description: 'Test', costs: [], drawInstead: true }],
    },
  },
  {
    name: 'rule static',
    patch: { ruleStatics: [{ kind: 'targetLifeTax', amount: 1, opponentOnly: true }] },
  },
  {
    name: 'continuous operation',
    patch: {
      staticEffects: [
        { affects: { kind: 'self' }, op: { layer: 6, addKeyword: 'flying', stacking: 'twice' } },
      ],
    },
  },
];

describe('exhaustive executable IR field boundary', () => {
  it.each(patches)(
    'rejects unknown $name fields in the final definition and authored patch',
    ({ patch }) => {
      const base = interpretCard(bear());
      const definition = { ...base, ...patch } as unknown as CardDefinition;
      const contained = enforceCardDefinition(definition);
      expect(contained.modeled).toBe(false);
      expect(
        contained.unmodeledReasons.some((reason) => reason.includes('unclassified field')),
      ).toBe(true);
      expect(() => assertValidModeledDefinition(definition)).toThrow('unclassified field');
      const override = {
        oracleId: base.oracleId,
        name: base.name,
        handledLines: [],
        def: patch,
      } as unknown as CardOverride;
      expect(
        validateOverrideDefinition(override).some((issue) =>
          issue.message.includes('unclassified field'),
        ),
      ).toBe(true);
    },
  );

  it('accepts ordinary complete definitions and faithful partial patches', () => {
    const definition = interpretCard(bear());
    expect(enforceCardDefinition(definition)).toBe(definition);
    expect(assertValidModeledDefinition(definition)).toBe(definition);
    expect(
      validateOverrideDefinition({
        oracleId: definition.oracleId,
        name: definition.name,
        handledLines: [],
        def: { keywords: ['flying'] },
      }),
    ).toEqual([]);
  });
});

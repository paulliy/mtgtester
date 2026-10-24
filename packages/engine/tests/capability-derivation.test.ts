import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { CardDefinition } from '../src/cards/definition';
import type { Effect, TokenSpec } from '../src/cards/ability';
import { deriveCardCapabilities, indexCardCapabilities } from '../src/cards/capabilities';
import { interpretCard } from '../src/cards/interpret';
import { manaCost, spell } from '../src/cards/templates';
import { oracle } from './fixtures';

function definition(changes: Partial<CardDefinition> = {}): CardDefinition {
  return {
    ...interpretCard(
      oracle({
        name: 'Capability probe',
        typeLine: 'Sorcery',
        manaCost: '{0}',
        oracleText: 'You gain 1 life.',
      }),
    ),
    ...changes,
  };
}

describe('final IR capability derivation', () => {
  it('reports the exact independent dependency set for a simple spell', () => {
    expect(deriveCardCapabilities(definition())).toEqual([
      'Ability.effects',
      'Ability.spell',
      'CardDefinition',
      'CardDefinition.manaCost',
      'CardDefinition.spellAbility',
      'Effect.gainLife',
      'ParsedManaCost',
      'Value.const',
    ]);
  });

  it('traverses nested modal conditions, cost choices, targets, and alternate faces', () => {
    const dependencies = deriveCardCapabilities(
      definition({
        alternativeCasts: [
          {
            kind: 'omen',
            manaCost: manaCost('{1}'),
            description: 'Probe face',
            typeLine: 'Instant — Omen',
            costs: [{ kind: 'exileCardFromHand', selector: { kind: 'color', value: 'U' } }],
            ability: spell({
              targets: [
                {
                  kind: 'cardInGraveyard',
                  graveyardOwnerScope: 'opponent',
                  filter: { kind: 'type', value: 'Creature' },
                },
              ],
              effects: [],
              modes: {
                minChoices: 1,
                maxChoices: 1,
                maxChoicesIf: {
                  maxChoices: 2,
                  condition: {
                    kind: 'countPermanents',
                    selector: { kind: 'powerAtLeast', n: 4 },
                    scope: 'you',
                    cmp: '>=',
                    n: 1,
                  },
                },
                options: [
                  {
                    targetSlots: [0],
                    effects: [{ op: 'graveyardToHand', target: 0 }],
                    additionalCost: [{ kind: 'payLifeValue', amount: { kind: 'countOpponents' } }],
                  },
                ],
              },
            }),
          },
        ],
      }),
    );
    expect(dependencies).toEqual(
      expect.arrayContaining([
        'AlternativeCast.omen',
        'AbilityCost.exileCardFromHand',
        'Selector.color',
        'TargetSpec.cardInGraveyard',
        'Selector.type',
        'Condition.countPermanents',
        'Effect.graveyardToHand',
        'AbilityCost.payLifeValue',
        'Value.countOpponents',
      ]),
    );
  });

  it('includes transitive token abilities, mana default costs, riders and spend triggers', () => {
    const token: TokenSpec = {
      name: 'Capability token',
      typeLine: 'Artifact Creature — Construct',
      types: ['Artifact', 'Creature'],
      subtypes: ['Construct'],
      colors: [],
      power: 1,
      toughness: 1,
      keywords: ['flying'],
      manaAbilities: [
        {
          units: [['G']],
          onActivate: [{ op: 'damageController', amount: 1 }],
          spendTrigger: {
            when: { purposes: ['castSpell'], description: 'Probe spend' },
            ability: spell({ effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }] }),
          },
        },
      ],
    };
    const def = definition({
      spellAbility: spell({
        effects: [
          { op: 'createToken', spec: token, count: { kind: 'const', n: 1 } },
          { op: 'createToken', spec: token, count: { kind: 'const', n: 1 } },
        ],
      }),
    });
    const dependencies = deriveCardCapabilities(def);
    expect(dependencies).toEqual(
      expect.arrayContaining([
        'TokenSpec',
        'Keyword.flying',
        'ManaAbilitySpec',
        'AbilityCost.tap',
        'Effect.damageController',
        'ManaSpendTrigger',
        'ManaRestriction',
        'Effect.draw',
      ]),
    );
    expect(dependencies.filter((capability) => capability === 'TokenSpec')).toHaveLength(1);
  });

  it('distinguishes implicit tap costs from an explicitly costless mana activation', () => {
    const implicit = deriveCardCapabilities(definition({ manaAbilities: [{ units: [['G']] }] }));
    const free = deriveCardCapabilities(
      definition({ manaAbilities: [{ units: [['G']], costs: [] }] }),
    );
    expect(implicit).toContain('AbilityCost.tap');
    expect(free).not.toContain('AbilityCost.tap');
  });

  it.each([
    [
      'unknown discriminator',
      () =>
        definition({
          spellAbility: spell({ effects: [{ op: 'futureEffect' } as unknown as Effect] }),
        }),
    ],
    [
      'unclassified field',
      () => ({ ...definition(), futureRules: { effects: [] } }) as CardDefinition,
    ],
  ] as const)('fails closed for %s', (_reason, build) => {
    expect(() => deriveCardCapabilities(build())).toThrow(/Capability IR/);
  });

  it('rejects recursive graphs without confusing shared token objects with cycles', () => {
    const recursive: Extract<Effect, { op: 'conditionalEffect' }> = {
      op: 'conditionalEffect',
      condition: { kind: 'opponentCount', cmp: '>=', n: 0 },
      then: [],
      else: [],
    };
    recursive.then.push(recursive);
    expect(() =>
      deriveCardCapabilities(definition({ spellAbility: spell({ effects: [recursive] }) })),
    ).toThrow(/cyclic/);
  });

  it('visits final interpreted production definitions in the pinned 93-card inventory', () => {
    const cards = JSON.parse(
      readFileSync(new URL('./fixtures/urdragon-oracle.json', import.meta.url), 'utf8'),
    ) as OracleCard[];
    const modeled = cards.map(interpretCard).filter((def) => def.modeled);
    expect(modeled).toHaveLength(90);
    for (const def of modeled) expect(() => deriveCardCapabilities(def), def.name).not.toThrow();
  });

  it('requires an explicit canonical identity and deduplicates equivalent fixture aliases', () => {
    const first = definition();
    const second = { ...first, oracleId: 'fixture-alias', scryfallId: 'fixture-printing' };
    const index = indexCardCapabilities([
      { canonicalOracleId: 'canonical-probe', definition: first },
      { canonicalOracleId: 'canonical-probe', definition: second },
    ]);
    expect(Object.keys(index.cards)).toEqual(['canonical-probe']);
    expect(index.capabilities['Effect.gainLife']).toEqual(['canonical-probe']);
    expect(() => indexCardCapabilities([{ canonicalOracleId: '', definition: first }])).toThrow(
      /canonical/,
    );
  });

  it('rejects conflicting aliases even when both use the same primitive names', () => {
    const first = definition();
    const second = definition({
      spellAbility: spell({ effects: [{ op: 'gainLife', amount: { kind: 'const', n: 2 } }] }),
    });
    expect(() =>
      indexCardCapabilities([
        { canonicalOracleId: 'canonical-probe', definition: first },
        { canonicalOracleId: 'canonical-probe', definition: second },
      ]),
    ).toThrow(/conflicting aliases/);
  });

  it('produces deterministic impact maps independently of consumer order', () => {
    const consumers = [
      { canonicalOracleId: 'second', definition: definition() },
      {
        canonicalOracleId: 'first',
        definition: definition({
          spellAbility: spell({ effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }] }),
        }),
      },
    ];
    expect(indexCardCapabilities(consumers)).toEqual(
      indexCardCapabilities([...consumers].reverse()),
    );
    expect(indexCardCapabilities(consumers).capabilities['Value.const']).toEqual([
      'first',
      'second',
    ]);
  });
});

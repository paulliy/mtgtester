/** The IR mutation operator table (ADR 0034 decision 5) and the definition-transform hook. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../../src/cards/definition';
import { interpretCard } from '../../src/cards/interpret';
import { createGame } from '../../src/state/game';
import { installDefinitionTransform } from '../../src/testing/definition-transform';
import { copies, forest, gameConfig, oracle } from '../fixtures';
import { pinStore } from '../scenario/pin-store';
import { cardMutants, mutate, unmutatedParts } from './operators';

const gain = (n: number) => ({ op: 'gainLife', amount: { kind: 'const', n } });

/** One of each shape in the table, as plain IR: the operators read structure, not types. */
const probe = {
  ...interpretCard(oracle({ name: 'Mutation probe', typeLine: 'Creature', manaCost: '{1}' })),
  keywords: ['flying'],
  entersTapped: true,
  entersWithCounters: { '+1/+1': 2 },
  entersUnlessDiscard: { filter: { kind: 'type', value: 'Land' } },
  optionalAdditionalCost: { mechanic: 'kicker', cost: {}, repeatable: true },
  staticEffects: [{ kind: 'anthem' }],
  manaAbilities: [{ units: [] }],
  activatedAbilities: [
    {
      costs: [{ kind: 'mana' }, { kind: 'tap' }],
      ability: { kind: 'activated', targets: [], effects: [gain(0)] },
      timing: 'any',
    },
  ],
  triggers: [
    {
      kind: 'triggered',
      trigger: {
        when: 'enters',
        subject: {
          kind: 'permanent',
          selector: { kind: 'allOf', of: [{ kind: 'type', value: 'Creature' }, { kind: 'other' }] },
        },
        condition: { kind: 'yourTurn' },
      },
      targets: [{ kind: 'creature', controller: 'opponent' }, { kind: 'player' }],
      effects: [gain(1), { op: 'draw' }],
    },
  ],
  spellAbility: {
    kind: 'spell',
    targets: [],
    effects: [],
    modes: { minChoices: 1, maxChoices: 2, options: [{ effects: [] }, { effects: [] }] },
  },
} as unknown as CardDefinition;

describe('IR mutation operators', () => {
  it('lists one mutant per change the table makes, in a fixed order', () => {
    expect(cardMutants(probe).map((mutant) => `${mutant.part} | ${mutant.label}`)).toEqual([
      'keywords | (card): drop keyword flying',
      'staticEffects[0] | (card): drop staticEffects[0]',
      'manaAbilities[0] | (card): drop manaAbilities[0]',
      'entersTapped | (card): flip entersTapped to false',
      'entersWithCounters | (card): remove entersWithCounters',
      'optionalAdditionalCost | (card): remove optionalAdditionalCost',
      'optionalAdditionalCost | (card): drop optionalAdditionalCost repeatable',
      'entersUnlessDiscard | (card): remove entersUnlessDiscard',
      'activatedAbilities[0] | (card): drop activatedAbilities[0] cost 1 (tap)',
      'activatedAbilities[0] | activatedAbilities[0].ability: drop effect 0',
      'activatedAbilities[0] | activatedAbilities[0].ability.effects[0].amount: const 0 + 1',
      'spellAbility | spellAbility: drop mode 0',
      'spellAbility | spellAbility: drop mode 1',
      'triggers[0] | triggers[0]: drop effect 0',
      'triggers[0] | triggers[0]: drop effect 1',
      'triggers[0] | triggers[0]: widen target 0 to its kind (drop controller)',
      'triggers[0] | triggers[0]: flip optional to true',
      'triggers[0] | triggers[0]: drop trigger condition',
      'triggers[0] | triggers[0]: widen trigger subject (drop condition 0)',
      'triggers[0] | triggers[0]: widen trigger subject (drop condition 1)',
      'triggers[0] | triggers[0].effects[0].amount: const 1 + 1',
      'triggers[0] | triggers[0].effects[0].amount: const 1 - 1',
    ]);
    expect(unmutatedParts(probe)).toEqual([]);
  });

  it('applies one mutant to a copy, leaving the definition as it was', () => {
    const before = JSON.stringify(probe);
    const labels = cardMutants(probe).map((mutant) => mutant.label);
    const at = (label: string) => mutate(probe, labels.indexOf(label));

    expect(at('(card): drop keyword flying').keywords).toEqual([]);
    expect(at('(card): flip entersTapped to false').entersTapped).toBe(false);
    expect(at('(card): remove entersWithCounters')).not.toHaveProperty('entersWithCounters');
    expect(at('(card): remove entersUnlessDiscard')).not.toHaveProperty('entersUnlessDiscard');
    expect(at('(card): remove optionalAdditionalCost')).not.toHaveProperty(
      'optionalAdditionalCost',
    );
    expect(
      at('(card): drop optionalAdditionalCost repeatable').optionalAdditionalCost,
    ).not.toHaveProperty('repeatable');
    expect(
      at('(card): drop activatedAbilities[0] cost 1 (tap)').activatedAbilities[0]!.costs,
    ).toEqual([{ kind: 'mana' }]);
    const trigger = (label: string) => at(label).triggers[0]!;
    expect(trigger('triggers[0]: drop effect 0').effects).toEqual([{ op: 'draw' }]);
    expect(trigger('triggers[0]: widen target 0 to its kind (drop controller)').targets).toEqual([
      { kind: 'creature' },
      { kind: 'player' },
    ]);
    expect(trigger('triggers[0]: flip optional to true').optional).toBe(true);
    expect(trigger('triggers[0]: drop trigger condition').trigger).not.toHaveProperty('condition');
    expect(trigger('triggers[0]: widen trigger subject (drop condition 0)').trigger).toMatchObject({
      subject: { selector: { kind: 'allOf', of: [{ kind: 'other' }] } },
    });
    expect(trigger('triggers[0].effects[0].amount: const 1 - 1').effects[0]).toEqual(gain(0));
    expect(at('spellAbility: drop mode 0').spellAbility!.modes).toMatchObject({
      minChoices: 1,
      maxChoices: 1,
      options: [{ effects: [] }],
    });
    expect(JSON.stringify(probe)).toBe(before);
    expect(() => mutate(probe, labels.length)).toThrow(/no mutant/);
  });

  it('gives every top-level part of every reviewed card at least one mutant', () => {
    const manifest = JSON.parse(
      readFileSync('packages/server/fixtures/card-verification-manifest.json', 'utf8'),
    ) as { cards: Record<string, { name: string; implementationStatus: string }> };
    const reviewed = Object.values(manifest.cards).filter(
      (card) => card.implementationStatus === 'implemented-reviewed',
    );
    expect(reviewed.length).toBeGreaterThan(100);
    const unmutated = reviewed.flatMap((card) =>
      unmutatedParts(interpretCard(pinStore.get(card.name))).map((part) => `${card.name}: ${part}`),
    );
    expect(unmutated).toEqual([]);
  });
});

describe('the definition-transform hook', () => {
  it('applies once to interpretCard and to createGame custom definitions, and uninstalls', () => {
    const seen: string[] = [];
    const previous = installDefinitionTransform((definition) => {
      seen.push(definition.name);
      return { ...definition, keywords: [...definition.keywords, 'flying'] };
    });
    try {
      // A split card interprets each half by recursion; the hook sees only the whole card.
      const split = interpretCard(pinStore.get('Wear // Tear'));
      expect(seen).toEqual(['Wear // Tear']);
      expect(split.keywords).toContain('flying');

      const custom = interpretCard(oracle({ name: 'Custom probe', typeLine: 'Creature' }));
      seen.length = 0;
      const ctx = createGame(
        gameConfig(
          [0, 1].map(() => ({ cards: copies(2, forest) })),
          {
            customDefinitions: [{ ...custom, keywords: [] }],
          },
        ),
      );
      // Each oracle ID once, seat by seat, then the custom definition.
      expect(seen).toEqual(['Test General P1', 'Forest', 'Test General P2', 'Custom probe']);
      expect(ctx.defs.get(custom.oracleId)!.keywords).toEqual(['flying']);
    } finally {
      installDefinitionTransform(previous);
    }
    expect(interpretCard(pinStore.get('Wear // Tear')).keywords).not.toContain('flying');
  });
});

/**
 * Implemented cards originally authored for the Counter-intelligence precon.
 *
 * That precon/deck/catalog is out of coverage and catalog-audit scope: leftover unreviewed
 * cards are not required work. These four cards stay registered because they already have
 * executable authored behavior (`modeled: true` via defineCard, not unimplemented stubs).
 */

import { constant } from '../value';
import { SAC_SELF, TAP } from '../templates';
import { defineCard } from './index';
import { allOf, CHOSEN_TYPE, not, ofType } from '../selector';

export function registerCOUNTER_INTELLIGENCEOverrides(): void {
  defineCard(
    '2a838818-d590-4374-9a63-d9e6381a0f0d',
    'Cloud Key',
    [
      'As this artifact enters, choose artifact, creature, enchantment, instant, or sorcery.',
      'Spells you cast of the chosen type cost {1} less to cast.',
    ],
    {
      entersChoosingOption: {
        prompt: 'Choose a spell type',
        options: [
          { key: 'Artifact', label: 'Artifact' },
          { key: 'Creature', label: 'Creature' },
          { key: 'Enchantment', label: 'Enchantment' },
          { key: 'Instant', label: 'Instant' },
          { key: 'Sorcery', label: 'Sorcery' },
        ],
      },
      ruleStatics: [{ kind: 'costReduction', amount: constant(1), filter: CHOSEN_TYPE }],
    },
  );

  defineCard(
    '66e37011-f3d2-41ed-8e09-7bba9464e8c3',
    'Coretapper',
    [
      '{T}: Put a charge counter on target artifact.',
      'Sacrifice this creature: Put two charge counters on target artifact.',
    ],
    {
      activatedAbilities: [
        {
          costs: [TAP],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'artifact' }],
            effects: [{ op: 'putCounters', target: 0, counter: 'charge', count: 1 }],
            description: 'Put a charge counter on target artifact',
          },
        },
        {
          costs: [SAC_SELF],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'artifact' }],
            effects: [{ op: 'putCounters', target: 0, counter: 'charge', count: 2 }],
            description: 'Put two charge counters on target artifact',
          },
        },
      ],
    },
  );

  defineCard(
    '133c99c0-3652-410f-8100-68015a47af9f',
    'Dispatch',
    ['If you control three or more artifacts, exile that creature.'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [{ kind: 'creature' }],
        effects: [
          { op: 'tapTarget', target: 0 },
          {
            op: 'conditionalEffect',
            condition: {
              kind: 'countPermanents',
              selector: ofType('Artifact'),
              scope: 'you',
              cmp: '>=',
              n: 3,
            },
            then: [{ op: 'exile', target: 0 }],
            else: [],
          },
        ],
        description: 'Tap target creature; metalcraft exiles it',
      },
    },
  );

  defineCard(
    'd9e24d7c-0907-45c1-b5d3-9fb16a929868',
    'Organic Extinction',
    ['Destroy all nonartifact creatures.'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'destroyEach', selector: allOf(ofType('Creature'), not(ofType('Artifact'))) },
        ],
        description: 'Destroy all nonartifact creatures',
      },
    },
  );
}

/** Canonically authored definitions for the five cards repaired in implementation steps 5–9. */

import {
  activated,
  costReductionFor,
  mana,
  onCast,
  onEtb,
  targetSlots,
  triggered,
} from '../templates';
import { constant } from '../value';
import {
  allOf,
  anyOf,
  manaValueAtLeast,
  manaValueAtMost,
  not,
  ofColor,
  ofSubtype,
  ofType,
  YOURS,
} from '../selector';
import { defineCard } from './index';

const GEV_TARGETS = targetSlots({
  opponent: { kind: 'player', controller: 'opponent' },
});
const THRAN_TARGETS = targetSlots({
  creature: { kind: 'creature', controller: 'you' },
});

export function registerReviewedFiveOverrides(): void {
  defineCard(
    'c2b51295-8820-425f-a517-55231123c7de',
    'Tribute Mage',
    [
      'When this creature enters, you may search your library for an artifact card with mana value 2, reveal that card, put it into your hand, then shuffle.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [
            {
              op: 'searchLibrary',
              filter: allOf(ofType('Artifact'), manaValueAtLeast(2), manaValueAtMost(2)),
              destinations: [{ zone: 'hand' }],
            },
            { op: 'shuffle' },
          ],
          description: 'Search for an artifact card with mana value exactly 2',
        }),
      ],
    },
  );

  defineCard(
    '77b832a8-a3af-44fe-bc67-72510d292667',
    'Gev, Scaled Scorch',
    // The Lizard trigger's line now parses (Phase 4 batch 1); the def keeps the same IR.
    ['Ward—Pay 2 life.'],
    {
      ward: { kind: 'life', amount: 2 },
      triggers: [
        triggered(onCast('you', ofSubtype('Lizard')), {
          targets: GEV_TARGETS.targets,
          effects: [{ op: 'dealDamage', target: GEV_TARGETS.slot.opponent, amount: constant(1) }],
          description: 'Whenever you cast a Lizard spell — deal 1 damage to target opponent',
        }),
      ],
    },
  );

  defineCard(
    '57296ea3-3c0d-49b7-bc08-0d0d8414e9ad',
    'Nightscape Familiar',
    [
      'Blue spells and red spells you cast cost {1} less to cast.',
      '{1}{B}: Regenerate this creature.',
    ],
    {
      ruleStatics: [costReductionFor(anyOf(ofColor('U'), ofColor('R')), constant(1))],
      activatedAbilities: [
        activated({
          costs: [mana('{1}{B}')],
          effects: [{ op: 'regenerate', target: 'source' }],
          description: '{1}{B}: Create a regeneration shield for Nightscape Familiar',
        }),
      ],
    },
  );

  defineCard(
    '01c179aa-533e-47e1-b6e5-c35587a39680',
    'Thran Vigil',
    [
      'Whenever one or more artifact and/or creature cards leave your graveyard during your turn, put a +1/+1 counter on target creature you control.',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'leavesGraveyard',
            subject: {
              kind: 'permanent',
              selector: allOf(anyOf(ofType('Artifact'), ofType('Creature')), YOURS),
            },
            aggregate: true,
          },
          {
            condition: { kind: 'yourTurn' },
            targets: THRAN_TARGETS.targets,
            effects: [
              {
                op: 'putCounters',
                target: THRAN_TARGETS.slot.creature,
                counter: '+1/+1',
                count: 1,
              },
            ],
            description:
              'Once per event during your turn when one or more of your artifact or creature cards leave your graveyard, put a +1/+1 counter on target creature you control',
          },
        ),
      ],
    },
  );

  defineCard(
    '2e2ace5b-4018-43af-8e72-ebafec1a7739',
    'Harmonic Prodigy',
    [
      'Prowess',
      'If a triggered ability of a Shaman or another Wizard you control triggers, that ability triggers an additional time.',
    ],
    {
      ruleStatics: [{ kind: 'triggerAdditionalForShamanOrOtherWizard' }],
      triggers: [
        triggered(onCast('you', not(ofType('Creature'))), {
          effects: [{ op: 'pumpUntilEot', target: 'source', power: 1, toughness: 1 }],
          description: 'Prowess — this creature gets +1/+1 until end of turn',
        }),
      ],
    },
  );
}

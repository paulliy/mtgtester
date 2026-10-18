/**
 * Coverage PR08 (docs/plans/card-coverage-chunks.md): control changes and multiplayer choices.
 *
 * Each registration lands with pinned Oracle clauses, behavioral tests and real lab scenarios.
 * Unfinished cards remain explicitly unsupported in their original deck registrations.
 */
import type { CardDefinition } from '../definition';
import { allOf, hasCounter, ofType } from '../selector';
import { activated, mana, onEtb, spell, targetSlots, triggered, TAP } from '../templates';
import { constant } from '../value';
import { defineCard } from './index';

export const MOB_RULE_HANDLED_LINES = [
  'Choose one —',
  '• Gain control of all creatures with power 4 or greater until end of turn. Untap those creatures. They gain haste until end of turn.',
  '• Gain control of all creatures with power 3 or less until end of turn. Untap those creatures. They gain haste until end of turn.',
];

export const MOB_RULE: Partial<CardDefinition> = {
  spellAbility: spell({
    effects: [],
    modes: {
      minChoices: 1,
      maxChoices: 1,
      options: [
        {
          description:
            'Gain control of creatures with power 4 or greater until end of turn; untap them and give them haste',
          effects: [
            {
              op: 'gainControl',
              selector: allOf(ofType('Creature'), { kind: 'powerAtLeast', n: 4 }),
              duration: 'untilEndOfTurn',
              untap: true,
              grantHaste: true,
            },
          ],
        },
        {
          description:
            'Gain control of creatures with power 3 or less until end of turn; untap them and give them haste',
          effects: [
            {
              op: 'gainControl',
              selector: allOf(ofType('Creature'), { kind: 'powerAtMost', n: 3 }),
              duration: 'untilEndOfTurn',
              untap: true,
              grantHaste: true,
            },
          ],
        },
      ],
    },
    description:
      'Choose one — gain control of creatures in the chosen power range until end of turn, untap them, and they gain haste',
  }),
};

export function registerCoveragePr08Overrides(): void {
  defineCard(
    '5bb32efd-9e58-4021-bbda-4ffccfa1d601',
    'Druid of Purification',
    [
      'unrecognized rules text: "When this creature enters, starting with you, each player may choose an artifact or enchantment you don\'t control. Destroy each permanent chosen this way."',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [{ op: 'druidPurification' }],
          description:
            'Starting with you, each player may choose an artifact or enchantment you do not control. Destroy each permanent chosen this way',
        }),
      ],
    },
  );
  const humbleTargets = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
  defineCard(
    '1582e16d-4825-4cc5-b12c-449c45e4e449',
    'Humble Defector',
    [
      '{T}: Draw two cards. Target opponent gains control of this creature. Activate only during your turn.',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [TAP],
          timing: 'yourTurn',
          targets: humbleTargets.targets,
          effects: [
            { op: 'draw', count: constant(2) },
            {
              op: 'gainControlTarget',
              target: 'source',
              recipient: { targetPlayer: humbleTargets.slot.opponent },
            },
          ],
          description:
            'Draw two cards, then target opponent gains control of Humble Defector (activate only during your turn)',
        }),
      ],
    },
  );
  const cytoplastTargets = targetSlots({
    counteredCreature: { kind: 'creature', filter: hasCounter('+1/+1') },
  });
  defineCard(
    '026ef98e-4f0a-4a6d-b74f-d17ac8b10e37',
    'Cytoplast Manipulator',
    [
      'unrecognized rules text: "{U}, {T}: Gain control of target creature with a +1/+1 counter on it for as long as this creature remains on the battlefield."',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{U}'), TAP],
          targets: cytoplastTargets.targets,
          effects: [
            {
              op: 'gainControlTarget',
              target: cytoplastTargets.slot.counteredCreature,
              duration: 'whileSourceOnBattlefield',
            },
          ],
          description:
            'Gain control of target creature with a +1/+1 counter on it for as long as Cytoplast Manipulator remains on the battlefield',
        }),
      ],
    },
  );
  defineCard(
    '8b5cffd5-5db3-4151-9275-d91387554412',
    'Cut a Deal',
    [
      'unrecognized rules text: "Each opponent draws a card, then you draw a card for each opponent who drew a card this way."',
    ],
    {
      spellAbility: spell({
        effects: [{ op: 'drawForEachOpponent' }],
        description:
          'Each opponent draws a card, then you draw a card for each opponent who drew a card this way',
      }),
    },
  );
  defineCard('acca2128-6ebb-48a5-a6a2-1bc5e4aa86ce', 'Mob Rule', MOB_RULE_HANDLED_LINES, MOB_RULE);
}

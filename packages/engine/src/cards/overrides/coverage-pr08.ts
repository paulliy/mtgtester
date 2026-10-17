/**
 * Coverage PR08 (docs/plans/card-coverage-chunks.md): control changes and multiplayer choices.
 *
 * Each registration lands with pinned Oracle clauses, behavioral tests and real lab scenarios.
 * Unfinished cards remain explicitly unsupported in their original deck registrations.
 */
import type { CardDefinition } from '../definition';
import { allOf, ofType } from '../selector';
import { spell } from '../templates';
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
  defineCard('acca2128-6ebb-48a5-a6a2-1bc5e4aa86ce', 'Mob Rule', MOB_RULE_HANDLED_LINES, MOB_RULE);
}

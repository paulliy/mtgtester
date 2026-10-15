/**
 * Coverage PR07 (docs/plans/card-coverage-chunks.md): combat requirements, restrictions and extra
 * combats. Authored cards that have no interpreter reading. This file is not part of the catalog
 * audit inventory; the cards PR07 restores are gated by `tests/pr07-card-coverage.test.ts`.
 */

import { onAttacks, triggered } from '../templates';
import { constant } from '../value';
import { allOf, ofType, YOURS } from '../selector';
import { defineCard } from './index';

export function registerCoveragePr07Overrides(): void {
  // Lightning Runner: the energy is gained, then paid, as one resolution (the payment is not a
  // reflexive trigger). Paying untaps only creatures you control, and the extra combat phase is
  // created during combat, so it is the phase right after this one (CR 500.8).
  defineCard(
    '2f82b232-21ff-44cc-bc35-0999a1d1c52f',
    'Lightning Runner',
    [
      'Whenever this creature attacks, you get {E}{E} , then you may pay eight {E}. If you pay, untap all creatures you control, and after this phase, there is an additional combat phase.',
    ],
    {
      triggers: [
        triggered(onAttacks(), {
          effects: [
            { op: 'gainEnergy', amount: constant(2) },
            {
              op: 'mayPayEnergy',
              amount: constant(8),
              then: [
                { op: 'untapEach', selector: allOf(ofType('Creature'), YOURS) },
                { op: 'extraCombatPhase' },
              ],
            },
          ],
          description:
            'Whenever this creature attacks, you get {E}{E}, then you may pay eight {E}. If you pay, untap all creatures you control, and after this phase, there is an additional combat phase',
        }),
      ],
    },
  );
}

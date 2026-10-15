/**
 * Coverage PR07 (docs/plans/card-coverage-chunks.md): combat requirements, restrictions and extra
 * combats. Authored cards that have no interpreter reading. This file is not part of the catalog
 * audit inventory; the cards PR07 restores are gated by `tests/pr07-card-coverage.test.ts`.
 */

import {
  onAttacks,
  onEndStep,
  targetSlots,
  triggered,
  whenAttacks,
  whenPermanent,
} from '../templates';
import { allOfConditions } from '../condition';
import { constant } from '../value';
import { allOf, ofSubtype, ofType, SELF, YOURS } from '../selector';
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

  // Firkraag, Cunning Instigator: the first ability triggers once for each opponent attacked by
  // one or more of your Dragons (a planeswalker attack is not an attack on that opponent), and
  // the goaded creature is one that opponent controls. The second is an intervening-if about the
  // creature that dealt the damage, not Firkraag (CR 603.4): it must have been required to attack
  // this combat, and the damage went to one of YOUR opponents, which can be a player another
  // opponent's creature attacked. Both are checked as the ability triggers and as it resolves,
  // from last known information if that creature has left the battlefield (CR 608.2h).
  const goad = targetSlots({ creature: { kind: 'creature', controller: 'eventPlayer' } });
  defineCard(
    '81dad7c5-5950-4c45-adb0-cf1a15a74250',
    'Firkraag, Cunning Instigator',
    [
      'Whenever one or more Dragons you control attack an opponent, goad target creature that player controls.',
      'Whenever a creature deals combat damage to one of your opponents, if that creature had to attack this combat, you put a +1/+1 counter on ~ and you draw a card.',
    ],
    {
      triggers: [
        triggered(whenAttacks(allOf(ofSubtype('Dragon'), YOURS), { aggregate: 'byEventPlayer' }), {
          targets: goad.targets,
          effects: [{ op: 'goad', target: goad.slot.creature }],
          description:
            'Whenever one or more Dragons you control attack an opponent, goad target creature that player controls',
        }),
        triggered(whenPermanent('dealsCombatDamageToPlayer', ofType('Creature')), {
          condition: allOfConditions(
            { kind: 'triggerObjectHadToAttackThisCombat' },
            { kind: 'triggerObjectAttackingOpponent' },
          ),
          effects: [
            { op: 'putCountersEach', selector: SELF, counter: '+1/+1', count: 1 },
            { op: 'draw', count: constant(1) },
          ],
          description:
            'Whenever a creature deals combat damage to one of your opponents, if that creature had to attack this combat, you put a +1/+1 counter on Firkraag and you draw a card',
        }),
      ],
    },
  );

  // Eriette of the Charmed Apple: the restriction covers every creature enchanted by an Aura you
  // control (that Aura may be any Aura, on any creature), whoever controls the creature. The
  // drain counts ALL Auras you control, attached to anything or not, once as it resolves.
  const aurasYouControl = {
    kind: 'countPermanents',
    selector: allOf(ofSubtype('Aura'), YOURS),
    scope: 'you',
  } as const;
  defineCard(
    'f43f5855-f297-4433-984b-18263b734cfc',
    'Eriette of the Charmed Apple',
    [
      "Each creature that's enchanted by an Aura you control can't attack you or planeswalkers you control.",
      'At the beginning of your end step, each opponent loses X life and you gain X life, where X is the number of Auras you control.',
    ],
    {
      ruleStatics: [
        {
          kind: 'attackRestriction',
          filter: { kind: 'enchantedByAuraYouControl' },
          includePlaneswalkers: true,
        },
      ],
      triggers: [
        triggered(onEndStep('you'), {
          effects: [
            { op: 'eachOpponentLosesLife', amount: aurasYouControl },
            { op: 'gainLife', amount: aurasYouControl },
          ],
          description:
            'At the beginning of your end step, each opponent loses X life and you gain X life, where X is the number of Auras you control',
        }),
      ],
    },
  );
}

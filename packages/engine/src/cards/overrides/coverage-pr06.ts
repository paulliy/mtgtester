/**
 * Coverage PR06 (docs/plans/card-coverage-chunks.md): cards that had no registration at all, and
 * containment for cards that PR06's engine work happened to make readable before their own
 * evidence lands. This file is not part of the catalog audit inventory; the cards PR06 restores
 * are gated by `tests/pr06-card-coverage.test.ts`.
 */

import {
  manaCost,
  onAttacks,
  onEtb,
  spell,
  targetSlots,
  triggered,
  whenAttacks,
} from '../templates';
import { constant } from '../value';
import { allOf, ofType, OTHER, YOURS } from '../selector';
import { defineCard, extendCard, unsupportedCard } from './index';

export function registerCoveragePr06Overrides(): void {
  // Flameblast Dragon: "if you do" is not a reflexive trigger (only "when you do" is, CR 603.12).
  // The ability targets, so the target is chosen when the trigger goes on the stack (CR 603.3d);
  // X is chosen and the cost paid on resolution (CR 107.3b), and the Dragon deals the damage
  // (last known information if it has left the battlefield, CR 608.2h).
  const blast = targetSlots({ victim: { kind: 'anyTarget' } });
  defineCard(
    '3180ee4f-66d7-4b73-bc10-9ee0c790ec18',
    'Flameblast Dragon',
    [
      'Whenever this creature attacks, you may pay {X}{R}. If you do, it deals X damage to any target.',
    ],
    {
      triggers: [
        triggered(onAttacks(), {
          targets: blast.targets,
          effects: [
            {
              op: 'mayPayXThenDealDamage',
              target: blast.slot.victim,
              templatedCost: manaCost('{X}{R}'),
            },
          ],
          description:
            'Whenever this creature attacks, you may pay {X}{R}. If you do, it deals X damage to any target',
        }),
      ],
    },
  );

  // Territorial Aetherkite: "when you do" is a reflexive trigger (CR 603.12). After the energy is
  // paid, a separate ability goes on the stack, so players get priority first, and as it
  // resolves the Aetherkite deals damage equal to the energy paid to each other creature (the
  // set is read then; last known information if it has left the battlefield, CR 608.2h). Any
  // amount from one up to all your energy may be paid, not only the two just gained.
  defineCard(
    '4f63d306-cc14-405c-8424-d8990c670c74',
    'Territorial Aetherkite',
    [
      'When this creature enters, you get {E}{E} . Then you may pay one or more {E}. When you do, this creature deals that much damage to each other creature.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [
            { op: 'gainEnergy', amount: constant(2) },
            {
              op: 'mayPayEnergyThenReflexive',
              min: 1,
              then: spell({
                effects: [
                  {
                    op: 'damageEach',
                    selector: allOf(ofType('Creature'), OTHER),
                    amount: { kind: 'energyPaid' },
                  },
                ],
                description:
                  'When you do, this creature deals that much damage to each other creature',
              }),
            },
          ],
          description:
            'When this creature enters, you get {E}{E}. Then you may pay one or more {E}. When you do, this creature deals that much damage to each other creature',
        }),
      ],
    },
  );

  // Invisible Woman: "whenever you attack" is one trigger for the whole declaration (CR 603.2c).
  // The payment is made first, as the trigger resolves; only paying fires the reflexive trigger
  // (CR 603.12), which then goes on the stack and chooses its target, and counts the creatures
  // you control as that reflexive trigger resolves. The Wall token line stays interpreted.
  const boost = targetSlots({ creature: { kind: 'creature' } });
  extendCard(
    '085016ee-4429-453f-b7f3-d61065f1214e',
    'Invisible Woman',
    [
      "Whenever you attack, you may pay {R}{G}{W}{U}. When you do, target creature gets +1/+0 until end of turn for each creature you control and can't be blocked this turn.",
    ],
    {
      triggers: [
        triggered(whenAttacks(allOf(ofType('Creature'), YOURS), { aggregate: true }), {
          effects: [
            {
              op: 'mayPayManaThenReflexive',
              cost: manaCost('{R}{G}{W}{U}'),
              then: spell({
                targets: boost.targets,
                effects: [
                  {
                    op: 'pumpUntilEot',
                    target: boost.slot.creature,
                    power: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' },
                    toughness: 0,
                  },
                  { op: 'cantBeBlockedUntilEot', target: boost.slot.creature },
                ],
                description:
                  "When you do, target creature gets +1/+0 until end of turn for each creature you control and can't be blocked this turn",
              }),
            },
          ],
          description: 'Whenever you attack, you may pay {R}{G}{W}{U}',
        }),
      ],
    },
  );

  // Binding the targeting player as the event player of "becomes the target" triggers (for
  // Thunderbreak Regent) lets the grammar read these two cards' "that player controls" targets.
  // Neither has focused engine or viewer evidence yet, so each stays contained until it does.
  unsupportedCard(
    'a30f30e3-dbbf-4cb2-b3d0-76f57dffb2dd',
    'Black Bolt, Inhuman King',
    'No focused engine or Card Test Lab evidence yet for the becomes-targeted destroy trigger.',
  );
  unsupportedCard(
    '9da65d66-71f0-4e17-a1f9-6da6cd1cfa8a',
    'Scalelord Reckoner',
    'No focused engine or Card Test Lab evidence yet for the becomes-targeted destroy trigger.',
  );
}

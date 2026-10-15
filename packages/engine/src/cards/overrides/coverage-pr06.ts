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
  whenPermanent,
} from '../templates';
import { constant } from '../value';
import { allOf, ofType, OPPONENTS, OTHER, withKeyword, YOURS } from '../selector';
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

  // Backlash: "untapped" holds when the target is chosen and again as the spell resolves (CR
  // 608.2b), so a creature tapped in response makes the only target illegal and the spell does
  // nothing. The creature itself deals the damage, equal to its power after being tapped, to the
  // player who controls it as Backlash resolves.
  const backlash = targetSlots({ creature: { kind: 'creature', tapState: 'untapped' } });
  defineCard(
    '3db9bf7b-da4e-428f-aa5d-a0cd1afeb16c',
    'Backlash',
    [
      'Tap target untapped creature. That creature deals damage equal to its power to its controller.',
    ],
    {
      spellAbility: spell({
        targets: backlash.targets,
        effects: [
          { op: 'tapTarget', target: backlash.slot.creature },
          {
            op: 'dealDamage',
            target: { controllerOf: backlash.slot.creature },
            source: backlash.slot.creature,
            amount: { kind: 'powerOfTarget', target: backlash.slot.creature },
          },
        ],
        description:
          'Tap target untapped creature. That creature deals damage equal to its power to its controller',
      }),
    },
  );

  // Selfless Squire: the enter trigger makes a shield for the rest of the turn that covers every
  // source and both combat and noncombat damage to you (CR 615). The second ability is a
  // separate trigger of the permanent, so it works whenever the Squire is on the battlefield and
  // damage to you is prevented by anything, once per prevented source's damage, for that amount.
  defineCard(
    '7d079c78-b2a9-444f-ab54-c61c041baa6d',
    'Selfless Squire',
    [
      'When this creature enters, prevent all damage that would be dealt to you this turn.',
      'Whenever damage that would be dealt to you is prevented, put that many +1/+1 counters on this creature.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [{ op: 'createDamageShield', player: 'you' }],
          description:
            'When this creature enters, prevent all damage that would be dealt to you this turn',
        }),
        triggered(
          { when: 'damagePreventedToPlayer', player: 'you' },
          {
            effects: [
              {
                op: 'putCounters',
                target: 'source',
                counter: '+1/+1',
                count: { kind: 'damageDealt' },
              },
            ],
            description:
              'Whenever damage that would be dealt to you is prevented, put that many +1/+1 counters on this creature',
          },
        ),
      ],
    },
  );

  // Thundermaw Hellkite: "those creatures" means the creatures with flying your opponents control,
  // not the creatures that were dealt damage (Gatherer ruling 2017-11-17), so a flier whose damage
  // is prevented, protection from red for one, is still tapped. Both instructions use that same
  // set as the ability resolves; nothing can change flying or control between the two
  // instructions of one resolution, so reading the selector twice is reading one set.
  const opposingFliers = allOf(ofType('Creature'), OPPONENTS, withKeyword('flying'));
  defineCard(
    'e958144e-01bc-46ff-8f56-ddf2eb098630',
    'Thundermaw Hellkite',
    [
      'When this creature enters, it deals 1 damage to each creature with flying your opponents control. Tap those creatures.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [
            { op: 'damageEach', selector: opposingFliers, amount: constant(1) },
            { op: 'tapEach', selector: opposingFliers },
          ],
          description:
            'When this creature enters, it deals 1 damage to each creature with flying your opponents control. Tap those creatures',
        }),
      ],
    },
  );

  // Arcbond: the delayed trigger is keyed to the chosen creature OBJECT (a blinked creature is a
  // new object, CR 400.7) and lasts this turn, under Arcbond's controller. Each time the creature is
  // dealt damage (simultaneous combat damage is one event, CR 510.2, 603.2c) the CREATURE deals
  // that much damage to each other creature and each player, simultaneously, with last known
  // information if the damage killed it (CR 608.2h). The damage it deals is never dealt to itself.
  const arcbond = targetSlots({ creature: { kind: 'creature' } });
  defineCard(
    '01790829-cc03-430f-a899-2f274b7dbf62',
    'Arcbond',
    [
      'Choose target creature. Whenever that creature is dealt damage this turn, it deals that much damage to each other creature and each player.',
    ],
    {
      spellAbility: spell({
        targets: arcbond.targets,
        effects: [
          {
            op: 'registerDelayedTrigger',
            when: 'dealtDamage',
            target: arcbond.slot.creature,
            expiry: 'cleanup',
            // The delayed ability is a triggered one; its head only names the event, the
            // registration above decides which creature's damage and for how long.
            ability: triggered(whenPermanent('dealtDamage', ofType('Creature')), {
              effects: [
                {
                  op: 'damageEach',
                  selector: ofType('Creature'),
                  amount: { kind: 'damageDealt' },
                  source: 'triggerObject',
                  exceptSource: true,
                },
                {
                  op: 'damageEachPlayer',
                  amount: { kind: 'damageDealt' },
                  source: 'triggerObject',
                },
              ],
              description:
                'That creature deals that much damage to each other creature and each player',
            }),
          },
        ],
        description:
          'Choose target creature. Whenever it is dealt damage this turn, it deals that much damage to each other creature and each player',
      }),
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

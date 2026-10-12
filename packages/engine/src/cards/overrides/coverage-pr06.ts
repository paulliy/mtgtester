/**
 * Coverage PR06 (docs/plans/card-coverage-chunks.md): cards that had no registration at all, and
 * containment for cards that PR06's engine work happened to make readable before their own
 * evidence lands. This file is not part of the catalog audit inventory; the cards PR06 restores
 * are gated by `tests/pr06-card-coverage.test.ts`.
 */

import { manaCost, spell, targetSlots, triggered, whenAttacks } from '../templates';
import { allOf, ofType, YOURS } from '../selector';
import { extendCard, unsupportedCard } from './index';

export function registerCoveragePr06Overrides(): void {
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

import { allOf, ofType, YOURS } from '../selector';
import { triggered, targetSlots } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlOverrides(): void {
  const chosen = targetSlots({
    creature: { kind: 'creature', filter: allOf(ofType('Creature'), YOURS) },
  });
  replaceCard(
    'd11e627b-8a48-411d-a261-2c9a02a758ba',
    'Breena, the Demagogue',
    [
      'Whenever a player attacks one of your opponents, if that opponent has more life than another of your opponents, that attacking player draws a card and you put two +1/+1 counters on a creature you control.',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'attacks',
            subject: { kind: 'permanent', selector: ofType('Creature') },
            aggregate: 'byEventPlayer',
            attackingPlayerIsEventPlayer: true,
          },
          {
            condition: { kind: 'defendingOpponentHasMoreLifeThanAnother' },
            targets: chosen.targets,
            effects: [
              { op: 'draw', player: 'eventPlayer', count: constant(1) },
              { op: 'putCounters', target: chosen.slot.creature, counter: '+1/+1', count: 2 },
            ],
            description:
              'The attacking player draws a card and you put two +1/+1 counters on a creature you control',
          },
        ),
      ],
    },
    'Restore Breena with defender-grouped attacks and the exact intervening opponent-life comparison.',
  );
}

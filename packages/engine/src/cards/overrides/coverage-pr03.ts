/**
 * Coverage PR03 (docs/plans/card-coverage-chunks.md): cards that had no registration at all.
 * Each one meets the completion standard individually and is gated by the PR03 restoration
 * gate in `tests/pr03-card-coverage.test.ts`, so this file is not part of the catalog audit
 * inventory.
 */

import { withKeyword } from '../selector';
import { onCast, triggered } from '../templates';
import { defineCard } from './index';

export function registerCoveragePr03Overrides(): void {
  // Aurora Phoenix: Flying and Cascade are interpreted; the cascade-cast trigger works only from
  // the graveyard (CR 112.6a) and returns that very card to its owner's hand.
  defineCard(
    'a98cc4d0-a322-4142-aee0-83f39b137616',
    'Aurora Phoenix',
    ['Whenever you cast a spell with cascade, return this card from your graveyard to your hand.'],
    {
      triggers: [
        {
          ...triggered(onCast('you', withKeyword('cascade')), {
            effects: [{ op: 'returnSelfFromGraveyardToHand' }],
            description:
              'Whenever you cast a spell with cascade, return this card from your graveyard to your hand',
          }),
          functionsInGraveyard: true,
        },
      ],
    },
  );
}

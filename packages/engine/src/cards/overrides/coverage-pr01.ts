/**
 * Coverage PR01 (docs/plans/card-coverage-chunks.md): cards that had no registration at all.
 * Each one meets the completion standard individually and is gated by the PR01 restoration
 * gate in `tests/pr01-card-coverage.test.ts`, so this file is not part of the catalog audit
 * inventory.
 */

import { anyOf, ofSubtype, ofType } from '../selector';
import { defineCard } from './index';

export function registerCoveragePr01Overrides(): void {
  // Mystic Sanctuary: the Islands are counted before it is on the battlefield, so "other" holds.
  defineCard(
    '17b60106-a4c7-410a-8ac3-ec8e74e29a7c',
    'Mystic Sanctuary',
    [
      '~ enters tapped unless you control three or more other Islands.',
      'When this land enters untapped, you may put target instant or sorcery card from your graveyard on top of your library.',
    ],
    {
      entersTappedUnless: {
        kind: 'countPermanents',
        selector: ofSubtype('Island'),
        scope: 'you',
        cmp: '>=',
        n: 3,
      },
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' }, entersUntapped: true },
          optional: true,
          targets: [
            { kind: 'cardInGraveyard', filter: anyOf(ofType('Instant'), ofType('Sorcery')) },
          ],
          effects: [{ op: 'graveyardToLibraryTop', target: 0 }],
          description:
            'You may put target instant or sorcery card from your graveyard on top of your library',
        },
      ],
    },
  );
}

/**
 * Coverage PR06 (docs/plans/card-coverage-chunks.md): containment for cards that PR06's engine
 * work happened to make readable before their own evidence lands. This file is not part of the
 * catalog audit inventory; the cards PR06 restores are gated by `tests/pr06-card-coverage.test.ts`.
 */

import { unsupportedCard } from './index';

export function registerCoveragePr06Overrides(): void {
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

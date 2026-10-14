/** Faithful Rule of Law and Deafening Silence casting limits for white-black-control. */

import { replaceCard } from './index';

export function registerWhiteBlackControlStaxOverrides(): void {
  replaceCard(
    '53e88e64-6f82-4154-a66e-6aeb0154b368',
    'Rule of Law',
    [
      `unrecognized rules text: "Each player can't cast more than one spell each turn."`,
    ],
    { ruleStatics: [{ kind: 'spellCastLimit', category: 'any', limit: 1 }] },
    'Applies the one-spell-per-player-per-turn limit from each player’s own cast tally.',
  );

  replaceCard(
    '6284ef01-d17d-4584-aecb-1b841ae638e5',
    'Deafening Silence',
    [
      `unrecognized rules text: "Each player can't cast more than one noncreature spell each turn."`,
    ],
    { ruleStatics: [{ kind: 'spellCastLimit', category: 'noncreature', limit: 1 }] },
    'Applies the one-noncreature-spell-per-player-per-turn limit using selected spell-face types.',
  );
}

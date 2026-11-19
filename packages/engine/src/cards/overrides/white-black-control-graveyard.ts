import { replaceCard } from './index';

export function registerWhiteBlackControlGraveyardOverrides(): void {
  replaceCard(
    '087f9ad7-e74f-40e2-8102-1ed2925d0418',
    'Rest in Peace',
    [
      'unrecognized rules text: "If a card or token would be put into a graveyard from anywhere, exile it instead."',
    ],
    {
      ruleStatics: [
        { kind: 'graveyardToExile', scope: 'all', basis: 'owner', includeTokens: true },
      ],
    },
    'Preserves the parsed enters trigger; redirects graveyard moves before dies events, including tokens and simultaneous source departure.',
  );
  replaceCard(
    '73dad679-1edb-41c9-9d43-56dc93c3e9fe',
    'Stone of Erech',
    ['unrecognized rules text: "If a creature an opponent controls would die, exile it instead."'],
    {
      ruleStatics: [
        {
          kind: 'graveyardToExile',
          scope: 'opponents',
          basis: 'controller',
          includeTokens: true,
          creatureFromBattlefieldOnly: true,
        },
      ],
    },
    // The activated line ("{2}, {T}, Sacrifice ~: Exile target player's graveyard. Draw a card.")
    // is interpreted; only the death replacement is overridden.
    'Reads current creature type and controller for deaths.',
  );
}

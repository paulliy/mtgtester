import { activated, mana, SAC_SELF, TAP, targetSlots } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlGraveyardOverrides(): void {
  const chosen = targetSlots({ player: { kind: 'player' } });
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
    [
      'unrecognized rules text: "If a creature an opponent controls would die, exile it instead."',
      'unrecognized rules text: "{2}, {T}, Sacrifice ~: Exile target player\'s graveyard. Draw a card."',
    ],
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
      activatedAbilities: [
        activated({
          costs: [mana('{2}'), TAP, SAC_SELF],
          targets: chosen.targets,
          effects: [
            { op: 'exileTargetPlayerGraveyard', target: chosen.slot.player },
            { op: 'draw', count: constant(1) },
          ],
          description: "Exile target player's graveyard. Draw a card",
        }),
      ],
    },
    'Reads current creature type and controller for deaths; the paid activation sacrifices the source before resolving and permits any player.',
  );
}

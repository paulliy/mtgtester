import { allOf, ofSupertype, ofType, YOURS } from '../selector';
import { activated, mana, onEndStep, triggered, targetSlots } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlTinybonesOverrides(): void {
  const players = targetSlots({ players: { kind: 'player', count: { min: 0, max: Infinity } } });
  replaceCard(
    '3d2bd4f6-174d-411a-b930-9161aeefd33a',
    'Tinybones Joins Up',
    [
      'unrecognized rules text: "When ~ enters, any number of target players each discard a card."',
      'unrecognized rules text: "Whenever a legendary creature you control enters, any number of target players each mill a card and lose 1 life."',
    ],
    {
      triggers: [
        triggered(
          { when: 'enters', subject: { kind: 'self' } },
          {
            targets: players.targets,
            effects: [
              { op: 'discardChosenPlayers', targetSlot: players.slot.players, count: constant(1) },
            ],
            description: 'Any number of target players each discard a card',
          },
        ),
        triggered(
          {
            when: 'enters',
            subject: {
              kind: 'permanent',
              selector: allOf(ofType('Creature'), ofSupertype('Legendary'), YOURS),
            },
          },
          {
            targets: players.targets,
            effects: [
              {
                op: 'millAndLoseLifeChosenPlayers',
                targetSlot: players.slot.players,
                count: constant(1),
                amount: constant(1),
              },
            ],
            description: 'Any number of target players each mill a card and lose 1 life',
          },
        ),
      ],
    },
    'Uses unrestricted counted player targets, with each legal selected player affected at resolution.',
  );
  replaceCard(
    '008eda1f-b913-4f04-8c29-5e87c270149e',
    'Tinybones, Trinket Thief',
    [
      'unrecognized rules text: "At the beginning of each end step, if an opponent discarded a card this turn, you draw a card and you lose 1 life."',
      'unrecognized rules text: "{4}{B}{B}: Each opponent with no cards in hand loses 10 life."',
    ],
    {
      triggers: [
        triggered(onEndStep('each'), {
          condition: { kind: 'opponentDiscardedThisTurn' },
          effects: [
            { op: 'draw', count: constant(1) },
            { op: 'loseLife', amount: constant(1) },
          ],
          description: 'If an opponent discarded this turn, draw a card and lose 1 life',
        }),
      ],
      activatedAbilities: [
        activated({
          costs: [mana('{4}{B}{B}')],
          effects: [{ op: 'eachOpponentLosesLife', amount: constant(10), emptyHandOnly: true }],
          description: 'Each opponent with no cards in hand loses 10 life',
        }),
      ],
    },
    'Tracks actual opponent discards across the whole turn, with an intervening condition; checks each opponent hand at activation resolution.',
  );
}

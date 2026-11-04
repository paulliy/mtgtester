import { onCast, spell, triggered } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlDiscardChoiceOverrides(): void {
  replaceCard(
    'c37051cc-6683-4dbb-b5ff-5c3a5bdab1df',
    'Painful Quandary',
    [
      'unrecognized rules text: "Whenever an opponent casts a spell, that player loses 5 life unless they discard a card."',
    ],
    {
      triggers: [
        triggered(onCast('opponent'), {
          effects: [{ op: 'discardOrLoseLife', target: 'eventPlayer', amount: constant(5) }],
          description: 'That player loses 5 life unless they discard a card',
        }),
      ],
    },
    'The spell caster chooses whether to discard a card, with life loss when they decline or have no card.',
  );

  replaceCard(
    'b8619990-9dc2-4fcc-bc7e-457b77cd2a8e',
    'Rankle, Master of Pranks',
    [],
    {
      triggers: [
        triggered(
          { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
          {
            modes: {
              minChoices: 0,
              maxChoices: 3,
              options: [
                {
                  description: 'Each player discards a card',
                  targetSlots: [],
                  effects: [{ op: 'discardEachPlayer', scope: 'all', count: constant(1) }],
                },
                {
                  description: 'Each player loses 1 life and draws a card',
                  targetSlots: [],
                  effects: [
                    { op: 'eachPlayerLosesLifeAndDraws', amount: constant(1), count: constant(1) },
                  ],
                },
                {
                  description: 'Each player sacrifices a creature',
                  targetSlots: [],
                  effects: [{ op: 'sacrificeEachPlayer', count: 1, filter: 'creature' }],
                },
              ],
            },
            effects: [],
            description: 'Choose any number of Rankle modes',
          },
        ),
      ],
    },
    'Preserves flying and haste; choose zero to three distinct modes on the combat-damage trigger.',
  );

  replaceCard(
    '55b72b1f-6463-406a-8824-d99a3c028285',
    'Vicious Rumors',
    [
      'unrecognized rules text: "~ deals 1 damage to each opponent. Each opponent discards a card, then mills a card. You gain 1 life."',
    ],
    {
      spellAbility: spell({
        effects: [
          { op: 'eachOpponentDamage', amount: constant(1) },
          { op: 'discardEachPlayer', scope: 'opponents', count: constant(1) },
          { op: 'millEachPlayer', scope: 'opponents', count: constant(1) },
          { op: 'gainLife', amount: constant(1) },
        ],
        description: 'Each opponent takes 1 damage, discards and mills a card. You gain 1 life',
      }),
    },
    'Applies each opponent instruction in printed order and gains exactly one life.',
  );
}

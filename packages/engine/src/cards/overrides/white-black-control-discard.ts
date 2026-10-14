/** Faithful discard cards authored for the white-black-control deck. */

import { triggered, spell, onCast, onUpkeep, targetSlots } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlDiscardOverrides(): void {
  const chosen = targetSlots({ player: { kind: 'player' } });
  replaceCard(
    '992d9a72-d34d-47d7-96fb-37f0efb515ef',
    'Hymn to Tourach',
    ['unrecognized rules text: "Target player discards two cards at random."'],
    {
      spellAbility: spell({
        targets: chosen.targets,
        effects: [{ op: 'discardTarget', target: chosen.slot.player, count: constant(2), atRandom: true }],
        description: 'Target player discards two cards at random',
      }),
    },
    'Models Hymn to Tourach with its printed player target and two random discards.',
  );

  replaceCard(
    '91e6fb47-59e4-4616-b8dd-3a7e30070074',
    'Bottomless Pit',
    [
      'unrecognized rules text: "At the beginning of each player\'s upkeep, that player discards a card at random."',
    ],
    {
      triggers: [
        triggered(onUpkeep('each'), {
          effects: [
            { op: 'discardTarget', target: 'eventPlayer', count: constant(1), atRandom: true },
          ],
          description: 'That player discards a card at random',
        }),
      ],
    },
    'Models the upkeep trigger for the active player, including random discard.',
  );

  replaceCard(
    'db25d48e-e5eb-4364-9d7a-f9757ee4ccbe',
    'Necrogen Mists',
    [
      'unrecognized rules text: "At the beginning of each player\'s upkeep, that player discards a card."',
    ],
    {
      triggers: [
        triggered(onUpkeep('each'), {
          effects: [{ op: 'discardTarget', target: 'eventPlayer', count: constant(1) }],
          description: 'That player discards a card',
        }),
      ],
    },
    'Models the upkeep trigger for the active player, with that player choosing the discard.',
  );

  replaceCard(
    '759af941-f6a3-4726-91f2-9b1e4e55ea71',
    'Hypnotic Specter',
    [
      'unrecognized rules text: "Whenever this creature deals damage to an opponent, that player discards a card at random."',
    ],
    {
      triggers: [
        triggered(
          { when: 'dealsDamageToOpponent', subject: { kind: 'self' } },
          {
            effects: [
              { op: 'discardTarget', target: 'eventPlayer', count: constant(1), atRandom: true },
            ],
            description: 'That player discards a card at random',
          },
        ),
      ],
    },
    'Models damage to an opponent from either combat or noncombat sources, preserving flying.',
  );

  replaceCard(
    'f488f679-f5d5-4e61-b0c8-0b0eb622df0d',
    'Oppression',
    ['unrecognized rules text: "Whenever a player casts a spell, that player discards a card."'],
    {
      triggers: [
        triggered(onCast('each'), {
          effects: [{ op: 'discardTarget', target: 'eventPlayer', count: constant(1) }],
          description: 'That player discards a card',
        }),
      ],
    },
    'Models the spell-cast trigger for the player who cast the spell.',
  );

  replaceCard(
    'abc37d6c-6300-47b5-a679-9db5b83eb54f',
    'Syphon Mind',
    [
      'unrecognized rules text: "Each other player discards a card. You draw a card for each card discarded this way."',
    ],
    {
      spellAbility: spell({
        effects: [
          {
            op: 'discardEachPlayer',
            scope: 'opponents',
            count: constant(1),
            drawForDiscarded: true,
          },
        ],
        description:
          'Each other player discards a card. Draw a card for each card discarded this way',
      }),
    },
    'Uses the APNAP simultaneous discard primitive and draws for the actual number discarded.',
  );

  replaceCard(
    'ef809e99-34a2-4471-8269-f56bf8037686',
    "Geth's Grimoire",
    ['unrecognized rules text: "Whenever an opponent discards a card, you may draw a card."'],
    {
      triggers: [
        triggered(
          { when: 'discardsCard', player: 'opponent' },
          {
            effects: [{ op: 'draw', count: constant(1) }],
            optional: true,
            description: 'You may draw a card',
          },
        ),
      ],
    },
    'Models an optional draw trigger for each opponent discard.',
  );
}

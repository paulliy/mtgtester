import { allOf, not, ofType, OPPONENTS } from '../selector';
import { spell, triggered, targetSlots } from '../templates';
import { ZOMBIE_2_2_BLACK } from '../tokens';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlPayoffOverrides(): void {
  const chosen = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
  replaceCard(
    '535e2af0-7b08-4026-b1bf-87626407dd42',
    'Archfiend of Ifnir',
    [
      'unrecognized rules text: "Whenever you cycle or discard another card, put a -1/-1 counter on each creature your opponents control."',
    ],
    {
      triggers: [
        triggered(
          { when: 'discardsCard', player: 'you', filter: { kind: 'other' } },
          {
            effects: [
              {
                op: 'putCountersEach',
                selector: allOf(ofType('Creature'), OPPONENTS),
                counter: '-1/-1',
                count: 1,
              },
            ],
            description: 'Put a -1/-1 counter on each creature your opponents control',
          },
        ),
      ],
    },
    'Cycling includes one discard action; observe that action once while preserving flying and the parsed cycling activation.',
  );
  replaceCard(
    '00fdcc19-88ed-46c3-91f0-095806228105',
    'Waste Not',
    [
      'unrecognized rules text: "Whenever an opponent discards a creature card, create a 2/2 black Zombie creature token."',
      'unrecognized rules text: "Whenever an opponent discards a land card, add {B}{B}."',
      'unrecognized rules text: "Whenever an opponent discards a noncreature, nonland card, draw a card."',
    ],
    {
      triggers: [
        triggered(
          { when: 'discardsCard', player: 'opponent', filter: ofType('Creature') },
          {
            effects: [{ op: 'createToken', spec: ZOMBIE_2_2_BLACK, count: constant(1) }],
            description: 'Create a 2/2 black Zombie creature token',
          },
        ),
        triggered(
          { when: 'discardsCard', player: 'opponent', filter: ofType('Land') },
          {
            effects: [
              { op: 'addMana', amount: constant(2), colors: ['B'], fixedSymbols: ['B', 'B'] },
            ],
            description: 'Add {B}{B}',
          },
        ),
        triggered(
          {
            when: 'discardsCard',
            player: 'opponent',
            filter: allOf(not(ofType('Creature')), not(ofType('Land'))),
          },
          {
            effects: [{ op: 'draw', count: constant(1) }],
            description: 'Draw a card',
          },
        ),
      ],
    },
    'Match each discarded card independently against its printed types; creature-land cards trigger both corresponding abilities.',
  );
  replaceCard(
    'cf8bc2e3-2f22-45d3-9810-bc039202f41c',
    'Whispers of Emrakul',
    [
      'unrecognized rules text: "Target opponent discards a card at random."',
      'unrecognized rules text: "If there are four or more card types among cards in your graveyard, that player discards two cards at random instead."',
    ],
    {
      spellAbility: spell({
        targets: chosen.targets,
        effects: [
          {
            op: 'conditionalEffect',
            condition: {
              kind: 'compareValues',
              left: { kind: 'cardTypesInYourGraveyard' },
              cmp: '>=',
              right: constant(4),
            },
            then: [
              {
                op: 'discardTarget',
                target: chosen.slot.opponent,
                count: constant(2),
                atRandom: true,
              },
            ],
            else: [
              {
                op: 'discardTarget',
                target: chosen.slot.opponent,
                count: constant(1),
                atRandom: true,
              },
            ],
          },
        ],
        description: 'Target opponent discards one card at random, or two with delirium',
      }),
    },
    'Evaluate distinct card types in your graveyard at resolution; opponents’ graveyards and the resolving spell do not count.',
  );
}

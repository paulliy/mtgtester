/** Authored hand-disruption and upkeep-reveal behavior for white-black-control. */

import { allOf, not, ofType } from '../selector';
import { onUpkeep, spell, triggered, targetSlots } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

const NONCREATURE_NONLAND = allOf(not(ofType('Creature')), not(ofType('Land')));
const NONLAND = not(ofType('Land'));
const opponent = targetSlots({ player: { kind: 'player', controller: 'opponent' } });
const anyPlayer = targetSlots({ player: { kind: 'player' } });

export function registerWhiteBlackControlHandOverrides(): void {
  replaceCard(
    '33d405ea-7a9a-4970-b70f-9c05d90dd6f0',
    'Duress',
    [
      'unrecognized rules text: "Target opponent reveals their hand. You choose a noncreature, nonland card from it. That player discards that card."',
    ],
    {
      spellAbility: spell({
        targets: opponent.targets,
        effects: [
          { op: 'revealHandAndDiscard', target: opponent.slot.player, filter: NONCREATURE_NONLAND },
        ],
        description:
          'Target opponent reveals their hand. You choose a noncreature, nonland card from it to discard',
      }),
    },
    'Restores Duress with an opponent-only target and the printed noncreature, nonland hand filter.',
  );

  replaceCard(
    'edd8d1e8-be43-4c38-bb3a-83081fbaf0b5',
    'Thoughtseize',
    [
      'unrecognized rules text: "Target player reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life."',
    ],
    {
      spellAbility: spell({
        targets: anyPlayer.targets,
        effects: [
          { op: 'revealHandAndDiscard', target: anyPlayer.slot.player, filter: NONLAND },
          { op: 'loseLife', amount: constant(2) },
        ],
        description:
          'Target player reveals their hand. You choose a nonland card from it to discard. You lose 2 life',
      }),
    },
    'Restores Thoughtseize with any-player targeting, a nonland hand filter, and its unconditional life loss.',
  );

  replaceCard(
    '2068185c-1b50-47d0-aa3f-bf505d199428',
    'Dark Confidant',
    [
      'unrecognized rules text: "At the beginning of your upkeep, reveal the top card of your library and put that card into your hand. You lose life equal to its mana value."',
    ],
    {
      triggers: [
        triggered(onUpkeep(), {
          effects: [{ op: 'drawRevealTopLoseManaValue' }],
          description:
            'Reveal the top card of your library, put it into your hand, and lose life equal to its mana value',
        }),
      ],
    },
    'Replaces the draw approximation with the reveal-and-put primitive, preserving no-draw events and empty-library behavior.',
  );
}

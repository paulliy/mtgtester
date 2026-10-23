import { counterSpellTarget, spell, targetSlots } from '../templates';
import { replaceCard } from './index';

export function registerWhiteBlackControlImpOverrides(): void {
  const chosen = targetSlots({
    spell: { ...counterSpellTarget('spell'), spellHasSingleTarget: true },
  });
  replaceCard(
    '30ec73ad-c7a1-4527-8dc6-44bdd65b9ba6',
    "Imp's Mischief",
    [
      'unrecognized rules text: "Change the target of target spell with a single target. You lose life equal to that spell\'s mana value."',
    ],
    {
      spellAbility: spell({
        targets: chosen.targets,
        effects: [
          { op: 'changeSingleSpellTarget', target: chosen.slot.spell },
          { op: 'loseLife', amount: { kind: 'manaValueOfTarget', target: chosen.slot.spell } },
        ],
        description: 'Change target single-target spell and lose life equal to its mana value',
      }),
    },
    'Counts actual targeting occurrences, changes the existing spell using its original controller and source legality, and queues ward and becomes-targeted triggers.',
  );
}

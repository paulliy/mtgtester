import { counterSpellTarget, spell, targetSlots } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlProtectionStackOverrides(): void {
  const returnedSpell = targetSlots({ spell: counterSpellTarget('spell') });
  // Mother of Runes and Sejiri Shelter: no override needed — "target creature you control gains
  // protection from the color of your choice until end of turn" now parses as an ordinary effect
  // sentence, both as Mother's tap ability and as Sejiri Shelter's spell. Deleted rather than
  // kept-empty.
  replaceCard(
    'f0449cbd-855c-4c20-a1f5-f76a395d8d39',
    'Reprieve',
    ['unrecognized rules text: "Return target spell to its owner\'s hand."'],
    {
      spellAbility: spell({
        targets: returnedSpell.targets,
        effects: [
          { op: 'returnSpellToOwnerHand', target: returnedSpell.slot.spell },
          { op: 'draw', count: constant(1) },
        ],
        description: "Return target spell to its owner's hand. Draw a card",
      }),
    },
    'Returns a stack spell rather than countering it, including uncounterable spells; retains the draw clause.',
  );
  // Rebuff the Wicked: no override needed — "counter target spell that targets a permanent you
  // control" now parses as a spell line with the same target restriction. Deleted rather than
  // kept-empty.
}

import { YOURS } from '../selector';
import { counterSpellTarget, spell, targetSlots } from '../templates';
import { replaceCard } from './index';

export function registerWhiteBlackControlGiftOverrides(): void {
  const targetSpell = targetSlots({ spell: counterSpellTarget('spell') });
  replaceCard(
    'ef71ef07-8a35-41ec-a851-d95e9e3a221b',
    "Bilbo's Gambit",
    [
      'unrecognized rules text: "Gift a Treasure"',
      'unrecognized rules text: "Return target spell to its owner\'s hand. If the gift was promised, players can\'t cast spells this turn."',
    ],
    {
      gift: 'treasure',
      spellAbility: spell({
        targets: targetSpell.targets,
        effects: [
          { op: 'returnSpellToOwnerHand', target: targetSpell.slot.spell },
          {
            op: 'conditionalEffect',
            condition: { kind: 'giftPromised' },
            then: [{ op: 'prohibitSpellsThisTurn' }],
            else: [],
          },
        ],
        description:
          "Return target spell to its owner's hand; if a gift was promised, players cannot cast spells this turn",
      }),
    },
    'Promises a non-targeted opponent during casting, creates their Treasure before other resolving effects, and prohibits all players from casting for the remainder of this turn only.',
  );

  replaceCard(
    '37c06f89-db36-4937-9404-2b07cd22e1a6',
    "Dawn's Truce",
    [
      'unrecognized rules text: "Gift a card"',
      'unrecognized rules text: "You and permanents you control gain hexproof until end of turn. If the gift was promised, permanents you control also gain indestructible until end of turn."',
    ],
    {
      gift: 'card',
      spellAbility: spell({
        effects: [
          { op: 'controllerHexproofUntilEot' },
          { op: 'grantKeywordEachUntilEot', selector: YOURS, keyword: 'hexproof' },
          {
            op: 'conditionalEffect',
            condition: { kind: 'giftPromised' },
            then: [{ op: 'grantKeywordEachUntilEot', selector: YOURS, keyword: 'indestructible' }],
            else: [],
          },
        ],
        description:
          'You and your permanents gain hexproof; promised gift also grants your permanents indestructible this turn',
      }),
    },
    'The promised opponent draws before protection is applied. Player hexproof and fixed-set permanent grants last through this turn only.',
  );
}

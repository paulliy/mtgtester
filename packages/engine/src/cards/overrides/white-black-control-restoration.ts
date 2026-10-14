import { YOURS } from '../selector';
import { mana, spell, targetSlots } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlRestorationOverrides(): void {
  const chosen = targetSlots({ cure: { kind: 'permanent' }, cura: { kind: 'permanent' } });
  replaceCard(
    'ddbe0d17-5cac-417c-afc0-e4aebae83205',
    'Restoration Magic',
    [
      'unrecognized rules text: "Tiered"',
      'unrecognized rules text: "• Cure — {0} — Target permanent gains hexproof and indestructible until end of turn."',
      'unrecognized rules text: "• Cura — {1} — Target permanent gains hexproof and indestructible until end of turn. You gain 3 life."',
      'unrecognized rules text: "• Curaga — {3}{W} — Permanents you control gain hexproof and indestructible until end of turn. You gain 6 life."',
    ],
    {
      spellAbility: spell({
        targets: chosen.targets,
        effects: [],
        modes: {
          minChoices: 1,
          maxChoices: 1,
          options: [
            {
              description: 'Cure',
              additionalCost: [mana('{0}')],
              targetSlots: [chosen.slot.cure],
              effects: [
                { op: 'grantKeywordUntilEot', target: chosen.slot.cure, keyword: 'hexproof' },
                { op: 'grantKeywordUntilEot', target: chosen.slot.cure, keyword: 'indestructible' },
              ],
            },
            {
              description: 'Cura',
              additionalCost: [mana('{1}')],
              targetSlots: [chosen.slot.cura],
              effects: [
                { op: 'grantKeywordUntilEot', target: chosen.slot.cura, keyword: 'hexproof' },
                { op: 'grantKeywordUntilEot', target: chosen.slot.cura, keyword: 'indestructible' },
                { op: 'gainLife', amount: constant(3) },
              ],
            },
            {
              description: 'Curaga',
              additionalCost: [mana('{3}{W}')],
              targetSlots: [],
              effects: [
                { op: 'grantKeywordEachUntilEot', selector: YOURS, keyword: 'hexproof' },
                { op: 'grantKeywordEachUntilEot', selector: YOURS, keyword: 'indestructible' },
                { op: 'gainLife', amount: constant(6) },
              ],
            },
          ],
        },
        description: 'Choose and pay exactly one tier in addition to the printed mana cost',
      }),
    },
    'Uses existing mode-bound additional-cost announcement and payment, with targets announced only for the chosen tier and fixed-set permanent protection until cleanup.',
  );
}

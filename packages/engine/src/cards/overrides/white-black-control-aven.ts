import { counterSpellTarget, targetSlots, triggered } from '../templates';
import { replaceCard } from './index';

export function registerWhiteBlackControlAvenOverrides(): void {
  const spellTarget = targetSlots({ spell: counterSpellTarget('spell') });
  replaceCard(
    'd31fd12f-b4dd-4bc3-ace4-703dabd0f607',
    'Aven Interrupter',
    [
      'unrecognized rules text: "When this creature enters, exile target spell. It becomes plotted."',
      'unrecognized rules text: "Spells your opponents cast from graveyards or from exile cost {2} more to cast."',
    ],
    {
      triggers: [
        triggered(
          { when: 'enters', subject: { kind: 'self' } },
          {
            targets: spellTarget.targets,
            effects: [{ op: 'exileSpellAndPlot', target: spellTarget.slot.spell }],
            description:
              'Exile target spell; its owner may cast it as a sorcery on a later turn without paying its mana cost',
          },
        ),
      ],
      ruleStatics: [{ kind: 'opponentNonHandSpellCostIncrease', amount: 2 }],
    },
    'Exiles without countering and gives the exiled incarnation an owner-only, later-turn sorcery-speed plot permission; opposing graveyard/exile casts pay an additive cost increase, including plot casts.',
  );
}

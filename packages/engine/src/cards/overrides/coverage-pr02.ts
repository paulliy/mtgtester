/**
 * Coverage PR02 (docs/plans/card-coverage-chunks.md): cards that had no registration at all.
 * Each one meets the completion standard individually and is gated by the PR02 restoration
 * gate in `tests/pr02-card-coverage.test.ts`, so this file is not part of the catalog audit
 * inventory.
 */

import { activated, mana, targetSlots, triggered } from '../templates';
import { defineCard } from './index';

export function registerCoveragePr02Overrides(): void {
  // Kogla and Yidaro: a modal enters trigger whose "it" is Kogla and Yidaro itself, and a
  // channel-style hand ability. Its "up to one" target may be left empty; the shuffle reads the
  // discarded card in the graveyard (it does nothing if the card has left), and the draw happens
  // either way.
  const fight = targetSlots({ creature: { kind: 'creature', controller: 'opponent' } });
  const channel = targetSlots({
    artifactOrEnchantment: { kind: 'artifactOrEnchantment', count: { min: 0, max: 1 } },
  });
  defineCard(
    'fe8c2b7e-f80d-4acb-a976-edcf436a78a9',
    'Kogla and Yidaro',
    [
      'When ~ enters, choose one —',
      '• It gains trample and haste until end of turn.',
      "• It fights target creature you don't control.",
      '{2}{R}{G}, Discard this card: Destroy up to one target artifact or enchantment. Shuffle this card into your library from your graveyard, then draw a card.',
    ],
    {
      triggers: [
        triggered(
          { when: 'enters', subject: { kind: 'self' } },
          {
            targets: fight.targets,
            effects: [],
            modes: {
              minChoices: 1,
              maxChoices: 1,
              options: [
                {
                  description: 'It gains trample and haste until end of turn',
                  effects: [
                    { op: 'grantKeywordUntilEot', target: 'source', keyword: 'trample' },
                    { op: 'grantKeywordUntilEot', target: 'source', keyword: 'haste' },
                  ],
                  targetSlots: [],
                },
                {
                  description: "It fights target creature you don't control",
                  effects: [{ op: 'fight', first: 'source', second: fight.slot.creature }],
                  targetSlots: [fight.slot.creature],
                },
              ],
            },
            description: 'When Kogla and Yidaro enters, choose one',
          },
        ),
      ],
      activatedAbilities: [
        activated({
          costs: [mana('{2}{R}{G}'), { kind: 'discardSelf' }],
          zone: 'hand',
          targets: channel.targets,
          effects: [
            { op: 'destroyEachChosen', targetSlot: channel.slot.artifactOrEnchantment },
            { op: 'shuffleSourceFromGraveyardIntoLibrary' },
            { op: 'draw', count: { kind: 'const', n: 1 } },
          ],
          description:
            'Destroy up to one target artifact or enchantment, shuffle this card into your library, then draw a card',
        }),
      ],
    },
  );
}

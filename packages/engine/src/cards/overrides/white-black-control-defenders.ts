import { activated, mana, SAC_SELF, targetSlots } from '../templates';
import { replaceCard } from './index';

export function registerWhiteBlackControlDefenderOverrides(): void {
  const chosen = targetSlots({
    creature: { kind: 'creature', filter: { kind: 'attackingYouOrYourPlaneswalker' } },
  });
  replaceCard(
    '0e3ac581-3d78-4879-9afb-3db69c5c47a5',
    'Archon of Absolution',
    [
      'unrecognized rules text: "Creatures can\'t attack you or planeswalkers you control unless their controller pays {1} for each of those creatures."',
    ],
    { ruleStatics: [{ kind: 'attackTax', amount: 1, includePlaneswalkers: true }] },
    'Taxes each attacking creature against you or your planeswalkers; preserves parsed flying and protection from white.',
  );
  replaceCard(
    '52bd4331-67b6-4eb8-9566-e00359889fc6',
    'Soul Snare',
    [
      'unrecognized rules text: "{W}, Sacrifice this enchantment: Exile target creature that\'s attacking you or a planeswalker you control."',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{W}'), SAC_SELF],
          targets: chosen.targets,
          effects: [{ op: 'exile', target: chosen.slot.creature }],
          description: 'Exile target creature attacking you or your planeswalker',
        }),
      ],
    },
    'Uses the ordinary mana and sacrifice activation cost with exact current defending-player and planeswalker targeting.',
  );
}

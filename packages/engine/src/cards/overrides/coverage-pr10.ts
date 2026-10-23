/** PR10 authored stack, copy and characteristic operations. Evidence is tracked in the manifest. */
import { countPermanents } from '../condition';
import { allOf, anyOf, ofType, powerAtLeast } from '../selector';
import { counterSpellTarget } from '../target-builders';
import { spell, targetSlots } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

/**
 * Replace contained approximations only with complete printed abilities. Registered from
 * `index.ts` once each card's manifest and viewer evidence lands; until then only the PR10
 * engine suites install it, in their own isolated module graph.
 */
export function registerCoveragePr10Overrides(): void {
  // PR10.01: choosing new targets changes the targets of the same object; it is not a copy.
  const swat = targetSlots({ object: { kind: 'stackObject' } });
  replaceCard(
    'ae120613-97d6-4393-b39d-c3e6c076f5d6',
    'Deflecting Swat',
    ['You may choose new targets for target spell or ability.'],
    {
      spellAbility: spell({
        targets: swat.targets,
        effects: [{ op: 'chooseNewTargets', target: swat.slot.object }],
        description: 'You may choose new targets for target spell or ability',
      }),
    },
    'PR10 retargets the same stack object instead of copying it.',
  );

  // PR10.11: "change the target" must pick another legal target when one exists (CR 115.7a).
  const bend = targetSlots({ object: { kind: 'stackObject', spellHasSingleTarget: true } });
  replaceCard(
    'c20a96f7-aa5a-4c15-b8b1-806685c99b27',
    'Bolt Bend',
    [
      'This spell costs {3} less to cast if you control a creature with power 4 or greater.',
      'Change the target of target spell or ability with a single target.',
    ],
    {
      ruleStatics: [
        {
          kind: 'costReduction',
          amount: constant(3),
          selfOnly: true,
          condition: countPermanents(allOf(ofType('Creature'), powerAtLeast(4)), 'you', '>=', 1),
        },
      ],
      spellAbility: spell({
        targets: bend.targets,
        effects: [{ op: 'changeSingleTarget', target: bend.slot.object }],
        description: 'Change the target of target spell or ability with a single target',
      }),
    },
    'PR10 changes the single target of the same stack object instead of copying it.',
  );

  // PR10.06, 10.14, 10.12: a copy whose controller may choose new targets (CR 707.10c).
  const instantOrSorcery = anyOf(ofType('Instant'), ofType('Sorcery'));
  const copyOne = targetSlots({ spell: counterSpellTarget('spell', { filter: instantOrSorcery }) });
  const copyOneAbility = spell({
    targets: copyOne.targets,
    effects: [{ op: 'copyTargetSpell', target: copyOne.slot.spell, newTargets: true }],
    description: 'Copy target instant or sorcery spell. You may choose new targets for the copy',
  });
  replaceCard(
    'a1f55890-31c5-4ed4-a2cd-7a4a9f05f8ca',
    'Reverberate',
    ['Copy target instant or sorcery spell. You may choose new targets for the copy.'],
    { spellAbility: copyOneAbility },
    'PR10 lets the copy choose new targets instead of keeping the original ones.',
  );
  replaceCard(
    'f586ecb8-310c-4f40-a766-6a7ca46a254d',
    'Flare of Duplication',
    ['Copy target instant or sorcery spell. You may choose new targets for the copy.'],
    { spellAbility: copyOneAbility },
    'PR10 lets the copy choose new targets; the interpreter reads the sacrifice alternative cost.',
  );
  const copyMany = targetSlots({
    spells: {
      ...counterSpellTarget('spell', { filter: instantOrSorcery }),
      count: { min: 0, max: Infinity },
    },
  });
  replaceCard(
    '99140891-face-4015-aacd-1309e87d8f9f',
    'Display of Power',
    [
      "This spell can't be copied.",
      'Copy any number of target instant and/or sorcery spells. You may choose new targets for the copies.',
    ],
    {
      cantBeCopied: true,
      spellAbility: spell({
        targets: copyMany.targets,
        effects: [
          { op: 'copyEachTargetedSpell', targetSlot: copyMany.slot.spells, newTargets: true },
        ],
        description:
          'Copy any number of target instant and/or sorcery spells. You may choose new targets for the copies',
      }),
    },
    'PR10 cannot be copied, and each copy may choose new targets.',
  );
}

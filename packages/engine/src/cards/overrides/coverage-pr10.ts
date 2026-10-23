/** PR10 authored stack, copy and characteristic operations. Evidence is tracked in the manifest. */
import { countPermanents } from '../condition';
import { allOf, anyOf, not, ofType, powerAtLeast } from '../selector';
import { counterSpellTarget } from '../target-builders';
import { onCast, spell, targetSlots, triggered } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

/**
 * Every PR10 override, for the PR10 engine suites. `index.ts` registers each group only once its
 * cards' manifest and Card Test Lab evidence has landed.
 */
export function registerCoveragePr10Overrides(): void {
  registerPr10RetargetAndCopyOverrides();
  registerPr10CastCopyOverrides();
}

/** PR10.01, 10.11, 10.06, 10.14, 10.12: retargeting and spell copies with new targets. */
export function registerPr10RetargetAndCopyOverrides(): void {
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

/** PR10.19, 10.26: copies of a cast spell made by a cast trigger (CR 707.10c). */
export function registerPr10CastCopyOverrides(): void {
  // PR10.19: a one-shot delayed cast trigger that lapses at cleanup; flashback is interpreted.
  replaceCard(
    'c51ed6e3-813b-49c4-b1de-7f92a77f8f6e',
    'Galvanic Iteration',
    [
      'When you next cast an instant or sorcery spell this turn, copy that spell. You may choose new targets for the copy.',
    ],
    {
      spellAbility: spell({
        effects: [
          {
            op: 'nextCastThisTurn',
            filter: anyOf(ofType('Instant'), ofType('Sorcery')),
            ability: triggered(undefined, {
              effects: [{ op: 'copyCastSpell' }],
              description: 'Copy that spell. You may choose new targets for the copy',
            }),
          },
        ],
        description:
          'When you next cast an instant or sorcery spell this turn, copy that spell. You may choose new targets for the copy',
      }),
    },
    'PR10 copies the next instant or sorcery cast this turn, with new targets.',
  );

  // PR10.26: "your first main phase" is the precombat main phase (CR 505.1a).
  replaceCard(
    '2469c0b7-a045-4733-bf53-28f3fdbe3797',
    'Cosmic Crucible',
    [
      'At the beginning of your first main phase, add four mana in any combination of colors.',
      'Whenever you cast a noncreature spell, you may copy it. You may choose new targets for the copy. Do this only once each turn.',
    ],
    {
      triggers: [
        triggered(
          { when: 'precombatMain', player: 'you' },
          {
            effects: [{ op: 'addMana', amount: constant(4), colors: 'any' }],
            description: 'Add four mana in any combination of colors',
          },
        ),
        triggered(onCast('you', not(ofType('Creature'))), {
          effects: [{ op: 'copyCastSpell', optional: true, oncePerTurn: true }],
          description:
            'You may copy that noncreature spell. You may choose new targets for the copy. Do this only once each turn',
        }),
      ],
    },
    'PR10 adds the first-main-phase mana and copies one noncreature spell each turn.',
  );
}

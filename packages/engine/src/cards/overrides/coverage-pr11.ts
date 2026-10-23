/** PR11 authored protection, phasing, layout and lifecycle cards. Review status is in the manifest. */
import { allOf, hasCounter, not, OPPONENTS, ofType, YOURS } from '../selector';
import {
  activated,
  mana,
  manaCost,
  onDrawStep,
  onEtb,
  onUpkeep,
  spell,
  TAP,
  targetSlots,
  triggered,
} from '../templates';
import type { Ability } from '../ability';
import { constant } from '../value';
import { KNIGHT_2_2_WHITE_VIGILANCE } from '../tokens';
import { defineCard, extendCard, replaceCard } from './index';

export function registerCoveragePr11Overrides(): void {
  // PR11: the creatures are fixed at resolution (CR 611.2c) and "can't have" outlasts any later
  // grant of hexproof or shroud until end of turn.
  replaceCard(
    '30ac68e6-160a-41f9-9f0f-0e0eef383150',
    'Arcane Lighthouse',
    [
      "{1}, {T}: Until end of turn, creatures your opponents control lose hexproof and shroud and can't have hexproof or shroud.",
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{1}'), TAP],
          effects: [
            {
              op: 'denyKeywordsEachUntilEot',
              selector: allOf(ofType('Creature'), OPPONENTS),
              keywords: ['hexproof', 'shroud'],
            },
          ],
          description:
            "{1}, {T}: Until end of turn, creatures your opponents control lose hexproof and shroud and can't have them",
        }),
      ],
    },
    'PR11 removes and denies hexproof and shroud instead of granting menace.',
  );

  // PR11: protection from multicolored is read by the keyword line; the dies trigger reads the
  // dying creature's last known counters (CR 603.10a).
  extendCard(
    '57d0c688-6206-4c83-9fcb-27fd29e2a9ed',
    "Basri's Lieutenant",
    [
      'unrecognized rules text: "Whenever this creature or another creature you control dies, if it had a +1/+1 counter on it, create a 2/2 white Knight creature token with vigilance."',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'dies',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
          },
          {
            condition: { kind: 'triggerObjectMatches', selector: hasCounter('+1/+1') },
            effects: [{ op: 'createToken', spec: KNIGHT_2_2_WHITE_VIGILANCE, count: constant(1) }],
            description:
              'When this or another creature you control dies with a +1/+1 counter, create a 2/2 white Knight with vigilance',
          },
        ),
      ],
    },
  );

  // PR11: a static of Shanna herself; spells may still target her.
  extendCard(
    '546201d0-3fa5-44e4-a526-ab0945711e49',
    "Shanna, Sisay's Legacy",
    ['unrecognized rules text: "~ can\'t be the target of abilities your opponents control."'],
    { ruleStatics: [{ kind: 'cantBeTargetedByOpponentAbilities' }] },
  );

  registerPr11PhasingOverrides();
  registerPr11LifecycleOverrides();
}

/** PR11.05, 11.18, 11.20, 11.22: phasing and player protection. */
function registerPr11PhasingOverrides(): void {
  // PR11.18: the life lock and protection from everything both last until your next turn.
  defineCard(
    '0d4ecdb1-ec90-497f-a7a4-1c68092b8757',
    "Teferi's Protection",
    [
      'unrecognized rules text: "Until your next turn, your life total can\'t change and you gain protection from everything. All permanents you control phase out."',
    ],
    {
      spellAbility: spell({
        effects: [
          { op: 'phaseOutAndProtectControllerUntilNextTurn' },
          { op: 'resolvingSpellExile' },
        ],
        description:
          "Until your next turn, your life total can't change and you have protection from everything; your permanents phase out; exile this spell",
      }),
    },
  );

  // PR11.20: protection from everything without the life lock; the cast check is an
  // intervening if (CR 603.4).
  defineCard(
    '3aa83ed2-f48b-4ce6-a614-2c54ddf50538',
    'The One Ring',
    [
      'unrecognized rules text: "When ~ enters, if you cast it, you gain protection from everything until your next turn."',
      'unrecognized rules text: "At the beginning of your upkeep, you lose 1 life for each burden counter on ~."',
      'unrecognized rules text: "{T}: Put a burden counter on ~, then draw a card for each burden counter on ~."',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          condition: { kind: 'sourceWasCast' },
          effects: [{ op: 'controllerProtectionFromEverythingUntilNextTurn' }],
          description:
            'When this enters, if you cast it, you gain protection from everything until your next turn',
        }),
        triggered(onUpkeep('you'), {
          effects: [{ op: 'loseLife', amount: { kind: 'countersOnSelf', counter: 'burden' } }],
          description: 'At the beginning of your upkeep, lose 1 life for each burden counter',
        }),
      ],
      activatedAbilities: [
        activated({
          costs: [TAP],
          effects: [
            { op: 'putCounters', target: 'source', counter: 'burden', count: constant(1) },
            { op: 'draw', count: { kind: 'countersOnSelf', counter: 'burden' } },
          ],
          description:
            '{T}: Put a burden counter on this, then draw a card for each burden counter',
        }),
      ],
    },
  );

  // PR11.22: each chosen permanent phases out with whatever is attached to it.
  const concealed = targetSlots({
    permanents: {
      kind: 'permanent',
      filter: allOf(not(ofType('Land')), YOURS),
      count: { min: 0, max: Infinity },
    },
  });
  defineCard(
    '42bb7ea9-f6e4-4551-8d93-3b1eae84b865',
    'Clever Concealment',
    ['unrecognized rules text: "Any number of target nonland permanents you control phase out."'],
    {
      spellAbility: spell({
        targets: concealed.targets,
        effects: [{ op: 'phaseOutEachChosen', targetSlot: concealed.slot.permanents }],
        description: 'Any number of target nonland permanents you control phase out',
      }),
    },
  );

  // PR11.05: split second is the keyword; "can't lose" covers every loss this turn, and the
  // life floor applies to damage only.
  replaceCard(
    '66ca8a60-e028-4a5f-8177-860b888cb9d1',
    "Angel's Grace",
    [
      'unrecognized rules text: "You can\'t lose the game this turn and your opponents can\'t win the game this turn. Until end of turn, damage that would reduce your life total to less than 1 reduces it to 1 instead."',
    ],
    {
      spellAbility: spell({
        effects: [{ op: 'angelGrace' }],
        description:
          "You can't lose and your opponents can't win this turn; damage can't reduce your life below 1 this turn",
      }),
    },
    'PR11 implements split second and the full cannot-lose clause instead of a life floor alone.',
  );
}

/**
 * CR 702.24a: cumulative upkeep. Put an age counter on the permanent, then sacrifice it unless
 * its controller pays the cost once for each age counter. Only generic costs are authored.
 */
function cumulativeUpkeep(generic: number): Ability {
  return triggered(onUpkeep('you'), {
    effects: [
      { op: 'putCounters', target: 'source', counter: 'age', count: constant(1) },
      {
        op: 'unlessPays',
        payer: 'controller',
        cost: manaCost('{0}'),
        genericValue: { kind: 'times', of: { kind: 'countersOnSelf', counter: 'age' }, n: generic },
        then: [{ op: 'sacrifice', target: 'source' }],
      },
    ],
    description: `Cumulative upkeep {${generic}}: add an age counter, then pay {${generic}} per age counter or sacrifice this`,
  });
}

/** PR11.03, .08, .09, .12, .15, .16, .17, .19, .28: permanents with a lifecycle. */
function registerPr11LifecycleOverrides(): void {
  // PR11.19: the untap is optional and paid on resolution; the draw-step damage is an
  // intervening if on the artifact being tapped.
  extendCard(
    '736892cb-a34b-4bb9-b56c-e26e3db207a2',
    'Mana Vault',
    [
      'unrecognized rules text: "~ doesn\'t untap during your untap step."',
      'unrecognized rules text: "At the beginning of your upkeep, you may pay {4}. If you do, untap this artifact."',
      'unrecognized rules text: "At the beginning of your draw step, if this artifact is tapped, it deals 1 damage to you."',
    ],
    {
      doesntUntapDuringUntapStep: true,
      triggers: [
        triggered(onUpkeep('you'), {
          effects: [
            {
              op: 'conditionalEffect',
              condition: { kind: 'mayPayMana', cost: manaCost('{4}') },
              then: [{ op: 'untapTarget', target: 'source' }],
              else: [],
            },
          ],
          description: 'At the beginning of your upkeep, you may pay {4} to untap this',
        }),
        triggered(onDrawStep('you'), {
          condition: { kind: 'not', of: { kind: 'isUntapped' } },
          effects: [{ op: 'damageController', amount: 1 }],
          description:
            'At the beginning of your draw step, if this is tapped, it deals 1 damage to you',
        }),
      ],
    },
  );

  // PR11.15: the opponent's draw trigger is interpreted; cumulative upkeep is authored.
  extendCard(
    '8a52f3c0-2552-4425-b2e3-5496eb2232a7',
    'Mystic Remora',
    ['unrecognized rules text: "Cumulative upkeep {1}"'],
    { triggers: [cumulativeUpkeep(1)] },
  );
}

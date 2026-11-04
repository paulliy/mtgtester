/** PR11 authored protection, phasing, layout and lifecycle cards. Review status is in the manifest. */
import {
  allOf,
  anyOf,
  CHOSEN_COLOR,
  hasCounter,
  not,
  OPPONENTS,
  ofType,
  OTHER,
  YOURS,
} from '../selector';
import {
  activated,
  graveyardCardTarget,
  lord,
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
import { KNIGHT_2_2_WHITE_VIGILANCE, SKELETON_4_1_BLACK_MENACE } from '../tokens';
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
  // intervening if on the artifact being tapped. "Doesn't untap during your untap step" is read by
  // the interpreter (EDHREC plan Phase 4 batch 3).
  extendCard(
    '736892cb-a34b-4bb9-b56c-e26e3db207a2',
    'Mana Vault',
    [
      'unrecognized rules text: "At the beginning of your upkeep, you may pay {4}. If you do, untap this artifact."',
      'unrecognized rules text: "At the beginning of your draw step, if this artifact is tapped, it deals 1 damage to you."',
    ],
    {
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

  // PR11.03: the soot counter is optional; each upkeep's sacrifice counts soot as it resolves,
  // so on your upkeep the order you stack the two triggers matters (CR 603.3b).
  replaceCard(
    'fda61506-ed79-47fd-badd-639185297913',
    'Smokestack',
    [
      'unrecognized rules text: "At the beginning of each player\'s upkeep, that player sacrifices a permanent of their choice for each soot counter on this artifact."',
    ],
    {
      triggers: [
        triggered(onUpkeep('you'), {
          optional: true,
          effects: [{ op: 'putCounters', target: 'source', counter: 'soot', count: constant(1) }],
          description: 'At the beginning of your upkeep, you may put a soot counter on this',
        }),
        triggered(onUpkeep('each'), {
          effects: [
            {
              op: 'eventPlayerSacrificesPermanents',
              count: { kind: 'countersOnSelf', counter: 'soot' },
            },
          ],
          description:
            "At the beginning of each player's upkeep, that player sacrifices a permanent for each soot counter",
        }),
      ],
    },
    'PR11 counts soot counters, starts with none, and makes only the upkeep player sacrifice.',
  );

  // PR11.09: the counters are put on at upkeep, not as it enters. The empty-library draw
  // replacement must return a creature card when there is one; only none means losing.
  replaceCard(
    '473a7998-669d-4181-83fe-f178a2e781f0',
    'Out of the Tombs',
    [
      'unrecognized rules text: "If you would draw a card while your library has no cards in it, instead return a creature card from your graveyard to the battlefield. If you can\'t, you lose the game."',
    ],
    {
      emptyLibraryCreatureReplacement: true,
      triggers: [
        triggered(onUpkeep('you'), {
          effects: [
            { op: 'putCounters', target: 'source', counter: 'eon', count: constant(2) },
            { op: 'mill', count: { kind: 'countersOnSelf', counter: 'eon' } },
          ],
          description:
            'At the beginning of your upkeep, put two eon counters on this, then mill one card per eon counter',
        }),
      ],
    },
    'PR11 adds the eon counters at upkeep only and requires returning a creature when able.',
  );

  // PR11.12: a triggered mana ability (CR 605.1b), so the extra mana is added with the land's;
  // a land that can make several colors gets it only when it makes the chosen one.
  replaceCard(
    '09b895ff-e729-48d1-bfc1-ea5fd7adda6a',
    'Caged Sun',
    [
      'unrecognized rules text: "As this artifact enters, choose a color."',
      'unrecognized rules text: "Creatures you control of the chosen color get +1/+1."',
      'unrecognized rules text: "Whenever a land\'s ability causes you to add one or more mana of the chosen color, add an additional one mana of that color."',
    ],
    {
      entersChoosingOption: {
        prompt: 'Choose a color',
        options: [
          { key: 'W', label: 'White' },
          { key: 'U', label: 'Blue' },
          { key: 'B', label: 'Black' },
          { key: 'R', label: 'Red' },
          { key: 'G', label: 'Green' },
        ],
      },
      staticEffects: [lord(allOf(ofType('Creature'), YOURS, CHOSEN_COLOR), 1, 1)],
      ruleStatics: [
        {
          kind: 'manaActivationRider',
          source: allOf(ofType('Land'), YOURS),
          add: { kind: 'chosenColorIfProduced' },
        },
      ],
    },
    'PR11 adds the chosen-color land mana as a triggered mana ability.',
  );

  // PR11.16: imprint links the exiled card to this object (CR 607.2a); the mana reads that card's
  // colors only while it stays in exile, so a colorless card or none makes no mana.
  defineCard(
    'ec3d4466-547c-4e02-b1b5-a156ec4637e9',
    'Chrome Mox',
    [
      'unrecognized rules text: "When this artifact enters, you may exile a nonartifact, nonland card from your hand."',
      'unsupported mana production: "{T}: Add one mana of any of the exiled card\'s colors."',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [{ op: 'exileFromHandWithSource', excludeTypes: ['Artifact', 'Land'] }],
          description:
            'Imprint — When this enters, you may exile a nonartifact, nonland card from your hand',
        }),
      ],
      manaAbilities: [{ units: [], dynamic: 'exiledWithSourceColors' }],
    },
  );

  // PR11.28: "exiled with this artifact" is the linked set on this object (CR 607.2a); the
  // upkeep check is an intervening if, and the flip is the controller's.
  const portalTarget = targetSlots({ card: graveyardCardTarget('opponent') });
  defineCard(
    '8430ae03-2d4c-4031-aa29-4d53815ded78',
    'Negative Zone Portal',
    [
      'unrecognized rules text: "{2}, {T}: Exile target card from an opponent\'s graveyard. If it\'s a creature card, draw a card."',
      'unrecognized rules text: "At the beginning of your upkeep, if there are four or more creature cards exiled with this artifact, flip a coin. If you lose the flip, sacrifice this artifact and return a card exiled with it at random to its owner\'s hand."',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{2}'), TAP],
          targets: portalTarget.targets,
          effects: [
            {
              op: 'exileGraveyardCardWithSource',
              target: portalTarget.slot.card,
              drawIfCardType: 'Creature',
            },
          ],
          description:
            "{2}, {T}: Exile target card from an opponent's graveyard; if it's a creature card, draw a card",
        }),
      ],
      triggers: [
        triggered(onUpkeep('you'), {
          condition: { kind: 'exiledWithSourceAtLeast', cardType: 'Creature', n: 4 },
          effects: [
            {
              op: 'flipCoin',
              onWin: [],
              onLose: [
                // In printed order: the return reads the sacrificed Portal's linked cards from
                // its last known information (CR 607.2a).
                { op: 'sacrifice', target: 'source' },
                { op: 'returnRandomExiledWithSourceToHand' },
              ],
            },
          ],
          description:
            'At the beginning of your upkeep, with four or more creature cards exiled with this, flip a coin; on a loss, sacrifice this and return one at random',
        }),
      ],
    },
  );

  // PR11.17: an opening-hand action (CR 103.6) only for a player who isn't the starting player;
  // the luck counter turns the colorless mana into any color, "instead".
  defineCard(
    'c0adbddc-b070-4c5f-afe0-0474c72a9251',
    'Gemstone Caverns',
    [
      'unrecognized rules text: "If this card is in your opening hand and you\'re not the starting player, you may begin the game with ~ on the battlefield with a luck counter on it. If you do, exile a card from your hand."',
      'unrecognized rules text: "{T}: Add {C}. If ~ has a luck counter on it, instead add one mana of any color."',
    ],
    {
      ruleStatics: [
        {
          kind: 'beginOnBattlefieldFromOpeningHand',
          notStartingPlayer: true,
          withCounter: 'luck',
          exileCardFromHand: true,
        },
      ],
      manaAbilities: [
        {
          units: [['C']],
          conditionalUnits: {
            condition: { kind: 'sourceMatches', selector: hasCounter('luck') },
            units: [['W', 'U', 'B', 'R', 'G']],
          },
        },
      ],
    },
  );

  // PR11.08: "whenever you attack" fires once per attack declaration; the token was never
  // declared as an attacker (CR 508.4). Choose a Background is deck construction only
  // (CR 702.124 and the background pairing in deck validation); it does nothing in a game.
  replaceCard(
    '60e7130a-d321-4e50-93a4-999013c76054',
    'Gut, True Soul Zealot',
    [
      'unrecognized rules text: "Whenever you attack, you may sacrifice another creature or an artifact. If you do, create a 4/1 black Skeleton creature token with menace that\'s tapped and attacking."',
      'unrecognized rules text: "Choose a Background"',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'attacks',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
            aggregate: true,
          },
          {
            optional: true,
            effects: [
              {
                op: 'sacrificeOneThen',
                selector: anyOf(allOf(ofType('Creature'), OTHER), ofType('Artifact')),
                then: [
                  {
                    op: 'createTokenAttacking',
                    spec: SKELETON_4_1_BLACK_MENACE,
                    count: constant(1),
                  },
                ],
              },
            ],
            description:
              'Whenever you attack, you may sacrifice another creature or an artifact to create a tapped and attacking 4/1 Skeleton with menace',
          },
        ),
      ],
    },
    'PR11 authors the attack trigger; Choose a Background is a deck-construction rule.',
  );

  // PR11.15: the opponent's draw trigger is interpreted; cumulative upkeep is authored.
  extendCard(
    '8a52f3c0-2552-4425-b2e3-5496eb2232a7',
    'Mystic Remora',
    ['unrecognized rules text: "Cumulative upkeep {1}"'],
    { triggers: [cumulativeUpkeep(1)] },
  );
}

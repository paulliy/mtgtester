/** Authored overrides for marchesa-the-black-rose.txt. */

import type { CardDefinition } from '../definition';
import { TAP, spell, targetSlots, triggered } from '../templates';
import { counterSpellTarget } from '../target-builders';
import type { Ability } from '../ability';
import { constant } from '../value';
import { allOf, anyOf, hasCounter, IS_TOKEN, OTHER, not, ofType, YOURS } from '../selector';
import { BIRD_1_1_FLYING, ELDRAZI_SPAWN_0_1, TREASURE } from '../tokens';
import { defineCard, unsupportedCard } from './index';

// Dethrone (CR 702.105) has no generic keyword representation in this engine — every carrier
// (Marchesa's own trigger, the static ability she grants other creatures) is this same
// bespoke trigger. Dack's Duplicate needs it as an "enters as a copy, except it also has
// dethrone" addition, which is why it is exported here rather than inlined in MARCHESA.
const DETHRONE_TRIGGER: Ability = triggered(
  { when: 'attacks', subject: { kind: 'self' } },
  {
    eventCondition: { kind: 'attackingPlayerHasMoreLife' },
    effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 1 }],
    description: 'Dethrone — put a +1/+1 counter on this creature',
  },
);

const MARCHESA: Partial<CardDefinition> = {
  staticEffects: [
    {
      affects: allOf(OTHER, ofType('Creature'), YOURS),
      op: {
        layer: 6,
        // Granted dethrone is the creature's own ability (CR 702.103). `source` is that
        // creature because `triggersOf` reads the grant from its characteristics. Do not use
        // `triggerObject` here: self-triggers do not set `triggerObjectCardId`.
        addTrigger: DETHRONE_TRIGGER,
      },
    },
  ],
  triggers: [
    triggered(
      { when: 'attacks', subject: { kind: 'self' } },
      {
        eventCondition: { kind: 'attackingPlayerHasMoreLife' },
        effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 1 }],
        description: 'Dethrone — put a +1/+1 counter on Marchesa',
      },
    ),
    triggered(
      {
        when: 'dies',
        subject: {
          kind: 'permanent',
          selector: allOf(ofType('Creature'), YOURS, hasCounter('+1/+1')),
        },
      },
      {
        effects: [
          {
            op: 'registerDelayedTrigger',
            when: 'endStep',
            expiry: 'endStep',
            target: 'triggerObject',
            controller: 'source',
            ability: triggered(undefined, {
              effects: [{ op: 'graveyardToBattlefield', target: 'triggerObject' }],
              description: 'Return that creature to the battlefield',
            }),
          },
        ],
        description:
          'Whenever a countered creature you control dies — return it at the next end step',
      },
    ),
  ],
};

export function registerMARCHESA_THE_BLACK_ROSEOverrides(): void {
  // Catalog audit batch 3: bounce mode is untargeted choose-on-resolution, not "another target".
  // Coverage PR01: the mode is chosen as the trigger is put on the stack; only the bounce mode
  // targets, and "another" excludes the Channeler itself.
  defineCard(
    'fb220f46-f8b8-4804-baa4-e7d50b4871f7',
    'Aether Channeler',
    [
      'When this creature enters, choose one —',
      '• Create a 1/1 white Bird creature token with flying.',
      "• Return another target nonland permanent to its owner's hand.",
      '• Draw a card.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'permanent', filter: allOf(not(ofType('Land')), OTHER) }],
          effects: [],
          modes: {
            minChoices: 1,
            maxChoices: 1,
            options: [
              {
                description: 'Create a 1/1 white Bird creature token with flying',
                effects: [{ op: 'createToken', spec: BIRD_1_1_FLYING, count: constant(1) }],
                targetSlots: [],
              },
              {
                description: "Return another target nonland permanent to its owner's hand",
                effects: [{ op: 'returnToHand', target: 0 }],
                targetSlots: [0],
              },
              {
                description: 'Draw a card',
                effects: [{ op: 'draw', count: constant(1) }],
                targetSlots: [],
              },
            ],
          },
          description: 'When Aether Channeler enters, choose one',
        },
      ],
    },
  );
  defineCard(
    '137b5708-50a9-4f4c-84e6-9043be9f1989',
    'Anathemancer',
    [
      'When this creature enters, it deals damage to target player equal to the number of nonbasic lands that player controls.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'player' }],
          effects: [{ op: 'dealDamageNonbasicLands', target: 0 }],
          description: 'Enters — damage target player for their nonbasic lands',
        },
      ],
    },
  );
  // Blasphemous Edict: restored in coverage PR02. The interpreter reads the conditional {B}
  // alternative cost and "each player sacrifices thirteen creatures", so no override remains.
  // Body Launderer: restored in coverage PR03. The interpreter reads connive (CR 701.50) and the
  // return bounded by its last-known power.
  // Catalog audit batch 1: copyTargetSpell is not "change the target". Contain until a true
  // retarget primitive exists.
  unsupportedCard(
    'c20a96f7-aa5a-4c15-b8b1-806685c99b27',
    'Bolt Bend',
    'Change-the-target is implemented as copyTargetSpell; a copy is not a retarget.',
  );
  // Carrion Feeder: restored in coverage PR02. The interpreter reads "can't block" and the
  // sacrifice-a-creature cost, which may sacrifice Carrion Feeder itself (allowSelf).
  // Catalog audit batch 3: control change is permanent, not "for as long as this remains".
  unsupportedCard(
    '026ef98e-4f0a-4a6d-b74f-d17ac8b10e37',
    'Cytoplast Manipulator',
    'Gain-control duration is omitted; gainControlTarget is a permanent steal.',
  );
  defineCard(
    '724767ca-bd84-4137-9133-4ad2e96b8428',
    "Dack's Duplicate",
    [
      'You may have this creature enter as a copy of any creature on the battlefield, except it has haste and dethrone.',
    ],
    {
      entersAsCopy: {
        selector: ofType('Creature'),
        addKeywords: ['haste'],
        addTriggers: [DETHRONE_TRIGGER],
      },
    },
  );
  // Catalog audit marchesa-batch-9: put-into-hand is a draw, including empty-library loss.
  unsupportedCard(
    '2068185c-1b50-47d0-aa3f-bf505d199428',
    'Dark Confidant',
    'Reveal-and-put-into-hand is implemented as a draw, including empty-library loss.',
  );
  // Catalog audit batch 1: the commander-free-cast line parses, but "choose new targets"
  // was authored as copyTargetSpell. Contain until a true retarget primitive exists.
  unsupportedCard(
    'ae120613-97d6-4393-b39d-c3e6c076f5d6',
    'Deflecting Swat',
    'Choose-new-targets is implemented as copyTargetSpell; a copy is not a retarget.',
  );
  defineCard(
    '8f2c8498-5b10-4ec7-8678-598c90987556',
    'Disciple of Bolas',
    [
      "When this creature enters, sacrifice another creature. You gain X life and draw X cards, where X is that creature's power.",
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'sacrificeAndDrawForPower' }],
          description:
            'Sacrifice another creature, then gain life and draw cards equal to its power',
        },
      ],
    },
  );
  // Both lines now parse generically on their own, but NOT to the same targets: the generic
  // "counter target noncreature spell" rule restricts to an opponent's spell (matching the
  // established, deliberately-simplified "counter target spell" convention elsewhere in this
  // parser), while Fierce Guardianship's real text has no such restriction. Kept for that one
  // real behavioral difference, with empty handledLines since neither line is an unmodeled
  // reason to claim anymore.
  defineCard('d09c9cba-fdd2-479b-ad5d-d05181c3e3f9', 'Fierce Guardianship', [], {
    commanderFreeCast: true,
    spellAbility: {
      kind: 'spell',
      targets: [{ kind: 'noncreatureSpell' }],
      effects: [{ op: 'counter', target: 0 }],
      description: 'Counter target noncreature spell',
    },
  });
  // Coverage PR02: the interpreter reads the sacrifice-a-nontoken-blue-creature alternative cost.
  // Kept, like Fierce Guardianship, for one difference: the generic "counter target spell" rule
  // targets only an opponent's spell, while Flare of Denial may counter any spell.
  const denial = targetSlots({ spell: counterSpellTarget('spell') });
  defineCard('437cfd16-94bc-43ba-afd8-e9e9d028a4ca', 'Flare of Denial', [], {
    spellAbility: spell({
      targets: denial.targets,
      effects: [{ op: 'counter', target: denial.slot.spell }],
      description: 'Counter target spell',
    }),
  });
  // Catalog audit batch 5: sacrifice-a-nontoken-creature alternative costs are claimed, not authored.
  unsupportedCard(
    'f586ecb8-310c-4f40-a766-6a7ca46a254d',
    'Flare of Duplication',
    'Sacrifice alternative cost is missing, and copyTargetSpell copies original targets instead of choosing new ones.',
  );
  // Flare of Malice: restored in coverage PR02. The interpreter reads the sacrifice alternative
  // cost and the greatest-mana-value sacrifice, so no override remains.
  // Flayer of the Hatebound: restored in coverage PR03. The interpreter reads Undying and the
  // enters-from-your-graveyard damage trigger, so no override remains.
  defineCard(
    '77807103-bcd5-479f-bedd-f5d97aa6d3d2',
    'Forge of Heroes',
    [
      "{T}: Choose target commander that entered this turn. Put a +1/+1 counter on it if it's a creature and a loyalty counter on it if it's a planeswalker.",
    ],
    {
      activatedAbilities: [
        {
          costs: [TAP],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [
              {
                kind: 'permanent',
                filter: allOf({ kind: 'isCommander' }, { kind: 'enteredThisTurn' }),
              },
            ],
            effects: [
              {
                op: 'putCounterByPermanentType',
                target: 0,
                creatureCounter: '+1/+1',
                planeswalkerCounter: 'loyalty',
                count: 1,
              },
            ],
            description: 'Put a counter on a commander that entered this turn',
          },
        },
      ],
    },
  );
  // Gleeful Arsonist: restored in coverage PR03. The interpreter reads the opponent-cast damage
  // trigger and Undying, so no override remains.
  // Glen Elendra Archmage: restored in coverage PR03. The interpreter reads Persist as a dies
  // trigger that returns the card it became, so no override remains.
  defineCard(
    '6f4ac4a4-53ec-4bc9-8f5c-d4b801d867b2',
    'Grave Pact',
    [
      'Whenever a creature you control dies, each other player sacrifices a creature of their choice.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'dies',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
          },
          targets: [],
          effects: [{ op: 'sacrificeOneEachOpponent', filter: 'creature' }],
          description: 'Each other player sacrifices a creature',
        },
      ],
    },
  );
  defineCard(
    '366a218e-84d3-4cf9-bbc8-f2f8ecce92a3',
    'Herald of Secret Streams',
    ["Creatures you control with +1/+1 counters on them can't be blocked."],
    {
      staticEffects: [
        {
          affects: allOf(ofType('Creature'), YOURS, hasCounter('+1/+1')),
          op: { layer: 6, setCantBeBlocked: true },
        },
      ],
    },
  );
  // Iron Apprentice: restored in coverage PR04. The interpreter reads the dies trigger gated on
  // the creature's last-known counters and moves those counters, so no override remains.
  defineCard(
    '4fca09ac-8134-43d9-a84b-686db5e2bf69',
    'Kalain, Reclusive Painter',
    [
      'Other creatures you control enter with an additional +1/+1 counter on them for each mana from a Treasure spent to cast them.',
    ],
    {
      additionalCountersOnEntry: [
        {
          affects: allOf(OTHER, ofType('Creature'), YOURS),
          counter: '+1/+1',
          count: { kind: 'treasureManaSpent' },
        },
      ],
    },
  );
  // Kardur, Doomscourge: restored in coverage PR07 (see coverage-pr07.ts).
  defineCard(
    '73413bd5-8c40-4d45-8f05-c20c39ee4017',
    'Madame Null, Power Broker',
    [
      'Whenever another creature you control enters, you may pay life equal to its power. If you do, put that many +1/+1 counters on it.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'enters',
            subject: { kind: 'permanent', selector: allOf(OTHER, ofType('Creature'), YOURS) },
          },
          targets: [],
          effects: [{ op: 'mayPayLifeForTriggerPowerAndCounter' }],
          description:
            'Pay life equal to the entering creature’s power to put that many counters on it',
        },
      ],
    },
  );
  defineCard(
    '1b3e841e-0f8f-467d-9983-f9b8d081a67f',
    'Mahadi, Emporium Master',
    [
      'At the beginning of your end step, create a Treasure token for each creature that died this turn.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'endStep', player: 'you' },
          targets: [],
          effects: [
            { op: 'createToken', spec: TREASURE, count: { kind: 'creaturesDiedThisTurn' } },
          ],
          description: 'Create a Treasure for each creature that died this turn',
        },
      ],
    },
  );
  // Catalog audit batch 8: Wizard intervening if is omitted; delayed manaSpent is not captured.
  unsupportedCard(
    '35e2f82e-7ca3-4a92-9134-b7999eef5337',
    'Mana Sculpt',
    'Wizard intervening-if is omitted, and delayed manaSpent is not captured from the countered spell.',
  );
  defineCard(
    '17a59d3d-9e01-48cd-bb4a-3eaaa077751c',
    'Marchesa, the Black Rose',
    [
      'Dethrone',
      'Other creatures you control have dethrone.',
      'Whenever a creature you control with a +1/+1 counter on it dies, return that card to the battlefield under your control at the beginning of the next end step.',
    ],
    MARCHESA,
  );
  // Midnight Reaper no longer needs an override: the generic parser reads
  // "this creature deals 1 damage to you and you draw a card" now that the damage-to-controller
  // sentence exists (added for City of Brass), and produces the same IR.
  defineCard(
    '9bcaf141-1f1f-491f-aced-13dc093b9e2c',
    'Pawn of Ulamog',
    [
      'Whenever this creature or another nontoken creature you control dies, you may create a 0/1 colorless Eldrazi Spawn creature token. It has "Sacrifice this token: Add {C}."',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          optional: true,
          trigger: {
            when: 'dies',
            subject: {
              kind: 'permanent',
              selector: allOf(ofType('Creature'), YOURS, not(IS_TOKEN)),
            },
          },
          targets: [],
          effects: [{ op: 'createToken', spec: ELDRAZI_SPAWN_0_1, count: constant(1) }],
          description: 'Create an Eldrazi Spawn',
        },
      ],
    },
  );
  // Pensive Professor: restored in coverage PR04. The interpreter reads Increment and the
  // counters-put draw trigger, so no override remains.
  // Puppeteer Clique: restored in coverage PR03. The interpreter reads the reanimation with haste
  // and its bound end-step exile, and Persist, so no override remains.
  // River Kelpie: restored in coverage PR03. The interpreter reads both graveyard-origin triggers
  // and Persist, so no override remains.
  // Sage of Fables: restored in coverage PR02. The draw's cost is removeCountersFromAmong: a
  // +1/+1 counter from any creature you control, chosen as the cost is paid.
  // Satoru, the Infiltrator: restored in coverage PR03. The interpreter reads the self-inclusive
  // aggregate enters head and the uncast-or-free restriction, so no override remains.
  // Catalog audit batch 7: targeting restriction is omitted.
  unsupportedCard(
    '59c7496b-19a2-478b-b28f-6f153c2458ae',
    'Siren Stormtamer',
    'Counter target is any stack object, not only spells or abilities that target you or your creature.',
  );
  // Catalog audit batch 7: soot count, active player, and enters-with-soot are all wrong.
  unsupportedCard(
    'fda61506-ed79-47fd-badd-639185297913',
    'Smokestack',
    'Upkeep sacrifice hits every player for 1 and enters with a soot counter.',
  );
  defineCard(
    '8dcb35e5-ae44-455f-86e3-4a77d496ff34',
    'Spark Double',
    [
      "You may have this creature enter as a copy of a creature or planeswalker you control, except it enters with an additional +1/+1 counter on it if it's a creature, it enters with an additional loyalty counter on it if it's a planeswalker, and it isn't legendary.",
    ],
    {
      entersAsCopy: {
        selector: allOf(YOURS, anyOf(ofType('Creature'), ofType('Planeswalker'))),
        addCounterByType: { creatureCounter: '+1/+1', planeswalkerCounter: 'loyalty', count: 1 },
        removeSupertypes: ['Legendary'],
      },
    },
  );
  // The Ooze: restored in coverage PR03. The interpreter reads the counter-gated leave trigger
  // (last-known counters), the graveyard exile, and the Mutagen token, so no override remains.
  // Toxic Deluge: restored in coverage PR02. The interpreter reads the announced pay-X-life
  // additional cost and the -X/-X sweep, so no override remains.
  // Catalog audit batch 6: graveyard-origin and once-each-turn restrictions are omitted.
  unsupportedCard(
    '05d7222b-cc08-4f1f-8e35-6058599572ba',
    'Twilight Diviner',
    'Graveyard-origin and once-each-turn restrictions are omitted from the enter trigger.',
  );
  // Vigean Graftmage: restored in coverage PR04. The interpreter reads Graft 2 as its
  // enters-with counters and its move-a-counter trigger, so no override remains.
  // Catalog audit batch 8: one mode and one opponent, not one-or-more different players.
  unsupportedCard(
    '6dc7f837-158f-4ccf-86a5-a07a20891ec5',
    'Vindictive Lich',
    'Modes are choose-one rather than one-or-more targeting different players.',
  );
  // Watcher for Tomorrow: restored in coverage PR03. The interpreter reads Hideaway, the
  // leaves-the-battlefield trigger and its linked exiled card, so no override remains.
}

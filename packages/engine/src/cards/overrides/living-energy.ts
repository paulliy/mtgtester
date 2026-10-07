/**
 * Authored card overrides for living-energy.txt.
 */

import { constant } from '../value';
import { SAC_SELF, TAP, mana, manaCost, spell, targetSlots } from '../templates';
import {
  BEAST_3_3_GREEN,
  BEAST_6_6_ARTIFACT,
  NALAAR_AETHERJET,
  SERVO_1_1,
  THOPTER_1_1_FLYING,
  TREASURE,
} from '../tokens';
import { defineCard, extendCard, replaceCard, unimplemented, unsupportedCard } from './index';
import { allOf, anyOf, not, ofSubtype, ofSupertype, ofType, OTHER, SELF, YOURS } from '../selector';
import type { CardDefinition } from '../definition';

const ARTIFACT_OR_ARTIFICER = anyOf(ofType('Artifact'), ofSubtype('Artificer'));
const ARTIFACT_CREATURES_YOU_CONTROL = allOf(ofType('Artifact'), ofType('Creature'), YOURS);

/** Exported for clause-level tests and the reviewed Arcane Denial registration below. */
const ARCANE_DENIAL_TARGETS = targetSlots({ spell: { kind: 'spell' } });
export const ARCANE_DENIAL_DEF: Partial<CardDefinition> = {
  spellAbility: spell({
    targets: ARCANE_DENIAL_TARGETS.targets,
    effects: [
      { op: 'counter', target: ARCANE_DENIAL_TARGETS.slot.spell },
      {
        op: 'registerDelayedTrigger',
        target: ARCANE_DENIAL_TARGETS.slot.spell,
        when: 'upkeep',
        expiry: 'onFire',
        affectedPlayer: 'targetController',
        ability: {
          kind: 'triggered',
          targets: [],
          effects: [{ op: 'drawUpToN', count: 2, player: 'eventPlayer' }],
          description: 'The targeted spell controller may draw up to two cards',
        },
      },
      {
        op: 'registerDelayedTrigger',
        when: 'upkeep',
        expiry: 'onFire',
        affectedPlayer: 'sourceController',
        ability: {
          kind: 'triggered',
          targets: [],
          effects: [{ op: 'draw', count: constant(1), player: 'eventPlayer' }],
          description: 'Arcane Denial controller draws a card',
        },
      },
    ],
    description:
      "Counter target spell; at the beginning of the next turn's upkeep its controller may draw up to two cards and you draw a card",
  }),
};

const AETHERSQUALL_ANCIENT_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'upkeep', player: 'you' },
      targets: [],
      effects: [{ op: 'gainEnergy', amount: constant(3) }],
      description: 'Upkeep — gain three energy',
    },
  ],
  activatedAbilities: [
    {
      costs: [{ kind: 'payEnergy', amount: 8 }],
      timing: 'sorcery',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'returnToHandEach', selector: allOf(ofType('Creature'), OTHER) }],
        description: 'Pay eight energy — return all other creatures to their owners’ hands',
      },
    },
  ],
};

const AETHERTIDE_WHALE_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'enters', subject: { kind: 'self' } },
      targets: [],
      effects: [{ op: 'gainEnergy', amount: constant(6) }],
      description: 'Enters — gain six energy',
    },
  ],
  activatedAbilities: [
    {
      costs: [{ kind: 'payEnergy', amount: 4 }],
      timing: 'any',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'returnToHand', target: 'source' }],
        description: 'Pay four energy — return this creature to its owner’s hand',
      },
    },
  ],
};

const AETHERWIND_BASKER_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'enters', subject: { kind: 'self' } },
      targets: [],
      effects: [
        {
          op: 'gainEnergy',
          amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' },
        },
      ],
      description: 'Enters — gain energy for each creature you control',
    },
    {
      kind: 'triggered',
      trigger: { when: 'attacks', subject: { kind: 'self' } },
      targets: [],
      effects: [
        {
          op: 'gainEnergy',
          amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' },
        },
      ],
      description: 'Attacks — gain energy for each creature you control',
    },
  ],
  activatedAbilities: [
    {
      costs: [{ kind: 'payEnergy', amount: 1 }],
      timing: 'any',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'pumpUntilEot', target: 'source', power: 1, toughness: 1 }],
        description: 'Pay one energy — this creature gets +1/+1 until end of turn',
      },
    },
  ],
};

const ARCHITECT_OF_THE_UNTAMED_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: {
        when: 'enters',
        subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) },
      },
      targets: [],
      effects: [{ op: 'gainEnergy', amount: constant(1) }],
      description: 'A land enters under your control — gain one energy',
    },
  ],
  activatedAbilities: [
    {
      costs: [{ kind: 'payEnergy', amount: 8 }],
      timing: 'any',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'createToken', count: constant(1), spec: BEAST_6_6_ARTIFACT }],
        description: 'Pay eight energy — create a 6/6 Beast artifact creature token',
      },
    },
  ],
};

const BLASPHEMOUS_ACT_DEF: Partial<CardDefinition> = {
  ruleStatics: [
    {
      kind: 'costReduction',
      amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'all' },
      selfOnly: true,
    },
  ],
};

const BOOTLEGGERS_STASH_DEF: Partial<CardDefinition> = {
  staticEffects: [
    {
      affects: allOf(ofType('Land'), YOURS),
      op: {
        layer: 6,
        addActivatedAbility: {
          costs: [TAP],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [{ op: 'createToken', count: constant(1), spec: TREASURE }],
            description: 'Tap — create a Treasure token',
          },
        },
      },
    },
  ],
};

// Decoction Module's activated ability is no longer overridden: "return target creature you
// control to its owner's hand" parses generically now that the return-to-hand sentence reads its
// target noun through `parseTargetClause` (which handles the "you control" suffix) instead of a
// fixed three-noun list. Only the energy trigger still needs authoring.
const DECOCTION_MODULE_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: {
        when: 'enters',
        subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
      },
      targets: [],
      effects: [{ op: 'gainEnergy', amount: constant(1) }],
      description: 'A creature enters under your control — gain one energy',
    },
  ],
};

const ERA_OF_INNOVATION_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: {
        when: 'enters',
        subject: { kind: 'permanent', selector: allOf(ARTIFACT_OR_ARTIFICER, YOURS) },
      },
      targets: [],
      effects: [
        {
          op: 'conditionalEffect',
          condition: { kind: 'mayPayMana', cost: manaCost('{1}') },
          then: [{ op: 'gainEnergy', amount: constant(2) }],
          else: [],
        },
      ],
      description: 'An artifact or Artificer enters — you may pay {1} to gain two energy',
    },
  ],
  activatedAbilities: [
    {
      costs: [{ kind: 'payEnergy', amount: 6 }, SAC_SELF],
      timing: 'any',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'draw', count: constant(3) }],
        description: 'Pay six energy and sacrifice — draw three cards',
      },
    },
  ],
};

const FROSTBOIL_SNARL_DEF: Partial<CardDefinition> = {
  entersTappedUnless: { kind: 'mayRevealCardFromHand', subtypes: ['Island', 'Mountain'] },
};
const VINEGLIMMER_SNARL_DEF: Partial<CardDefinition> = {
  entersTappedUnless: { kind: 'mayRevealCardFromHand', subtypes: ['Forest', 'Island'] },
};

const LOYAL_APPRENTICE_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: {
        when: 'beginningOfCombat',
        player: 'you',
        condition: { kind: 'controlsYourCommander' },
      },
      targets: [],
      effects: [
        {
          op: 'createToken',
          count: constant(1),
          spec: { ...THOPTER_1_1_FLYING, grantHasteUntilEot: true },
        },
      ],
      description: 'Beginning of combat — if you control your commander, create a hasty Thopter',
    },
  ],
};

const RECKLESS_FIREWEAVER_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: {
        when: 'enters',
        subject: { kind: 'permanent', selector: allOf(ofType('Artifact'), YOURS) },
      },
      targets: [],
      effects: [{ op: 'eachOpponentDamage', amount: 1 }],
      description: 'An artifact enters under your control — this deals one damage to each opponent',
    },
  ],
};

const PIA_NALAAR_CHIEF_MECHANIC_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: {
        when: 'dealsCombatDamageToPlayer',
        subject: { kind: 'permanent', selector: ARTIFACT_CREATURES_YOU_CONTROL },
        aggregate: 'byEventPlayer',
      },
      targets: [],
      effects: [{ op: 'gainEnergy', amount: constant(2) }],
      description:
        'One or more artifact creatures deal combat damage to a player — gain two energy',
    },
    {
      kind: 'triggered',
      trigger: { when: 'endStep', player: 'you' },
      targets: [],
      effects: [
        {
          op: 'mayPayEnergyUpTo',
          min: 1,
          max: { kind: 'energyAvailable' },
          then: [
            {
              op: 'createToken',
              count: constant(1),
              spec: NALAAR_AETHERJET,
              powerOverride: { kind: 'energyPaid' },
              toughnessOverride: { kind: 'energyPaid' },
            },
          ],
        },
      ],
      description: 'End step — pay one or more energy to create an X/X Nalaar Aetherjet',
    },
  ],
};

const CONFISCATION_COUP_DEF: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'permanent', filter: anyOf(ofType('Artifact'), ofType('Creature')) }],
    effects: [
      { op: 'gainEnergy', amount: constant(4) },
      {
        op: 'mayPayEnergy',
        amount: { kind: 'manaValueOfTarget', target: 0 },
        then: [{ op: 'gainControlTarget', target: 0 }],
      },
    ],
    description:
      'Gain four energy, then you may pay energy equal to the target’s mana value to gain control of it',
  },
};

const NISSA_WORLDSOUL_SPEAKER_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: {
        when: 'enters',
        subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) },
      },
      targets: [],
      effects: [{ op: 'gainEnergy', amount: constant(2) }],
      description: 'A land enters under your control — gain two energy',
    },
  ],
  energyAlternativeCost: 8,
};

const AETHERIC_AMPLIFIER_DEF: Partial<CardDefinition> = {
  activatedAbilities: [
    {
      costs: [mana('{4}'), TAP],
      timing: 'sorcery',
      ability: {
        kind: 'activated',
        targets: [{ kind: 'permanent' }],
        effects: [{ op: 'doubleCountersTarget', target: 0 }],
        description: 'Double all counters on target permanent',
      },
    },
    {
      costs: [mana('{4}'), TAP],
      timing: 'sorcery',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'doublePlayerCounters' }],
        description: 'Double all counters you have',
      },
    },
  ],
};

const STRIDEHANGAR_AUTOMATON_DEF: Partial<CardDefinition> = {
  ruleStatics: [{ kind: 'artifactTokenCreatesThopter' }],
};

const AETHERFLUX_CONDUIT_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'castsSpell', caster: 'you' },
      targets: [],
      effects: [{ op: 'gainEnergy', amount: { kind: 'manaSpent' } }],
      description: 'Cast a spell — gain energy equal to mana spent',
    },
  ],
  activatedAbilities: [
    {
      costs: [TAP, { kind: 'payEnergy', amount: 50 }],
      timing: 'any',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'draw', count: constant(7) }, { op: 'castAnyFromHandFree' }],
        description:
          'Pay fifty energy — draw seven cards and cast any number of cards from your hand for free',
      },
    },
  ],
};

const RAMPAGING_AETHERHOOD_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'upkeep', player: 'you' },
      targets: [],
      effects: [
        { op: 'gainEnergy', amount: { kind: 'greatestPowerAmong', selector: SELF, scope: 'you' } },
        {
          op: 'mayPayEnergyUpTo',
          min: 1,
          max: { kind: 'energyAvailable' },
          then: [
            {
              op: 'putCounters',
              target: 'source',
              counter: '+1/+1',
              count: { kind: 'energyPaid' },
            },
          ],
        },
      ],
      description:
        'Upkeep — gain energy equal to this creature’s power, then optionally pay energy for +1/+1 counters',
    },
  ],
};

const PEEMA_TRAILBLAZER_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
      targets: [],
      effects: [{ op: 'gainEnergy', amount: { kind: 'damageDealt' } }],
      description: 'Combat damage to a player — gain that much energy',
    },
  ],
  activatedAbilities: [
    {
      // Exhaust (CR 702.177a): the cost is only the energy, and the ability works once.
      costs: [{ kind: 'payEnergy', amount: 6 }],
      timing: 'any',
      exhaust: true,
      ability: {
        kind: 'activated',
        targets: [],
        effects: [
          { op: 'putCounters', target: 'source', counter: '+1/+1', count: 2 },
          // Counted on resolution, after the counters: "Then draw cards equal to …".
          {
            op: 'draw',
            count: { kind: 'greatestPowerAmong', selector: ofType('Creature'), scope: 'you' },
          },
        ],
        description:
          'Exhaust — Pay six {E}: Put two +1/+1 counters on this creature. Then draw cards equal to the greatest power among creatures you control.',
      },
    },
  ],
};

const ELDER_GARGAROTH_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'attacks', subject: { kind: 'self' } },
      targets: [],
      effects: [
        {
          op: 'chooseOne',
          options: [
            {
              description: 'Create a 3/3 Beast',
              effects: [{ op: 'createToken', count: constant(1), spec: BEAST_3_3_GREEN }],
            },
            { description: 'Gain 3 life', effects: [{ op: 'gainLife', amount: constant(3) }] },
            { description: 'Draw a card', effects: [{ op: 'draw', count: constant(1) }] },
          ],
        },
      ],
      description: 'Attack — create a Beast, gain 3 life, or draw a card',
    },
    {
      kind: 'triggered',
      trigger: { when: 'blocks', subject: { kind: 'self' } },
      targets: [],
      effects: [
        {
          op: 'chooseOne',
          options: [
            {
              description: 'Create a 3/3 Beast',
              effects: [{ op: 'createToken', count: constant(1), spec: BEAST_3_3_GREEN }],
            },
            { description: 'Gain 3 life', effects: [{ op: 'gainLife', amount: constant(3) }] },
            { description: 'Draw a card', effects: [{ op: 'draw', count: constant(1) }] },
          ],
        },
      ],
      description: 'Block — create a Beast, gain 3 life, or draw a card',
    },
  ],
};

const PEEMA_AETHER_SEER_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'enters', subject: { kind: 'self' } },
      targets: [],
      effects: [
        {
          op: 'gainEnergy',
          amount: { kind: 'greatestPowerAmong', selector: ofType('Creature'), scope: 'you' },
        },
      ],
      description: 'Enters — gain energy equal to the greatest power among creatures you control',
    },
  ],
  activatedAbilities: [
    {
      costs: [{ kind: 'payEnergy', amount: 3 }],
      timing: 'any',
      ability: {
        kind: 'activated',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'setMustBlockThisTurn', target: 0 }],
        description: 'Pay three energy — target creature must block this turn if able',
      },
    },
  ],
};

const COMBUSTIBLE_GEARHULK_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'enters', subject: { kind: 'self' } },
      targets: [{ kind: 'player', controller: 'opponent' }],
      effects: [{ op: 'opponentMayDrawOrMillThenDamage', target: 0, drawCount: 3, millCount: 3 }],
      description:
        'Target opponent may have you draw three cards or decline and take damage from the milled cards',
    },
  ],
};

const SAHEELI_SUBLIME_ARTIFICER_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'castsSpell', caster: 'you', filter: not(ofType('Creature')) },
      targets: [],
      effects: [{ op: 'createToken', count: constant(1), spec: SERVO_1_1 }],
      description: 'Cast a noncreature spell — create a Servo',
    },
  ],
  activatedAbilities: [
    {
      costs: [{ kind: 'loyalty', delta: 1 }],
      timing: 'sorcery',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'createToken', count: constant(1), spec: SERVO_1_1 }],
        description: '+1: Create a Servo',
      },
    },
    {
      costs: [{ kind: 'loyalty', delta: -2 }],
      timing: 'sorcery',
      ability: {
        kind: 'activated',
        targets: [
          { kind: 'artifact', controller: 'you' },
          {
            kind: 'permanent',
            controller: 'you',
            filter: anyOf(ofType('Artifact'), ofType('Creature')),
          },
        ],
        effects: [
          { op: 'becomeCopyOfTarget', target: 0, ref: 1, untilEot: true, addTypes: ['Artifact'] },
        ],
        description:
          '−2: Target artifact becomes a copy of another target artifact or creature, except it is an artifact',
      },
    },
  ],
};

const PANHARMONICON_DEF: Partial<CardDefinition> = {
  ruleStatics: [{ kind: 'triggerAdditionalOnArtifactOrCreatureEntry' }],
};

const ONE_WITH_THE_MACHINE_DEF: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [],
    effects: [
      {
        op: 'draw',
        count: { kind: 'greatestManaValueAmong', selector: ofType('Artifact'), scope: 'you' },
      },
    ],
    description: 'Draw cards equal to the greatest mana value among artifacts you control',
  },
};

const MIDNIGHT_CLOCK_DEF: Partial<CardDefinition> = {
  counterThresholdTriggers: [
    {
      counter: 'hour',
      threshold: 12,
      ability: {
        kind: 'triggered',
        targets: [],
        effects: [
          { op: 'shuffleHandGraveyardIntoLibrary' },
          { op: 'draw', count: constant(7) },
          { op: 'exile', target: 'source' },
        ],
        description:
          'At twelve hour counters — shuffle your hand and graveyard into your library, draw seven cards, then exile this artifact',
      },
    },
  ],
};

const DISALLOW_DEF: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'stackObject' }],
    effects: [{ op: 'counter', target: 0 }],
    description: 'Counter target spell, activated ability, or triggered ability',
  },
};

export function registerLIVING_ENERGYOverrides(): void {
  // Catalog audit living-energy-batch-2: reflexive copy target is chosen before payment.
  unsupportedCard(
    '20f602b3-814f-406c-b7eb-2d1fc98f8cf1',
    'Saheeli, Radiant Creator',
    'The copy is a reflexive trigger after payment; the target is chosen before you decide to pay.',
  );

  defineCard(
    '31cb87bf-1020-4fd5-95f7-8ecb197d823b',
    'Pia Nalaar, Chief Mechanic',
    [
      'Whenever one or more artifact creatures you control deal combat damage to a player, you get {E}{E} .',
      'At the beginning of your end step, you may pay one or more {E}. If you do, create an X/X colorless Vehicle artifact token named Nalaar Aetherjet with flying and crew 2, where X is the amount of {E} paid this way.',
    ],
    PIA_NALAAR_CHIEF_MECHANIC_DEF,
  );

  unimplemented('52241b9c-7a69-4176-9234-8bdab09d8e64', 'Sai, Master Thopterist', [
    '{1}{U}, Sacrifice two artifacts: Draw a card.',
  ]);

  unimplemented('7060f2c8-fca0-4b7a-bddf-37682f434596', 'Whirler Rogue', [
    "Tap two untapped artifacts you control: Target creature can't be blocked this turn.",
  ]);

  unimplemented('49be65fd-3755-410d-b0dc-2e5861ea2552', 'Thopter Spy Network', [
    'Whenever one or more artifact creatures you control deal combat damage to a player, draw a card.',
  ]);

  // Catalog audit living-energy-batch-1: extra combat untaps all permanents you control.
  unsupportedCard(
    '2f82b232-21ff-44cc-bc35-0999a1d1c52f',
    'Lightning Runner',
    'Untap all creatures you control is implemented as untapEach of all permanents you control.',
  );

  defineCard(
    '355603d1-f62d-407a-8fa9-74e7dca8ecf9',
    'Era of Innovation',
    [
      'Whenever an artifact or Artificer you control enters, you may pay {1}. If you do, you get {E}{E} .',
      'Pay six {E}, Sacrifice this enchantment: Draw three cards.',
    ],
    ERA_OF_INNOVATION_DEF,
  );

  defineCard(
    '47c685b1-6e1e-4e08-8a52-9da6902df113',
    'Aethersquall Ancient',
    [
      'At the beginning of your upkeep, you get {E}{E}{E} .',
      "Pay eight {E}: Return all other creatures to their owners' hands. Activate only as a sorcery.",
    ],
    AETHERSQUALL_ANCIENT_DEF,
  );

  defineCard(
    '53b2c8f2-db9a-4ab0-a4e8-17385b2fa3bd',
    'Aethertide Whale',
    [
      'When this creature enters, you get six {E} .',
      "Pay {E}{E}{E}{E}: Return this creature to its owner's hand.",
    ],
    AETHERTIDE_WHALE_DEF,
  );

  defineCard(
    'b9c58cfb-b7d5-4e86-a5d3-efb07192aa22',
    'Glimmer of Genius',
    ['Scry 2, then draw two cards. You get {E}{E} .'],
    {
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'scry', count: 2 },
          { op: 'draw', count: constant(2) },
          { op: 'gainEnergy', amount: constant(2) },
        ],
        description: 'Scry two, draw two, gain two energy',
      },
    },
  );

  defineCard(
    'c246cdb4-2fd8-487e-944e-3e52fbd1bbaa',
    'Confiscation Coup',
    [
      "Choose target artifact or creature. You get {E}{E}{E}{E} , then you may pay an amount of {E} equal to that permanent's mana value. If you do, gain control of it.",
    ],
    CONFISCATION_COUP_DEF,
  );

  // Coverage PR02: the four energy activations are appended to the parsed Crew 4 instead of
  // replacing activatedAbilities. Paying four energy animates it without crewing it.
  extendCard(
    'cdfcfd2b-966a-4e03-8ed5-4fa7fab423d0',
    'Bespoke Battlewagon',
    [
      '{T}: You get {E}{E} .',
      '{T}, Pay {E}{E}: Tap target creature.',
      '{T}, Pay {E}{E}{E}: Draw a card.',
      'Pay {E}{E}{E}{E}: ~ becomes an artifact creature until end of turn.',
    ],
    {
      activatedAbilities: [
        {
          costs: [TAP],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [{ op: 'gainEnergy', amount: constant(2) }],
            description: '{T}: You get {E}{E}.',
          },
        },
        {
          costs: [TAP, { kind: 'payEnergy', amount: 2 }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [{ kind: 'creature' }],
            effects: [{ op: 'tapTarget', target: 0 }],
            description: '{T}, Pay {E}{E}: Tap target creature.',
          },
        },
        {
          costs: [TAP, { kind: 'payEnergy', amount: 3 }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [{ op: 'draw', count: constant(1) }],
            description: '{T}, Pay {E}{E}{E}: Draw a card.',
          },
        },
        {
          costs: [{ kind: 'payEnergy', amount: 4 }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [{ op: 'becomeArtifactCreature' }],
            description:
              'Pay {E}{E}{E}{E}: This Vehicle becomes an artifact creature until end of turn.',
          },
        },
      ],
    },
  );

  defineCard(
    '00037840-6089-42ec-8c5c-281f9f474504',
    'Nissa, Worldsoul Speaker',
    [
      'Whenever a land you control enters, you get {E}{E} .',
      'You may pay eight {E} rather than pay the mana cost for permanent spells you cast.',
    ],
    NISSA_WORLDSOUL_SPEAKER_DEF,
  );

  // Catalog audit living-energy-batch-4: look-at-top does not reveal the artifact taken.
  unsupportedCard(
    'e91240bc-4a13-4131-9379-5ddac6555f4a',
    'Adaptive Omnitool',
    'Artifact-from-library is put into hand without revealing.',
  );

  defineCard(
    'ab1cc360-b9de-48d9-9983-4dfe4a7d2a37',
    'Arcane Denial',
    [
      "Counter target spell. Its controller may draw up to two cards at the beginning of the next turn's upkeep.",
      "You draw a card at the beginning of the next turn's upkeep.",
    ],
    ARCANE_DENIAL_DEF,
  );

  defineCard(
    '295cd8e1-0830-46c1-9957-556afd4bcee6',
    'Aetheric Amplifier',
    [
      '{4}, {T}: Choose one. Activate only as a sorcery.',
      'â€¢ Double the number of each kind of counter on target permanent.',
      'â€¢ Double the number of each kind of counter you have.',
    ],
    AETHERIC_AMPLIFIER_DEF,
  );

  defineCard(
    '9070c98b-fd01-4eeb-a4ec-fc464946c7c0',
    'Stridehangar Automaton',
    [
      'If one or more artifact tokens would be created under your control, those tokens plus an additional 1/1 colorless Thopter artifact creature token with flying are created instead.',
    ],
    STRIDEHANGAR_AUTOMATON_DEF,
  );

  defineCard(
    '775617cd-7264-4365-94c4-ffae4eb9ec8b',
    'Aetherflux Conduit',
    [
      'Whenever you cast a spell, you get an amount of {E} equal to the amount of mana spent to cast that spell.',
      '{T}, Pay fifty {E}: Draw seven cards. You may cast any number of spells from your hand without paying their mana costs.',
    ],
    AETHERFLUX_CONDUIT_DEF,
  );

  defineCard(
    '9b1f0780-072a-4fe6-91d8-e546a8aaea20',
    'Rampaging Aetherhood',
    [
      "At the beginning of your upkeep, you get an amount of {E} equal to this creature's power. Then you may pay one or more {E}. If you do, put that many +1/+1 counters on this creature.",
    ],
    RAMPAGING_AETHERHOOD_DEF,
  );

  defineCard(
    '88600bd4-4dcc-4788-bba4-78b6cf5ad8f8',
    'Peema Trailblazer',
    [
      'Whenever this creature deals combat damage to a player, you get that many {E} .',
      'Exhaust â€” Pay six {E}: Put two +1/+1 counters on this creature. Then draw cards equal to the greatest power among creatures you control.',
    ],
    PEEMA_TRAILBLAZER_DEF,
  );

  // Catalog audit living-energy-batch-3: reflexive damage is same-resolution then.
  unsupportedCard(
    '4f63d306-cc14-405c-8424-d8990c670c74',
    'Territorial Aetherkite',
    'The damage is a reflexive trigger after payment, implemented as the same resolution.',
  );

  defineCard(
    'be6cab52-b3ae-46a2-a581-2468a49bff25',
    'Architect of the Untamed',
    [
      'Whenever a land you control enters, you get {E} .',
      'Pay eight {E}: Create a 6/6 colorless Beast artifact creature token.',
    ],
    ARCHITECT_OF_THE_UNTAMED_DEF,
  );

  defineCard(
    '1daba4f6-2a7d-426a-97d1-0298a7100c45',
    'Decoction Module',
    ['Whenever a creature you control enters, you get {E} .'],
    DECOCTION_MODULE_DEF,
  );

  // Retrofitter Foundry: restored in coverage PR02. The interpreter models all four activated
  // abilities faithfully, so no override is registered (the authored list used to replace the
  // parsed one and drop the {2}, {T} Servo ability).

  defineCard(
    '397b9dcf-690a-4a58-8637-bb9baab7cc2f',
    'Elder Gargaroth',
    [
      'Whenever this creature attacks or blocks, choose one â€”',
      'â€¢ Create a 3/3 green Beast creature token.',
      'â€¢ You gain 3 life.',
      'â€¢ Draw a card.',
    ],
    ELDER_GARGAROTH_DEF,
  );

  // Catalog audit living-energy-batch-3: free-cast rest is not random and skipped when none are castable.
  unsupportedCard(
    '470ec98e-120c-446d-ade6-7d80aa836b55',
    'Aetherworks Marvel',
    'Look-at-top-six free-cast does not put the rest on the bottom in a random order, and skips that reordering when no spell is castable.',
  );

  defineCard(
    '4a00f56e-e558-4239-bc75-fb0af7639042',
    'Peema Aether-Seer',
    [
      'When this creature enters, you get an amount of {E} equal to the greatest power among creatures you control.',
      'Pay {E}{E}{E}: Target creature blocks this turn if able.',
    ],
    PEEMA_AETHER_SEER_DEF,
  );

  // Coverage PR02: the energy mana ability is appended to the parsed {T}: Add {C} instead of
  // replacing manaAbilities, which used to drop the colorless ability.
  extendCard(
    '61c89b11-65c9-4fda-bbcd-d84de25df801',
    'Aether Hub',
    ['When this land enters, you get {E} .', '{T}, Pay {E}: Add one mana of any color.'],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'gainEnergy', amount: constant(1) }],
          description: 'Enters — gain one energy',
        },
      ],
      manaAbilities: [
        { units: [['W', 'U', 'B', 'R', 'G']], costs: [TAP, { kind: 'payEnergy', amount: 1 }] },
      ],
    },
  );

  defineCard(
    'b2f09e41-0a91-4fb6-8804-874b3a5166b0',
    'Rogue Refiner',
    ['When this creature enters, draw a card and you get {E}{E} .'],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [
            { op: 'draw', count: constant(1) },
            { op: 'gainEnergy', amount: constant(2) },
          ],
          description: 'Enters — draw and gain two energy',
        },
      ],
    },
  );

  // Coverage PR01: the found basic is revealed to every player before it goes to hand (CR
  // 701.16a), the search may legally find nothing (CR 701.19c), and the energy follows.
  defineCard(
    'b337c241-f2c4-48e3-a303-371b172fcd18',
    'Attune with Aether',
    [
      'Search your library for a basic land card, reveal it, put it into your hand, then shuffle. You get {E}{E} .',
    ],
    {
      spellAbility: spell({
        targets: [],
        effects: [
          {
            op: 'searchLibrary',
            filter: allOf(ofSupertype('Basic'), ofType('Land')),
            destinations: [{ zone: 'hand' }],
            allowFailToFind: true,
            reveal: true,
          },
          { op: 'shuffle' },
          { op: 'gainEnergy', amount: constant(2) },
        ],
      }),
    },
  );

  // Coverage PR02: as Aether Hub, the energy mana ability is appended to the parsed {T}: Add {C};
  // "This artifact enters tapped" stays interpreted.
  extendCard(
    'cb377c27-39a6-42b4-8c89-80a9a2350e81',
    'Solar Transformer',
    ['When this artifact enters, you get {E}{E}{E} .', '{T}, Pay {E}: Add one mana of any color.'],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'gainEnergy', amount: constant(3) }],
          description: 'Enters — gain three energy',
        },
      ],
      manaAbilities: [
        { units: [['W', 'U', 'B', 'R', 'G']], costs: [TAP, { kind: 'payEnergy', amount: 1 }] },
      ],
    },
  );

  defineCard(
    'd9ec9a4f-0644-47c5-bc09-1201d5251bde',
    'Aetherwind Basker',
    [
      'Whenever this creature enters or attacks, you get {E} for each creature you control.',
      'Pay {E}: ~ gets +1/+1 until end of turn.',
    ],
    AETHERWIND_BASKER_DEF,
  );

  defineCard(
    'df1a8846-b4da-4e9b-8cf3-ee687e4c606b',
    'Servant of the Conduit',
    ['When this creature enters, you get {E}{E} .', '{T}, Pay {E}: Add one mana of any color.'],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'gainEnergy', amount: constant(2) }],
          description: 'Enters — gain two energy',
        },
      ],
      manaAbilities: [
        { units: [['W', 'U', 'B', 'R', 'G']], costs: [TAP, { kind: 'payEnergy', amount: 1 }] },
      ],
    },
  );

  defineCard(
    'f82da236-e567-4221-a0bc-439a0c7e2b03',
    'Whirler Virtuoso',
    [
      'When this creature enters, you get {E}{E}{E} .',
      'Pay {E}{E}{E}: Create a 1/1 colorless Thopter artifact creature token with flying.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [],
          effects: [{ op: 'gainEnergy', amount: constant(3) }],
          description: 'Enters — gain three energy',
        },
      ],
      activatedAbilities: [
        {
          costs: [{ kind: 'payEnergy', amount: 3 }],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [{ op: 'createToken', count: constant(1), spec: THOPTER_1_1_FLYING }],
            description: 'Pay three energy — create a Thopter',
          },
        },
      ],
    },
  );

  // Catalog audit living-energy-batch-8: Chaos Warp peeks without revealing.
  unsupportedCard(
    '07a0cba9-8768-4fd9-a3d5-b0f83b4bf8e8',
    'Chaos Warp',
    'The top card is not revealed; a nonpermanent remains hidden on top of the library.',
  );

  defineCard(
    'd1deba03-b26a-4a0d-b242-24bb3a3f9ea6',
    "Bootleggers' Stash",
    ['Lands you control have "{T}: Create a Treasure token."'],
    BOOTLEGGERS_STASH_DEF,
  );

  unimplemented('a3da7d5b-2c2b-45fe-b9c5-413b8c8fc0a2', 'Academy Ruins', [
    '{1}{U}, {T}: Put target artifact card from your graveyard on top of your library.',
  ]);

  // Catalog audit living-energy-batch-9: manifest never offers turn-face-up.
  unsupportedCard(
    '70dc830e-d05b-4fc7-88dd-879e140b3fbf',
    'Reality Shift',
    'Manifest puts the card face-down but never offers turning it face up for its mana cost.',
  );

  // Catalog audit living-energy-batch-3: optional exile is a required target.
  unsupportedCard(
    'ea86abfa-6cab-4ef0-8463-34136fc25b59',
    'Duplicant',
    'Optional exile is a required target.',
  );

  defineCard(
    '7a2484a9-04fd-41a0-8224-610c1c07ed10',
    'Blasphemous Act',
    ['This spell costs {1} less to cast for each creature on the battlefield.'],
    BLASPHEMOUS_ACT_DEF,
  );

  defineCard(
    '3494a575-f68e-4e78-9f6b-142cd8a0edea',
    'Combustible Gearhulk',
    [
      "When this creature enters, target opponent may have you draw three cards. If the player doesn't, you mill three cards, then this creature deals damage to that player equal to the total mana value of those cards.",
    ],
    COMBUSTIBLE_GEARHULK_DEF,
  );

  defineCard(
    '7137aae6-260d-41de-8b4e-42a8cf752697',
    'Frostboil Snarl',
    [
      "As this land enters, you may reveal an Island or Mountain card from your hand. If you don't, this land enters tapped.",
    ],
    FROSTBOIL_SNARL_DEF,
  );

  defineCard(
    '33f52df8-4b44-4422-8b0a-37fead9c894b',
    'Vineglimmer Snarl',
    [
      "As this land enters, you may reveal a Forest or Island card from your hand. If you don't, this land enters tapped.",
    ],
    VINEGLIMMER_SNARL_DEF,
  );

  unsupportedCard(
    '5bb32efd-9e58-4021-bbda-4ffccfa1d601',
    'Druid of Purification',
    'Each player chooses a permanent they do not control, not a permanent you do not control.',
  );

  // Stale claim removed: Scryfall's 2026-08-28 oracle update rewrote this card into current
  // templating, which the generic parser reads on its own. Keeping the claim made the
  // override look drifted. The def stays — it still wins the merge and pins the exact shape.
  defineCard(
    'ab655810-f67e-4576-9174-35b16f5e3235',
    'Saheeli, Sublime Artificer',
    [
      "âˆ’2: Target artifact you control becomes a copy of another target artifact or creature you control until end of turn, except it's an artifact in addition to its other types.",
    ],
    SAHEELI_SUBLIME_ARTIFICER_DEF,
  );

  defineCard(
    '7f268b15-ac92-4e98-821b-78d15d9285d9',
    'Loyal Apprentice',
    [
      'At the beginning of combat on your turn, if you control your commander, create a 1/1 colorless Thopter artifact creature token with flying. That token gains haste until end of turn.',
    ],
    LOYAL_APPRENTICE_DEF,
  );

  unimplemented('86084ed9-b8bb-4289-9579-6056194787bc', 'Pia and Kiran Nalaar', [
    '{2}{R}, Sacrifice an artifact: ~ deals 2 damage to any target.',
  ]);

  // Coverage PR01 (was contained by living-energy-batch-3): the creature is targeted when the
  // trigger is put on the stack, and "you may" is decided as it resolves (CR 603.5).
  defineCard(
    'cd1eda60-53e4-44d0-9b2c-7a57395e291f',
    "Conjurer's Closet",
    [
      'At the beginning of your end step, you may exile target creature you control, then return that card to the battlefield under your control.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'endStep', player: 'you' },
          optional: true,
          targets: [{ kind: 'creature', controller: 'you' }],
          effects: [{ op: 'blinkTarget', target: 0 }],
          description: 'You may exile target creature you control, then return it',
        },
      ],
    },
  );

  defineCard(
    '76678885-3674-443d-b9a2-2a460cf6aac0',
    'Panharmonicon',
    [
      'If an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.',
    ],
    PANHARMONICON_DEF,
  );

  // Catalog audit living-energy-batch-3: graveyard exile is mashed with the {1} draw mode.
  unsupportedCard(
    '1b5e6560-ff2e-4475-96cb-63f64c8a86db',
    'Soul-Guide Lantern',
    'Opponent-graveyard exile is authored with a free draw instead of a separate {1} draw ability.',
  );

  // Stale claim removed: Scryfall's 2026-08-28 oracle update rewrote this card into current
  // templating, which the generic parser reads on its own. Keeping the claim made the
  // override look drifted. The def stays — it still wins the merge and pins the exact shape.
  defineCard(
    '180e1a7e-890d-477c-80a5-da8a5f2857b3',
    'Reckless Fireweaver',
    [],
    RECKLESS_FIREWEAVER_DEF,
  );

  defineCard(
    '757eadac-dd29-4a7f-8683-5bc823168326',
    'One with the Machine',
    ['Draw cards equal to the greatest mana value among artifacts you control.'],
    ONE_WITH_THE_MACHINE_DEF,
  );

  defineCard(
    'c68faebc-b2cd-461b-b93e-e1fcd4816810',
    'Midnight Clock',
    [
      'When the twelfth hour counter is put on this artifact, shuffle your hand and graveyard into your library, then draw seven cards. Exile this artifact.',
    ],
    MIDNIGHT_CLOCK_DEF,
  );

  defineCard(
    '88b51e15-6630-4e14-a6b8-db0aa12e34ef',
    'Disallow',
    ['Counter target spell, activated ability, or triggered ability.'],
    DISALLOW_DEF,
  );

  // Final exact-text registrations for the Unicode-sensitive oracle lines. These re-register
  // cards defined above whose `handledLines` literals were mojibake; going through defineCard
  // means the corrected text reaches BOTH ids, not just the Scryfall one — previously the
  // fixture id kept the broken text and the card stayed unmodeled when built by name.
  replaceCard(
    '295cd8e1-0830-46c1-9957-556afd4bcee6',
    'Aetheric Amplifier',
    [
      '{4}, {T}: Choose one. Activate only as a sorcery.',
      '\u2022 Double the number of each kind of counter on target permanent.',
      '\u2022 Double the number of each kind of counter you have.',
    ],
    AETHERIC_AMPLIFIER_DEF,
    'replace the earlier generated inline definition with the reviewed shared constant',
  );
  replaceCard(
    '397b9dcf-690a-4a58-8637-bb9baab7cc2f',
    'Elder Gargaroth',
    [
      'Whenever this creature attacks or blocks, choose one \u2014',
      '\u2022 Create a 3/3 green Beast creature token.',
      '\u2022 You gain 3 life.',
      '\u2022 Draw a card.',
    ],
    ELDER_GARGAROTH_DEF,
    'replace the earlier generated inline definition with the reviewed shared constant',
  );
  replaceCard(
    '88600bd4-4dcc-4788-bba4-78b6cf5ad8f8',
    'Peema Trailblazer',
    [
      'Whenever this creature deals combat damage to a player, you get that many {E} .',
      'Exhaust \u2014 Pay six {E}: Put two +1/+1 counters on this creature. Then draw cards equal to the greatest power among creatures you control.',
    ],
    PEEMA_TRAILBLAZER_DEF,
    'replace the earlier generated inline definition with the reviewed shared constant',
  );
  replaceCard(
    'ab655810-f67e-4576-9174-35b16f5e3235',
    'Saheeli, Sublime Artificer',
    [
      "\u2212\u0032: Target artifact you control becomes a copy of another target artifact or creature you control until end of turn, except it's an artifact in addition to its other types.",
    ],
    SAHEELI_SUBLIME_ARTIFICER_DEF,
    'replace the earlier generated inline definition with the reviewed shared constant',
  );
  // Catalog audit living-energy-batch-1: choose-one is two independent activations.
  unsupportedCard(
    '295cd8e1-0830-46c1-9957-556afd4bcee6',
    'Aetheric Amplifier',
    'Choose-one is implemented as two independent activated abilities.',
  );
  // Catalog audit living-energy-batch-2: extra +1 loyalty is not on the card.
  unsupportedCard(
    'ab655810-f67e-4576-9174-35b16f5e3235',
    'Saheeli, Sublime Artificer',
    'A +1 loyalty ability is authored that is not on the card.',
  );
}

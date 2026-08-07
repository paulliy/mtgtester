/**
 * Authored card overrides for living-energy.txt.
 */

import { constant } from '../value';
import { ATTACHED, SAC_SELF, TAP, mana, manaCost } from '../templates';
import { TREASURE } from '../tokens';
import { defineCard, unimplemented } from './index';
import { allOf, anyOf, not, ofSupertype, ofSubtype, ofType, IS_TOKEN, OTHER, SELF, YOURS, withKeyword } from '../selector';
import type { CardDefinition } from '../definition';
import type { TokenSpec } from '../ability';

const ARTIFACT_OR_ARTIFICER = anyOf(ofType('Artifact'), ofSubtype('Artificer'));
const ARTIFACT_CREATURES_YOU_CONTROL = allOf(ofType('Artifact'), ofType('Creature'), YOURS);

const THOPTER_TOKEN: TokenSpec = {
  name: 'Thopter',
  typeLine: 'Artifact Creature — Thopter',
  types: ['Artifact', 'Creature'],
  subtypes: ['Thopter'],
  colors: [],
  power: 1,
  toughness: 1,
  keywords: ['flying'],
};

const SERVO_TOKEN: TokenSpec = {
  name: 'Servo',
  typeLine: 'Artifact Creature — Servo',
  types: ['Artifact', 'Creature'],
  subtypes: ['Servo'],
  colors: [],
  power: 1,
  toughness: 1,
};

const BEAST_TOKEN: TokenSpec = {
  name: 'Beast',
  typeLine: 'Artifact Creature — Beast',
  types: ['Artifact', 'Creature'],
  subtypes: ['Beast'],
  colors: [],
  power: 6,
  toughness: 6,
};


const GREEN_BEAST_TOKEN: TokenSpec = {
  name: 'Beast',
  typeLine: 'Creature — Beast',
  types: ['Creature'],
  subtypes: ['Beast'],
  colors: ['G'],
  power: 3,
  toughness: 3,
};

const NALAAR_AETHERJET_TOKEN: TokenSpec = {
  name: 'Nalaar Aetherjet',
  typeLine: 'Artifact — Vehicle',
  types: ['Artifact'],
  subtypes: ['Vehicle'],
  colors: [],
  power: 0,
  toughness: 0,
  keywords: ['flying'],
  activatedAbilities: [{
    costs: [{ kind: 'tapCreaturesTotalPower', minPower: 2 }],
    timing: 'any',
    ability: { kind: 'activated', targets: [], effects: [{ op: 'crewVehicle', minPower: 2 }], description: 'Crew 2' },
  }],
};

const NON_TOKEN_CREATURE: import('../selector').Selector = allOf(ofType('Creature'), not(IS_TOKEN));

const ADAPTIVE_OMNITOOL_DEF: Partial<CardDefinition> = {
  staticEffects: [{
    affects: ATTACHED,
    op: {
      layer: 7,
      sublayer: 'd',
      power: { kind: 'countPermanents', selector: allOf(ofType('Artifact'), YOURS), scope: 'you' },
      toughness: { kind: 'countPermanents', selector: allOf(ofType('Artifact'), YOURS), scope: 'you' },
    },
  }],
  triggers: [{
    kind: 'triggered',
    trigger: { when: 'attacks', subject: { kind: 'permanent', selector: ATTACHED } },
    targets: [],
    effects: [{
      op: 'lookAtTopN',
      count: 6,
      mayPut: { filter: ofType('Artifact'), destination: { zone: 'hand' } },
      rest: 'bottomRandom',
    }],
    description: 'Equipped creature attacks — look at the top six cards for an artifact',
  }],
};

const AETHERSQUALL_ANCIENT_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'upkeep', player: 'you' }, targets: [],
    effects: [{ op: 'gainEnergy', amount: constant(3) }], description: 'Upkeep — gain three energy',
  }],
  activatedAbilities: [{
    costs: [{ kind: 'payEnergy', amount: 8 }], timing: 'sorcery',
    ability: { kind: 'activated', targets: [], effects: [{ op: 'returnToHandEach', selector: allOf(ofType('Creature'), OTHER) }], description: 'Pay eight energy — return all other creatures to their owners’ hands' },
  }],
};

const AETHERTIDE_WHALE_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
    effects: [{ op: 'gainEnergy', amount: constant(6) }], description: 'Enters — gain six energy',
  }],
  activatedAbilities: [{
    costs: [{ kind: 'payEnergy', amount: 4 }], timing: 'any',
    ability: { kind: 'activated', targets: [], effects: [{ op: 'returnToHand', target: 'source' }], description: 'Pay four energy — return this creature to its owner’s hand' },
  }],
};

const AETHERWIND_BASKER_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
      effects: [{ op: 'gainEnergy', amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' } }], description: 'Enters — gain energy for each creature you control',
    },
    {
      kind: 'triggered', trigger: { when: 'attacks', subject: { kind: 'self' } }, targets: [],
      effects: [{ op: 'gainEnergy', amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' } }], description: 'Attacks — gain energy for each creature you control',
    },
  ],
  activatedAbilities: [{
    costs: [{ kind: 'payEnergy', amount: 1 }], timing: 'any',
    ability: { kind: 'activated', targets: [], effects: [{ op: 'pumpUntilEot', target: 'source', power: 1, toughness: 1 }], description: 'Pay one energy — this creature gets +1/+1 until end of turn' },
  }],
};

const ARCHITECT_OF_THE_UNTAMED_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) } }, targets: [],
    effects: [{ op: 'gainEnergy', amount: constant(1) }], description: 'A land enters under your control — gain one energy',
  }],
  activatedAbilities: [{
    costs: [{ kind: 'payEnergy', amount: 8 }], timing: 'any',
    ability: { kind: 'activated', targets: [], effects: [{ op: 'createToken', count: constant(1), spec: BEAST_TOKEN }], description: 'Pay eight energy — create a 6/6 Beast artifact creature token' },
  }],
};

const BESPOKE_BATTLEWAGON_DEF: Partial<CardDefinition> = {
  activatedAbilities: [
    { costs: [TAP], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'gainEnergy', amount: constant(2) }], description: 'Tap — gain two energy' } },
    { costs: [TAP, { kind: 'payEnergy', amount: 2 }], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'creature' }], effects: [{ op: 'tapTarget', target: 0 }], description: 'Tap and pay two energy — tap target creature' } },
    { costs: [TAP, { kind: 'payEnergy', amount: 3 }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'draw', count: constant(1) }], description: 'Tap and pay three energy — draw a card' } },
    { costs: [{ kind: 'payEnergy', amount: 4 }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'crewVehicle', minPower: 0 }], description: 'Pay four energy — this Vehicle becomes an artifact creature until end of turn' } },
  ],
};

const BLASPHEMOUS_ACT_DEF: Partial<CardDefinition> = {
  ruleStatics: [{ kind: 'costReduction', amount: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'all' }, selfOnly: true }],
};

const BOOTLEGGERS_STASH_DEF: Partial<CardDefinition> = {
  staticEffects: [{
    affects: allOf(ofType('Land'), YOURS),
    op: { layer: 6, addActivatedAbility: { costs: [TAP], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'createToken', count: constant(1), spec: TREASURE }], description: 'Tap — create a Treasure token' } } },
  }],
};

const DECOCTION_MODULE_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) } }, targets: [],
    effects: [{ op: 'gainEnergy', amount: constant(1) }], description: 'A creature enters under your control — gain one energy',
  }],
  activatedAbilities: [{
    costs: [mana('{4}'), TAP], timing: 'any',
    ability: { kind: 'activated', targets: [{ kind: 'creature', controller: 'you' }], effects: [{ op: 'returnToHand', target: 0 }], description: 'Pay {4} and tap — return target creature you control to its owner’s hand' },
  }],
};

const ERA_OF_INNOVATION_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ARTIFACT_OR_ARTIFICER, YOURS) } }, targets: [],
    effects: [{ op: 'conditionalEffect', condition: { kind: 'mayPayMana', cost: manaCost('{1}') }, then: [{ op: 'gainEnergy', amount: constant(2) }], else: [] }],
    description: 'An artifact or Artificer enters — you may pay {1} to gain two energy',
  }],
  activatedAbilities: [{
    costs: [{ kind: 'payEnergy', amount: 6 }, SAC_SELF], timing: 'any',
    ability: { kind: 'activated', targets: [], effects: [{ op: 'draw', count: constant(3) }], description: 'Pay six energy and sacrifice — draw three cards' },
  }],
};

const FROSTBOIL_SNARL_DEF: Partial<CardDefinition> = { entersTappedUnless: { kind: 'mayRevealCardFromHand', subtypes: ['Island', 'Mountain'] } };
const VINEGLIMMER_SNARL_DEF: Partial<CardDefinition> = { entersTappedUnless: { kind: 'mayRevealCardFromHand', subtypes: ['Forest', 'Island'] } };

const LOYAL_APPRENTICE_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'beginningOfCombat', player: 'you', condition: { kind: 'controlsYourCommander' } }, targets: [],
    effects: [{ op: 'createToken', count: constant(1), spec: { ...THOPTER_TOKEN, grantHasteUntilEot: true } }],
    description: 'Beginning of combat — if you control your commander, create a hasty Thopter',
  }],
};

const OVERFLOWING_BASIN_DEF: Partial<CardDefinition> = {
  activatedAbilities: [{
    costs: [mana('{1}'), TAP], timing: 'any',
    ability: { kind: 'activated', targets: [], effects: [{ op: 'addMana', amount: constant(2), colors: [], fixedSymbols: ['G', 'U'] }], description: 'Pay {1} and tap — add {G}{U}' },
  }],
};

const RECKLESS_FIREWEAVER_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Artifact'), YOURS) } }, targets: [],
    effects: [{ op: 'eachOpponentDamage', amount: 1 }], description: 'An artifact enters under your control — this deals one damage to each opponent',
  }],
};

const RETROFITTER_FOUNDRY_DEF: Partial<CardDefinition> = {
  activatedAbilities: [
    { costs: [mana('{3}')], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'untapTarget', target: 'source' }], description: 'Pay {3} — untap this artifact' } },
    { costs: [mana('{1}'), TAP, { kind: 'sacrificeOther', selector: allOf(ofSubtype('Servo'), YOURS), count: 1 }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'createToken', count: constant(1), spec: THOPTER_TOKEN }], description: 'Pay {1}, tap, and sacrifice a Servo — create a Thopter' } },
    { costs: [TAP, { kind: 'sacrificeOther', selector: allOf(ofSubtype('Thopter'), YOURS), count: 1 }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'createToken', count: constant(1), spec: { name: 'Construct', typeLine: 'Artifact Creature — Construct', types: ['Artifact', 'Creature'], subtypes: ['Construct'], colors: [], power: 4, toughness: 4 } }], description: 'Tap and sacrifice a Thopter — create a Construct' } },
  ],
};

const SAHEELI_RADIANT_CREATOR_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'castsSpell', caster: 'you', filter: ARTIFACT_OR_ARTIFICER }, targets: [],
    effects: [{ op: 'gainEnergy', amount: constant(1) }], description: 'Cast an artifact or Artificer spell — gain one energy',
  }, {
    kind: 'triggered', trigger: { when: 'beginningOfCombat', player: 'you' }, targets: [{ kind: 'permanent', controller: 'you' }],
    effects: [{ op: 'mayPayEnergy', amount: constant(3), then: [{ op: 'createTokenCopyOf', ref: 0, count: constant(1), addTypes: ['Artifact'], powerOverride: 5, toughnessOverride: 5, addKeywords: ['haste'], sacrificeAt: 'endStep' }] }],
    description: 'Beginning of combat — you may pay three energy to create a hasty 5/5 artifact copy until the next end step',
  }],
};

const PIA_NALAAR_CHIEF_MECHANIC_DEF: Partial<CardDefinition> = {
  triggers: [
    {
      kind: 'triggered',
      trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'permanent', selector: ARTIFACT_CREATURES_YOU_CONTROL }, aggregate: 'byEventPlayer' },
      targets: [], effects: [{ op: 'gainEnergy', amount: constant(2) }],
      description: 'One or more artifact creatures deal combat damage to a player — gain two energy',
    },
    {
      kind: 'triggered', trigger: { when: 'endStep', player: 'you' }, targets: [],
      effects: [{ op: 'mayPayEnergyUpTo', min: 1, max: { kind: 'energyAvailable' }, then: [{ op: 'createToken', count: constant(1), spec: NALAAR_AETHERJET_TOKEN, powerOverride: { kind: 'energyPaid' }, toughnessOverride: { kind: 'energyPaid' } }] }],
      description: 'End step — pay one or more energy to create an X/X Nalaar Aetherjet',
    },
  ],
};

const LIGHTNING_RUNNER_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'attacks', subject: { kind: 'self' } }, targets: [],
    effects: [{ op: 'gainEnergy', amount: constant(2) }, { op: 'mayPayEnergy', amount: constant(8), then: [{ op: 'untapEach', selector: YOURS }, { op: 'extraCombatPhase' }] }],
    description: 'Attack — gain two energy, then optionally pay eight for another combat',
  }],
};

const CONFISCATION_COUP_DEF: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell', targets: [{ kind: 'permanent', filter: anyOf(ofType('Artifact'), ofType('Creature')) }],
    effects: [{ op: 'gainEnergy', amount: constant(4) }, { op: 'mayPayEnergy', amount: { kind: 'manaValueOfTarget', target: 0 }, then: [{ op: 'gainControlTarget', target: 0 }] }],
    description: 'Gain four energy, then you may pay energy equal to the target’s mana value to gain control of it',
  },
};

const NISSA_WORLDSOUL_SPEAKER_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) } }, targets: [],
    effects: [{ op: 'gainEnergy', amount: constant(2) }], description: 'A land enters under your control — gain two energy',
  }],
  energyAlternativeCost: 8,
};

const AETHERIC_AMPLIFIER_DEF: Partial<CardDefinition> = {
  activatedAbilities: [
    { costs: [mana('{4}'), TAP], timing: 'sorcery', ability: { kind: 'activated', targets: [{ kind: 'permanent' }], effects: [{ op: 'doubleCountersTarget', target: 0 }], description: 'Double all counters on target permanent' } },
    { costs: [mana('{4}'), TAP], timing: 'sorcery', ability: { kind: 'activated', targets: [], effects: [{ op: 'doublePlayerCounters' }], description: 'Double all counters you have' } },
  ],
};

const STRIDEHANGAR_AUTOMATON_DEF: Partial<CardDefinition> = {
  ruleStatics: [{ kind: 'artifactTokenCreatesThopter' }],
};

const AETHERFLUX_CONDUIT_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'castsSpell', caster: 'you' }, targets: [],
    effects: [{ op: 'gainEnergy', amount: { kind: 'manaSpent' } }], description: 'Cast a spell — gain energy equal to mana spent',
  }],
  activatedAbilities: [{
    costs: [TAP, { kind: 'payEnergy', amount: 50 }], timing: 'any',
    ability: { kind: 'activated', targets: [], effects: [{ op: 'draw', count: constant(7) }, { op: 'castAnyFromHandFree' }], description: 'Pay fifty energy — draw seven cards and cast any number of cards from your hand for free' },
  }],
};

const RAMPAGING_AETHERHOOD_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'upkeep', player: 'you' }, targets: [],
    effects: [{ op: 'gainEnergy', amount: { kind: 'greatestPowerAmong', selector: SELF, scope: 'you' } }, { op: 'mayPayEnergyUpTo', min: 1, max: { kind: 'energyAvailable' }, then: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: { kind: 'energyPaid' } }] }],
    description: 'Upkeep — gain energy equal to this creature’s power, then optionally pay energy for +1/+1 counters',
  }],
};

const PEEMA_TRAILBLAZER_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } }, targets: [],
    effects: [{ op: 'gainEnergy', amount: { kind: 'damageDealt' } }], description: 'Combat damage to a player — gain that much energy',
  }],
  activatedAbilities: [{
    costs: [TAP, { kind: 'payEnergy', amount: 6 }], timing: 'any',
    ability: { kind: 'activated', targets: [], effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 2 }, { op: 'draw', count: { kind: 'greatestPowerAmong', selector: ofType('Creature'), scope: 'you' } }], description: 'Tap and pay six energy — put two +1/+1 counters on this creature, then draw cards equal to the greatest power among creatures you control' },
  }],
};

const TERRITORIAL_AETHERKITE_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
    effects: [{ op: 'gainEnergy', amount: constant(2) }, { op: 'mayPayEnergyUpTo', min: 1, max: { kind: 'energyAvailable' }, then: [{ op: 'damageEach', selector: allOf(ofType('Creature'), OTHER), amount: { kind: 'energyPaid' } }] }],
    description: 'Enters — gain two energy, then optionally pay energy to damage each other creature',
  }],
};

const ELDER_GARGAROTH_DEF: Partial<CardDefinition> = {
  triggers: [
    { kind: 'triggered', trigger: { when: 'attacks', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'chooseOne', options: [
      { description: 'Create a 3/3 Beast', effects: [{ op: 'createToken', count: constant(1), spec: GREEN_BEAST_TOKEN }] },
      { description: 'Gain 3 life', effects: [{ op: 'gainLife', amount: constant(3) }] },
      { description: 'Draw a card', effects: [{ op: 'draw', count: constant(1) }] },
    ] }], description: 'Attack — create a Beast, gain 3 life, or draw a card' },
    { kind: 'triggered', trigger: { when: 'blocks', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'chooseOne', options: [
      { description: 'Create a 3/3 Beast', effects: [{ op: 'createToken', count: constant(1), spec: GREEN_BEAST_TOKEN }] },
      { description: 'Gain 3 life', effects: [{ op: 'gainLife', amount: constant(3) }] },
      { description: 'Draw a card', effects: [{ op: 'draw', count: constant(1) }] },
    ] }], description: 'Block — create a Beast, gain 3 life, or draw a card' },
  ],
};

const AETHERWORKS_MARVEL_DEF: Partial<CardDefinition> = {
  triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: YOURS } }, targets: [], effects: [{ op: 'gainEnergy', amount: constant(1) }], description: 'A permanent you control goes to a graveyard — gain one energy' }],
  activatedAbilities: [{ costs: [TAP, { kind: 'payEnergy', amount: 6 }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'lookAtTopNCastOneFree', count: 6 }], description: 'Pay six energy — look at the top six cards and cast one for free' } }],
};

const PEEMA_AETHER_SEER_DEF: Partial<CardDefinition> = {
  triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: { kind: 'greatestPowerAmong', selector: ofType('Creature'), scope: 'you' } }], description: 'Enters — gain energy equal to the greatest power among creatures you control' }],
  activatedAbilities: [{ costs: [{ kind: 'payEnergy', amount: 3 }], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'creature' }], effects: [{ op: 'setMustBlockThisTurn', target: 0 }], description: 'Pay three energy — target creature must block this turn if able' } }],
};

const ARCANE_DENIAL_DEF: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell', targets: [{ kind: 'stackObject' }], effects: [
      { op: 'registerDelayedTrigger', when: 'upkeep', expiry: 'cleanup', target: 0, controller: 'targetController', ability: { kind: 'triggered', targets: [], effects: [{ op: 'drawUpToN', count: 2 }], description: 'Its controller may draw up to two cards' } },
      { op: 'counter', target: 0 },
      { op: 'registerDelayedTrigger', when: 'upkeep', expiry: 'cleanup', ability: { kind: 'triggered', targets: [], effects: [{ op: 'draw', count: constant(1) }], description: 'Draw a card' } },
    ], description: 'Counter target spell or ability; its controller may draw up to two cards and you draw a card next upkeep',
  },
};

const CHAOS_WARP_DEF: Partial<CardDefinition> = {
  spellAbility: { kind: 'spell', targets: [{ kind: 'permanent' }], effects: [{ op: 'chaosWarp', target: 0 }], description: 'Shuffle the target permanent into its owner’s library, then reveal the top card' },
};

const COMBUSTIBLE_GEARHULK_DEF: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [{ kind: 'player', controller: 'opponent' }],
    effects: [{ op: 'opponentMayDrawOrMillThenDamage', target: 0, drawCount: 3, millCount: 3 }], description: 'Target opponent may have you draw three cards or decline and take damage from the milled cards',
  }],
};

const DRUID_OF_PURIFICATION_DEF: Partial<CardDefinition> = {
  triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'druidPurification' }], description: 'Starting with you, each player may choose an artifact or enchantment they do not control to destroy' }],
};

const DUPLICANT_DEF: Partial<CardDefinition> = {
  copyLastExiledCreature: true,
  triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [{ kind: 'creature', filter: NON_TOKEN_CREATURE }], effects: [{ op: 'exileTargetWithSource', target: 0 }], description: 'You may exile target nontoken creature' }],
};

const SAHEELI_SUBLIME_ARTIFICER_DEF: Partial<CardDefinition> = {
  triggers: [{ kind: 'triggered', trigger: { when: 'castsSpell', caster: 'you', filter: not(ofType('Creature')) }, targets: [], effects: [{ op: 'createToken', count: constant(1), spec: SERVO_TOKEN }], description: 'Cast a noncreature spell — create a Servo' }],
  activatedAbilities: [
    { costs: [{ kind: 'loyalty', delta: 1 }], timing: 'sorcery', ability: { kind: 'activated', targets: [], effects: [{ op: 'createToken', count: constant(1), spec: SERVO_TOKEN }], description: '+1: Create a Servo' } },
    { costs: [{ kind: 'loyalty', delta: -2 }], timing: 'sorcery', ability: { kind: 'activated', targets: [{ kind: 'artifact', controller: 'you' }, { kind: 'permanent', controller: 'you', filter: anyOf(ofType('Artifact'), ofType('Creature')) }], effects: [{ op: 'becomeCopyOfTarget', target: 0, ref: 1, untilEot: true, addTypes: ['Artifact'] }], description: '−2: Target artifact becomes a copy of another target artifact or creature, except it is an artifact' } },
  ],
};

const CONJURERS_CLOSET_DEF: Partial<CardDefinition> = {
  triggers: [{ kind: 'triggered', trigger: { when: 'endStep', player: 'you' }, targets: [], effects: [{ op: 'blinkOneCreatureYouControl' }], description: 'End step — you may blink a creature you control' }],
};

const PANHARMONICON_DEF: Partial<CardDefinition> = {
  ruleStatics: [{ kind: 'triggerAdditionalOnArtifactOrCreatureEntry' }],
};

const SOUL_GUIDE_LANTERN_DEF: Partial<CardDefinition> = {
  triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [{ kind: 'cardInGraveyard', graveyardOwnerScope: 'any' }], effects: [{ op: 'exileCard', target: 0 }], description: 'Exile target card from a graveyard' }],
  activatedAbilities: [{ costs: [TAP, SAC_SELF], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'exileEachOpponentGraveyard' }, { op: 'draw', count: constant(1) }], description: 'Sacrifice — exile all cards from opponents’ graveyards, then draw a card' } }],
};

const ONE_WITH_THE_MACHINE_DEF: Partial<CardDefinition> = {
  spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'draw', count: { kind: 'greatestManaValueAmong', selector: ofType('Artifact'), scope: 'you' } }], description: 'Draw cards equal to the greatest mana value among artifacts you control' },
};

const MIDNIGHT_CLOCK_DEF: Partial<CardDefinition> = {
  counterThresholdTriggers: [{ counter: 'hour', threshold: 12, ability: { kind: 'triggered', targets: [], effects: [{ op: 'shuffleHandGraveyardIntoLibrary' }, { op: 'draw', count: constant(7) }, { op: 'exile', target: 'source' }], description: 'At twelve hour counters — shuffle your hand and graveyard into your library, draw seven cards, then exile this artifact' } }],
};

const DISALLOW_DEF: Partial<CardDefinition> = {
  spellAbility: { kind: 'spell', targets: [{ kind: 'stackObject' }], effects: [{ op: 'counter', target: 0 }], description: 'Counter target spell, activated ability, or triggered ability' },
};

const REALITY_SHIFT_DEF: Partial<CardDefinition> = {
  spellAbility: { kind: 'spell', targets: [{ kind: 'creature' }], effects: [{ op: 'exileAndManifestTarget', target: 0 }], description: 'Exile target creature; its controller manifests the top card of their library' },
};

export function registerLIVING_ENERGYOverrides(): void {
  defineCard("20f602b3-814f-406c-b7eb-2d1fc98f8cf1", "Saheeli, Radiant Creator", [
          "Whenever you cast an Artificer or artifact spell, you get {E} .",
          "At the beginning of combat on your turn, you may pay {E}{E}{E}. When you do, create a token that's a copy of target permanent you control, except it's a 5/5 artifact creature in addition to its other types and has haste. Sacrifice it at the beginning of the next end step."
    ], SAHEELI_RADIANT_CREATOR_DEF);

  defineCard("31cb87bf-1020-4fd5-95f7-8ecb197d823b", "Pia Nalaar, Chief Mechanic", [
          "Whenever one or more artifact creatures you control deal combat damage to a player, you get {E}{E} .",
          "At the beginning of your end step, you may pay one or more {E}. If you do, create an X/X colorless Vehicle artifact token named Nalaar Aetherjet with flying and crew 2, where X is the amount of {E} paid this way."
    ], PIA_NALAAR_CHIEF_MECHANIC_DEF);

  unimplemented("52241b9c-7a69-4176-9234-8bdab09d8e64", "Sai, Master Thopterist", [
          "{1}{U}, Sacrifice two artifacts: Draw a card."
    ]);

  unimplemented("7060f2c8-fca0-4b7a-bddf-37682f434596", "Whirler Rogue", [
          "Tap two untapped artifacts you control: Target creature can't be blocked this turn."
    ]);

  unimplemented("49be65fd-3755-410d-b0dc-2e5861ea2552", "Thopter Spy Network", [
          "Whenever one or more artifact creatures you control deal combat damage to a player, draw a card."
    ]);

  defineCard("2f82b232-21ff-44cc-bc35-0999a1d1c52f", "Lightning Runner", [
          "Whenever this creature attacks, you get {E}{E} , then you may pay eight {E}. If you pay, untap all creatures you control, and after this phase, there is an additional combat phase."
    ], LIGHTNING_RUNNER_DEF);

  defineCard("355603d1-f62d-407a-8fa9-74e7dca8ecf9", "Era of Innovation", [
          "Whenever an artifact or Artificer you control enters, you may pay {1}. If you do, you get {E}{E} .",
          "Pay six {E}, Sacrifice this enchantment: Draw three cards."
    ], ERA_OF_INNOVATION_DEF);

  defineCard("47c685b1-6e1e-4e08-8a52-9da6902df113", "Aethersquall Ancient", [
          "At the beginning of your upkeep, you get {E}{E}{E} .",
          "Pay eight {E}: Return all other creatures to their owners' hands. Activate only as a sorcery."
    ], AETHERSQUALL_ANCIENT_DEF);

  defineCard("53b2c8f2-db9a-4ab0-a4e8-17385b2fa3bd", "Aethertide Whale", [
          "When this creature enters, you get six {E} .",
          "Pay {E}{E}{E}{E}: Return this creature to its owner's hand."
    ], AETHERTIDE_WHALE_DEF);

  defineCard("b9c58cfb-b7d5-4e86-a5d3-efb07192aa22", "Glimmer of Genius", [
          "Scry 2, then draw two cards. You get {E}{E} ."
    ], {
      spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'scry', count: 2 }, { op: 'draw', count: constant(2) }, { op: 'gainEnergy', amount: constant(2) }], description: 'Scry two, draw two, gain two energy' },
    });

  defineCard("c246cdb4-2fd8-487e-944e-3e52fbd1bbaa", "Confiscation Coup", [
          "Choose target artifact or creature. You get {E}{E}{E}{E} , then you may pay an amount of {E} equal to that permanent's mana value. If you do, gain control of it."
    ], CONFISCATION_COUP_DEF);

  defineCard("cdfcfd2b-966a-4e03-8ed5-4fa7fab423d0", "Bespoke Battlewagon", [
          "{T}: You get {E}{E} .",
          "{T}, Pay {E}{E}: Tap target creature.",
          "{T}, Pay {E}{E}{E}: Draw a card.",
          "Pay {E}{E}{E}{E}: ~ becomes an artifact creature until end of turn."
    ], BESPOKE_BATTLEWAGON_DEF);

  defineCard("00037840-6089-42ec-8c5c-281f9f474504", "Nissa, Worldsoul Speaker", [
          "Whenever a land you control enters, you get {E}{E} .",
          "You may pay eight {E} rather than pay the mana cost for permanent spells you cast."
    ], NISSA_WORLDSOUL_SPEAKER_DEF);

  defineCard("e91240bc-4a13-4131-9379-5ddac6555f4a", "Adaptive Omnitool", [
          "Equipped creature gets +1/+1 for each artifact you control.",
          "Whenever equipped creature attacks, look at the top six cards of your library. You may reveal an artifact card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."
    ], ADAPTIVE_OMNITOOL_DEF);

  defineCard("ab1cc360-b9de-48d9-9983-4dfe4a7d2a37", "Arcane Denial", [
          "Counter target spell. Its controller may draw up to two cards at the beginning of the next turn's upkeep.",
          "You draw a card at the beginning of the next turn's upkeep."
    ], ARCANE_DENIAL_DEF);

  defineCard("295cd8e1-0830-46c1-9957-556afd4bcee6", "Aetheric Amplifier", [
          "{4}, {T}: Choose one. Activate only as a sorcery.",
          "â€¢ Double the number of each kind of counter on target permanent.",
          "â€¢ Double the number of each kind of counter you have."
    ], AETHERIC_AMPLIFIER_DEF);

  defineCard("9070c98b-fd01-4eeb-a4ec-fc464946c7c0", "Stridehangar Automaton", [
          "If one or more artifact tokens would be created under your control, those tokens plus an additional 1/1 colorless Thopter artifact creature token with flying are created instead."
    ], STRIDEHANGAR_AUTOMATON_DEF);

  defineCard("775617cd-7264-4365-94c4-ffae4eb9ec8b", "Aetherflux Conduit", [
          "Whenever you cast a spell, you get an amount of {E} equal to the amount of mana spent to cast that spell.",
          "{T}, Pay fifty {E}: Draw seven cards. You may cast any number of spells from your hand without paying their mana costs."
    ], AETHERFLUX_CONDUIT_DEF);

  defineCard("9b1f0780-072a-4fe6-91d8-e546a8aaea20", "Rampaging Aetherhood", [
          "At the beginning of your upkeep, you get an amount of {E} equal to this creature's power. Then you may pay one or more {E}. If you do, put that many +1/+1 counters on this creature."
    ], RAMPAGING_AETHERHOOD_DEF);

  defineCard("88600bd4-4dcc-4788-bba4-78b6cf5ad8f8", "Peema Trailblazer", [
          "Whenever this creature deals combat damage to a player, you get that many {E} .",
          "Exhaust â€” Pay six {E}: Put two +1/+1 counters on this creature. Then draw cards equal to the greatest power among creatures you control."
    ], PEEMA_TRAILBLAZER_DEF);

  defineCard("4f63d306-cc14-405c-8424-d8990c670c74", "Territorial Aetherkite", [
          "When this creature enters, you get {E}{E} . Then you may pay one or more {E}. When you do, this creature deals that much damage to each other creature."
    ], TERRITORIAL_AETHERKITE_DEF);

  defineCard("be6cab52-b3ae-46a2-a581-2468a49bff25", "Architect of the Untamed", [
          "Whenever a land you control enters, you get {E} .",
          "Pay eight {E}: Create a 6/6 colorless Beast artifact creature token."
    ], ARCHITECT_OF_THE_UNTAMED_DEF);

  defineCard("1daba4f6-2a7d-426a-97d1-0298a7100c45", "Decoction Module", [
          "Whenever a creature you control enters, you get {E} .",
          "{4}, {T}: Return target creature you control to its owner's hand."
    ], DECOCTION_MODULE_DEF);

  defineCard("aaadfe41-b2be-4183-b45e-a70e53a59d2e", "Retrofitter Foundry", [
          "{3}: Untap this artifact.",
          "{1}, {T}, Sacrifice a Servo: Create a 1/1 colorless Thopter artifact creature token with flying.",
          "{T}, Sacrifice a Thopter: Create a 4/4 colorless Construct artifact creature token."
    ], RETROFITTER_FOUNDRY_DEF);

  defineCard("397b9dcf-690a-4a58-8637-bb9baab7cc2f", "Elder Gargaroth", [
          "Whenever this creature attacks or blocks, choose one â€”",
          "â€¢ Create a 3/3 green Beast creature token.",
          "â€¢ You gain 3 life.",
          "â€¢ Draw a card."
    ], ELDER_GARGAROTH_DEF);

  defineCard("470ec98e-120c-446d-ade6-7d80aa836b55", "Aetherworks Marvel", [
          "Whenever a permanent you control is put into a graveyard, you get {E} .",
          "{T}, Pay six {E}: Look at the top six cards of your library. You may cast a spell from among them without paying its mana cost. Put the rest on the bottom of your library in a random order."
    ], AETHERWORKS_MARVEL_DEF);

  defineCard("4a00f56e-e558-4239-bc75-fb0af7639042", "Peema Aether-Seer", [
          "When this creature enters, you get an amount of {E} equal to the greatest power among creatures you control.",
          "Pay {E}{E}{E}: Target creature blocks this turn if able."
    ], PEEMA_AETHER_SEER_DEF);

  defineCard("61c89b11-65c9-4fda-bbcd-d84de25df801", "Aether Hub", [
          "When this land enters, you get {E} .",
          "{T}, Pay {E}: Add one mana of any color."
    ], {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: constant(1) }], description: 'Enters — gain one energy' }],
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']], costs: [TAP, { kind: 'payEnergy', amount: 1 }] }]
    });

  defineCard("b2f09e41-0a91-4fb6-8804-874b3a5166b0", "Rogue Refiner", [
          "When this creature enters, draw a card and you get {E}{E} ."
    ], {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'draw', count: constant(1) }, { op: 'gainEnergy', amount: constant(2) }], description: 'Enters — draw and gain two energy' }],
    });

  defineCard("b337c241-f2c4-48e3-a303-371b172fcd18", "Attune with Aether", [
          "Search your library for a basic land card, reveal it, put it into your hand, then shuffle. You get {E}{E} ."
    ], {
      spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'searchLibrary', filter: allOf(ofType('Land'), ofSupertype('Basic')), destinations: [{ zone: 'hand' }] }, { op: 'shuffle' }, { op: 'gainEnergy', amount: constant(2) }], description: 'Search for a basic land, then gain two energy' }
    });

  defineCard("cb377c27-39a6-42b4-8c89-80a9a2350e81", "Solar Transformer", [
          "When this artifact enters, you get {E}{E}{E} .",
          "{T}, Pay {E}: Add one mana of any color."
    ], {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: constant(3) }], description: 'Enters — gain three energy' }],
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']], costs: [TAP, { kind: 'payEnergy', amount: 1 }] }]
    });

  defineCard("d9ec9a4f-0644-47c5-bc09-1201d5251bde", "Aetherwind Basker", [
          "Whenever this creature enters or attacks, you get {E} for each creature you control.",
          "Pay {E}: ~ gets +1/+1 until end of turn."
    ], AETHERWIND_BASKER_DEF);

  defineCard("df1a8846-b4da-4e9b-8cf3-ee687e4c606b", "Servant of the Conduit", [
          "When this creature enters, you get {E}{E} .",
          "{T}, Pay {E}: Add one mana of any color."
    ], {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: constant(2) }], description: 'Enters — gain two energy' }],
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']], costs: [TAP, { kind: 'payEnergy', amount: 1 }] }]
    });

  defineCard("f82da236-e567-4221-a0bc-439a0c7e2b03", "Whirler Virtuoso", [
          "When this creature enters, you get {E}{E}{E} .",
          "Pay {E}{E}{E}: Create a 1/1 colorless Thopter artifact creature token with flying."
    ], {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: constant(3) }], description: 'Enters — gain three energy' }],
      activatedAbilities: [{ costs: [{ kind: 'payEnergy', amount: 3 }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'createToken', count: constant(1), spec: { name: 'Thopter', typeLine: 'Artifact Creature — Thopter', types: ['Artifact', 'Creature'], subtypes: ['Thopter'], colors: [], power: 1, toughness: 1, keywords: ['flying'] } }], description: 'Pay three energy — create a Thopter' } }],
    });

  defineCard("07a0cba9-8768-4fd9-a3d5-b0f83b4bf8e8", "Chaos Warp", [
          "The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it's a permanent card, they put it onto the battlefield."
    ], CHAOS_WARP_DEF);

  defineCard("d1deba03-b26a-4a0d-b242-24bb3a3f9ea6", "Bootleggers' Stash", [
          "Lands you control have \"{T}: Create a Treasure token.\""
    ], BOOTLEGGERS_STASH_DEF);

  unimplemented("a3da7d5b-2c2b-45fe-b9c5-413b8c8fc0a2", "Academy Ruins", [
          "{1}{U}, {T}: Put target artifact card from your graveyard on top of your library."
    ]);

  defineCard("70dc830e-d05b-4fc7-88dd-879e140b3fbf", "Reality Shift", [
          "Exile target creature. Its controller manifests the top card of their library."
    ], REALITY_SHIFT_DEF);

  defineCard("ea86abfa-6cab-4ef0-8463-34136fc25b59", "Duplicant", [
          "When this creature enters, you may exile target nontoken creature.",
          "As long as a card exiled with this creature is a creature card, this creature has the power, toughness, and creature types of the last creature card exiled with it. It's still a Shapeshifter."
    ], DUPLICANT_DEF);

  defineCard("7a2484a9-04fd-41a0-8224-610c1c07ed10", "Blasphemous Act", [
          "This spell costs {1} less to cast for each creature on the battlefield."
    ], BLASPHEMOUS_ACT_DEF);

  defineCard("3494a575-f68e-4e78-9f6b-142cd8a0edea", "Combustible Gearhulk", [
          "When this creature enters, target opponent may have you draw three cards. If the player doesn't, you mill three cards, then this creature deals damage to that player equal to the total mana value of those cards."
    ], COMBUSTIBLE_GEARHULK_DEF);

  defineCard("7137aae6-260d-41de-8b4e-42a8cf752697", "Frostboil Snarl", [
          "As this land enters, you may reveal an Island or Mountain card from your hand. If you don't, this land enters tapped."
    ], FROSTBOIL_SNARL_DEF);

  defineCard("5ac8e01c-b0a7-4855-a122-1cd26b07c4a5", "Overflowing Basin", [
          "{1}, {T}: Add {G}{U}."
    ], OVERFLOWING_BASIN_DEF);

  defineCard("33f52df8-4b44-4422-8b0a-37fead9c894b", "Vineglimmer Snarl", [
          "As this land enters, you may reveal a Forest or Island card from your hand. If you don't, this land enters tapped."
    ], VINEGLIMMER_SNARL_DEF);

  defineCard("5bb32efd-9e58-4021-bbda-4ffccfa1d601", "Druid of Purification", [
          "When this creature enters, starting with you, each player may choose an artifact or enchantment you don't control. Destroy each permanent chosen this way."
    ], DRUID_OF_PURIFICATION_DEF);

  defineCard("ab655810-f67e-4576-9174-35b16f5e3235", "Saheeli, Sublime Artificer", [
          "Whenever you cast a noncreature spell, create a 1/1 colorless Servo artifact creature token.",
          "âˆ’2: Target artifact you control becomes a copy of another target artifact or creature you control until end of turn, except it's an artifact in addition to its other types."
    ], SAHEELI_SUBLIME_ARTIFICER_DEF);

  defineCard("7f268b15-ac92-4e98-821b-78d15d9285d9", "Loyal Apprentice", [
          "At the beginning of combat on your turn, if you control your commander, create a 1/1 colorless Thopter artifact creature token with flying. That token gains haste until end of turn."
    ], LOYAL_APPRENTICE_DEF);

  unimplemented("86084ed9-b8bb-4289-9579-6056194787bc", "Pia and Kiran Nalaar", [
          "{2}{R}, Sacrifice an artifact: ~ deals 2 damage to any target."
    ]);

  defineCard("cd1eda60-53e4-44d0-9b2c-7a57395e291f", "Conjurer's Closet", [
          "At the beginning of your end step, you may exile target creature you control, then return that card to the battlefield under your control."
    ], CONJURERS_CLOSET_DEF);

  defineCard("76678885-3674-443d-b9a2-2a460cf6aac0", "Panharmonicon", [
          "If an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time."
    ], PANHARMONICON_DEF);

  defineCard("1b5e6560-ff2e-4475-96cb-63f64c8a86db", "Soul-Guide Lantern", [
          "When this artifact enters, exile target card from a graveyard.",
          "{T}, Sacrifice this artifact: Exile each opponent's graveyard."
    ], SOUL_GUIDE_LANTERN_DEF);

  defineCard("180e1a7e-890d-477c-80a5-da8a5f2857b3", "Reckless Fireweaver", [
          "Whenever an artifact you control enters, this creature deals 1 damage to each opponent."
    ], RECKLESS_FIREWEAVER_DEF);

  defineCard("757eadac-dd29-4a7f-8683-5bc823168326", "One with the Machine", [
          "Draw cards equal to the greatest mana value among artifacts you control."
    ], ONE_WITH_THE_MACHINE_DEF);

  defineCard("c68faebc-b2cd-461b-b93e-e1fcd4816810", "Midnight Clock", [
          "When the twelfth hour counter is put on this artifact, shuffle your hand and graveyard into your library, then draw seven cards. Exile this artifact."
    ], MIDNIGHT_CLOCK_DEF);

  defineCard("88b51e15-6630-4e14-a6b8-db0aa12e34ef", "Disallow", [
          "Counter target spell, activated ability, or triggered ability."
    ], DISALLOW_DEF);

  // Final exact-text registrations for the Unicode-sensitive oracle lines. These re-register
  // cards defined above whose `handledLines` literals were mojibake; going through defineCard
  // means the corrected text reaches BOTH ids, not just the Scryfall one — previously the
  // fixture id kept the broken text and the card stayed unmodeled when built by name.
  defineCard("295cd8e1-0830-46c1-9957-556afd4bcee6", "Aetheric Amplifier", ["{4}, {T}: Choose one. Activate only as a sorcery.", "\u2022 Double the number of each kind of counter on target permanent.", "\u2022 Double the number of each kind of counter you have."], AETHERIC_AMPLIFIER_DEF);
  defineCard("397b9dcf-690a-4a58-8637-bb9baab7cc2f", "Elder Gargaroth", ["Whenever this creature attacks or blocks, choose one \u2014", "\u2022 Create a 3/3 green Beast creature token.", "\u2022 You gain 3 life.", "\u2022 Draw a card."], ELDER_GARGAROTH_DEF);
  defineCard("88600bd4-4dcc-4788-bba4-78b6cf5ad8f8", "Peema Trailblazer", ["Whenever this creature deals combat damage to a player, you get that many {E} .", "Exhaust \u2014 Pay six {E}: Put two +1/+1 counters on this creature. Then draw cards equal to the greatest power among creatures you control."], PEEMA_TRAILBLAZER_DEF);
  defineCard("aaadfe41-b2be-4183-b45e-a70e53a59d2e", "Retrofitter Foundry", ["{3}: Untap this artifact.", "{T}, Sacrifice a Thopter: Create a 4/4 colorless Construct artifact creature token."], RETROFITTER_FOUNDRY_DEF);
  defineCard("ab655810-f67e-4576-9174-35b16f5e3235", "Saheeli, Sublime Artificer", ["Whenever you cast a noncreature spell, create a 1/1 colorless Servo artifact creature token.", "\u2212\u0032: Target artifact you control becomes a copy of another target artifact or creature you control until end of turn, except it's an artifact in addition to its other types."], SAHEELI_SUBLIME_ARTIFICER_DEF);

}

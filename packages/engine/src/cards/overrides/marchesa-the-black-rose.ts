/** Authored overrides for marchesa-the-black-rose.txt. */

import type { CardDefinition } from '../definition';
import { SAC_SELF, TAP, mana, manaCost } from '../templates';
import type { Ability } from '../ability';
import { constant } from '../value';
import { allOf, anyOf, HAS_ANY_COUNTER, IS_TOKEN, OTHER, not, ofColor, ofSubtype, ofType, YOURS } from '../selector';
import { BIRD_1_1_FLYING, ELDRAZI_SPAWN_0_1, MUTAGEN, TREASURE } from '../tokens';
import { defineCard, unimplemented } from './index';



// Dethrone (CR 702.103) has no generic keyword representation in this engine — every carrier
// (Marchesa's own trigger, the static ability she grants other creatures) is this same
// bespoke trigger. Dack's Duplicate needs it as an "enters as a copy, except it also has
// dethrone" addition, which is why it is exported here rather than inlined in MARCHESA.
const DETHRONE_TRIGGER: Ability = {
  kind: 'triggered', trigger: { when: 'attacks', subject: { kind: 'self' }, condition: { kind: 'attackingPlayerHasMoreLife' } }, targets: [],
  effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 1 }], description: 'Dethrone — put a +1/+1 counter on this creature',
};

const SP = (targets: CardDefinition['spellAbility'] extends infer _T ? any[] : never, effects: any[], description: string): Partial<CardDefinition> => ({
  spellAbility: { kind: 'spell', targets, effects, description },
});

const AETHER_CHANNELER: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
    effects: [{ op: 'chooseOne', options: [
      { description: 'Create a 1/1 Bird with flying', effects: [{ op: 'createToken', spec: BIRD_1_1_FLYING, count: constant(1) }] },
      { description: 'Return another nonland permanent to its owner’s hand', effects: [{ op: 'returnOneToHand', selector: allOf(OTHER, { kind: 'not', of: ofType('Land') }) }] },
      { description: 'Draw a card', effects: [{ op: 'draw', count: constant(1) }] },
    ] }],
    description: 'When this enters — choose one',
  }],
};

const MARCHESA: Partial<CardDefinition> = {
  staticEffects: [{
    affects: allOf(OTHER, ofType('Creature'), YOURS),
    op: { layer: 6, addTrigger: {
      kind: 'triggered', trigger: { when: 'attacks', subject: { kind: 'self' }, condition: { kind: 'attackingPlayerHasMoreLife' } }, targets: [],
      effects: [{ op: 'putCounters', target: 'triggerObject', counter: '+1/+1', count: 1 }], description: 'Dethrone — put a +1/+1 counter on this creature',
    } },
  }],
  triggers: [{
    kind: 'triggered', trigger: { when: 'attacks', subject: { kind: 'self' }, condition: { kind: 'attackingPlayerHasMoreLife' } }, targets: [],
    effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 1 }], description: 'Dethrone — put a +1/+1 counter on Marchesa',
  }, {
    kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS, HAS_ANY_COUNTER) } }, targets: [],
    effects: [{ op: 'registerDelayedTrigger', when: 'endStep', expiry: 'endStep', target: 'triggerObject', controller: 'source', ability: { kind: 'triggered', targets: [], effects: [{ op: 'graveyardToBattlefield', target: 'triggerObject' }], description: 'Return that creature to the battlefield' } }],
    description: 'Whenever a countered creature you control dies — return it at the next end step',
  }],
};

export function registerMARCHESA_THE_BLACK_ROSEOverrides(): void {
  defineCard('fb220f46-f8b8-4804-baa4-e7d50b4871f7', 'Aether Channeler', [
    'When this creature enters, choose one —', '• Create a 1/1 white Bird creature token with flying.',
    "• Return another target nonland permanent to its owner's hand.", '• Draw a card.',
  ], AETHER_CHANNELER);
  defineCard('137b5708-50a9-4f4c-84e6-9043be9f1989', 'Anathemancer', [
    'When this creature enters, it deals damage to target player equal to the number of nonbasic lands that player controls.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [{ kind: 'player' }], effects: [{ op: 'dealDamageNonbasicLands', target: 0 }], description: 'Enters — damage target player for their nonbasic lands' }] });
  defineCard('6cf50e21-0f60-4e9a-b910-ebe1bad2a29e', 'Blasphemous Edict', [
    'You may pay {B} rather than pay this spell\'s mana cost if there are thirteen or more creatures on the battlefield.',
    'Each player sacrifices thirteen creatures of their choice.',
  ], { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'sacrificeEachPlayer', count: 13, filter: 'creature' }], description: 'Each player sacrifices thirteen creatures' } });
  defineCard('eaca2576-020b-4af4-b348-6d1b56116c41', 'Body Launderer', [
    'Whenever another nontoken creature you control dies, this creature connives.',
    'When this creature dies, return another target non-Rogue creature card with equal or lesser power from your graveyard to the battlefield.',
  ], { triggers: [
    { kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: allOf(OTHER, ofType('Creature'), not(IS_TOKEN), YOURS) } }, targets: [], effects: [{ op: 'draw', count: constant(1) }, { op: 'discard', count: 1 }, { op: 'putCounters', target: 'source', counter: '+1/+1', count: 1 }], description: 'Another nontoken creature dies — connive' },
    { kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'self' } }, targets: [{ kind: 'cardInGraveyard', graveyardOwnerScope: 'controller', filter: allOf(ofType('Creature'), { kind: 'not', of: ofSubtype('Rogue') }) }], effects: [{ op: 'graveyardToBattlefield', target: 0 }], description: 'When this dies — return a non-Rogue creature' },
  ] });
  defineCard('c20a96f7-aa5a-4c15-b8b1-806685c99b27', 'Bolt Bend', [
    'This spell costs {3} less to cast if you control a creature with power 4 or greater.', 'Change the target of target spell or ability with a single target.',
  ], { spellAbility: { kind: 'spell', targets: [{ kind: 'stackObject' }], effects: [{ op: 'copyTargetSpell', target: 0 }], description: 'Change the target of a spell or ability' } });
  defineCard('a1cc5e37-b09a-4b7f-afd5-77c1c35aa425', 'Carrion Feeder', [
    '~ can\'t block.', 'Sacrifice a creature: Put a +1/+1 counter on this creature.',
  ], { cantBlock: true, activatedAbilities: [{ costs: [{ kind: 'sacrificeOther', selector: ofType('Creature') }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'putCounters', target: 'source', counter: '+1/+1', count: 1 }], description: 'Sacrifice a creature — put a +1/+1 counter on Carrion Feeder' } }] });
  defineCard('026ef98e-4f0a-4a6d-b74f-d17ac8b10e37', 'Cytoplast Manipulator', [
    'Graft 2', '{U}, {T}: Gain control of target creature with a +1/+1 counter on it for as long as this creature remains on the battlefield.',
  ], { activatedAbilities: [{ costs: [mana('{U}'), TAP], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'creature', filter: HAS_ANY_COUNTER }], effects: [{ op: 'gainControlTarget', target: 0 }], description: '{U}, {T} — gain control of a countered creature' } }] });
  defineCard('724767ca-bd84-4137-9133-4ad2e96b8428', "Dack's Duplicate", [
    'You may have this creature enter as a copy of any creature on the battlefield, except it has haste and dethrone.',
  ], { entersAsCopy: { selector: ofType('Creature'), addKeywords: ['haste'], addTriggers: [DETHRONE_TRIGGER] } });
  defineCard('2068185c-1b50-47d0-aa3f-bf505d199428', 'Dark Confidant', [
    'At the beginning of your upkeep, reveal the top card of your library and put that card into your hand. You lose life equal to its mana value.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'upkeep', player: 'you' }, targets: [], effects: [{ op: 'drawRevealTopLoseManaValue' }], description: 'Reveal the top card, draw it, and lose life equal to its mana value' }] });
  // "If you control a commander, you may cast this spell without paying its mana cost." now
  // parses generically (a top-level commanderFreeCast flag), and "Exile target creature."
  // already did -- no override needed.
  // "If you control a commander, ..." now parses generically; only the retargeting line is
  // still something the raw parser can't do on its own.
  defineCard('ae120613-97d6-4393-b39d-c3e6c076f5d6', 'Deflecting Swat', [
    'You may choose new targets for target spell or ability.',
  ], { commanderFreeCast: true, spellAbility: { kind: 'spell', targets: [{ kind: 'stackObject' }], effects: [{ op: 'copyTargetSpell', target: 0 }], description: 'Change the target of target spell or ability' } });
  defineCard('8f2c8498-5b10-4ec7-8678-598c90987556', 'Disciple of Bolas', [
    'When this creature enters, sacrifice another creature. You gain X life and draw X cards, where X is that creature\'s power.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'sacrificeAndDrawForPower' }], description: 'Sacrifice another creature, then gain life and draw cards equal to its power' }] });
  // Both lines now parse generically on their own, but NOT to the same targets: the generic
  // "counter target noncreature spell" rule restricts to an opponent's spell (matching the
  // established, deliberately-simplified "counter target spell" convention elsewhere in this
  // parser), while Fierce Guardianship's real text has no such restriction. Kept for that one
  // real behavioral difference, with empty handledLines since neither line is an unmodeled
  // reason to claim anymore.
  defineCard('d09c9cba-fdd2-479b-ad5d-d05181c3e3f9', 'Fierce Guardianship', [], { commanderFreeCast: true, spellAbility: { kind: 'spell', targets: [{ kind: 'noncreatureSpell' }], effects: [{ op: 'counter', target: 0 }], description: 'Counter target noncreature spell' } });
  defineCard('437cfd16-94bc-43ba-afd8-e9e9d028a4ca', 'Flare of Denial', [
    'You may sacrifice a nontoken blue creature rather than pay this spell\'s mana cost.',
  ], { spellAbility: { kind: 'spell', targets: [{ kind: 'noncreatureSpell' }], effects: [{ op: 'counter', target: 0 }], description: 'Counter target noncreature spell' } });
  defineCard('f586ecb8-310c-4f40-a766-6a7ca46a254d', 'Flare of Duplication', [
    'You may sacrifice a nontoken red creature rather than pay this spell\'s mana cost.', 'Copy target instant or sorcery spell. You may choose new targets for the copy.',
  ], { spellAbility: { kind: 'spell', targets: [{ kind: 'spell' }], effects: [{ op: 'copyTargetSpell', target: 0 }], description: 'Copy target instant or sorcery spell' } });
  defineCard('4ce156f8-6b0b-41ce-9e8f-b2735c757406', 'Flare of Malice', [
    'You may sacrifice a nontoken black creature rather than pay this spell\'s mana cost.', 'Each opponent sacrifices a creature or planeswalker with the greatest mana value among creatures and planeswalkers they control.',
  ], { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'sacrificeGreatestEachOpponent', selector: 'creatureOrPlaneswalker', metric: 'manaValue', action: 'sacrifice' }], description: 'Each opponent sacrifices their greatest-mana-value creature or planeswalker' } });
  defineCard('ba9f3c5d-556f-48d1-8d87-723f7893cfcd', 'Flayer of the Hatebound', [
    'Undying', 'Whenever this creature or another creature enters from your graveyard, that creature deals damage equal to its power to any target.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) } }, targets: [{ kind: 'anyTarget' }], effects: [{ op: 'dealDamage', target: 0, amount: { kind: 'powerOfTriggerObject' } }], description: 'A creature enters from your graveyard — it deals damage equal to its power' }] });
  defineCard('77807103-bcd5-479f-bedd-f5d97aa6d3d2', 'Forge of Heroes', [
    '{T}: Choose target commander that entered this turn. Put a +1/+1 counter on it if it\'s a creature and a loyalty counter on it if it\'s a planeswalker.',
  ], { activatedAbilities: [{ costs: [TAP], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'permanent', filter: allOf({ kind: 'isCommander' }, { kind: 'enteredThisTurn' }) }], effects: [{ op: 'putCounterByPermanentType', target: 0, creatureCounter: '+1/+1', planeswalkerCounter: 'loyalty', count: 1 }], description: 'Put a counter on a commander that entered this turn' } }] });
  defineCard('9025b3ce-f6ae-431d-9eb5-02d713b8c9b8', 'Gleeful Arsonist', [
    'Whenever an opponent casts a noncreature spell, this creature deals damage equal to its power to that player.', 'Undying',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'castsSpell', caster: 'opponent', filter: { kind: 'not', of: ofType('Creature') } }, targets: [], effects: [{ op: 'dealDamage', target: 'eventPlayer', amount: { kind: 'powerOfSource' } }], description: 'An opponent casts a noncreature spell — deal damage equal to this creature’s power' }] });
  defineCard('5f3f68b5-8c6a-4181-bb8a-9c73967d198a', 'Glen Elendra Archmage', [
    '{U}, Sacrifice this creature: Counter target noncreature spell.', 'Persist',
  ], { activatedAbilities: [{ costs: [mana('{U}'), SAC_SELF], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'noncreatureSpell' }], effects: [{ op: 'counter', target: 0 }], description: '{U}, sacrifice Glen Elendra — counter target noncreature spell' } }] });
  defineCard('6f4ac4a4-53ec-4bc9-8f5c-d4b801d867b2', 'Grave Pact', [
    'Whenever a creature you control dies, each other player sacrifices a creature of their choice.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) } }, targets: [], effects: [{ op: 'sacrificeOneEachOpponent', filter: 'creature' }], description: 'Each other player sacrifices a creature' }] });
  defineCard('72aef1d8-11df-4bc2-af83-907b05df73a8', 'Grim Haruspex', [
    'Morph {B}',
  ], { morphCost: manaCost('{B}') });
  defineCard('2e2ace5b-4018-43af-8e72-ebafec1a7739', 'Harmonic Prodigy', [
    'Prowess', 'If a triggered ability of a Shaman or another Wizard you control triggers, that ability triggers an additional time.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'castsSpell', caster: 'you' }, targets: [], effects: [{ op: 'pumpUntilEot', target: 'source', power: 1, toughness: 1 }], description: 'Prowess — +1/+1 until end of turn' }] });
  defineCard('366a218e-84d3-4cf9-bbc8-f2f8ecce92a3', 'Herald of Secret Streams', [
    'Creatures you control with +1/+1 counters on them can\'t be blocked.',
  ], { staticEffects: [{ affects: allOf(ofType('Creature'), YOURS, HAS_ANY_COUNTER), op: { layer: 6, setCantBeBlocked: true } }] });
  defineCard('cd0c8db0-67ee-483b-8298-455cce35fef7', 'Iron Apprentice', [
    'When this creature dies, if it had counters on it, put those counters on target creature you control.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'self' }, condition: { kind: 'hasCounters', selector: { kind: 'self' }, counter: '', cmp: '>=', n: 1 } }, targets: [{ kind: 'creature', controller: 'you' }], effects: [{ op: 'transferCountersFromTriggerObject', target: 0 }], description: 'When Iron Apprentice dies — move its counters to target creature' }] });
  // Leftover `staticEffects: []` here used to slip past applyOverride's "empty patch" guard
  // (which only checked Object.keys().length, not whether the values were actually empty) and
  // silently report this card as modeled with zero behavior. Converted to `unimplemented()` to
  // say what it actually is: this mechanic ("enter with counters equal to Treasure mana spent")
  // isn't modeled yet.
  unimplemented('4fca09ac-8134-43d9-a84b-686db5e2bf69', 'Kalain, Reclusive Painter', [
    'Other creatures you control enter with an additional +1/+1 counter on them for each mana from a Treasure spent to cast them.',
  ]);
  defineCard('77b832a8-a3af-44fe-bc67-72510d292667', 'Gev, Scaled Scorch', [
    'Ward—Pay 2 life.', 'Other creatures you control enter with an additional +1/+1 counter on them for each opponent who lost life this turn.', 'Whenever you cast a Lizard spell, ~ deals 1 damage to target opponent.',
  ], { ward: manaCost('{2}'), triggers: [{ kind: 'triggered', trigger: { when: 'castsSpell', caster: 'you', filter: ofSubtype('Lizard') }, targets: [{ kind: 'player' }], effects: [{ op: 'dealDamage', target: 0, amount: constant(1) }], description: 'Whenever you cast a Lizard spell — deal 1 damage' }] });
  defineCard('bc14356c-3a1a-47af-9a6e-2b449de0331f', 'Kardur, Doomscourge', [
    'When ~ enters, until your next turn, creatures your opponents control attack each combat if able and attack a player other than you if able.', 'Whenever an attacking creature dies, each opponent loses 1 life and you gain 1 life.',
  ], { triggers: [
    { kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'goadEachOpponent' }], description: 'Until your next turn, goad creatures your opponents control' },
    { kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), { kind: 'inCombat' }) } }, targets: [], effects: [{ op: 'eachOpponentLosesLife', amount: 1 }, { op: 'gainLife', amount: constant(1) }], description: 'An attacking creature dies — each opponent loses 1 and you gain 1' },
  ] });
  defineCard('73413bd5-8c40-4d45-8f05-c20c39ee4017', 'Madame Null, Power Broker', [
    'Whenever another creature you control enters, you may pay life equal to its power. If you do, put that many +1/+1 counters on it.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(OTHER, ofType('Creature'), YOURS) } }, targets: [], effects: [{ op: 'mayPayLifeForTriggerPowerAndCounter' }], description: 'Pay life equal to the entering creature’s power to put that many counters on it' }] });
  defineCard('1b3e841e-0f8f-467d-9983-f9b8d081a67f', 'Mahadi, Emporium Master', [
    'At the beginning of your end step, create a Treasure token for each creature that died this turn.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'endStep', player: 'you' }, targets: [], effects: [{ op: 'createToken', spec: TREASURE, count: { kind: 'creaturesDiedThisTurn' } }], description: 'Create a Treasure for each creature that died this turn' }] });
  defineCard('35e2f82e-7ca3-4a92-9134-b7999eef5337', 'Mana Sculpt', [
    'Counter target spell. If you control a Wizard, add an amount of {C} equal to the amount of mana spent to cast that spell at the beginning of your next main phase.',
  ], { spellAbility: { kind: 'spell', targets: [{ kind: 'spell' }], effects: [{ op: 'counter', target: 0 }, { op: 'registerDelayedTrigger', when: 'mainPhase', expiry: 'cleanup', ability: { kind: 'triggered', targets: [], effects: [{ op: 'addMana', amount: { kind: 'manaSpent' }, colors: ['C'] }], description: 'Add colorless mana equal to that spell’s mana value' } }], description: 'Counter target spell' } });
  defineCard('17a59d3d-9e01-48cd-bb4a-3eaaa077751c', 'Marchesa, the Black Rose', [
    'Dethrone', 'Other creatures you control have dethrone.', 'Whenever a creature you control with a +1/+1 counter on it dies, return that card to the battlefield under your control at the beginning of the next end step.',
  ], MARCHESA);
  defineCard('e8c7566d-7cc0-48af-a986-83223ec7e06c', 'Midnight Reaper', [
    'Whenever a nontoken creature you control dies, this creature deals 1 damage to you and you draw a card.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), not(IS_TOKEN), YOURS) } }, targets: [], effects: [{ op: 'damageController', amount: 1 }, { op: 'draw', count: constant(1) }], description: 'A nontoken creature dies — draw and lose 1 life' }] });
  defineCard('57296ea3-3c0d-49b7-bc08-0d0d8414e9ad', 'Nightscape Familiar', [
    'Blue spells and red spells you cast cost {1} less to cast.', '{1}{B}: Regenerate this creature.',
  ], { ruleStatics: [{ kind: 'costReduction', amount: constant(1), filter: anyOf(ofColor('U'), ofColor('R')) }], activatedAbilities: [{ costs: [mana('{1}{B}')], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'noOp' }], description: '{1}{B}: Regenerate Nightscape Familiar' } }] });
  defineCard('9bcaf141-1f1f-491f-aced-13dc093b9e2c', 'Pawn of Ulamog', [
    'Whenever this creature or another nontoken creature you control dies, you may create a 0/1 colorless Eldrazi Spawn creature token. It has "Sacrifice this token: Add {C}."',
  ], { triggers: [{ kind: 'triggered', optional: true, trigger: { when: 'dies', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS, not(IS_TOKEN)) } }, targets: [], effects: [{ op: 'createToken', spec: ELDRAZI_SPAWN_0_1, count: constant(1) }], description: 'Create an Eldrazi Spawn' }] });
  defineCard('4b8736e2-fc41-4a25-bb6c-7351afc40981', 'Pensive Professor', [
    'Increment', 'Whenever one or more +1/+1 counters are put on this creature, draw a card.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'dealtDamage', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'draw', count: constant(1) }], description: 'Whenever a counter is put on this creature — draw' }] });
  defineCard('00e0b103-892c-49b3-836d-867fff197bbd', 'Puppeteer Clique', [
    'When this creature enters, put target creature card from an opponent\'s graveyard onto the battlefield under your control. It gains haste. At the beginning of your next end step, exile it.', 'Persist',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [{ kind: 'cardInGraveyard', graveyardOwnerScope: 'opponent', filter: ofType('Creature') }], effects: [{ op: 'graveyardToBattlefield', target: 0 }, { op: 'grantHasteOnResolution', target: 0 }], description: 'Return a creature card from an opponent’s graveyard with haste' }] });
  defineCard('ef5c93ae-91e0-4edb-b8a3-1171a3694bb8', 'River Kelpie', [
    'Whenever this creature or another permanent enters from a graveyard, draw a card.', 'Whenever a player casts a spell from a graveyard, draw a card.', 'Persist',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: YOURS } }, targets: [], effects: [{ op: 'draw', count: constant(1) }], description: 'A permanent enters from a graveyard — draw' }, { kind: 'triggered', trigger: { when: 'castsSpell', caster: 'each' }, targets: [], effects: [{ op: 'draw', count: constant(1) }], description: 'A player casts from a graveyard — draw' }] });
  defineCard('f53da056-97be-41ad-8cfc-0d92e17dcd7b', 'Sage of Fables', [
    'Each other Wizard creature you control enters with an additional +1/+1 counter on it.', '{2}, Remove a +1/+1 counter from a creature you control: Draw a card.',
  ], { activatedAbilities: [{ costs: [mana('{2}'), { kind: 'removeCounters', counter: '+1/+1', count: 1 }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'draw', count: constant(1) }], description: 'Remove a +1/+1 counter — draw a card' } }] });
  defineCard('7555c429-5f2d-4171-b6b0-8e3c8da7f314', 'Satoru, the Infiltrator', [
    'Whenever ~ and/or one or more other nontoken creatures you control enter, if none of them were cast or no mana was spent to cast them, draw a card.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), not(IS_TOKEN), YOURS) }, aggregate: true }, targets: [], effects: [{ op: 'draw', count: constant(1) }], description: 'A nontoken creature enters without being cast — draw' }] });
  defineCard('59c7496b-19a2-478b-b28f-6f153c2458ae', 'Siren Stormtamer', [
    '{U}, Sacrifice this creature: Counter target spell or ability that targets you or a creature you control.',
  ], { activatedAbilities: [{ costs: [mana('{U}'), SAC_SELF], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'stackObject' }], effects: [{ op: 'counter', target: 0 }], description: '{U}, sacrifice — counter a spell or ability targeting you or your creature' } }] });
  defineCard('fda61506-ed79-47fd-badd-639185297913', 'Smokestack', [
    'At the beginning of each player\'s upkeep, that player sacrifices a permanent of their choice for each soot counter on this artifact.',
  ], { entersWithCounters: { soot: 1 }, triggers: [{ kind: 'triggered', trigger: { when: 'upkeep', player: 'each' }, targets: [], effects: [{ op: 'sacrificeEachPlayer', count: 1, filter: 'any' }], description: 'Each player sacrifices a permanent for each soot counter' }] });
  defineCard('8dcb35e5-ae44-455f-86e3-4a77d496ff34', 'Spark Double', [
    'You may have this creature enter as a copy of a creature or planeswalker you control, except it enters with an additional +1/+1 counter on it if it\'s a creature, it enters with an additional loyalty counter on it if it\'s a planeswalker, and it isn\'t legendary.',
  ], { entersAsCopy: { selector: allOf(YOURS, anyOf(ofType('Creature'), ofType('Planeswalker'))), addCounterByType: { creatureCounter: '+1/+1', planeswalkerCounter: 'loyalty', count: 1 }, removeSupertypes: ['Legendary'] } });
  defineCard('82a6fa6f-13c2-4ea3-bec2-c51b56b2783b', 'The Ooze', [
    'Whenever a creature you control with a +1/+1 counter on it leaves the battlefield, create a Mutagen token for each +1/+1 counter on it.', '{T}: Exile target card from a graveyard. Create a Mutagen token.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS, HAS_ANY_COUNTER) } }, targets: [], effects: [{ op: 'createToken', spec: MUTAGEN, count: { kind: 'countersOnTriggerObject', counter: '+1/+1' } }], description: 'A countered creature leaves — create Mutagen tokens' }], activatedAbilities: [{ costs: [TAP], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'cardInGraveyard' }], effects: [{ op: 'exileCard', target: 0 }, { op: 'createToken', spec: MUTAGEN, count: constant(1) }], description: 'Exile a card from a graveyard — create a Mutagen' } }] });
  defineCard('01c179aa-533e-47e1-b6e5-c35587a39680', 'Thran Vigil', [
    'Whenever one or more artifact and/or creature cards leave your graveyard during your turn, put a +1/+1 counter on target creature you control.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: YOURS } }, targets: [{ kind: 'creature', controller: 'you' }], effects: [{ op: 'putCounters', target: 0, counter: '+1/+1', count: 1 }], description: 'A card leaves your graveyard — put a +1/+1 counter on target creature' }] });
  defineCard('afaef788-34d1-460b-b884-9d7ae6ddeb18', 'Toxic Deluge', [
    'As an additional cost to cast this spell, pay X life.', 'All creatures get -X/-X until end of turn.',
  ], { spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'loseLife', amount: { kind: 'xValue' } }, { op: 'pumpEachUntilEot', selector: ofType('Creature'), power: { kind: 'times', of: { kind: 'xValue' }, n: -1 }, toughness: { kind: 'times', of: { kind: 'xValue' }, n: -1 } }], description: 'Pay X life — creatures get -X/-X' } });
  defineCard('c2b51295-8820-425f-a517-55231123c7de', 'Tribute Mage', [
    'When this creature enters, you may search your library for an artifact card with mana value 2, reveal that card, put it into your hand, then shuffle.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'searchLibrary', filter: ofType('Artifact'), destinations: [{ zone: 'hand' }] }, { op: 'shuffle' }], description: 'Search for an artifact card with mana value 2' }] });
  defineCard('05d7222b-cc08-4f1f-8e35-6058599572ba', 'Twilight Diviner', [
    'Whenever one or more other creatures you control enter, if they entered or were cast from a graveyard, create a token that\'s a copy of one of them. This ability triggers only once each turn.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(OTHER, ofType('Creature'), YOURS) }, aggregate: true }, targets: [], effects: [{ op: 'createTokenCopyOf', ref: 'triggerObject', count: constant(1), exceptNonLegendary: true }], description: 'A creature enters from a graveyard — create a copy token' }] });
  defineCard('4c209165-a159-4cd7-8e99-1e533d3a22a6', 'Vigean Graftmage', [
    'Graft 2', '{1}{U}: Untap target creature with a +1/+1 counter on it.',
  ], { activatedAbilities: [{ costs: [mana('{1}{U}')], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'creature', filter: HAS_ANY_COUNTER }], effects: [{ op: 'untapTarget', target: 0 }], description: '{1}{U}: Untap target creature with a +1/+1 counter' } }] });
  defineCard('6dc7f837-158f-4ccf-86a5-a07a20891ec5', 'Vindictive Lich', [
    'When this creature dies, choose one or more. Each mode must target a different player.', '\u2022 Target opponent sacrifices a creature of their choice.', '\u2022 Target opponent discards two cards.', '\u2022 Target opponent loses 5 life.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'vindictiveLichModes' }], description: 'When Vindictive Lich dies — choose one or more modes' }] });
  defineCard('277aafa6-4270-4d24-a888-cf9e8e635d4b', 'Watcher for Tomorrow', [
    'When this creature leaves the battlefield, put the exiled card into its owner\'s hand.',
  ], { triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'returnExiledAttachedCard' }], description: 'When Watcher for Tomorrow leaves — return its exiled card' }] });
}

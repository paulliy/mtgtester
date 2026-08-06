/** Authored overrides for queen-marchesa-queens-gambit.txt. */

import type { CardDefinition } from '../definition';
import { constant } from '../value';
import { SAC_SELF, TAP } from '../templates';
import { parseManaCost } from '../../mana/cost';
import { allOf, ofType, YOURS } from '../selector';
import { defineCard } from './index';
import { ASSASSIN_1_1 as ASSASSIN_TOKEN } from '../tokens';

const MANA = (cost: string) => ({ kind: 'mana' as const, cost: parseManaCost(cost).cost! });

const SIGNET = (symbols: ['W' | 'U' | 'B' | 'R' | 'G', 'W' | 'U' | 'B' | 'R' | 'G']) => ({
  activatedAbilities: [{
    costs: [MANA('{1}'), TAP],
    timing: 'any' as const,
    ability: {
      kind: 'activated' as const,
      targets: [],
      effects: [{ op: 'addMana' as const, amount: constant(2), colors: [], fixedSymbols: symbols },
      ],
      description: `Pay {1} and tap — add {${symbols.join('}{')}}`,
    },
  }],
});

const BOROS_CHARM: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'playerOrPlaneswalker' }, { kind: 'creature' }],
    modes: {
      minChoices: 1,
      maxChoices: 1,
      options: [
        { description: 'Deal 4 damage to target player or planeswalker', targetSlots: [0], effects: [{ op: 'dealDamage', target: 0, amount: constant(4) }] },
        { description: 'Permanents you control gain indestructible until end of turn', targetSlots: [], effects: [{ op: 'grantKeywordEachUntilEot', selector: YOURS, keyword: 'indestructible' }] },
        { description: 'Target creature gains double strike until end of turn', targetSlots: [1], effects: [{ op: 'grantKeywordUntilEot', target: 1, keyword: 'double strike' }] },
      ],
    },
    effects: [],
    description: 'Choose one — Boros Charm mode',
  },
};

const RAKDOS_CHARM: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'player' }, { kind: 'artifact' }],
    modes: {
      minChoices: 1,
      maxChoices: 1,
      options: [
        { description: "Exile target player's graveyard", targetSlots: [0], effects: [{ op: 'exileTargetPlayerGraveyard', target: 0 }] },
        { description: 'Destroy target artifact', targetSlots: [1], effects: [{ op: 'destroy', target: 1 }] },
        { description: 'Each creature deals 1 damage to its controller', targetSlots: [], effects: [{ op: 'damageEachCreatureController', amount: constant(1) }] },
      ],
    },
    effects: [],
    description: 'Choose one — Rakdos Charm mode',
  },
};

const MOB_RULE: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [],
    modes: {
      minChoices: 1,
      maxChoices: 1,
      options: [
        { description: 'Gain control of creatures with power 4 or greater', targetSlots: [], effects: [{ op: 'gainControl', selector: allOf(ofType('Creature'), { kind: 'powerAtLeast', n: 4 }) }, { op: 'untapEach', selector: allOf(ofType('Creature'), { kind: 'powerAtLeast', n: 4 }) }, { op: 'grantKeywordEachUntilEot', selector: allOf(ofType('Creature'), { kind: 'powerAtLeast', n: 4 }), keyword: 'haste' }] },
        { description: 'Gain control of creatures with power 3 or less', targetSlots: [], effects: [{ op: 'gainControl', selector: allOf(ofType('Creature'), { kind: 'powerAtMost', n: 3 }) }, { op: 'untapEach', selector: allOf(ofType('Creature'), { kind: 'powerAtMost', n: 3 }) }, { op: 'grantKeywordEachUntilEot', selector: allOf(ofType('Creature'), { kind: 'powerAtMost', n: 3 }), keyword: 'haste' }] },
      ],
    },
    effects: [],
    description: 'Choose one — Mob Rule mode',
  },
};

const QUEEN_MARCHESA: Partial<CardDefinition> = {
  triggers: [{
    kind: 'triggered',
    trigger: { when: 'enters', subject: { kind: 'self' } },
    targets: [],
    effects: [{ op: 'becomeMonarch' }],
    description: 'Enters — you become the monarch',
  }, {
    kind: 'triggered',
    trigger: { when: 'upkeep', player: 'you', condition: { kind: 'opponentIsMonarch' } },
    targets: [],
    effects: [{ op: 'createToken', count: constant(1), spec: ASSASSIN_TOKEN }],
    description: 'Upkeep — if an opponent is the monarch, create an Assassin',
  }],
};

const GENEROUS_GIFT: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'permanent' }],
    effects: [{ op: 'destroyAndCreateTokenForController', target: 0, count: constant(1), spec: { name: 'Elephant', typeLine: 'Creature — Elephant', types: ['Creature'], subtypes: ['Elephant'], colors: ['G'], power: 3, toughness: 3 } }],
    description: 'Destroy target permanent; its controller creates a 3/3 Elephant',
  },
};

const STROKE_OF_MIDNIGHT: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'nonlandPermanent' }],
    effects: [{ op: 'destroyAndCreateTokenForController', target: 0, count: constant(1), spec: { name: 'Human', typeLine: 'Creature — Human', types: ['Creature'], subtypes: ['Human'], colors: ['W'], power: 1, toughness: 1 } }],
    description: 'Destroy target nonland permanent; its controller creates a 1/1 Human',
  },
};

const SWORDS_TO_PLOWSHARES: Partial<CardDefinition> = {
  spellAbility: {
    kind: 'spell',
    targets: [{ kind: 'creature' }],
    effects: [{ op: 'exileAndGainLifeTargetController', target: 0 }],
    description: 'Exile target creature; its controller gains life equal to its power',
  },
};

const FABLED_PASSAGE: Partial<CardDefinition> = {
  activatedAbilities: [{
    costs: [TAP, SAC_SELF],
    timing: 'any',
    ability: {
      kind: 'activated',
      targets: [],
      effects: [{ op: 'searchLibrary', filter: allOf(ofType('Land'), { kind: 'supertype', value: 'Basic' }), destinations: [{ zone: 'battlefield', tapped: true }] }, { op: 'shuffle' }],
      description: 'Sacrifice — search for a basic land and put it onto the battlefield tapped',
    },
  }],
};

export function registerQUEEN_MARCHESA_QUEENS_GAMBITOverrides(): void {
  defineCard('e580a229-e800-4746-9d37-c32fcef8de28', 'Blightstep Pathway // Searstep Pathway', ['unsupported layout "modal_dfc"'], { staticEffects: [] });
  defineCard('1c633e02-95ef-445b-b4e0-fbfbc5ed9cc9', 'Brightclimb Pathway // Grimclimb Pathway', ['unsupported layout "modal_dfc"'], { staticEffects: [] });
  defineCard('a9b8d020-4d72-4934-8942-df29ef19fc1d', 'Needleverge Pathway // Pillarverge Pathway', ['unsupported layout "modal_dfc"'], { staticEffects: [] });
  defineCard('a731e87b-8d99-4b64-8ee3-8e540d652366', 'Malakir Rebirth // Malakir Mire', ['unsupported layout "modal_dfc"', 'unrecognized rules text: "Choose target creature. You lose 2 life. Until end of turn, that creature gains \"When this creature dies, return it to the battlefield tapped under its owner\'s control.\""'], { staticEffects: [] });
  defineCard('ff0ab867-b710-4b1a-baed-95fc3cf68f79', 'Valakut Awakening // Valakut Stoneforge', ['unsupported layout "modal_dfc"', 'unrecognized rules text: "Put any number of cards from your hand on the bottom of your library, then draw that many cards plus one."'], { staticEffects: [] });
  defineCard('6556c4c0-b10d-4208-821b-0c0a49abd188', 'Wandering Archaic // Explore the Vastlands', ['unsupported layout "modal_dfc"', 'unrecognized rules text: "Whenever an opponent casts an instant or sorcery spell, they may pay {2}. If they don\'t, you may copy that spell. You may choose new targets for the copy."'], { staticEffects: [] });
  defineCard('9842734c-1eac-4509-a731-4c22017ae586', 'Wear // Tear', ['unsupported layout "split"', 'unrecognized rules text: "Fuse"'], { staticEffects: [] });
  defineCard('2679d0dd-ba30-4a1c-b6a0-b3ac6c790496', 'Boros Charm', ['unrecognized rules text: "Choose one —"', 'unrecognized rules text: "• ~ deals 4 damage to target player or planeswalker."', 'unrecognized rules text: "• Permanents you control gain indestructible until end of turn."', 'unrecognized rules text: "• Target creature gains double strike until end of turn."'], BOROS_CHARM);
  defineCard('5e62b51d-faec-4aa0-9504-cf2c282d08ea', 'Rakdos Charm', ['unrecognized rules text: "Choose one —"', 'unrecognized rules text: "• Exile target player\'s graveyard."', 'unrecognized rules text: "• Destroy target artifact."', 'unrecognized rules text: "• Each creature deals 1 damage to its controller."'], RAKDOS_CHARM);
  defineCard('acca2128-6ebb-48a5-a6a2-1bc5e4aa86ce', 'Mob Rule', ['unrecognized rules text: "Choose one —"', 'unrecognized rules text: "• Gain control of all creatures with power 4 or greater until end of turn. Untap those creatures. They gain haste until end of turn."', 'unrecognized rules text: "• Gain control of all creatures with power 3 or less until end of turn. Untap those creatures. They gain haste until end of turn."'], MOB_RULE);
  defineCard('d7ac4be1-dcca-49b6-8ddb-d1b0e6cf2dcf', 'Queen Marchesa', ['unrecognized rules text: "When ~ enters, you become the monarch."', 'unrecognized rules text: "At the beginning of your upkeep, if an opponent is the monarch, create a 1/1 black Assassin creature token with deathtouch and haste."'], QUEEN_MARCHESA);
  defineCard('fae37e28-e137-4177-b973-fa8b4dd8f409', 'Generous Gift', ['unrecognized rules text: "Destroy target permanent. Its controller creates a 3/3 green Elephant creature token."'], GENEROUS_GIFT);
  defineCard('9a107e48-3d50-4941-95b1-10f2b29a4245', 'Stroke of Midnight', ['unrecognized rules text: "Destroy target nonland permanent. Its controller creates a 1/1 white Human creature token."'], STROKE_OF_MIDNIGHT);
  defineCard('b1544f21-7e98-461b-aed5-e748b0168c52', 'Swords to Plowshares', ['unrecognized rules text: "Exile target creature. Its controller gains life equal to its power."'], SWORDS_TO_PLOWSHARES);
  defineCard('0c85b8f7-0bd0-4680-9ec5-d4b110460a54', 'Fabled Passage', ['unrecognized rules text: "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. Then if you control four or more lands, untap that land."'], FABLED_PASSAGE);
  defineCard('41c84665-1f99-40ab-aaca-1188649eb263', 'Boros Signet', ['unrecognized rules text: "{1}, {T}: Add {R}{W}."'], SIGNET(['R', 'W']));
  defineCard('de3dcb5d-775a-479f-99f5-d1883ed9b1b5', 'Orzhov Signet', ['unrecognized rules text: "{1}, {T}: Add {W}{B}."'], SIGNET(['W', 'B']));
  defineCard('3adb7681-977f-4a32-9ec8-51481b958268', 'Rakdos Signet', ['unrecognized rules text: "{1}, {T}: Add {B}{R}."'], SIGNET(['B', 'R']));
  defineCard('8fa3ac81-3dfe-4565-be99-5554f7597b4b', 'Boros Garrison', ['unrecognized rules text: "When this land enters, return a land you control to its owner\'s hand."'], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'returnOneToHand', selector: allOf(ofType('Land'), YOURS) }], description: 'Enters — return a land you control to its owner’s hand' }] });
  defineCard('aa00ae0b-7c0f-427e-8102-ce0e2a6af5df', 'Orzhov Basilica', ['unrecognized rules text: "When this land enters, return a land you control to its owner\'s hand."'], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'returnOneToHand', selector: allOf(ofType('Land'), YOURS) }], description: 'Enters — return a land you control to its owner’s hand' }] });
  defineCard('0a023964-2905-4928-9c3e-dc63e6ebd218', 'Rakdos Carnarium', ['unrecognized rules text: "When this land enters, return a land you control to its owner\'s hand."'], { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'returnOneToHand', selector: allOf(ofType('Land'), YOURS) }], description: 'Enters — return a land you control to its owner’s hand' }] });
}

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

const dragonTempest = () =>
  oracle({
    name: 'Dragon Tempest',
    manaCost: '{1}{R}',
    typeLine: 'Enchantment',
    types: ['Enchantment'],
    oracleText:
      'Whenever a creature you control with flying enters, it gains haste until end of turn.\nWhenever a Dragon you control enters, it deals X damage to any target, where X is the number of Dragons you control.',
  });

const firkraag = () =>
  oracle({
    name: 'Firkraag, Cunning Instigator',
    manaCost: '{1}{U}{R}',
    typeLine: 'Legendary Creature — Dragon Elemental',
    types: ['Creature'],
    subtypes: ['Dragon', 'Elemental'],
    supertypes: ['Legendary'],
    power: '3',
    toughness: '3',
    oracleText:
      'Flying, haste\nWhenever one or more Dragons you control attack an opponent, goad target creature that player controls.\nWhenever a creature deals combat damage to one of your opponents, if that creature had to attack this combat, you put a +1/+1 counter on Firkraag and you draw a card.',
    keywords: ['Flying', 'Haste'],
  });

const iymrith = () =>
  oracle({
    name: 'Iymrith, Desert Doom',
    manaCost: '{3}{U}{U}',
    typeLine: 'Legendary Creature — Dragon',
    types: ['Creature'],
    subtypes: ['Dragon'],
    supertypes: ['Legendary'],
    power: '5',
    toughness: '5',
    oracleText:
      "Flying\nIymrith, Desert Doom has ward {4} as long as it's untapped.\nWhenever Iymrith deals combat damage to a player, draw a card. Then if you have fewer than three cards in hand, draw cards equal to the difference.",
    keywords: ['Flying'],
  });

const kairi = () =>
  oracle({
    name: 'Kairi, the Swirling Sky',
    manaCost: '{4}{U}{U}',
    typeLine: 'Legendary Creature — Dragon Spirit',
    types: ['Creature'],
    subtypes: ['Dragon', 'Spirit'],
    supertypes: ['Legendary'],
    power: '6',
    toughness: '7',
    oracleText:
      "Flying, ward {3}\nWhen Kairi, the Swirling Sky dies, choose one —\n• Return any number of target nonland permanents with total mana value 6 or less to their owners' hands.\n• Mill six cards, then return up to two instant and/or sorcery cards from your graveyard to your hand.",
    keywords: ['Flying'],
  });

const lozhan = () =>
  oracle({
    name: "Lozhan, Dragons' Legacy",
    manaCost: '{3}{U}{R}',
    typeLine: 'Legendary Creature — Dragon Shaman',
    types: ['Creature'],
    subtypes: ['Dragon', 'Shaman'],
    supertypes: ['Legendary'],
    power: '4',
    toughness: '2',
    oracleText:
      "Flying\nWhenever you cast an Adventure or Dragon spell, Lozhan, Dragons' Legacy deals damage equal to that spell's mana value to any target that isn't a commander.",
    keywords: ['Flying'],
  });

const morophon = () =>
  oracle({
    name: 'Morophon, the Boundless',
    manaCost: '{7}',
    typeLine: 'Legendary Creature — Shapeshifter',
    types: ['Creature'],
    subtypes: ['Shapeshifter'],
    supertypes: ['Legendary'],
    power: '6',
    toughness: '6',
    oracleText:
      'Changeling\nAs Morophon, the Boundless enters, choose a creature type.\nSpells of the chosen type you cast cost {W}{U}{B}{R}{G} less to cast. This effect reduces only the amount of colored mana you pay.\nOther creatures you control of the chosen type get +1/+1.',
    keywords: ['Changeling'],
  });

const orbOfDragonkind = () =>
  oracle({
    name: 'Orb of Dragonkind',
    manaCost: '{1}{R}',
    typeLine: 'Artifact',
    types: ['Artifact'],
    oracleText:
      '{1}, {T}: Add two mana in any combination of colors. Spend this mana only to cast Dragon spells or activate abilities of Dragons.\n{R}, {T}, Sacrifice Orb of Dragonkind: Look at the top seven cards of your library. You may reveal a Dragon card from among them and put it into your hand. Put the rest on the bottom of your library in a random order.',
  });

const rivaz = () =>
  oracle({
    name: 'Rivaz of the Claw',
    manaCost: '{1}{B}{R}',
    typeLine: 'Legendary Creature — Viashino Warlock',
    types: ['Creature'],
    subtypes: ['Viashino', 'Warlock'],
    supertypes: ['Legendary'],
    power: '3',
    toughness: '3',
    oracleText:
      '{T}: Add two mana in any combination of colors. Spend this mana only to cast Dragon creature spells.\nOnce during each of your turns, you may cast a Dragon creature spell from your graveyard.\nWhenever you cast a Dragon creature spell from your graveyard, it gains "When this creature dies, exile it."',
  });

const sarkhanAscendant = () =>
  oracle({
    name: 'Sarkhan, Dragon Ascendant',
    manaCost: '{1}{R}{G}',
    typeLine: 'Legendary Planeswalker — Sarkhan',
    types: ['Planeswalker'],
    subtypes: ['Sarkhan'],
    supertypes: ['Legendary'],
    loyalty: '3',
    oracleText:
      'When Sarkhan, Dragon Ascendant enters, you may behold a Dragon. If you do, create a Treasure token.\nWhenever a Dragon you control enters, put a +1/+1 counter on Sarkhan. Until end of turn, Sarkhan becomes a Dragon in addition to its other types and gains flying.',
  });

const sarkhanSoulAflame = () =>
  oracle({
    name: 'Sarkhan, Soul Aflame',
    manaCost: '{1}{U}{R}',
    typeLine: 'Legendary Creature — Human Shaman',
    types: ['Creature'],
    subtypes: ['Human', 'Shaman'],
    supertypes: ['Legendary'],
    power: '2',
    toughness: '4',
    oracleText:
      "Dragon spells you cast cost {1} less to cast.\nWhenever a Dragon you control enters, you may have Sarkhan, Soul Aflame become a copy of it until end of turn, except its name is Sarkhan, Soul Aflame and it's legendary in addition to its other types.",
  });

const skycloudExpanse = () =>
  oracle({
    name: 'Skycloud Expanse',
    manaCost: '',
    typeLine: 'Land',
    types: ['Land'],
    oracleText: '{1}, {T}: Add {W}{U}.',
  });

const thrakkus = () =>
  oracle({
    name: 'Thrakkus the Butcher',
    manaCost: '{3}{R}{G}',
    typeLine: 'Legendary Creature — Dragon Barbarian',
    types: ['Creature'],
    subtypes: ['Dragon', 'Barbarian'],
    supertypes: ['Legendary'],
    power: '3',
    toughness: '4',
    oracleText:
      'Trample\nWhenever Thrakkus the Butcher attacks, double the power of each Dragon you control until end of turn.',
    keywords: ['Trample'],
  });

const vaevictis = () =>
  oracle({
    name: 'Vaevictis Asmadi, the Dire',
    manaCost: '{3}{B}{R}{G}',
    typeLine: 'Legendary Creature — Elder Dragon',
    types: ['Creature'],
    subtypes: ['Elder', 'Dragon'],
    supertypes: ['Legendary'],
    power: '6',
    toughness: '6',
    oracleText:
      "Flying\nWhenever Vaevictis Asmadi, the Dire attacks, for each player, choose target permanent that player controls. Those players sacrifice those permanents. Each player who sacrificed a permanent this way reveals the top card of their library, then puts it onto the battlefield if it's a permanent card.",
    keywords: ['Flying'],
  });

const zurgoAndOjutai = () =>
  oracle({
    name: 'Zurgo and Ojutai',
    manaCost: '{2}{U}{R}{W}',
    typeLine: 'Legendary Creature — Orc Dragon',
    types: ['Creature'],
    subtypes: ['Orc', 'Dragon'],
    supertypes: ['Legendary'],
    power: '4',
    toughness: '4',
    oracleText:
      "Flying, haste\nZurgo and Ojutai has hexproof as long as it entered this turn.\nWhenever one or more Dragons you control deal combat damage to a player or battle, look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order. You may return one of those Dragons to its owner's hand.",
    keywords: ['Flying', 'Haste'],
  });

describe('Ur-Dragon residual-card implementation', () => {
  it('keeps every completed Ur-Dragon residual-card implementation executable', () => {
    const list = [
      dragonTempest(),
      firkraag(),
      iymrith(),
      kairi(),
      lozhan(),
      morophon(),
      orbOfDragonkind(),
      rivaz(),
      sarkhanAscendant(),
      sarkhanSoulAflame(),
      skycloudExpanse(),
      thrakkus(),
      vaevictis(),
      zurgoAndOjutai(),
    ];

    const executable = new Set([
      // Coverage PR06: the entering Dragon is the damage source.
      'Dragon Tempest',
      // Coverage PR07: the goad and the damaging creature's intervening-if are modeled.
      'Firkraag, Cunning Instigator',
      'Iymrith, Desert Doom',
      // Coverage PR01: the bounce mode's total-mana-value budget is modeled.
      'Kairi, the Swirling Sky',
      "Lozhan, Dragons' Legacy",
      'Morophon, the Boundless',
      // Back on the list: its `{1}, {T}` mana ability is honoured now that `planPayment` pays
      // for its own sources (`mana-cost-in-mana-ability.test.ts`).
      'Orb of Dragonkind',
      'Rivaz of the Claw',
      'Sarkhan, Dragon Ascendant',
      'Sarkhan, Soul Aflame',
      'Skycloud Expanse',
      'Thrakkus the Butcher',
      'Vaevictis Asmadi, the Dire',
      // Coverage PR12: the look-at-three and the return of one of those Dragons are modeled.
      'Zurgo and Ojutai',
    ]);
    for (const raw of list) {
      const def = interpretCard(raw);
      expect(def.modeled).toBe(executable.has(raw.name));
      if (def.modeled) expect(def.unmodeledReasons).toEqual([]);
      else expect(def.unmodeledReasons.length).toBeGreaterThan(0);
    }
  });
});

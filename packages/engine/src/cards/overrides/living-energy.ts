/**
 * Authored card overrides for living-energy.txt.
 */

import { registerOverride } from './index';
import { allOf, ofSupertype, ofType } from '../selector';

export function registerLIVING_ENERGYOverrides(): void {
  registerOverride({
    oracleId: "20f602b3-814f-406c-b7eb-2d1fc98f8cf1",
    name: "Saheeli, Radiant Creator",
    handledLines: [
          "Whenever you cast an Artificer or artifact spell, you get {E} .",
          "At the beginning of combat on your turn, you may pay {E}{E}{E}. When you do, create a token that's a copy of target permanent you control, except it's a 5/5 artifact creature in addition to its other types and has haste. Sacrifice it at the beginning of the next end step."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-saheeli-radiant-creator",
    name: "Saheeli, Radiant Creator",
    handledLines: [
          "Whenever you cast an Artificer or artifact spell, you get {E} .",
          "At the beginning of combat on your turn, you may pay {E}{E}{E}. When you do, create a token that's a copy of target permanent you control, except it's a 5/5 artifact creature in addition to its other types and has haste. Sacrifice it at the beginning of the next end step."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "31cb87bf-1020-4fd5-95f7-8ecb197d823b",
    name: "Pia Nalaar, Chief Mechanic",
    handledLines: [
          "Whenever one or more artifact creatures you control deal combat damage to a player, you get {E}{E} .",
          "At the beginning of your end step, you may pay one or more {E}. If you do, create an X/X colorless Vehicle artifact token named Nalaar Aetherjet with flying and crew 2, where X is the amount of {E} paid this way."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-pia-nalaar-chief-mechanic",
    name: "Pia Nalaar, Chief Mechanic",
    handledLines: [
          "Whenever one or more artifact creatures you control deal combat damage to a player, you get {E}{E} .",
          "At the beginning of your end step, you may pay one or more {E}. If you do, create an X/X colorless Vehicle artifact token named Nalaar Aetherjet with flying and crew 2, where X is the amount of {E} paid this way."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "52241b9c-7a69-4176-9234-8bdab09d8e64",
    name: "Sai, Master Thopterist",
    handledLines: [
          "{1}{U}, Sacrifice two artifacts: Draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-sai-master-thopterist",
    name: "Sai, Master Thopterist",
    handledLines: [
          "{1}{U}, Sacrifice two artifacts: Draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "7060f2c8-fca0-4b7a-bddf-37682f434596",
    name: "Whirler Rogue",
    handledLines: [
          "Tap two untapped artifacts you control: Target creature can't be blocked this turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-whirler-rogue",
    name: "Whirler Rogue",
    handledLines: [
          "Tap two untapped artifacts you control: Target creature can't be blocked this turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "49be65fd-3755-410d-b0dc-2e5861ea2552",
    name: "Thopter Spy Network",
    handledLines: [
          "Whenever one or more artifact creatures you control deal combat damage to a player, draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-thopter-spy-network",
    name: "Thopter Spy Network",
    handledLines: [
          "Whenever one or more artifact creatures you control deal combat damage to a player, draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "2f82b232-21ff-44cc-bc35-0999a1d1c52f",
    name: "Lightning Runner",
    handledLines: [
          "Whenever this creature attacks, you get {E}{E} , then you may pay eight {E}. If you pay, untap all creatures you control, and after this phase, there is an additional combat phase."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-lightning-runner",
    name: "Lightning Runner",
    handledLines: [
          "Whenever this creature attacks, you get {E}{E} , then you may pay eight {E}. If you pay, untap all creatures you control, and after this phase, there is an additional combat phase."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "355603d1-f62d-407a-8fa9-74e7dca8ecf9",
    name: "Era of Innovation",
    handledLines: [
          "Whenever an artifact or Artificer you control enters, you may pay {1}. If you do, you get {E}{E} .",
          "Pay six {E}, Sacrifice this enchantment: Draw three cards."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-era-of-innovation",
    name: "Era of Innovation",
    handledLines: [
          "Whenever an artifact or Artificer you control enters, you may pay {1}. If you do, you get {E}{E} .",
          "Pay six {E}, Sacrifice this enchantment: Draw three cards."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "47c685b1-6e1e-4e08-8a52-9da6902df113",
    name: "Aethersquall Ancient",
    handledLines: [
          "At the beginning of your upkeep, you get {E}{E}{E} .",
          "Pay eight {E}: Return all other creatures to their owners' hands. Activate only as a sorcery."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-aethersquall-ancient",
    name: "Aethersquall Ancient",
    handledLines: [
          "At the beginning of your upkeep, you get {E}{E}{E} .",
          "Pay eight {E}: Return all other creatures to their owners' hands. Activate only as a sorcery."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "53b2c8f2-db9a-4ab0-a4e8-17385b2fa3bd",
    name: "Aethertide Whale",
    handledLines: [
          "When this creature enters, you get six {E} .",
          "Pay {E}{E}{E}{E}: Return this creature to its owner's hand."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-aethertide-whale",
    name: "Aethertide Whale",
    handledLines: [
          "When this creature enters, you get six {E} .",
          "Pay {E}{E}{E}{E}: Return this creature to its owner's hand."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "b9c58cfb-b7d5-4e86-a5d3-efb07192aa22",
    name: "Glimmer of Genius",
    handledLines: [
          "Scry 2, then draw two cards. You get {E}{E} ."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'scry', count: 2 }, { op: 'draw', count: { kind: 'const', n: 2 } }, { op: 'gainEnergy', amount: { kind: 'const', n: 2 } }], description: 'Scry two, draw two, gain two energy' },
    },
  });
  registerOverride({
    oracleId: "oracle-glimmer-of-genius",
    name: "Glimmer of Genius",
    handledLines: [
          "Scry 2, then draw two cards. You get {E}{E} ."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'scry', count: 2 }, { op: 'draw', count: { kind: 'const', n: 2 } }, { op: 'gainEnergy', amount: { kind: 'const', n: 2 } }], description: 'Scry two, draw two, gain two energy' },
    },
  });

  registerOverride({
    oracleId: "c246cdb4-2fd8-487e-944e-3e52fbd1bbaa",
    name: "Confiscation Coup",
    handledLines: [
          "Choose target artifact or creature. You get {E}{E}{E}{E} , then you may pay an amount of {E} equal to that permanent's mana value. If you do, gain control of it."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-confiscation-coup",
    name: "Confiscation Coup",
    handledLines: [
          "Choose target artifact or creature. You get {E}{E}{E}{E} , then you may pay an amount of {E} equal to that permanent's mana value. If you do, gain control of it."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "cdfcfd2b-966a-4e03-8ed5-4fa7fab423d0",
    name: "Bespoke Battlewagon",
    handledLines: [
          "{T}: You get {E}{E} .",
          "{T}, Pay {E}{E}: Tap target creature.",
          "{T}, Pay {E}{E}{E}: Draw a card.",
          "Pay {E}{E}{E}{E}: ~ becomes an artifact creature until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-bespoke-battlewagon",
    name: "Bespoke Battlewagon",
    handledLines: [
          "{T}: You get {E}{E} .",
          "{T}, Pay {E}{E}: Tap target creature.",
          "{T}, Pay {E}{E}{E}: Draw a card.",
          "Pay {E}{E}{E}{E}: ~ becomes an artifact creature until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "00037840-6089-42ec-8c5c-281f9f474504",
    name: "Nissa, Worldsoul Speaker",
    handledLines: [
          "Whenever a land you control enters, you get {E}{E} .",
          "You may pay eight {E} rather than pay the mana cost for permanent spells you cast."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-nissa-worldsoul-speaker",
    name: "Nissa, Worldsoul Speaker",
    handledLines: [
          "Whenever a land you control enters, you get {E}{E} .",
          "You may pay eight {E} rather than pay the mana cost for permanent spells you cast."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e91240bc-4a13-4131-9379-5ddac6555f4a",
    name: "Adaptive Omnitool",
    handledLines: [
          "Equipped creature gets +1/+1 for each artifact you control.",
          "Whenever equipped creature attacks, look at the top six cards of your library. You may reveal an artifact card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-adaptive-omnitool",
    name: "Adaptive Omnitool",
    handledLines: [
          "Equipped creature gets +1/+1 for each artifact you control.",
          "Whenever equipped creature attacks, look at the top six cards of your library. You may reveal an artifact card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ab1cc360-b9de-48d9-9983-4dfe4a7d2a37",
    name: "Arcane Denial",
    handledLines: [
          "Counter target spell. Its controller may draw up to two cards at the beginning of the next turn's upkeep.",
          "You draw a card at the beginning of the next turn's upkeep."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-arcane-denial",
    name: "Arcane Denial",
    handledLines: [
          "Counter target spell. Its controller may draw up to two cards at the beginning of the next turn's upkeep.",
          "You draw a card at the beginning of the next turn's upkeep."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "295cd8e1-0830-46c1-9957-556afd4bcee6",
    name: "Aetheric Amplifier",
    handledLines: [
          "{4}, {T}: Choose one. Activate only as a sorcery.",
          "â€¢ Double the number of each kind of counter on target permanent.",
          "â€¢ Double the number of each kind of counter you have."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-aetheric-amplifier",
    name: "Aetheric Amplifier",
    handledLines: [
          "{4}, {T}: Choose one. Activate only as a sorcery.",
          "â€¢ Double the number of each kind of counter on target permanent.",
          "â€¢ Double the number of each kind of counter you have."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9070c98b-fd01-4eeb-a4ec-fc464946c7c0",
    name: "Stridehangar Automaton",
    handledLines: [
          "If one or more artifact tokens would be created under your control, those tokens plus an additional 1/1 colorless Thopter artifact creature token with flying are created instead."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-stridehangar-automaton",
    name: "Stridehangar Automaton",
    handledLines: [
          "If one or more artifact tokens would be created under your control, those tokens plus an additional 1/1 colorless Thopter artifact creature token with flying are created instead."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "775617cd-7264-4365-94c4-ffae4eb9ec8b",
    name: "Aetherflux Conduit",
    handledLines: [
          "Whenever you cast a spell, you get an amount of {E} equal to the amount of mana spent to cast that spell.",
          "{T}, Pay fifty {E}: Draw seven cards. You may cast any number of spells from your hand without paying their mana costs."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-aetherflux-conduit",
    name: "Aetherflux Conduit",
    handledLines: [
          "Whenever you cast a spell, you get an amount of {E} equal to the amount of mana spent to cast that spell.",
          "{T}, Pay fifty {E}: Draw seven cards. You may cast any number of spells from your hand without paying their mana costs."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9b1f0780-072a-4fe6-91d8-e546a8aaea20",
    name: "Rampaging Aetherhood",
    handledLines: [
          "At the beginning of your upkeep, you get an amount of {E} equal to this creature's power. Then you may pay one or more {E}. If you do, put that many +1/+1 counters on this creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-rampaging-aetherhood",
    name: "Rampaging Aetherhood",
    handledLines: [
          "At the beginning of your upkeep, you get an amount of {E} equal to this creature's power. Then you may pay one or more {E}. If you do, put that many +1/+1 counters on this creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "88600bd4-4dcc-4788-bba4-78b6cf5ad8f8",
    name: "Peema Trailblazer",
    handledLines: [
          "Whenever this creature deals combat damage to a player, you get that many {E} .",
          "Exhaust â€” Pay six {E}: Put two +1/+1 counters on this creature. Then draw cards equal to the greatest power among creatures you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-peema-trailblazer",
    name: "Peema Trailblazer",
    handledLines: [
          "Whenever this creature deals combat damage to a player, you get that many {E} .",
          "Exhaust â€” Pay six {E}: Put two +1/+1 counters on this creature. Then draw cards equal to the greatest power among creatures you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "4f63d306-cc14-405c-8424-d8990c670c74",
    name: "Territorial Aetherkite",
    handledLines: [
          "When this creature enters, you get {E}{E} . Then you may pay one or more {E}. When you do, this creature deals that much damage to each other creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-territorial-aetherkite",
    name: "Territorial Aetherkite",
    handledLines: [
          "When this creature enters, you get {E}{E} . Then you may pay one or more {E}. When you do, this creature deals that much damage to each other creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "be6cab52-b3ae-46a2-a581-2468a49bff25",
    name: "Architect of the Untamed",
    handledLines: [
          "Whenever a land you control enters, you get {E} .",
          "Pay eight {E}: Create a 6/6 colorless Beast artifact creature token."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-architect-of-the-untamed",
    name: "Architect of the Untamed",
    handledLines: [
          "Whenever a land you control enters, you get {E} .",
          "Pay eight {E}: Create a 6/6 colorless Beast artifact creature token."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "1daba4f6-2a7d-426a-97d1-0298a7100c45",
    name: "Decoction Module",
    handledLines: [
          "Whenever a creature you control enters, you get {E} .",
          "{4}, {T}: Return target creature you control to its owner's hand."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-decoction-module",
    name: "Decoction Module",
    handledLines: [
          "Whenever a creature you control enters, you get {E} .",
          "{4}, {T}: Return target creature you control to its owner's hand."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "aaadfe41-b2be-4183-b45e-a70e53a59d2e",
    name: "Retrofitter Foundry",
    handledLines: [
          "{3}: Untap this artifact.",
          "{1}, {T}, Sacrifice a Servo: Create a 1/1 colorless Thopter artifact creature token with flying.",
          "{T}, Sacrifice a Thopter: Create a 4/4 colorless Construct artifact creature token."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-retrofitter-foundry",
    name: "Retrofitter Foundry",
    handledLines: [
          "{3}: Untap this artifact.",
          "{1}, {T}, Sacrifice a Servo: Create a 1/1 colorless Thopter artifact creature token with flying.",
          "{T}, Sacrifice a Thopter: Create a 4/4 colorless Construct artifact creature token."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "397b9dcf-690a-4a58-8637-bb9baab7cc2f",
    name: "Elder Gargaroth",
    handledLines: [
          "Whenever this creature attacks or blocks, choose one â€”",
          "â€¢ Create a 3/3 green Beast creature token.",
          "â€¢ You gain 3 life.",
          "â€¢ Draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-elder-gargaroth",
    name: "Elder Gargaroth",
    handledLines: [
          "Whenever this creature attacks or blocks, choose one â€”",
          "â€¢ Create a 3/3 green Beast creature token.",
          "â€¢ You gain 3 life.",
          "â€¢ Draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "470ec98e-120c-446d-ade6-7d80aa836b55",
    name: "Aetherworks Marvel",
    handledLines: [
          "Whenever a permanent you control is put into a graveyard, you get {E} .",
          "{T}, Pay six {E}: Look at the top six cards of your library. You may cast a spell from among them without paying its mana cost. Put the rest on the bottom of your library in a random order."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-aetherworks-marvel",
    name: "Aetherworks Marvel",
    handledLines: [
          "Whenever a permanent you control is put into a graveyard, you get {E} .",
          "{T}, Pay six {E}: Look at the top six cards of your library. You may cast a spell from among them without paying its mana cost. Put the rest on the bottom of your library in a random order."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "4a00f56e-e558-4239-bc75-fb0af7639042",
    name: "Peema Aether-Seer",
    handledLines: [
          "When this creature enters, you get an amount of {E} equal to the greatest power among creatures you control.",
          "Pay {E}{E}{E}: Target creature blocks this turn if able."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-peema-aether-seer",
    name: "Peema Aether-Seer",
    handledLines: [
          "When this creature enters, you get an amount of {E} equal to the greatest power among creatures you control.",
          "Pay {E}{E}{E}: Target creature blocks this turn if able."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "61c89b11-65c9-4fda-bbcd-d84de25df801",
    name: "Aether Hub",
    handledLines: [
          "When this land enters, you get {E} .",
          "{T}, Pay {E}: Add one mana of any color."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: { kind: 'const', n: 1 } }], description: 'Enters — gain one energy' }],
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'payEnergy', amount: 1 }] }]
    },
  });
  registerOverride({
    oracleId: "oracle-aether-hub",
    name: "Aether Hub",
    handledLines: [
          "When this land enters, you get {E} .",
          "{T}, Pay {E}: Add one mana of any color."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: { kind: 'const', n: 1 } }], description: 'Enters — gain one energy' }],
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'payEnergy', amount: 1 }] }]
    },
  });

  registerOverride({
    oracleId: "b2f09e41-0a91-4fb6-8804-874b3a5166b0",
    name: "Rogue Refiner",
    handledLines: [
          "When this creature enters, draw a card and you get {E}{E} ."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }, { op: 'gainEnergy', amount: { kind: 'const', n: 2 } }], description: 'Enters — draw and gain two energy' }],
    },
  });
  registerOverride({
    oracleId: "oracle-rogue-refiner",
    name: "Rogue Refiner",
    handledLines: [
          "When this creature enters, draw a card and you get {E}{E} ."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }, { op: 'gainEnergy', amount: { kind: 'const', n: 2 } }], description: 'Enters — draw and gain two energy' }],
    },
  });

  registerOverride({
    oracleId: "b337c241-f2c4-48e3-a303-371b172fcd18",
    name: "Attune with Aether",
    handledLines: [
          "Search your library for a basic land card, reveal it, put it into your hand, then shuffle. You get {E}{E} ."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'searchLibrary', filter: allOf(ofType('Land'), ofSupertype('Basic')), destinations: [{ zone: 'hand' }] }, { op: 'shuffle' }, { op: 'gainEnergy', amount: { kind: 'const', n: 2 } }], description: 'Search for a basic land, then gain two energy' }
    },
  });
  registerOverride({
    oracleId: "oracle-attune-with-aether",
    name: "Attune with Aether",
    handledLines: [
          "Search your library for a basic land card, reveal it, put it into your hand, then shuffle. You get {E}{E} ."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [], effects: [{ op: 'searchLibrary', filter: allOf(ofType('Land'), ofSupertype('Basic')), destinations: [{ zone: 'hand' }] }, { op: 'shuffle' }, { op: 'gainEnergy', amount: { kind: 'const', n: 2 } }], description: 'Search for a basic land, then gain two energy' }
    },
  });

  registerOverride({
    oracleId: "cb377c27-39a6-42b4-8c89-80a9a2350e81",
    name: "Solar Transformer",
    handledLines: [
          "When this artifact enters, you get {E}{E}{E} .",
          "{T}, Pay {E}: Add one mana of any color."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: { kind: 'const', n: 3 } }], description: 'Enters — gain three energy' }],
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'payEnergy', amount: 1 }] }]
    },
  });
  registerOverride({
    oracleId: "oracle-solar-transformer",
    name: "Solar Transformer",
    handledLines: [
          "When this artifact enters, you get {E}{E}{E} .",
          "{T}, Pay {E}: Add one mana of any color."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: { kind: 'const', n: 3 } }], description: 'Enters — gain three energy' }],
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'payEnergy', amount: 1 }] }]
    },
  });

  registerOverride({
    oracleId: "d9ec9a4f-0644-47c5-bc09-1201d5251bde",
    name: "Aetherwind Basker",
    handledLines: [
          "Whenever this creature enters or attacks, you get {E} for each creature you control.",
          "Pay {E}: ~ gets +1/+1 until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-aetherwind-basker",
    name: "Aetherwind Basker",
    handledLines: [
          "Whenever this creature enters or attacks, you get {E} for each creature you control.",
          "Pay {E}: ~ gets +1/+1 until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "df1a8846-b4da-4e9b-8cf3-ee687e4c606b",
    name: "Servant of the Conduit",
    handledLines: [
          "When this creature enters, you get {E}{E} .",
          "{T}, Pay {E}: Add one mana of any color."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: { kind: 'const', n: 2 } }], description: 'Enters — gain two energy' }],
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'payEnergy', amount: 1 }] }]
    },
  });
  registerOverride({
    oracleId: "oracle-servant-of-the-conduit",
    name: "Servant of the Conduit",
    handledLines: [
          "When this creature enters, you get {E}{E} .",
          "{T}, Pay {E}: Add one mana of any color."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: { kind: 'const', n: 2 } }], description: 'Enters — gain two energy' }],
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'payEnergy', amount: 1 }] }]
    },
  });

  registerOverride({
    oracleId: "f82da236-e567-4221-a0bc-439a0c7e2b03",
    name: "Whirler Virtuoso",
    handledLines: [
          "When this creature enters, you get {E}{E}{E} .",
          "Pay {E}{E}{E}: Create a 1/1 colorless Thopter artifact creature token with flying."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: { kind: 'const', n: 3 } }], description: 'Enters — gain three energy' }],
      activatedAbilities: [{ costs: [{ kind: 'payEnergy', amount: 3 }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'createToken', count: { kind: 'const', n: 1 }, spec: { name: 'Thopter', typeLine: 'Artifact Creature — Thopter', types: ['Artifact', 'Creature'], subtypes: ['Thopter'], colors: [], power: 1, toughness: 1, keywords: ['flying'] } }], description: 'Pay three energy — create a Thopter' } }],
    },
  });
  registerOverride({
    oracleId: "oracle-whirler-virtuoso",
    name: "Whirler Virtuoso",
    handledLines: [
          "When this creature enters, you get {E}{E}{E} .",
          "Pay {E}{E}{E}: Create a 1/1 colorless Thopter artifact creature token with flying."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [], effects: [{ op: 'gainEnergy', amount: { kind: 'const', n: 3 } }], description: 'Enters — gain three energy' }],
      activatedAbilities: [{ costs: [{ kind: 'payEnergy', amount: 3 }], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'createToken', count: { kind: 'const', n: 1 }, spec: { name: 'Thopter', typeLine: 'Artifact Creature — Thopter', types: ['Artifact', 'Creature'], subtypes: ['Thopter'], colors: [], power: 1, toughness: 1, keywords: ['flying'] } }], description: 'Pay three energy — create a Thopter' } }],
    },
  });

  registerOverride({
    oracleId: "07a0cba9-8768-4fd9-a3d5-b0f83b4bf8e8",
    name: "Chaos Warp",
    handledLines: [
          "The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it's a permanent card, they put it onto the battlefield."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-chaos-warp",
    name: "Chaos Warp",
    handledLines: [
          "The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it's a permanent card, they put it onto the battlefield."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "d1deba03-b26a-4a0d-b242-24bb3a3f9ea6",
    name: "Bootleggers' Stash",
    handledLines: [
          "Lands you control have \"{T}: Create a Treasure token.\""
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-bootleggers-stash",
    name: "Bootleggers' Stash",
    handledLines: [
          "Lands you control have \"{T}: Create a Treasure token.\""
    ],
    def: {},
  });

  registerOverride({
    oracleId: "a3da7d5b-2c2b-45fe-b9c5-413b8c8fc0a2",
    name: "Academy Ruins",
    handledLines: [
          "{1}{U}, {T}: Put target artifact card from your graveyard on top of your library."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-academy-ruins",
    name: "Academy Ruins",
    handledLines: [
          "{1}{U}, {T}: Put target artifact card from your graveyard on top of your library."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "70dc830e-d05b-4fc7-88dd-879e140b3fbf",
    name: "Reality Shift",
    handledLines: [
          "Exile target creature. Its controller manifests the top card of their library."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-reality-shift",
    name: "Reality Shift",
    handledLines: [
          "Exile target creature. Its controller manifests the top card of their library."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ea86abfa-6cab-4ef0-8463-34136fc25b59",
    name: "Duplicant",
    handledLines: [
          "When this creature enters, you may exile target nontoken creature.",
          "As long as a card exiled with this creature is a creature card, this creature has the power, toughness, and creature types of the last creature card exiled with it. It's still a Shapeshifter."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-duplicant",
    name: "Duplicant",
    handledLines: [
          "When this creature enters, you may exile target nontoken creature.",
          "As long as a card exiled with this creature is a creature card, this creature has the power, toughness, and creature types of the last creature card exiled with it. It's still a Shapeshifter."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "7a2484a9-04fd-41a0-8224-610c1c07ed10",
    name: "Blasphemous Act",
    handledLines: [
          "This spell costs {1} less to cast for each creature on the battlefield."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-blasphemous-act",
    name: "Blasphemous Act",
    handledLines: [
          "This spell costs {1} less to cast for each creature on the battlefield."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "3494a575-f68e-4e78-9f6b-142cd8a0edea",
    name: "Combustible Gearhulk",
    handledLines: [
          "When this creature enters, target opponent may have you draw three cards. If the player doesn't, you mill three cards, then this creature deals damage to that player equal to the total mana value of those cards."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-combustible-gearhulk",
    name: "Combustible Gearhulk",
    handledLines: [
          "When this creature enters, target opponent may have you draw three cards. If the player doesn't, you mill three cards, then this creature deals damage to that player equal to the total mana value of those cards."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "7137aae6-260d-41de-8b4e-42a8cf752697",
    name: "Frostboil Snarl",
    handledLines: [
          "As this land enters, you may reveal an Island or Mountain card from your hand. If you don't, this land enters tapped."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-frostboil-snarl",
    name: "Frostboil Snarl",
    handledLines: [
          "As this land enters, you may reveal an Island or Mountain card from your hand. If you don't, this land enters tapped."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "5ac8e01c-b0a7-4855-a122-1cd26b07c4a5",
    name: "Overflowing Basin",
    handledLines: [
          "{1}, {T}: Add {G}{U}."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-overflowing-basin",
    name: "Overflowing Basin",
    handledLines: [
          "{1}, {T}: Add {G}{U}."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "33f52df8-4b44-4422-8b0a-37fead9c894b",
    name: "Vineglimmer Snarl",
    handledLines: [
          "As this land enters, you may reveal a Forest or Island card from your hand. If you don't, this land enters tapped."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-vineglimmer-snarl",
    name: "Vineglimmer Snarl",
    handledLines: [
          "As this land enters, you may reveal a Forest or Island card from your hand. If you don't, this land enters tapped."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "5bb32efd-9e58-4021-bbda-4ffccfa1d601",
    name: "Druid of Purification",
    handledLines: [
          "When this creature enters, starting with you, each player may choose an artifact or enchantment you don't control. Destroy each permanent chosen this way."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-druid-of-purification",
    name: "Druid of Purification",
    handledLines: [
          "When this creature enters, starting with you, each player may choose an artifact or enchantment you don't control. Destroy each permanent chosen this way."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ab655810-f67e-4576-9174-35b16f5e3235",
    name: "Saheeli, Sublime Artificer",
    handledLines: [
          "Whenever you cast a noncreature spell, create a 1/1 colorless Servo artifact creature token.",
          "âˆ’2: Target artifact you control becomes a copy of another target artifact or creature you control until end of turn, except it's an artifact in addition to its other types."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-saheeli-sublime-artificer",
    name: "Saheeli, Sublime Artificer",
    handledLines: [
          "Whenever you cast a noncreature spell, create a 1/1 colorless Servo artifact creature token.",
          "âˆ’2: Target artifact you control becomes a copy of another target artifact or creature you control until end of turn, except it's an artifact in addition to its other types."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "7f268b15-ac92-4e98-821b-78d15d9285d9",
    name: "Loyal Apprentice",
    handledLines: [
          "At the beginning of combat on your turn, if you control your commander, create a 1/1 colorless Thopter artifact creature token with flying. That token gains haste until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-loyal-apprentice",
    name: "Loyal Apprentice",
    handledLines: [
          "At the beginning of combat on your turn, if you control your commander, create a 1/1 colorless Thopter artifact creature token with flying. That token gains haste until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "86084ed9-b8bb-4289-9579-6056194787bc",
    name: "Pia and Kiran Nalaar",
    handledLines: [
          "{2}{R}, Sacrifice an artifact: ~ deals 2 damage to any target."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-pia-and-kiran-nalaar",
    name: "Pia and Kiran Nalaar",
    handledLines: [
          "{2}{R}, Sacrifice an artifact: ~ deals 2 damage to any target."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "cd1eda60-53e4-44d0-9b2c-7a57395e291f",
    name: "Conjurer's Closet",
    handledLines: [
          "At the beginning of your end step, you may exile target creature you control, then return that card to the battlefield under your control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-conjurer-s-closet",
    name: "Conjurer's Closet",
    handledLines: [
          "At the beginning of your end step, you may exile target creature you control, then return that card to the battlefield under your control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "76678885-3674-443d-b9a2-2a460cf6aac0",
    name: "Panharmonicon",
    handledLines: [
          "If an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-panharmonicon",
    name: "Panharmonicon",
    handledLines: [
          "If an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "1b5e6560-ff2e-4475-96cb-63f64c8a86db",
    name: "Soul-Guide Lantern",
    handledLines: [
          "When this artifact enters, exile target card from a graveyard.",
          "{T}, Sacrifice this artifact: Exile each opponent's graveyard."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-soul-guide-lantern",
    name: "Soul-Guide Lantern",
    handledLines: [
          "When this artifact enters, exile target card from a graveyard.",
          "{T}, Sacrifice this artifact: Exile each opponent's graveyard."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "180e1a7e-890d-477c-80a5-da8a5f2857b3",
    name: "Reckless Fireweaver",
    handledLines: [
          "Whenever an artifact you control enters, this creature deals 1 damage to each opponent."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-reckless-fireweaver",
    name: "Reckless Fireweaver",
    handledLines: [
          "Whenever an artifact you control enters, this creature deals 1 damage to each opponent."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "757eadac-dd29-4a7f-8683-5bc823168326",
    name: "One with the Machine",
    handledLines: [
          "Draw cards equal to the greatest mana value among artifacts you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-one-with-the-machine",
    name: "One with the Machine",
    handledLines: [
          "Draw cards equal to the greatest mana value among artifacts you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c68faebc-b2cd-461b-b93e-e1fcd4816810",
    name: "Midnight Clock",
    handledLines: [
          "When the twelfth hour counter is put on this artifact, shuffle your hand and graveyard into your library, then draw seven cards. Exile this artifact."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-midnight-clock",
    name: "Midnight Clock",
    handledLines: [
          "When the twelfth hour counter is put on this artifact, shuffle your hand and graveyard into your library, then draw seven cards. Exile this artifact."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "88b51e15-6630-4e14-a6b8-db0aa12e34ef",
    name: "Disallow",
    handledLines: [
          "Counter target spell, activated ability, or triggered ability."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-disallow",
    name: "Disallow",
    handledLines: [
          "Counter target spell, activated ability, or triggered ability."
    ],
    def: {},
  });

}

/**
 * Authored card overrides for counter-intelligence.txt.
 */

import { registerOverride } from './index';
import { allOf, CHOSEN_TYPE, not, ofType } from '../selector';

export function registerCOUNTER_INTELLIGENCEOverrides(): void {
  registerOverride({
    oracleId: "7a884166-de5a-43ba-8855-4999f39f2059",
    name: "Kilo, Apogee Mind",
    handledLines: [
          "Whenever ~ becomes tapped, proliferate."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-kilo-apogee-mind",
    name: "Kilo, Apogee Mind",
    handledLines: [
          "Whenever ~ becomes tapped, proliferate."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "03d32ace-dd99-48c6-bcae-9b915d041aef",
    name: "Freed from the Real",
    handledLines: [
          "{U}: Tap enchanted creature.",
          "{U}: Untap enchanted creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-freed-from-the-real",
    name: "Freed from the Real",
    handledLines: [
          "{U}: Tap enchanted creature.",
          "{U}: Untap enchanted creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ada2f380-bca7-4d64-9587-bab11c776ba8",
    name: "Pemmin's Aura",
    handledLines: [
          "{U}: Untap enchanted creature.",
          "{U}: Enchanted creature gains flying until end of turn.",
          "{U}: Enchanted creature gains shroud until end of turn.",
          "{1}: Enchanted creature gets +1/-1 or -1/+1 until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-pemmin-s-aura",
    name: "Pemmin's Aura",
    handledLines: [
          "{U}: Untap enchanted creature.",
          "{U}: Enchanted creature gains flying until end of turn.",
          "{U}: Enchanted creature gains shroud until end of turn.",
          "{1}: Enchanted creature gets +1/-1 or -1/+1 until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "44b90948-e85a-4f69-a9e2-aba63775ba40",
    name: "Filigree Vector",
    handledLines: [
          "When this creature enters, put a +1/+1 counter on each of any number of target creatures and a charge counter on each of any number of target artifacts.",
          "{1}, {T}, Sacrifice another artifact: Proliferate."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-filigree-vector",
    name: "Filigree Vector",
    handledLines: [
          "When this creature enters, put a +1/+1 counter on each of any number of target creatures and a charge counter on each of any number of target artifacts.",
          "{1}, {T}, Sacrifice another artifact: Proliferate."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "554df866-3dbb-4811-8573-6033481591aa",
    name: "Inspirit, Flagship Vessel",
    handledLines: [
          "Station",
          "1+ | At the beginning of combat on your turn, put your choice of a +1/+1 counter or two charge counters on up to one other target artifact.",
          "8+ | Flying"
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-inspirit-flagship-vessel",
    name: "Inspirit, Flagship Vessel",
    handledLines: [
          "Station",
          "1+ | At the beginning of combat on your turn, put your choice of a +1/+1 counter or two charge counters on up to one other target artifact.",
          "8+ | Flying"
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e5e8e116-10fe-48b0-b3d8-6edb39bd5f90",
    name: "Alibou, Ancient Witness",
    handledLines: [
          "Other artifact creatures you control have haste.",
          "Whenever one or more artifact creatures you control attack, ~ deals X damage to any target and you scry X, where X is the number of tapped artifacts you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-alibou-ancient-witness",
    name: "Alibou, Ancient Witness",
    handledLines: [
          "Other artifact creatures you control have haste.",
          "Whenever one or more artifact creatures you control attack, ~ deals X damage to any target and you scry X, where X is the number of tapped artifacts you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "1bc42024-52da-4d93-8b47-544f0a4a72a1",
    name: "Astral Cornucopia",
    handledLines: [
          "~ enters with X charge counters on it.",
          "{T}: Choose a color. Add one mana of that color for each charge counter on this artifact."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-astral-cornucopia",
    name: "Astral Cornucopia",
    handledLines: [
          "~ enters with X charge counters on it.",
          "{T}: Choose a color. Add one mana of that color for each charge counter on this artifact."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "f1603384-4361-49c9-98aa-7785fc3504c4",
    name: "Cascade Bluffs",
    handledLines: [
          "{U/R}, {T}: Add {U}{U}, {U}{R}, or {R}{R}."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-cascade-bluffs",
    name: "Cascade Bluffs",
    handledLines: [
          "{U/R}, {T}: Add {U}{U}, {U}{R}, or {R}{R}."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "837c5d0e-0a33-4f9d-ae25-68a687bdf640",
    name: "Chrome Host Seedshark",
    handledLines: [
          "Whenever you cast a noncreature spell, incubate X, where X is that spell's mana value."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-chrome-host-seedshark",
    name: "Chrome Host Seedshark",
    handledLines: [
          "Whenever you cast a noncreature spell, incubate X, where X is that spell's mana value."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "2a838818-d590-4374-9a63-d9e6381a0f0d",
    name: "Cloud Key",
    handledLines: [
          "As this artifact enters, choose artifact, creature, enchantment, instant, or sorcery.",
          "Spells you cast of the chosen type cost {1} less to cast."
    ],
    def: {
      entersChoosingOption: {
        prompt: 'Choose a spell type',
        options: [
          { key: 'Artifact', label: 'Artifact' },
          { key: 'Creature', label: 'Creature' },
          { key: 'Enchantment', label: 'Enchantment' },
          { key: 'Instant', label: 'Instant' },
          { key: 'Sorcery', label: 'Sorcery' },
        ],
      },
      ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 1 }, filter: CHOSEN_TYPE }],
    },
  });
  registerOverride({
    oracleId: "oracle-cloud-key",
    name: "Cloud Key",
    handledLines: [
          "As this artifact enters, choose artifact, creature, enchantment, instant, or sorcery.",
          "Spells you cast of the chosen type cost {1} less to cast."
    ],
    def: {
      entersChoosingOption: {
        prompt: 'Choose a spell type',
        options: [
          { key: 'Artifact', label: 'Artifact' },
          { key: 'Creature', label: 'Creature' },
          { key: 'Enchantment', label: 'Enchantment' },
          { key: 'Instant', label: 'Instant' },
          { key: 'Sorcery', label: 'Sorcery' },
        ],
      },
      ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 1 }, filter: CHOSEN_TYPE }],
    },
  });

  registerOverride({
    oracleId: "66e37011-f3d2-41ed-8e09-7bba9464e8c3",
    name: "Coretapper",
    handledLines: [
          "{T}: Put a charge counter on target artifact.",
          "Sacrifice this creature: Put two charge counters on target artifact."
    ],
    def: {
      activatedAbilities: [
        { costs: [{ kind: 'tap' }], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'artifact' }], effects: [{ op: 'putCounters', target: 0, counter: 'charge', count: 1 }], description: 'Put a charge counter on target artifact' } },
        { costs: [{ kind: 'sacrificeSelf' }], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'artifact' }], effects: [{ op: 'putCounters', target: 0, counter: 'charge', count: 2 }], description: 'Put two charge counters on target artifact' } },
      ],
    },
  });
  registerOverride({
    oracleId: "oracle-coretapper",
    name: "Coretapper",
    handledLines: [
          "{T}: Put a charge counter on target artifact.",
          "Sacrifice this creature: Put two charge counters on target artifact."
    ],
    def: {
      activatedAbilities: [
        { costs: [{ kind: 'tap' }], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'artifact' }], effects: [{ op: 'putCounters', target: 0, counter: 'charge', count: 1 }], description: 'Put a charge counter on target artifact' } },
        { costs: [{ kind: 'sacrificeSelf' }], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'artifact' }], effects: [{ op: 'putCounters', target: 0, counter: 'charge', count: 2 }], description: 'Put two charge counters on target artifact' } },
      ],
    },
  });

  registerOverride({
    oracleId: "5ea3e672-ae14-49a4-badb-f713497dd126",
    name: "Crystalline Crawler",
    handledLines: [
          "~ enters with a +1/+1 counter on it for each color of mana spent to cast it.",
          "Remove a +1/+1 counter from this creature: Add one mana of any color.",
          "{T}: Put a +1/+1 counter on this creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-crystalline-crawler",
    name: "Crystalline Crawler",
    handledLines: [
          "~ enters with a +1/+1 counter on it for each color of mana spent to cast it.",
          "Remove a +1/+1 counter from this creature: Add one mana of any color.",
          "{T}: Put a +1/+1 counter on this creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "126a5d0b-e7d6-458e-87af-47d845678014",
    name: "Cyberdrive Awakener",
    handledLines: [
          "Other artifact creatures you control have flying.",
          "When this creature enters, each noncreature artifact you control becomes a 4/4 artifact creature until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-cyberdrive-awakener",
    name: "Cyberdrive Awakener",
    handledLines: [
          "Other artifact creatures you control have flying.",
          "When this creature enters, each noncreature artifact you control becomes a 4/4 artifact creature until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "bc483bab-14fb-498d-9310-9c070766c7ae",
    name: "Darksteel Reactor",
    handledLines: [
          "When this artifact has twenty or more charge counters on it, you win the game."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-darksteel-reactor",
    name: "Darksteel Reactor",
    handledLines: [
          "When this artifact has twenty or more charge counters on it, you win the game."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "debce64a-18bd-42f5-9e85-158c2242e9e9",
    name: "Deepglow Skate",
    handledLines: [
          "When this creature enters, double the number of each kind of counter on any number of target permanents."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-deepglow-skate",
    name: "Deepglow Skate",
    handledLines: [
          "When this creature enters, double the number of each kind of counter on any number of target permanents."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "133c99c0-3652-410f-8100-68015a47af9f",
    name: "Dispatch",
    handledLines: [
          "Tap target creature.",
          "If you control three or more artifacts, exile that creature."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [{ kind: 'creature' }],
        effects: [
          { op: 'tapTarget', target: 0 },
          { op: 'conditionalEffect', condition: { kind: 'countPermanents', selector: ofType('Artifact'), scope: 'you', cmp: '>=', n: 3 }, then: [{ op: 'exile', target: 0 }], else: [] },
        ], description: 'Tap target creature; metalcraft exiles it',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-dispatch",
    name: "Dispatch",
    handledLines: [
          "Tap target creature.",
          "If you control three or more artifacts, exile that creature."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [{ kind: 'creature' }],
        effects: [
          { op: 'tapTarget', target: 0 },
          { op: 'conditionalEffect', condition: { kind: 'countPermanents', selector: ofType('Artifact'), scope: 'you', cmp: '>=', n: 3 }, then: [{ op: 'exile', target: 0 }], else: [] },
        ], description: 'Tap target creature; metalcraft exiles it',
      },
    },
  });

  registerOverride({
    oracleId: "6832f9e2-294a-44a2-8af9-eb16ccfdfc36",
    name: "Empowered Autogenerator",
    handledLines: [
          "{T}: Put a charge counter on this artifact. Add X mana of any one color, where X is the number of charge counters on this artifact."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-empowered-autogenerator",
    name: "Empowered Autogenerator",
    handledLines: [
          "{T}: Put a charge counter on this artifact. Add X mana of any one color, where X is the number of charge counters on this artifact."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "da3e7d3d-2ca0-40c3-9602-fca37c92f507",
    name: "Emry, Lurker of the Loch",
    handledLines: [
          "Affinity for artifacts",
          "When ~ enters, mill four cards.",
          "{T}: Choose target artifact card in your graveyard. You may cast that card this turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-emry-lurker-of-the-loch",
    name: "Emry, Lurker of the Loch",
    handledLines: [
          "Affinity for artifacts",
          "When ~ enters, mill four cards.",
          "{T}: Choose target artifact card in your graveyard. You may cast that card this turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c9722086-23e8-43dc-8a8c-541ff6962318",
    name: "Enthusiastic Mechanaut",
    handledLines: [
          "Artifact spells you cast cost {1} less to cast."
    ],
    def: { ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 1 }, filter: ofType('Artifact') }] },
  });
  registerOverride({
    oracleId: "oracle-enthusiastic-mechanaut",
    name: "Enthusiastic Mechanaut",
    handledLines: [
          "Artifact spells you cast cost {1} less to cast."
    ],
    def: { ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 1 }, filter: ofType('Artifact') }] },
  });

  registerOverride({
    oracleId: "7ecfa47e-1165-46a6-884c-290b1c14d020",
    name: "Etched Oracle",
    handledLines: [
          "Sunburst",
          "{1}, Remove four +1/+1 counters from this creature: Target player draws three cards."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-etched-oracle",
    name: "Etched Oracle",
    handledLines: [
          "Sunburst",
          "{1}, Remove four +1/+1 counters from this creature: Target player draws three cards."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "96b87445-6362-4a17-91b2-cbf203fd03fd",
    name: "Etherium Sculptor",
    handledLines: [
          "Artifact spells you cast cost {1} less to cast."
    ],
    def: { ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 1 }, filter: ofType('Artifact') }] },
  });
  registerOverride({
    oracleId: "oracle-etherium-sculptor",
    name: "Etherium Sculptor",
    handledLines: [
          "Artifact spells you cast cost {1} less to cast."
    ],
    def: { ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 1 }, filter: ofType('Artifact') }] },
  });

  registerOverride({
    oracleId: "0a79237e-0811-4a8a-bd4d-db3ca91bff22",
    name: "Everflowing Chalice",
    handledLines: [
          "~ enters with a charge counter on it for each time it was kicked.",
          "{T}: Add {C} for each charge counter on this artifact."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-everflowing-chalice",
    name: "Everflowing Chalice",
    handledLines: [
          "~ enters with a charge counter on it for each time it was kicked.",
          "{T}: Add {C} for each charge counter on this artifact."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "2ee08dcd-5558-45be-b619-8a550f3865ad",
    name: "Experimental Augury",
    handledLines: [
          "Look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order. Proliferate."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-experimental-augury",
    name: "Experimental Augury",
    handledLines: [
          "Look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order. Proliferate."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "204a5616-9f19-4d4c-aeb0-d1ec486b9ace",
    name: "Gavel of the Righteous",
    handledLines: [
          "At the beginning of combat on your turn, put a charge counter on this Equipment.",
          "Equipped creature gets +1/+1 for each counter on this Equipment.",
          "As long as this Equipment has four or more counters on it, equipped creature has double strike.",
          "Equip—Pay {3} or remove a counter from this Equipment."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-gavel-of-the-righteous",
    name: "Gavel of the Righteous",
    handledLines: [
          "At the beginning of combat on your turn, put a charge counter on this Equipment.",
          "Equipped creature gets +1/+1 for each counter on this Equipment.",
          "As long as this Equipment has four or more counters on it, equipped creature has double strike.",
          "Equip—Pay {3} or remove a counter from this Equipment."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "dde55256-5259-44e7-a267-fca45a7f0d04",
    name: "Hangarback Walker",
    handledLines: [
          "~ enters with X +1/+1 counters on it.",
          "When this creature dies, create a 1/1 colorless Thopter artifact creature token with flying for each +1/+1 counter on this creature.",
          "{1}, {T}: Put a +1/+1 counter on this creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-hangarback-walker",
    name: "Hangarback Walker",
    handledLines: [
          "~ enters with X +1/+1 counters on it.",
          "When this creature dies, create a 1/1 colorless Thopter artifact creature token with flying for each +1/+1 counter on this creature.",
          "{1}, {T}: Put a +1/+1 counter on this creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "83409a22-10de-4d51-90a3-e0579ca8cbea",
    name: "Insight Engine",
    handledLines: [
          "{2}, {T}: Put a charge counter on this artifact, then draw a card for each charge counter on it."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-insight-engine",
    name: "Insight Engine",
    handledLines: [
          "{2}, {T}: Put a charge counter on this artifact, then draw a card for each charge counter on it."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c803b788-4213-4fab-b841-7e5bbf66088e",
    name: "Jhoira, Weatherlight Captain",
    handledLines: [
          "Whenever you cast a historic spell, draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-jhoira-weatherlight-captain",
    name: "Jhoira, Weatherlight Captain",
    handledLines: [
          "Whenever you cast a historic spell, draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "7fffbe7f-ad78-4bb6-a611-c37e495c6ee0",
    name: "Kappa Cannoneer",
    handledLines: [
          "Whenever this creature or another artifact you control enters, put a +1/+1 counter on this creature. It can't be blocked this turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-kappa-cannoneer",
    name: "Kappa Cannoneer",
    handledLines: [
          "Whenever this creature or another artifact you control enters, put a +1/+1 counter on this creature. It can't be blocked this turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9fb8cd81-403a-4988-8f1c-b8eccf8abd9c",
    name: "Karn's Bastion",
    handledLines: [
          "{4}, {T}: Proliferate."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-karn-s-bastion",
    name: "Karn's Bastion",
    handledLines: [
          "{4}, {T}: Proliferate."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "358297cd-4a9f-48e2-aaa5-131b0849f8dc",
    name: "Long-Range Sensor",
    handledLines: [
          "Whenever you attack a player, put a charge counter on this artifact.",
          "{1}, Remove two charge counters from this artifact: Discover 4. Activate only as a sorcery."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-long-range-sensor",
    name: "Long-Range Sensor",
    handledLines: [
          "Whenever you attack a player, put a charge counter on this artifact.",
          "{1}, Remove two charge counters from this artifact: Discover 4. Activate only as a sorcery."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "cbd76b22-d04e-48e7-bcab-c7f5466d67d8",
    name: "Lux Artillery",
    handledLines: [
          "Whenever you cast an artifact creature spell, it gains sunburst.",
          "At the beginning of your end step, if there are thirty or more counters among artifacts and creatures you control, this artifact deals 10 damage to each opponent."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-lux-artillery",
    name: "Lux Artillery",
    handledLines: [
          "Whenever you cast an artifact creature spell, it gains sunburst.",
          "At the beginning of your end step, if there are thirty or more counters among artifacts and creatures you control, this artifact deals 10 damage to each opponent."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "3fe9367b-def1-4820-9e23-92ce3d7a4afc",
    name: "Moxite Refinery",
    handledLines: [
          "{2}, {T}, Remove X counters from an artifact or creature you control: Choose one. Activate only as a sorcery.",
          "• Put X charge counters on target artifact.",
          "• Put X +1/+1 counters on target creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-moxite-refinery",
    name: "Moxite Refinery",
    handledLines: [
          "{2}, {T}, Remove X counters from an artifact or creature you control: Choose one. Activate only as a sorcery.",
          "• Put X charge counters on target artifact.",
          "• Put X +1/+1 counters on target creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "d9e24d7c-0907-45c1-b5d3-9fb16a929868",
    name: "Organic Extinction",
    handledLines: [
          "Destroy all nonartifact creatures."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), not(ofType('Artifact'))) }],
        description: 'Destroy all nonartifact creatures',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-organic-extinction",
    name: "Organic Extinction",
    handledLines: [
          "Destroy all nonartifact creatures."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), not(ofType('Artifact'))) }],
        description: 'Destroy all nonartifact creatures',
      },
    },
  });

  registerOverride({
    oracleId: "72e8d67a-41e6-4074-bcbd-b54ead995237",
    name: "Pentad Prism",
    handledLines: [
          "Sunburst"
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-pentad-prism",
    name: "Pentad Prism",
    handledLines: [
          "Sunburst"
    ],
    def: {},
  });

  registerOverride({
    oracleId: "340bbe8b-e987-4c3e-ab4e-9dee63e57d4f",
    name: "Phyrexian Metamorph",
    handledLines: [
          "unsupported mana cost symbols: {U/P}",
          "You may have this creature enter as a copy of any artifact or creature on the battlefield, except it's an artifact in addition to its other types."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-phyrexian-metamorph",
    name: "Phyrexian Metamorph",
    handledLines: [
          "unsupported mana cost symbols: {U/P}",
          "You may have this creature enter as a copy of any artifact or creature on the battlefield, except it's an artifact in addition to its other types."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "83e78565-e61f-4bbc-b834-f47941f7e3ec",
    name: "Resourceful Defense",
    handledLines: [
          "Whenever a permanent you control leaves the battlefield, if it had counters on it, put those counters on target permanent you control.",
          "{4}{W}: Move any number of counters from target permanent you control onto a second target permanent you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-resourceful-defense",
    name: "Resourceful Defense",
    handledLines: [
          "Whenever a permanent you control leaves the battlefield, if it had counters on it, put those counters on target permanent you control.",
          "{4}{W}: Move any number of counters from target permanent you control onto a second target permanent you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "45bcebd0-5e93-4433-b92f-b4c161d04bd6",
    name: "Ripples of Potential",
    handledLines: [
          "Proliferate, then choose any number of permanents you control that had a counter put on them this way. Those permanents phase out."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-ripples-of-potential",
    name: "Ripples of Potential",
    handledLines: [
          "Proliferate, then choose any number of permanents you control that had a counter put on them this way. Those permanents phase out."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "8e7641e1-e814-4d5a-9cb3-71ad2f4ceee8",
    name: "Rugged Prairie",
    handledLines: [
          "{R/W}, {T}: Add {R}{R}, {R}{W}, or {W}{W}."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-rugged-prairie",
    name: "Rugged Prairie",
    handledLines: [
          "{R/W}, {T}: Add {R}{R}, {R}{W}, or {W}{W}."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e8e2f273-5e74-4f16-8d49-2e86e9c9f2dc",
    name: "Solar Array",
    handledLines: [
          "{T}: Add one mana of any color. When you next cast an artifact spell this turn, that spell gains sunburst."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-solar-array",
    name: "Solar Array",
    handledLines: [
          "{T}: Add one mana of any color. When you next cast an artifact spell this turn, that spell gains sunburst."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "986ae327-f433-4c58-93dc-afc544b9bfcb",
    name: "Steel Overseer",
    handledLines: [
          "{T}: Put a +1/+1 counter on each artifact creature you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-steel-overseer",
    name: "Steel Overseer",
    handledLines: [
          "{T}: Put a +1/+1 counter on each artifact creature you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "dc11d9dc-7d18-45dc-955b-d0ba71fc0db8",
    name: "Surge Conductor",
    handledLines: [
          "Whenever another nontoken artifact you control enters, proliferate."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-surge-conductor",
    name: "Surge Conductor",
    handledLines: [
          "Whenever another nontoken artifact you control enters, proliferate."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "8ddfc283-c9b4-41a5-af88-cf0068e986cc",
    name: "Swan Song",
    handledLines: [
          "Counter target enchantment, instant, or sorcery spell. Its controller creates a 2/2 blue Bird creature token with flying."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-swan-song",
    name: "Swan Song",
    handledLines: [
          "Counter target enchantment, instant, or sorcery spell. Its controller creates a 2/2 blue Bird creature token with flying."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "b1544f21-7e98-461b-aed5-e748b0168c52",
    name: "Swords to Plowshares",
    handledLines: [
          "Exile target creature. Its controller gains life equal to its power."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-swords-to-plowshares",
    name: "Swords to Plowshares",
    handledLines: [
          "Exile target creature. Its controller gains life equal to its power."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "4716ab91-30e6-4c63-8389-a9db8f9414d8",
    name: "Tekuthal, Inquiry Dominus",
    handledLines: [
          "If you would proliferate, proliferate twice instead.",
          "{1}{U/P}{U/P}, Remove three counters from among other artifacts, creatures, and planeswalkers you control: Put an indestructible counter on ~."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-tekuthal-inquiry-dominus",
    name: "Tekuthal, Inquiry Dominus",
    handledLines: [
          "If you would proliferate, proliferate twice instead.",
          "{1}{U/P}{U/P}, Remove three counters from among other artifacts, creatures, and planeswalkers you control: Put an indestructible counter on ~."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "b33d2b77-f068-4fdc-a1a8-0353a35e3973",
    name: "Tezzeret's Gambit",
    handledLines: [
          "unsupported mana cost symbols: {U/P}",
          "Draw two cards, then proliferate."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-tezzeret-s-gambit",
    name: "Tezzeret's Gambit",
    handledLines: [
          "unsupported mana cost symbols: {U/P}",
          "Draw two cards, then proliferate."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "03f5c566-825c-4c46-9c01-a2f9b1e70a13",
    name: "The Mycosynth Gardens",
    handledLines: [
          "{1}, {T}: Add one mana of any color.",
          "{X}, {T}: ~ becomes a copy of target nontoken artifact you control with mana value X."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-the-mycosynth-gardens",
    name: "The Mycosynth Gardens",
    handledLines: [
          "{1}, {T}: Add one mana of any color.",
          "{X}, {T}: ~ becomes a copy of target nontoken artifact you control with mana value X."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "939e6f71-185e-41f2-9d54-72cce06f1dce",
    name: "Thirst for Knowledge",
    handledLines: [
          "Draw three cards. Then discard two cards unless you discard an artifact card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-thirst-for-knowledge",
    name: "Thirst for Knowledge",
    handledLines: [
          "Draw three cards. Then discard two cards unless you discard an artifact card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9deded8b-cec4-4ede-a50b-131404d456d4",
    name: "Thought Monitor",
    handledLines: [
          "Affinity for artifacts"
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-thought-monitor",
    name: "Thought Monitor",
    handledLines: [
          "Affinity for artifacts"
    ],
    def: {},
  });

  registerOverride({
    oracleId: "b8020a8b-557b-465d-865d-b59fecd7abc1",
    name: "Threefold Thunderhulk",
    handledLines: [
          "Whenever this creature enters or attacks, create a number of 1/1 colorless Gnome artifact creature tokens equal to its power.",
          "{2}, Sacrifice another artifact: Put a +1/+1 counter on this creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-threefold-thunderhulk",
    name: "Threefold Thunderhulk",
    handledLines: [
          "Whenever this creature enters or attacks, create a number of 1/1 colorless Gnome artifact creature tokens equal to its power.",
          "{2}, Sacrifice another artifact: Put a +1/+1 counter on this creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e1c9783a-1d1b-40d7-872e-0ca11b229ce6",
    name: "Uthros Research Craft",
    handledLines: [
          "Station",
          "3+ | Whenever you cast an artifact spell, draw a card. Put a charge counter on this Spacecraft.",
          "12+ | Flying",
          "This Spacecraft gets +1/+0 for each artifact you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-uthros-research-craft",
    name: "Uthros Research Craft",
    handledLines: [
          "Station",
          "3+ | Whenever you cast an artifact spell, draw a card. Put a charge counter on this Spacecraft.",
          "12+ | Flying",
          "This Spacecraft gets +1/+0 for each artifact you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "05d75b10-4f20-4083-af27-f85c6e207fd0",
    name: "Ghirapur Aether Grid",
    handledLines: [
          "Tap two untapped artifacts you control: ~ deals 1 damage to any target."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-ghirapur-aether-grid",
    name: "Ghirapur Aether Grid",
    handledLines: [
          "Tap two untapped artifacts you control: ~ deals 1 damage to any target."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "5dedd5a9-bc5d-47bb-9ae1-7d683843d041",
    name: "Tezzeret, Betrayer of Flesh",
    handledLines: [
          "The first activated ability of an artifact you activate each turn costs {2} less to activate.",
          "+1: Draw two cards. Then discard two cards unless you discard an artifact card.",
          "−2: Target artifact becomes an artifact creature. If it isn't a Vehicle, it has base power and toughness 4/4.",
          "−6: You get an emblem with \"Whenever an artifact you control becomes tapped, draw a card.\""
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-tezzeret-betrayer-of-flesh",
    name: "Tezzeret, Betrayer of Flesh",
    handledLines: [
          "The first activated ability of an artifact you activate each turn costs {2} less to activate.",
          "+1: Draw two cards. Then discard two cards unless you discard an artifact card.",
          "−2: Target artifact becomes an artifact creature. If it isn't a Vehicle, it has base power and toughness 4/4.",
          "−6: You get an emblem with \"Whenever an artifact you control becomes tapped, draw a card.\""
    ],
    def: {},
  });

  registerOverride({
    oracleId: "1e943e04-e213-4781-b1a7-935aad8790e1",
    name: "Intruder Alarm",
    handledLines: [
          "Creatures don't untap during their controllers' untap steps."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-intruder-alarm",
    name: "Intruder Alarm",
    handledLines: [
          "Creatures don't untap during their controllers' untap steps."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "1ff00f5b-4bf9-4724-8bb5-6b9a9eb0ec7f",
    name: "Replicating Ring",
    handledLines: [
          "At the beginning of your upkeep, put a night counter on this artifact. Then if it has eight or more night counters on it, remove all of them and create eight colorless snow artifact tokens named Replicated Ring with \"{T}: Add one mana of any color.\""
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-replicating-ring",
    name: "Replicating Ring",
    handledLines: [
          "At the beginning of your upkeep, put a night counter on this artifact. Then if it has eight or more night counters on it, remove all of them and create eight colorless snow artifact tokens named Replicated Ring with \"{T}: Add one mana of any color.\""
    ],
    def: {},
  });

  registerOverride({
    oracleId: "7c4b2203-a937-4d91-8e39-2283fe686b45",
    name: "Urabrask's Forge",
    handledLines: [
          "At the beginning of combat on your turn, put an oil counter on this artifact, then create an X/1 red Phyrexian Horror creature token with trample and haste, where X is the number of oil counters on this artifact. Sacrifice that token at the beginning of the next end step."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-urabrask-s-forge",
    name: "Urabrask's Forge",
    handledLines: [
          "At the beginning of combat on your turn, put an oil counter on this artifact, then create an X/1 red Phyrexian Horror creature token with trample and haste, where X is the number of oil counters on this artifact. Sacrifice that token at the beginning of the next end step."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c4175a34-70bb-47e5-8406-efdc4d2cd079",
    name: "Sami, Wildcat Captain",
    handledLines: [
          "Spells you cast have affinity for artifacts."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-sami-wildcat-captain",
    name: "Sami, Wildcat Captain",
    handledLines: [
          "Spells you cast have affinity for artifacts."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "0405e0a9-6d02-4691-bdb8-59c72b824dab",
    name: "Marketback Walker",
    handledLines: [
          "~ enters with X +1/+1 counters on it.",
          "{4}: Put a +1/+1 counter on this creature.",
          "When this creature dies, draw a card for each +1/+1 counter on it."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-marketback-walker",
    name: "Marketback Walker",
    handledLines: [
          "~ enters with X +1/+1 counters on it.",
          "{4}: Put a +1/+1 counter on this creature.",
          "When this creature dies, draw a card for each +1/+1 counter on it."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "23bf0648-7097-41df-a539-1d36ac42cf9c",
    name: "Depthshaker Titan",
    handledLines: [
          "When this creature enters, any number of target noncreature artifacts you control become 3/3 artifact creatures. Sacrifice them at the beginning of the next end step.",
          "Each artifact creature you control has melee, trample, and haste."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-depthshaker-titan",
    name: "Depthshaker Titan",
    handledLines: [
          "When this creature enters, any number of target noncreature artifacts you control become 3/3 artifact creatures. Sacrifice them at the beginning of the next end step.",
          "Each artifact creature you control has melee, trample, and haste."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "bfa20bc7-4626-4a52-87f4-6e2763cb8ed5",
    name: "Archway of Innovation",
    handledLines: [
          "{U}, {T}: The next spell you cast this turn has improvise."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-archway-of-innovation",
    name: "Archway of Innovation",
    handledLines: [
          "{U}, {T}: The next spell you cast this turn has improvise."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e48ea9ea-64bc-4f1c-a424-592d48569244",
    name: "Blighted Agent",
    handledLines: [
          "Infect",
          "~ can't be blocked."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-blighted-agent",
    name: "Blighted Agent",
    handledLines: [
          "Infect",
          "~ can't be blocked."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "de58fa4b-eeeb-4dc8-aab9-6521b15678cc",
    name: "Mm'menon, the Right Hand",
    handledLines: [
          "Artifacts you control have \"{T}: Add {U}. Spend this mana only to cast a spell from anywhere other than your hand.\""
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-mm-menon-the-right-hand",
    name: "Mm'menon, the Right Hand",
    handledLines: [
          "Artifacts you control have \"{T}: Add {U}. Spend this mana only to cast a spell from anywhere other than your hand.\""
    ],
    def: {},
  });

  registerOverride({
    oracleId: "83874e60-291b-47a7-ba9f-69437fa7e3c7",
    name: "Flux Channeler",
    handledLines: [
          "Whenever you cast a noncreature spell, proliferate."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-flux-channeler",
    name: "Flux Channeler",
    handledLines: [
          "Whenever you cast a noncreature spell, proliferate."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c1121b83-1ba2-473d-89c9-e3bbd4529072",
    name: "Paradise Mantle",
    handledLines: [
          "Equipped creature has \"{T}: Add one mana of any color.\""
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-paradise-mantle",
    name: "Paradise Mantle",
    handledLines: [
          "Equipped creature has \"{T}: Add one mana of any color.\""
    ],
    def: {},
  });

  registerOverride({
    oracleId: "09669283-eb14-46a2-b37a-51d7a52da891",
    name: "Requisition Raid",
    handledLines: [
          "Spree",
          "+ {1} — Destroy target artifact.",
          "+ {1} — Destroy target enchantment.",
          "+ {1} — Put a +1/+1 counter on each creature target player controls."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-requisition-raid",
    name: "Requisition Raid",
    handledLines: [
          "Spree",
          "+ {1} — Destroy target artifact.",
          "+ {1} — Destroy target enchantment.",
          "+ {1} — Put a +1/+1 counter on each creature target player controls."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "2fc6de19-9d04-422b-90bc-eee2f9f8c84c",
    name: "Contentious Plan",
    handledLines: [
          "Proliferate."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-contentious-plan",
    name: "Contentious Plan",
    handledLines: [
          "Proliferate."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "af6e4c3e-0276-4f72-9a70-25868fe8bba5",
    name: "Ioreth of the Healing House",
    handledLines: [
          "{T}: Untap another target permanent.",
          "{T}: Untap two other target legendary creatures."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-ioreth-of-the-healing-house",
    name: "Ioreth of the Healing House",
    handledLines: [
          "{T}: Untap another target permanent.",
          "{T}: Untap two other target legendary creatures."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "3f661b58-e8ca-412c-bdac-af151162de12",
    name: "Prologue to Phyresis",
    handledLines: [
          "Each opponent gets a poison counter."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-prologue-to-phyresis",
    name: "Prologue to Phyresis",
    handledLines: [
          "Each opponent gets a poison counter."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "d2145ad3-fe7e-459b-b155-1b3ed089e936",
    name: "Steady Progress",
    handledLines: [
          "Proliferate."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-steady-progress",
    name: "Steady Progress",
    handledLines: [
          "Proliferate."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "da422b3e-1092-47ad-97d6-a7a3ef060a53",
    name: "Scour for Scrap",
    handledLines: [
          "Choose one or both —",
          "• Search your library for an artifact card, reveal it, put it into your hand, then shuffle.",
          "• Return target artifact card from your graveyard to your hand."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-scour-for-scrap",
    name: "Scour for Scrap",
    handledLines: [
          "Choose one or both —",
          "• Search your library for an artifact card, reveal it, put it into your hand, then shuffle.",
          "• Return target artifact card from your graveyard to your hand."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "fbc7350c-d392-44bf-92f7-8dd4743a73b4",
    name: "Serum Snare",
    handledLines: [
          "Return target nonland permanent to its owner's hand. If that permanent had mana value 3 or less, proliferate."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-serum-snare",
    name: "Serum Snare",
    handledLines: [
          "Return target nonland permanent to its owner's hand. If that permanent had mana value 3 or less, proliferate."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "5d0f4665-aa10-4251-b590-129b59274fb3",
    name: "Clock of Omens",
    handledLines: [
          "Tap two untapped artifacts you control: Untap target artifact."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-clock-of-omens",
    name: "Clock of Omens",
    handledLines: [
          "Tap two untapped artifacts you control: Untap target artifact."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "73b3682f-396a-4ebe-aaac-6ce3ee36283a",
    name: "Weatherlight",
    handledLines: [
          "Whenever ~ deals combat damage to a player, look at the top five cards of your library. You may reveal a historic card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-weatherlight",
    name: "Weatherlight",
    handledLines: [
          "Whenever ~ deals combat damage to a player, look at the top five cards of your library. You may reveal a historic card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e2962883-6daf-4a84-af73-917afc73092c",
    name: "Shorikai, Genesis Engine",
    handledLines: [
          "{1}, {T}: Draw two cards, then discard a card. Create a 1/1 colorless Pilot creature token with \"~ crews Vehicles as though its power were 2 greater.\""
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-shorikai-genesis-engine",
    name: "Shorikai, Genesis Engine",
    handledLines: [
          "{1}, {T}: Draw two cards, then discard a card. Create a 1/1 colorless Pilot creature token with \"~ crews Vehicles as though its power were 2 greater.\""
    ],
    def: {},
  });

  registerOverride({
    oracleId: "bdeb440d-a714-40e8-9038-f651e6ae45fb",
    name: "Springleaf Drum",
    handledLines: [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-springleaf-drum",
    name: "Springleaf Drum",
    handledLines: [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "4d9554de-c005-41ab-a941-39328ebff9de",
    name: "Relic of Legends",
    handledLines: [
          "Tap an untapped legendary creature you control: Add one mana of any color."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-relic-of-legends",
    name: "Relic of Legends",
    handledLines: [
          "Tap an untapped legendary creature you control: Add one mana of any color."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ba11a517-1dbd-4797-9f5e-46ce0f6c77c0",
    name: "Scene of the Crime",
    handledLines: [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-scene-of-the-crime",
    name: "Scene of the Crime",
    handledLines: [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "152e7e91-4eda-4e72-a9fb-bd5cb2e68239",
    name: "Survivors' Encampment",
    handledLines: [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-survivors-encampment",
    name: "Survivors' Encampment",
    handledLines: [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "98c389ed-b960-42e2-9c76-a062f77c9a78",
    name: "Teferi, Who Slows the Sunset",
    handledLines: [
          "+1: Choose up to one target artifact, up to one target creature, and up to one target land. Untap the chosen permanents you control. Tap the chosen permanents you don't control. You gain 2 life.",
          "−2: Look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order.",
          "−7: You get an emblem with \"Untap all permanents you control during each opponent's untap step\" and \"You draw a card during each opponent's draw step.\""
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-teferi-who-slows-the-sunset",
    name: "Teferi, Who Slows the Sunset",
    handledLines: [
          "+1: Choose up to one target artifact, up to one target creature, and up to one target land. Untap the chosen permanents you control. Tap the chosen permanents you don't control. You gain 2 life.",
          "−2: Look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order.",
          "−7: You get an emblem with \"Untap all permanents you control during each opponent's untap step\" and \"You draw a card during each opponent's draw step.\""
    ],
    def: {},
  });

  registerOverride({
    oracleId: "370c37f7-2484-40e8-8fd9-c10cf6f5d5f2",
    name: "Manifold Key",
    handledLines: [
          "{1}, {T}: Untap another target artifact.",
          "{3}, {T}: Target creature can't be blocked this turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-manifold-key",
    name: "Manifold Key",
    handledLines: [
          "{1}, {T}: Untap another target artifact.",
          "{3}, {T}: Target creature can't be blocked this turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "6b336228-92c0-4f14-a479-1f97aaeae018",
    name: "Belisarius Cawl",
    handledLines: [
          "Ultima Founding — {T}, Tap two untapped artifacts you control: Create a 2/2 white Astartes Warrior creature token with vigilance.",
          "Master of Machines — {T}, Tap X untapped creatures you control: Look at the top X cards of your library. You may reveal an artifact card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-belisarius-cawl",
    name: "Belisarius Cawl",
    handledLines: [
          "Ultima Founding — {T}, Tap two untapped artifacts you control: Create a 2/2 white Astartes Warrior creature token with vigilance.",
          "Master of Machines — {T}, Tap X untapped creatures you control: Look at the top X cards of your library. You may reveal an artifact card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."
    ],
    def: {},
  });

}

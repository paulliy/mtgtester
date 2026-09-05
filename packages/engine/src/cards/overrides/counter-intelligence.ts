/**
 * Authored card overrides for counter-intelligence.txt.
 */

import { constant } from '../value';
import { SAC_SELF, TAP } from '../templates';
import { defineCard, unimplemented } from './index';
import { allOf, CHOSEN_TYPE, not, ofType } from '../selector';

export function registerCOUNTER_INTELLIGENCEOverrides(): void {
  unimplemented("7a884166-de5a-43ba-8855-4999f39f2059", "Kilo, Apogee Mind", [
          "Whenever ~ becomes tapped, proliferate."
    ]);

  unimplemented("03d32ace-dd99-48c6-bcae-9b915d041aef", "Freed from the Real", [
          "{U}: Tap enchanted creature.",
          "{U}: Untap enchanted creature."
    ]);

  unimplemented("ada2f380-bca7-4d64-9587-bab11c776ba8", "Pemmin's Aura", [
          "{U}: Untap enchanted creature.",
          "{U}: Enchanted creature gains flying until end of turn.",
          "{U}: Enchanted creature gains shroud until end of turn.",
          "{1}: Enchanted creature gets +1/-1 or -1/+1 until end of turn."
    ]);

  unimplemented("44b90948-e85a-4f69-a9e2-aba63775ba40", "Filigree Vector", [
          "When this creature enters, put a +1/+1 counter on each of any number of target creatures and a charge counter on each of any number of target artifacts.",
          "{1}, {T}, Sacrifice another artifact: Proliferate."
    ]);

  unimplemented("554df866-3dbb-4811-8573-6033481591aa", "Inspirit, Flagship Vessel", [
          "Station",
          "1+ | At the beginning of combat on your turn, put your choice of a +1/+1 counter or two charge counters on up to one other target artifact.",
          "8+ | Flying"
    ]);

  unimplemented("e5e8e116-10fe-48b0-b3d8-6edb39bd5f90", "Alibou, Ancient Witness", [
          "Other artifact creatures you control have haste.",
          "Whenever one or more artifact creatures you control attack, ~ deals X damage to any target and you scry X, where X is the number of tapped artifacts you control."
    ]);

  unimplemented("1bc42024-52da-4d93-8b47-544f0a4a72a1", "Astral Cornucopia", [
          "~ enters with X charge counters on it.",
          "{T}: Choose a color. Add one mana of that color for each charge counter on this artifact."
    ]);

  unimplemented("837c5d0e-0a33-4f9d-ae25-68a687bdf640", "Chrome Host Seedshark", [
          "Whenever you cast a noncreature spell, incubate X, where X is that spell's mana value."
    ]);

  defineCard("2a838818-d590-4374-9a63-d9e6381a0f0d", "Cloud Key", [
          "As this artifact enters, choose artifact, creature, enchantment, instant, or sorcery.",
          "Spells you cast of the chosen type cost {1} less to cast."
    ], {
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
      ruleStatics: [{ kind: 'costReduction', amount: constant(1), filter: CHOSEN_TYPE }],
    });

  defineCard("66e37011-f3d2-41ed-8e09-7bba9464e8c3", "Coretapper", [
          "{T}: Put a charge counter on target artifact.",
          "Sacrifice this creature: Put two charge counters on target artifact."
    ], {
      activatedAbilities: [
        { costs: [TAP], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'artifact' }], effects: [{ op: 'putCounters', target: 0, counter: 'charge', count: 1 }], description: 'Put a charge counter on target artifact' } },
        { costs: [SAC_SELF], timing: 'any', ability: { kind: 'activated', targets: [{ kind: 'artifact' }], effects: [{ op: 'putCounters', target: 0, counter: 'charge', count: 2 }], description: 'Put two charge counters on target artifact' } },
      ],
    });

  unimplemented("5ea3e672-ae14-49a4-badb-f713497dd126", "Crystalline Crawler", [
          "~ enters with a +1/+1 counter on it for each color of mana spent to cast it.",
          "Remove a +1/+1 counter from this creature: Add one mana of any color.",
          "{T}: Put a +1/+1 counter on this creature."
    ]);

  unimplemented("126a5d0b-e7d6-458e-87af-47d845678014", "Cyberdrive Awakener", [
          "Other artifact creatures you control have flying.",
          "When this creature enters, each noncreature artifact you control becomes a 4/4 artifact creature until end of turn."
    ]);

  unimplemented("bc483bab-14fb-498d-9310-9c070766c7ae", "Darksteel Reactor", [
          "When this artifact has twenty or more charge counters on it, you win the game."
    ]);

  unimplemented("debce64a-18bd-42f5-9e85-158c2242e9e9", "Deepglow Skate", [
          "When this creature enters, double the number of each kind of counter on any number of target permanents."
    ]);

  defineCard("133c99c0-3652-410f-8100-68015a47af9f", "Dispatch", [
          "Tap target creature.",
          "If you control three or more artifacts, exile that creature."
    ], {
      spellAbility: {
        kind: 'spell', targets: [{ kind: 'creature' }],
        effects: [
          { op: 'tapTarget', target: 0 },
          { op: 'conditionalEffect', condition: { kind: 'countPermanents', selector: ofType('Artifact'), scope: 'you', cmp: '>=', n: 3 }, then: [{ op: 'exile', target: 0 }], else: [] },
        ], description: 'Tap target creature; metalcraft exiles it',
      },
    });

  unimplemented("6832f9e2-294a-44a2-8af9-eb16ccfdfc36", "Empowered Autogenerator", [
          "{T}: Put a charge counter on this artifact. Add X mana of any one color, where X is the number of charge counters on this artifact."
    ]);

  unimplemented("da3e7d3d-2ca0-40c3-9602-fca37c92f507", "Emry, Lurker of the Loch", [
          "Affinity for artifacts",
          "When ~ enters, mill four cards.",
          "{T}: Choose target artifact card in your graveyard. You may cast that card this turn."
    ]);

  unimplemented("7ecfa47e-1165-46a6-884c-290b1c14d020", "Etched Oracle", [
          "Sunburst",
          "{1}, Remove four +1/+1 counters from this creature: Target player draws three cards."
    ]);

  // Enthusiastic Mechanaut and Etherium Sculptor (both "Artifact spells you cast cost {1} less
  // to cast.") no longer need overrides here â€” the line now parses generically.

  unimplemented("0a79237e-0811-4a8a-bd4d-db3ca91bff22", "Everflowing Chalice", [
          "~ enters with a charge counter on it for each time it was kicked.",
          "{T}: Add {C} for each charge counter on this artifact."
    ]);

  unimplemented("2ee08dcd-5558-45be-b619-8a550f3865ad", "Experimental Augury", [
          "Look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order. Proliferate."
    ]);

  unimplemented("204a5616-9f19-4d4c-aeb0-d1ec486b9ace", "Gavel of the Righteous", [
          "At the beginning of combat on your turn, put a charge counter on this Equipment.",
          "Equipped creature gets +1/+1 for each counter on this Equipment.",
          "As long as this Equipment has four or more counters on it, equipped creature has double strike.",
          "Equip—Pay {3} or remove a counter from this Equipment."
    ]);

  unimplemented("dde55256-5259-44e7-a267-fca45a7f0d04", "Hangarback Walker", [
          "~ enters with X +1/+1 counters on it.",
          "When this creature dies, create a 1/1 colorless Thopter artifact creature token with flying for each +1/+1 counter on this creature.",
          "{1}, {T}: Put a +1/+1 counter on this creature."
    ]);

  unimplemented("83409a22-10de-4d51-90a3-e0579ca8cbea", "Insight Engine", [
          "{2}, {T}: Put a charge counter on this artifact, then draw a card for each charge counter on it."
    ]);

  unimplemented("c803b788-4213-4fab-b841-7e5bbf66088e", "Jhoira, Weatherlight Captain", [
          "Whenever you cast a historic spell, draw a card."
    ]);

  unimplemented("7fffbe7f-ad78-4bb6-a611-c37e495c6ee0", "Kappa Cannoneer", [
          "Whenever this creature or another artifact you control enters, put a +1/+1 counter on this creature. It can't be blocked this turn."
    ]);

  unimplemented("9fb8cd81-403a-4988-8f1c-b8eccf8abd9c", "Karn's Bastion", [
          "{4}, {T}: Proliferate."
    ]);

  unimplemented("358297cd-4a9f-48e2-aaa5-131b0849f8dc", "Long-Range Sensor", [
          "Whenever you attack a player, put a charge counter on this artifact.",
          "{1}, Remove two charge counters from this artifact: Discover 4. Activate only as a sorcery."
    ]);

  unimplemented("cbd76b22-d04e-48e7-bcab-c7f5466d67d8", "Lux Artillery", [
          "Whenever you cast an artifact creature spell, it gains sunburst.",
          "At the beginning of your end step, if there are thirty or more counters among artifacts and creatures you control, this artifact deals 10 damage to each opponent."
    ]);

  unimplemented("3fe9367b-def1-4820-9e23-92ce3d7a4afc", "Moxite Refinery", [
          "{2}, {T}, Remove X counters from an artifact or creature you control: Choose one. Activate only as a sorcery.",
          "• Put X charge counters on target artifact.",
          "• Put X +1/+1 counters on target creature."
    ]);

  defineCard("d9e24d7c-0907-45c1-b5d3-9fb16a929868", "Organic Extinction", [
          "Destroy all nonartifact creatures."
    ], {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [{ op: 'destroyEach', selector: allOf(ofType('Creature'), not(ofType('Artifact'))) }],
        description: 'Destroy all nonartifact creatures',
      },
    });

  unimplemented("72e8d67a-41e6-4074-bcbd-b54ead995237", "Pentad Prism", [
          "Sunburst"
    ]);

  unimplemented("340bbe8b-e987-4c3e-ab4e-9dee63e57d4f", "Phyrexian Metamorph", [
          "unsupported mana cost symbols: {U/P}",
          "You may have this creature enter as a copy of any artifact or creature on the battlefield, except it's an artifact in addition to its other types."
    ]);

  unimplemented("83e78565-e61f-4bbc-b834-f47941f7e3ec", "Resourceful Defense", [
          "Whenever a permanent you control leaves the battlefield, if it had counters on it, put those counters on target permanent you control.",
          "{4}{W}: Move any number of counters from target permanent you control onto a second target permanent you control."
    ]);

  unimplemented("45bcebd0-5e93-4433-b92f-b4c161d04bd6", "Ripples of Potential", [
          "Proliferate, then choose any number of permanents you control that had a counter put on them this way. Those permanents phase out."
    ]);

  unimplemented("e8e2f273-5e74-4f16-8d49-2e86e9c9f2dc", "Solar Array", [
          "{T}: Add one mana of any color. When you next cast an artifact spell this turn, that spell gains sunburst."
    ]);

  unimplemented("986ae327-f433-4c58-93dc-afc544b9bfcb", "Steel Overseer", [
          "{T}: Put a +1/+1 counter on each artifact creature you control."
    ]);

  unimplemented("dc11d9dc-7d18-45dc-955b-d0ba71fc0db8", "Surge Conductor", [
          "Whenever another nontoken artifact you control enters, proliferate."
    ]);

  unimplemented("b1544f21-7e98-461b-aed5-e748b0168c52", "Swords to Plowshares", [
          "Exile target creature. Its controller gains life equal to its power."
    ]);

  unimplemented("4716ab91-30e6-4c63-8389-a9db8f9414d8", "Tekuthal, Inquiry Dominus", [
          "If you would proliferate, proliferate twice instead.",
          "{1}{U/P}{U/P}, Remove three counters from among other artifacts, creatures, and planeswalkers you control: Put an indestructible counter on ~."
    ]);

  unimplemented("b33d2b77-f068-4fdc-a1a8-0353a35e3973", "Tezzeret's Gambit", [
          "unsupported mana cost symbols: {U/P}",
          "Draw two cards, then proliferate."
    ]);

  unimplemented("03f5c566-825c-4c46-9c01-a2f9b1e70a13", "The Mycosynth Gardens", [
          "{1}, {T}: Add one mana of any color.",
          "{X}, {T}: ~ becomes a copy of target nontoken artifact you control with mana value X."
    ]);

  unimplemented("939e6f71-185e-41f2-9d54-72cce06f1dce", "Thirst for Knowledge", [
          "Draw three cards. Then discard two cards unless you discard an artifact card."
    ]);

  unimplemented("9deded8b-cec4-4ede-a50b-131404d456d4", "Thought Monitor", [
          "Affinity for artifacts"
    ]);

  unimplemented("b8020a8b-557b-465d-865d-b59fecd7abc1", "Threefold Thunderhulk", [
          "Whenever this creature enters or attacks, create a number of 1/1 colorless Gnome artifact creature tokens equal to its power.",
          "{2}, Sacrifice another artifact: Put a +1/+1 counter on this creature."
    ]);

  unimplemented("e1c9783a-1d1b-40d7-872e-0ca11b229ce6", "Uthros Research Craft", [
          "Station",
          "3+ | Whenever you cast an artifact spell, draw a card. Put a charge counter on this Spacecraft.",
          "12+ | Flying",
          "This Spacecraft gets +1/+0 for each artifact you control."
    ]);

  unimplemented("05d75b10-4f20-4083-af27-f85c6e207fd0", "Ghirapur Aether Grid", [
          "Tap two untapped artifacts you control: ~ deals 1 damage to any target."
    ]);

  unimplemented("5dedd5a9-bc5d-47bb-9ae1-7d683843d041", "Tezzeret, Betrayer of Flesh", [
          "The first activated ability of an artifact you activate each turn costs {2} less to activate.",
          "+1: Draw two cards. Then discard two cards unless you discard an artifact card.",
          "−2: Target artifact becomes an artifact creature. If it isn't a Vehicle, it has base power and toughness 4/4.",
          "−6: You get an emblem with \"Whenever an artifact you control becomes tapped, draw a card.\""
    ]);

  unimplemented("1e943e04-e213-4781-b1a7-935aad8790e1", "Intruder Alarm", [
          "Creatures don't untap during their controllers' untap steps."
    ]);

  unimplemented("1ff00f5b-4bf9-4724-8bb5-6b9a9eb0ec7f", "Replicating Ring", [
          "At the beginning of your upkeep, put a night counter on this artifact. Then if it has eight or more night counters on it, remove all of them and create eight colorless snow artifact tokens named Replicated Ring with \"{T}: Add one mana of any color.\""
    ]);

  unimplemented("7c4b2203-a937-4d91-8e39-2283fe686b45", "Urabrask's Forge", [
          "At the beginning of combat on your turn, put an oil counter on this artifact, then create an X/1 red Phyrexian Horror creature token with trample and haste, where X is the number of oil counters on this artifact. Sacrifice that token at the beginning of the next end step."
    ]);

  unimplemented("c4175a34-70bb-47e5-8406-efdc4d2cd079", "Sami, Wildcat Captain", [
          "Spells you cast have affinity for artifacts."
    ]);

  unimplemented("0405e0a9-6d02-4691-bdb8-59c72b824dab", "Marketback Walker", [
          "~ enters with X +1/+1 counters on it.",
          "{4}: Put a +1/+1 counter on this creature.",
          "When this creature dies, draw a card for each +1/+1 counter on it."
    ]);

  unimplemented("23bf0648-7097-41df-a539-1d36ac42cf9c", "Depthshaker Titan", [
          "When this creature enters, any number of target noncreature artifacts you control become 3/3 artifact creatures. Sacrifice them at the beginning of the next end step.",
          "Each artifact creature you control has melee, trample, and haste."
    ]);

  unimplemented("bfa20bc7-4626-4a52-87f4-6e2763cb8ed5", "Archway of Innovation", [
          "{U}, {T}: The next spell you cast this turn has improvise."
    ]);

  unimplemented("e48ea9ea-64bc-4f1c-a424-592d48569244", "Blighted Agent", [
          "Infect",
          "~ can't be blocked."
    ]);

  unimplemented("de58fa4b-eeeb-4dc8-aab9-6521b15678cc", "Mm'menon, the Right Hand", [
          "Artifacts you control have \"{T}: Add {U}. Spend this mana only to cast a spell from anywhere other than your hand.\""
    ]);

  unimplemented("83874e60-291b-47a7-ba9f-69437fa7e3c7", "Flux Channeler", [
          "Whenever you cast a noncreature spell, proliferate."
    ]);

  unimplemented("c1121b83-1ba2-473d-89c9-e3bbd4529072", "Paradise Mantle", [
          "Equipped creature has \"{T}: Add one mana of any color.\""
    ]);

  unimplemented("09669283-eb14-46a2-b37a-51d7a52da891", "Requisition Raid", [
          "Spree",
          "+ {1} — Destroy target artifact.",
          "+ {1} — Destroy target enchantment.",
          "+ {1} — Put a +1/+1 counter on each creature target player controls."
    ]);

  unimplemented("2fc6de19-9d04-422b-90bc-eee2f9f8c84c", "Contentious Plan", [
          "Proliferate."
    ]);

  unimplemented("af6e4c3e-0276-4f72-9a70-25868fe8bba5", "Ioreth of the Healing House", [
          "{T}: Untap another target permanent.",
          "{T}: Untap two other target legendary creatures."
    ]);

  unimplemented("3f661b58-e8ca-412c-bdac-af151162de12", "Prologue to Phyresis", [
          "Each opponent gets a poison counter."
    ]);

  unimplemented("d2145ad3-fe7e-459b-b155-1b3ed089e936", "Steady Progress", [
          "Proliferate."
    ]);

  unimplemented("da422b3e-1092-47ad-97d6-a7a3ef060a53", "Scour for Scrap", [
          "Choose one or both —",
          "• Search your library for an artifact card, reveal it, put it into your hand, then shuffle.",
          "• Return target artifact card from your graveyard to your hand."
    ]);

  unimplemented("fbc7350c-d392-44bf-92f7-8dd4743a73b4", "Serum Snare", [
          "Return target nonland permanent to its owner's hand. If that permanent had mana value 3 or less, proliferate."
    ]);

  unimplemented("5d0f4665-aa10-4251-b590-129b59274fb3", "Clock of Omens", [
          "Tap two untapped artifacts you control: Untap target artifact."
    ]);

  unimplemented("73b3682f-396a-4ebe-aaac-6ce3ee36283a", "Weatherlight", [
          "Whenever ~ deals combat damage to a player, look at the top five cards of your library. You may reveal a historic card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."
    ]);

  unimplemented("e2962883-6daf-4a84-af73-917afc73092c", "Shorikai, Genesis Engine", [
          "{1}, {T}: Draw two cards, then discard a card. Create a 1/1 colorless Pilot creature token with \"~ crews Vehicles as though its power were 2 greater.\""
    ]);

  unimplemented("bdeb440d-a714-40e8-9038-f651e6ae45fb", "Springleaf Drum", [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ]);

  unimplemented("4d9554de-c005-41ab-a941-39328ebff9de", "Relic of Legends", [
          "Tap an untapped legendary creature you control: Add one mana of any color."
    ]);

  unimplemented("ba11a517-1dbd-4797-9f5e-46ce0f6c77c0", "Scene of the Crime", [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ]);

  unimplemented("152e7e91-4eda-4e72-a9fb-bd5cb2e68239", "Survivors' Encampment", [
          "{T}, Tap an untapped creature you control: Add one mana of any color."
    ]);

  unimplemented("98c389ed-b960-42e2-9c76-a062f77c9a78", "Teferi, Who Slows the Sunset", [
          "+1: Choose up to one target artifact, up to one target creature, and up to one target land. Untap the chosen permanents you control. Tap the chosen permanents you don't control. You gain 2 life.",
          "−2: Look at the top three cards of your library. Put one of them into your hand and the rest on the bottom of your library in any order.",
          "−7: You get an emblem with \"Untap all permanents you control during each opponent's untap step\" and \"You draw a card during each opponent's draw step.\""
    ]);

  unimplemented("370c37f7-2484-40e8-8fd9-c10cf6f5d5f2", "Manifold Key", [
          "{1}, {T}: Untap another target artifact.",
          "{3}, {T}: Target creature can't be blocked this turn."
    ]);

  unimplemented("6b336228-92c0-4f14-a479-1f97aaeae018", "Belisarius Cawl", [
          "Ultima Founding — {T}, Tap two untapped artifacts you control: Create a 2/2 white Astartes Warrior creature token with vigilance.",
          "Master of Machines — {T}, Tap X untapped creatures you control: Look at the top X cards of your library. You may reveal an artifact card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."
    ]);

}

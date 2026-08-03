/**
 * Authored card overrides for necron-dynasties.txt.
 */

import { registerOverride } from './index';
import { allOf, anyOf, CHOSEN_COLOR, IS_TOKEN, not, OTHER, ofSubtype, ofSupertype, ofType, YOURS } from '../selector';
import { constant } from '../value';

export function registerNECRON_DYNASTIESOverrides(): void {
  registerOverride({
    oracleId: "9a63f950-2e8a-4617-896c-1d0af538dbc7",
    name: "Szarekh, the Silent King",
    handledLines: [
          "My Will Be Done — Whenever ~ attacks, mill three cards. You may put an artifact creature card or Vehicle card from among the cards milled this way into your hand."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-szarekh-the-silent-king",
    name: "Szarekh, the Silent King",
    handledLines: [
          "My Will Be Done — Whenever ~ attacks, mill three cards. You may put an artifact creature card or Vehicle card from among the cards milled this way into your hand."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "32476743-c9d4-49ca-bec2-0669c215841b",
    name: "Anrakyr the Traveller",
    handledLines: [
          "Lord of the Pyrrhian Legions — Whenever ~ attacks, you may cast an artifact spell from your hand or graveyard by paying life equal to its mana value rather than paying its mana cost."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-anrakyr-the-traveller",
    name: "Anrakyr the Traveller",
    handledLines: [
          "Lord of the Pyrrhian Legions — Whenever ~ attacks, you may cast an artifact spell from your hand or graveyard by paying life equal to its mana value rather than paying its mana cost."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "aef874fa-93c0-4f86-8b0d-dc24ec51467d",
    name: "Beacon of Unrest",
    handledLines: [
          "Put target artifact or creature card from a graveyard onto the battlefield under your control. Shuffle ~ into its owner's library."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-beacon-of-unrest",
    name: "Beacon of Unrest",
    handledLines: [
          "Put target artifact or creature card from a graveyard onto the battlefield under your control. Shuffle ~ into its owner's library."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "5443557e-440f-4fdd-a29b-7740d7cec085",
    name: "Biotransference",
    handledLines: [
          "Creatures you control are artifacts in addition to their other types. The same is true for creature spells you control and creature cards you own that aren't on the battlefield.",
          "Whenever you cast an artifact spell, you lose 1 life and create a 2/2 black Necron Warrior artifact creature token."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-biotransference",
    name: "Biotransference",
    handledLines: [
          "Creatures you control are artifacts in addition to their other types. The same is true for creature spells you control and creature cards you own that aren't on the battlefield.",
          "Whenever you cast an artifact spell, you lose 1 life and create a 2/2 black Necron Warrior artifact creature token."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "09b895ff-e729-48d1-bfc1-ea5fd7adda6a",
    name: "Caged Sun",
    handledLines: [
          "As this artifact enters, choose a color.",
          "Creatures you control of the chosen color get +1/+1."
    ],
    def: {
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
      staticEffects: [{
        affects: allOf(ofType('Creature'), YOURS, CHOSEN_COLOR),
        op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 },
      }],
    },
  });
  registerOverride({
    oracleId: "oracle-caged-sun",
    name: "Caged Sun",
    handledLines: [
          "As this artifact enters, choose a color.",
          "Creatures you control of the chosen color get +1/+1."
    ],
    def: {
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
      staticEffects: [{
        affects: allOf(ofType('Creature'), YOURS, CHOSEN_COLOR),
        op: { layer: 7, sublayer: 'd', power: 1, toughness: 1 },
      }],
    },
  });

  registerOverride({
    oracleId: "5b7f6cc3-8d4e-42e5-a908-7ebe3bccaf1e",
    name: "Canoptek Scarab Swarm",
    handledLines: [
          "Feeder Mandibles — When this creature enters, exile target player's graveyard. For each artifact or land card exiled this way, create a 1/1 colorless Insect artifact creature token with flying."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-canoptek-scarab-swarm",
    name: "Canoptek Scarab Swarm",
    handledLines: [
          "Feeder Mandibles — When this creature enters, exile target player's graveyard. For each artifact or land card exiled this way, create a 1/1 colorless Insect artifact creature token with flying."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "bcad5b83-5513-4455-a9c9-716281505eaa",
    name: "Canoptek Spyder",
    handledLines: [
          "Fabricator Claw Array — Whenever another nontoken artifact creature or Vehicle you control enters, draw a card."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(OTHER, not(IS_TOKEN), ofType('Artifact'), anyOf(ofType('Creature'), ofType('Vehicle')), YOURS) } }, targets: [], effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }], description: 'Another nontoken artifact creature or Vehicle enters � draw' }],
    },
  });
  registerOverride({
    oracleId: "oracle-canoptek-spyder",
    name: "Canoptek Spyder",
    handledLines: [
          "Fabricator Claw Array — Whenever another nontoken artifact creature or Vehicle you control enters, draw a card."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(OTHER, not(IS_TOKEN), ofType('Artifact'), anyOf(ofType('Creature'), ofType('Vehicle')), YOURS) } }, targets: [], effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }], description: 'Another nontoken artifact creature or Vehicle enters � draw' }],
    },
  });

  registerOverride({
    oracleId: "678b3fb5-aa9f-4268-9433-2a89dd37b927",
    name: "Canoptek Tomb Sentinel",
    handledLines: [
          "Exile Cannon — When this creature enters from a graveyard, exile up to one target nonland permanent."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-canoptek-tomb-sentinel",
    name: "Canoptek Tomb Sentinel",
    handledLines: [
          "Exile Cannon — When this creature enters from a graveyard, exile up to one target nonland permanent."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "61849685-b407-4ed0-aafc-ec3a003200b9",
    name: "Canoptek Wraith",
    handledLines: [
          "Wraith Form — ~ can't be blocked.",
          "Transdimensional Scout — When this creature deals combat damage to a player, you may pay {3} and sacrifice it. If you do, choose a land you control. Then search your library for up to two basic land cards which have the same name as the chosen land, put them onto the battlefield tapped, then shuffle."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-canoptek-wraith",
    name: "Canoptek Wraith",
    handledLines: [
          "Wraith Form — ~ can't be blocked.",
          "Transdimensional Scout — When this creature deals combat damage to a player, you may pay {3} and sacrifice it. If you do, choose a land you control. Then search your library for up to two basic land cards which have the same name as the chosen land, put them onto the battlefield tapped, then shuffle."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9833e3bd-6e7f-41b7-bf7e-ffb74ff17844",
    name: "Chronomancer",
    handledLines: [
          "Atomic Transmutation — {1}, {T}, Sacrifice another artifact: Draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-chronomancer",
    name: "Chronomancer",
    handledLines: [
          "Atomic Transmutation — {1}, {T}, Sacrifice another artifact: Draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "655aece2-f33a-46e0-8f80-112ae8a457fe",
    name: "Convergence of Dominion",
    handledLines: [
          "Dynastic Command Node — As long as you control your commander, activated abilities of cards in your graveyard cost {2} less to activate. This effect can't reduce the mana in that ability's activation cost to less than one mana.",
          "Translocation Protocols — {3}, {T}: Mill three cards."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-convergence-of-dominion",
    name: "Convergence of Dominion",
    handledLines: [
          "Dynastic Command Node — As long as you control your commander, activated abilities of cards in your graveyard cost {2} less to activate. This effect can't reduce the mana in that ability's activation cost to less than one mana.",
          "Translocation Protocols — {3}, {T}: Mill three cards."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "75564721-e4e9-463a-b49e-f0c7cd6f53a7",
    name: "Cranial Plating",
    handledLines: [
          "Equipped creature gets +1/+0 for each artifact you control.",
          "{B}{B}: Attach this Equipment to target creature you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-cranial-plating",
    name: "Cranial Plating",
    handledLines: [
          "Equipped creature gets +1/+0 for each artifact you control.",
          "{B}{B}: Attach this Equipment to target creature you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "27a4b633-5a62-4d8c-8cc6-44959c311de9",
    name: "Cryptek",
    handledLines: [
          "{1}{B}, {T}: Choose another target artifact creature you control. When that creature dies this turn, return it to the battlefield tapped under your control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-cryptek",
    name: "Cryptek",
    handledLines: [
          "{1}{B}, {T}: Choose another target artifact creature you control. When that creature dies this turn, return it to the battlefield tapped under your control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e26f0fcd-d6d2-4e7b-82dd-711bc0b9dad3",
    name: "Cryptothrall",
    handledLines: [
          "Protector — Other artifact creatures you control have hexproof."
    ],
    def: {
      staticEffects: [{ affects: allOf(OTHER, ofType('Artifact'), ofType('Creature'), YOURS), op: { layer: 6, addKeyword: 'hexproof' } }],
    },
  });
  registerOverride({
    oracleId: "oracle-cryptothrall",
    name: "Cryptothrall",
    handledLines: [
          "Protector — Other artifact creatures you control have hexproof."
    ],
    def: {
      staticEffects: [{ affects: allOf(OTHER, ofType('Artifact'), ofType('Creature'), YOURS), op: { layer: 6, addKeyword: 'hexproof' } }],
    },
  });

  registerOverride({
    oracleId: "932708ae-9d5c-4561-aa8b-0d2222d37fdc",
    name: "Darkness",
    handledLines: [
          "Prevent all combat damage that would be dealt this turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-darkness",
    name: "Darkness",
    handledLines: [
          "Prevent all combat damage that would be dealt this turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "49dddec0-d958-4810-8c6e-225fc8118c8f",
    name: "Defile",
    handledLines: [
          "Target creature gets -1/-1 until end of turn for each Swamp you control."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [{ kind: 'creature' }],
        effects: [{ op: 'pumpUntilEot', target: 0, power: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 }, toughness: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 } }],
        description: 'Target creature gets -1/-1 for each Swamp controlled',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-defile",
    name: "Defile",
    handledLines: [
          "Target creature gets -1/-1 until end of turn for each Swamp you control."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [{ kind: 'creature' }],
        effects: [{ op: 'pumpUntilEot', target: 0, power: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 }, toughness: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 } }],
        description: 'Target creature gets -1/-1 for each Swamp controlled',
      },
    },
  });

  registerOverride({
    oracleId: "352b64d2-2ae5-44ee-a64f-94932ef545d3",
    name: "Dread Return",
    handledLines: [
          "Flashback—Sacrifice three creatures."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-dread-return",
    name: "Dread Return",
    handledLines: [
          "Flashback—Sacrifice three creatures."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "cb923c4d-1d2e-4039-90bb-72d1981b9738",
    name: "Endless Atlas",
    handledLines: [
          "{2}, {T}: Draw a card. Activate only if you control three or more lands with the same name."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-endless-atlas",
    name: "Endless Atlas",
    handledLines: [
          "{2}, {T}: Draw a card. Activate only if you control three or more lands with the same name."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "899415fd-4164-42a5-a0c7-eef1967c5ec5",
    name: "Flayed One",
    handledLines: [
          "Flesh Flayer — When this creature enters, mill three cards."
    ],
    def: {
      triggers: [{
        kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
        effects: [{ op: 'mill', count: { kind: 'const', n: 3 } }], description: 'Enters � mill three cards',
      }],
    },
  });
  registerOverride({
    oracleId: "oracle-flayed-one",
    name: "Flayed One",
    handledLines: [
          "Flesh Flayer — When this creature enters, mill three cards."
    ],
    def: {
      triggers: [{
        kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
        effects: [{ op: 'mill', count: { kind: 'const', n: 3 } }], description: 'Enters � mill three cards',
      }],
    },
  });

  registerOverride({
    oracleId: "bb1b4786-3804-486b-9fd9-85848d24d362",
    name: "Ghost Ark",
    handledLines: [
          "Repair Barge — Whenever this Vehicle becomes crewed, each artifact creature card in your graveyard gains unearth {3} until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-ghost-ark",
    name: "Ghost Ark",
    handledLines: [
          "Repair Barge — Whenever this Vehicle becomes crewed, each artifact creature card in your graveyard gains unearth {3} until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9a02a9a7-39d9-4763-85d3-747a0540b60b",
    name: "Gilded Lotus",
    handledLines: [
          "{T}: Add three mana of any one color."
    ],
    def: {
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G'], ['W', 'U', 'B', 'R', 'G'], ['W', 'U', 'B', 'R', 'G']], linked: true }],
    },
  });
  registerOverride({
    oracleId: "oracle-gilded-lotus",
    name: "Gilded Lotus",
    handledLines: [
          "{T}: Add three mana of any one color."
    ],
    def: {
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G'], ['W', 'U', 'B', 'R', 'G'], ['W', 'U', 'B', 'R', 'G']], linked: true }],
    },
  });

  registerOverride({
    oracleId: "2f092562-9e17-43cd-aeb8-d0567f99363e",
    name: "Go for the Throat",
    handledLines: [
          "Destroy target nonartifact creature."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [{ kind: 'creature', filter: not(ofType('Artifact')) }], effects: [{ op: 'destroy', target: 0 }], description: 'Destroy target nonartifact creature' },
    },
  });
  registerOverride({
    oracleId: "oracle-go-for-the-throat",
    name: "Go for the Throat",
    handledLines: [
          "Destroy target nonartifact creature."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [{ kind: 'creature', filter: not(ofType('Artifact')) }], effects: [{ op: 'destroy', target: 0 }], description: 'Destroy target nonartifact creature' },
    },
  });

  registerOverride({
    oracleId: "b3329240-c812-45ea-a7f8-4d79cd4ed515",
    name: "Hexmark Destroyer",
    handledLines: [
          "Multi-threat Eliminator — ~ can't be blocked except by six or more creatures."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-hexmark-destroyer",
    name: "Hexmark Destroyer",
    handledLines: [
          "Multi-threat Eliminator — ~ can't be blocked except by six or more creatures."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "10f274f9-9044-447b-81c9-d4906ad9e6be",
    name: "Illuminor Szeras",
    handledLines: [
          "Secrets of the Soul — {T}, Sacrifice another creature: Add an amount of {B} equal to the sacrificed creature's mana value."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-illuminor-szeras",
    name: "Illuminor Szeras",
    handledLines: [
          "Secrets of the Soul — {T}, Sacrifice another creature: Add an amount of {B} equal to the sacrificed creature's mana value."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "425fea06-76ec-4cd9-bd3b-750504fd7fd2",
    name: "Imotekh the Stormlord",
    handledLines: [
          "Phaeron — Whenever one or more artifact cards leave your graveyard, create two 2/2 black Necron Warrior artifact creature tokens.",
          "Grand Strategist — At the beginning of combat on your turn, another target artifact creature you control gets +2/+2 and gains menace until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-imotekh-the-stormlord",
    name: "Imotekh the Stormlord",
    handledLines: [
          "Phaeron — Whenever one or more artifact cards leave your graveyard, create two 2/2 black Necron Warrior artifact creature tokens.",
          "Grand Strategist — At the beginning of combat on your turn, another target artifact creature you control gets +2/+2 and gains menace until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9e6a3df4-67a3-452e-a6ef-f04dbadb21ef",
    name: "Living Death",
    handledLines: [
          "Each player exiles all creature cards from their graveyard, then sacrifices all creatures they control, then puts all cards they exiled this way onto the battlefield."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-living-death",
    name: "Living Death",
    handledLines: [
          "Each player exiles all creature cards from their graveyard, then sacrifices all creatures they control, then puts all cards they exiled this way onto the battlefield."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "fd03f20a-d365-48fb-8b2a-ad4b502a0045",
    name: "Lokhust Heavy Destroyer",
    handledLines: [
          "Enmitic Exterminator — When this creature enters, each player sacrifices a creature of their choice."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-lokhust-heavy-destroyer",
    name: "Lokhust Heavy Destroyer",
    handledLines: [
          "Enmitic Exterminator — When this creature enters, each player sacrifices a creature of their choice."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "d6b2c998-a226-426c-a40d-6e6007041bfe",
    name: "Mask of Memory",
    handledLines: [
          "Whenever equipped creature deals combat damage to a player, you may draw two cards. If you do, discard a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-mask-of-memory",
    name: "Mask of Memory",
    handledLines: [
          "Whenever equipped creature deals combat damage to a player, you may draw two cards. If you do, discard a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "698e79ec-c2bc-4973-a095-f3c57b50e39c",
    name: "Mutilate",
    handledLines: [
          "All creatures get -1/-1 until end of turn for each Swamp you control."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [{ op: 'pumpEachUntilEot', selector: ofType('Creature'), power: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 }, toughness: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 } }],
        description: 'All creatures get -1/-1 for each Swamp controlled',
      },
    },
  });
  registerOverride({
    oracleId: "oracle-mutilate",
    name: "Mutilate",
    handledLines: [
          "All creatures get -1/-1 until end of turn for each Swamp you control."
    ],
    def: {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [{ op: 'pumpEachUntilEot', selector: ofType('Creature'), power: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 }, toughness: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 } }],
        description: 'All creatures get -1/-1 for each Swamp controlled',
      },
    },
  });

  registerOverride({
    oracleId: "2549bc57-9ffb-4053-9f10-f2a5f792b845",
    name: "Myriad Landscape",
    handledLines: [
          "{2}, {T}, Sacrifice this land: Search your library for up to two basic land cards that share a land type, put them onto the battlefield tapped, then shuffle."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-myriad-landscape",
    name: "Myriad Landscape",
    handledLines: [
          "{2}, {T}, Sacrifice this land: Search your library for up to two basic land cards that share a land type, put them onto the battlefield tapped, then shuffle."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "994bc16d-fdc6-475c-96df-beeb4d5aa03e",
    name: "Mystic Forge",
    handledLines: [
          "You may cast artifact spells and colorless spells from the top of your library.",
          "{T}, Pay 1 life: Exile the top card of your library."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-mystic-forge",
    name: "Mystic Forge",
    handledLines: [
          "You may cast artifact spells and colorless spells from the top of your library.",
          "{T}, Pay 1 life: Exile the top card of your library."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "45866598-4ee4-46b6-ade2-ffcdbe98e58f",
    name: "Necron Deathmark",
    handledLines: [
          "Synaptic Disintegrator — When this creature enters, destroy up to one target creature and target player mills three cards."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-necron-deathmark",
    name: "Necron Deathmark",
    handledLines: [
          "Synaptic Disintegrator — When this creature enters, destroy up to one target creature and target player mills three cards."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "20932bca-52be-4288-9c7d-4154650c5ec9",
    name: "Necron Monolith",
    handledLines: [
          "Eternity Gate — Whenever this Vehicle attacks, mill three cards. For each creature card milled this way, create a 2/2 black Necron Warrior artifact creature token."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-necron-monolith",
    name: "Necron Monolith",
    handledLines: [
          "Eternity Gate — Whenever this Vehicle attacks, mill three cards. For each creature card milled this way, create a 2/2 black Necron Warrior artifact creature token."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "2c0de95f-4269-439c-a1bc-faa11348b185",
    name: "Necron Overlord",
    handledLines: [
          "Relentless March — {X}, {T}, Tap X untapped artifacts you control: Target opponent loses X life."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-necron-overlord",
    name: "Necron Overlord",
    handledLines: [
          "Relentless March — {X}, {T}, Tap X untapped artifacts you control: Target opponent loses X life."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "dea9741a-3360-4a17-aeea-a854e2174d25",
    name: "Night Scythe",
    handledLines: [
          "Invasion Beams — When this Vehicle enters, create a 2/2 black Necron Warrior artifact creature token."
    ],
    def: {
      triggers: [{
        kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
        effects: [{ op: 'createToken', count: { kind: 'const', n: 1 }, spec: { name: 'Necron Warrior', typeLine: 'Artifact Creature � Necron Warrior', types: ['Artifact', 'Creature'], subtypes: ['Necron', 'Warrior'], colors: [], power: 2, toughness: 2 } }],
        description: 'Enters � create a Necron Warrior token',
      }],
    },
  });
  registerOverride({
    oracleId: "oracle-night-scythe",
    name: "Night Scythe",
    handledLines: [
          "Invasion Beams — When this Vehicle enters, create a 2/2 black Necron Warrior artifact creature token."
    ],
    def: {
      triggers: [{
        kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
        effects: [{ op: 'createToken', count: { kind: 'const', n: 1 }, spec: { name: 'Necron Warrior', typeLine: 'Artifact Creature � Necron Warrior', types: ['Artifact', 'Creature'], subtypes: ['Necron', 'Warrior'], colors: [], power: 2, toughness: 2 } }],
        description: 'Enters � create a Necron Warrior token',
      }],
    },
  });

  registerOverride({
    oracleId: "473a7998-669d-4181-83fe-f178a2e781f0",
    name: "Out of the Tombs",
    handledLines: [
          "At the beginning of your upkeep, put two eon counters on this enchantment, then mill cards equal to the number of eon counters on it.",
          "If you would draw a card while your library has no cards in it, instead return a creature card from your graveyard to the battlefield. If you can't, you lose the game."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-out-of-the-tombs",
    name: "Out of the Tombs",
    handledLines: [
          "At the beginning of your upkeep, put two eon counters on this enchantment, then mill cards equal to the number of eon counters on it.",
          "If you would draw a card while your library has no cards in it, instead return a creature card from your graveyard to the battlefield. If you can't, you lose the game."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "b3ff8da4-f2cc-41c3-8950-9cc531854b78",
    name: "Plasmancer",
    handledLines: [
          "Dynastic Advisor — When this creature enters, search your library for a basic Swamp card, reveal it, put it into your hand, then shuffle."
    ],
    def: {
      triggers: [{
        kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
        effects: [
          { op: 'searchLibrary', filter: allOf(ofType('Land'), ofSupertype('Basic'), ofSubtype('Swamp')), destinations: [{ zone: 'hand' }] },
          { op: 'shuffle' },
        ], description: 'Enters � search for a basic Swamp',
      }],
    },
  });
  registerOverride({
    oracleId: "oracle-plasmancer",
    name: "Plasmancer",
    handledLines: [
          "Dynastic Advisor — When this creature enters, search your library for a basic Swamp card, reveal it, put it into your hand, then shuffle."
    ],
    def: {
      triggers: [{
        kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
        effects: [
          { op: 'searchLibrary', filter: allOf(ofType('Land'), ofSupertype('Basic'), ofSubtype('Swamp')), destinations: [{ zone: 'hand' }] },
          { op: 'shuffle' },
        ], description: 'Enters � search for a basic Swamp',
      }],
    },
  });

  registerOverride({
    oracleId: "589b742c-fee5-413a-a56c-4d4ffaf0f73d",
    name: "Psychomancer",
    handledLines: [
          "Harbinger of Despair — Whenever this creature or another nontoken artifact you control is put into a graveyard from the battlefield or is put into exile from the battlefield, target opponent loses 1 life and you gain 1 life."
    ],
    def: {
      triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: allOf(ofType('Artifact'), not(IS_TOKEN), YOURS) } }, targets: [{ kind: 'player' }], effects: [{ op: 'loseLife', amount: constant(1) }, { op: 'gainLife', amount: constant(1) }], description: 'An artifact leaves — target opponent loses 1 and you gain 1' }],
    },
  });
  registerOverride({
    oracleId: "oracle-psychomancer",
    name: "Psychomancer",
    handledLines: [
          "Harbinger of Despair — Whenever this creature or another nontoken artifact you control is put into a graveyard from the battlefield or is put into exile from the battlefield, target opponent loses 1 life and you gain 1 life."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c23e5b80-08d2-4e24-9908-fe2aa4f30f6f",
    name: "Reliquary Tower",
    handledLines: [
          "You have no maximum hand size."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-reliquary-tower",
    name: "Reliquary Tower",
    handledLines: [
          "You have no maximum hand size."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "b410f294-cbb6-4016-981f-808fd9b7bbae",
    name: "Resurrection Orb",
    handledLines: [
          "Whenever equipped creature dies, return that card to the battlefield under its owner's control at the beginning of the next end step."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-resurrection-orb",
    name: "Resurrection Orb",
    handledLines: [
          "Whenever equipped creature dies, return that card to the battlefield under its owner's control at the beginning of the next end step."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "0192ba05-6144-4fec-a803-462ecdf64195",
    name: "Royal Warden",
    handledLines: [
          "Phalanx Commander — When this creature enters, create two tapped 2/2 black Necron Warrior artifact creature tokens."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-royal-warden",
    name: "Royal Warden",
    handledLines: [
          "Phalanx Commander — When this creature enters, create two tapped 2/2 black Necron Warrior artifact creature tokens."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "7388a797-d40d-4783-a281-d17bc159b856",
    name: "Sautekh Immortal",
    handledLines: [
          "Elite Troops — ~ enters with a +1/+1 counter on it for each creature that died this turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-sautekh-immortal",
    name: "Sautekh Immortal",
    handledLines: [
          "Elite Troops — ~ enters with a +1/+1 counter on it for each creature that died this turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ce08aff3-efe6-4186-9557-274e00a7ca38",
    name: "Sceptre of Eternal Glory",
    handledLines: [
          "{T}: Add three mana of any one color. Activate only if you control three or more lands with the same name."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-sceptre-of-eternal-glory",
    name: "Sceptre of Eternal Glory",
    handledLines: [
          "{T}: Add three mana of any one color. Activate only if you control three or more lands with the same name."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "6c85271c-c711-49b0-a72e-9e576c33714d",
    name: "Sculpting Steel",
    handledLines: [
          "You may have this artifact enter as a copy of any artifact on the battlefield."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-sculpting-steel",
    name: "Sculpting Steel",
    handledLines: [
          "You may have this artifact enter as a copy of any artifact on the battlefield."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "eedd5a17-d0fe-4a13-8f2c-f343bfa43f92",
    name: "Shard of the Nightbringer",
    handledLines: [
          "Drain Life — When this creature enters, if you cast it, target opponent loses half their life, rounded up. You gain life equal to the life lost this way."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-shard-of-the-nightbringer",
    name: "Shard of the Nightbringer",
    handledLines: [
          "Drain Life — When this creature enters, if you cast it, target opponent loses half their life, rounded up. You gain life equal to the life lost this way."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "d04d2434-121e-4420-abfc-fa21ad5577c3",
    name: "Shard of the Void Dragon",
    handledLines: [
          "Spear of the Void Dragon — Whenever this creature attacks, each opponent sacrifices a nonland permanent of their choice.",
          "Matter Absorption — Whenever an artifact is put into a graveyard from the battlefield or is put into exile from the battlefield, put two +1/+1 counters on this creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-shard-of-the-void-dragon",
    name: "Shard of the Void Dragon",
    handledLines: [
          "Spear of the Void Dragon — Whenever this creature attacks, each opponent sacrifices a nonland permanent of their choice.",
          "Matter Absorption — Whenever an artifact is put into a graveyard from the battlefield or is put into exile from the battlefield, put two +1/+1 counters on this creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "f96fcb37-5f17-4231-b1a2-64f5fe45730b",
    name: "Skorpekh Destroyer",
    handledLines: [
          "Hyperphase Threshers — Whenever an artifact you control enters, this creature gains first strike until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-skorpekh-destroyer",
    name: "Skorpekh Destroyer",
    handledLines: [
          "Hyperphase Threshers — Whenever an artifact you control enters, this creature gains first strike until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "3f97541e-34f3-4f7f-8ac2-7167b2ec9b33",
    name: "Technomancer",
    handledLines: [
          "When this creature enters, mill three cards, then return any number of artifact creature cards with total mana value 6 or less from your graveyard to the battlefield."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-technomancer",
    name: "Technomancer",
    handledLines: [
          "When this creature enters, mill three cards, then return any number of artifact creature cards with total mana value 6 or less from your graveyard to the battlefield."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "5924cbb0-19b5-449c-a7c5-722e744a54f8",
    name: "The War in Heaven",
    handledLines: [
          "unsupported layout \"saga\"",
          "I — You draw three cards and you lose 3 life.",
          "II — Mill three cards.",
          "III — Choose up to three target creature cards with total mana value 8 or less in your graveyard. Return each of them to the battlefield with a necrodermis counter on it. They're artifacts in addition to their other types."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-the-war-in-heaven",
    name: "The War in Heaven",
    handledLines: [
          "unsupported layout \"saga\"",
          "I — You draw three cards and you lose 3 life.",
          "II — Mill three cards.",
          "III — Choose up to three target creature cards with total mana value 8 or less in your graveyard. Return each of them to the battlefield with a necrodermis counter on it. They're artifacts in addition to their other types."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "97f9aa5e-e34d-4029-9213-b32ebaf9859c",
    name: "Their Name Is Death",
    handledLines: [
          "Destroy all nonartifact creatures."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-their-name-is-death",
    name: "Their Name Is Death",
    handledLines: [
          "Destroy all nonartifact creatures."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "8cd45064-2ad9-4247-902e-aefaf3bc1a43",
    name: "Their Number Is Legion",
    handledLines: [
          "Create X tapped 2/2 black Necron Warrior artifact creature tokens, then you gain life equal to the number of artifacts you control. Exile ~.",
          "You may cast this card from your graveyard."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-their-number-is-legion",
    name: "Their Number Is Legion",
    handledLines: [
          "Create X tapped 2/2 black Necron Warrior artifact creature tokens, then you gain life equal to the number of artifacts you control. Exile ~.",
          "You may cast this card from your graveyard."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9965d9c5-2ebf-4a6c-930e-55c5890979be",
    name: "Thought Vessel",
    handledLines: [
          "You have no maximum hand size."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-thought-vessel",
    name: "Thought Vessel",
    handledLines: [
          "You have no maximum hand size."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c857de66-f4e0-4e97-ad01-fac623af8225",
    name: "Tomb Blade",
    handledLines: [
          "Whenever this creature deals combat damage to a player, that player loses life equal to the number of creatures they control unless they sacrifice a creature of their choice."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-tomb-blade",
    name: "Tomb Blade",
    handledLines: [
          "Whenever this creature deals combat damage to a player, that player loses life equal to the number of creatures they control unless they sacrifice a creature of their choice."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "986f510c-e2ec-423e-a443-51a169939558",
    name: "Tomb Fortress",
    handledLines: [
          "{2}{B}{B}{B}, {T}, Exile this land: Mill four cards, then return a creature card from your graveyard to the battlefield. Activate only as a sorcery."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-tomb-fortress",
    name: "Tomb Fortress",
    handledLines: [
          "{2}{B}{B}{B}, {T}, Exile this land: Mill four cards, then return a creature card from your graveyard to the battlefield. Activate only as a sorcery."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "1ef3b48a-55ef-422e-ac7f-e1c1057eec2c",
    name: "Trazyn the Infinite",
    handledLines: [
          "Prismatic Gallery — As long as ~ is on the battlefield, it has all activated abilities of all artifact cards in your graveyard."
    ],
    def: {
      activatedAbilities: [{ costs: [], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'noOp' }], description: 'Use an activated ability from an artifact card in your graveyard' } }],
    },
  });
  registerOverride({
    oracleId: "oracle-trazyn-the-infinite",
    name: "Trazyn the Infinite",
    handledLines: [
          "Prismatic Gallery — As long as ~ is on the battlefield, it has all activated abilities of all artifact cards in your graveyard."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "52aa5a79-db0e-4eaa-b2df-e41674c47794",
    name: "Triarch Praetorian",
    handledLines: [
          "Dynastic Codes — When this creature enters from a graveyard, you draw two cards and you lose 2 life."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-triarch-praetorian",
    name: "Triarch Praetorian",
    handledLines: [
          "Dynastic Codes — When this creature enters from a graveyard, you draw two cards and you lose 2 life."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "1b3ae9c3-1940-4fb8-a47c-2d9e1790f4a3",
    name: "Triarch Stalker",
    handledLines: [
          "Targeting Relay — At the beginning of combat on your turn, choose an opponent.",
          "Creatures attacking the last chosen player have menace."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-triarch-stalker",
    name: "Triarch Stalker",
    handledLines: [
          "Targeting Relay — At the beginning of combat on your turn, choose an opponent.",
          "Creatures attacking the last chosen player have menace."
    ],
    def: {},
  });

}

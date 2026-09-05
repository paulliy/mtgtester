/**
 * Authored card overrides for necron-dynasties.txt.
 */

import { NECRON_WARRIOR_2_2 } from '../tokens';
import { defineCard, unimplemented } from './index';
import { allOf, anyOf, CHOSEN_COLOR, IS_TOKEN, not, OTHER, ofSubtype, ofSupertype, ofType, YOURS } from '../selector';
import { constant } from '../value';

export function registerNECRON_DYNASTIESOverrides(): void {
  unimplemented("9a63f950-2e8a-4617-896c-1d0af538dbc7", "Szarekh, the Silent King", [
          "My Will Be Done — Whenever ~ attacks, mill three cards. You may put an artifact creature card or Vehicle card from among the cards milled this way into your hand."
    ]);

  unimplemented("32476743-c9d4-49ca-bec2-0669c215841b", "Anrakyr the Traveller", [
          "Lord of the Pyrrhian Legions — Whenever ~ attacks, you may cast an artifact spell from your hand or graveyard by paying life equal to its mana value rather than paying its mana cost."
    ]);

  unimplemented("aef874fa-93c0-4f86-8b0d-dc24ec51467d", "Beacon of Unrest", [
          "Put target artifact or creature card from a graveyard onto the battlefield under your control. Shuffle ~ into its owner's library."
    ]);



  defineCard("09b895ff-e729-48d1-bfc1-ea5fd7adda6a", "Caged Sun", [
          "As this artifact enters, choose a color.",
          "Creatures you control of the chosen color get +1/+1."
    ], {
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
    });

  unimplemented("5b7f6cc3-8d4e-42e5-a908-7ebe3bccaf1e", "Canoptek Scarab Swarm", [
          "Feeder Mandibles — When this creature enters, exile target player's graveyard. For each artifact or land card exiled this way, create a 1/1 colorless Insect artifact creature token with flying."
    ]);

  defineCard("bcad5b83-5513-4455-a9c9-716281505eaa", "Canoptek Spyder", [
          "Fabricator Claw Array — Whenever another nontoken artifact creature or Vehicle you control enters, draw a card."
    ], {
      triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'permanent', selector: allOf(OTHER, not(IS_TOKEN), ofType('Artifact'), anyOf(ofType('Creature'), ofType('Vehicle')), YOURS) } }, targets: [], effects: [{ op: 'draw', count: constant(1) }], description: 'Another nontoken artifact creature or Vehicle enters — draw' }],
    });

  unimplemented("678b3fb5-aa9f-4268-9433-2a89dd37b927", "Canoptek Tomb Sentinel", [
          "Exile Cannon — When this creature enters from a graveyard, exile up to one target nonland permanent."
    ]);

  unimplemented("61849685-b407-4ed0-aafc-ec3a003200b9", "Canoptek Wraith", [
          "Wraith Form — ~ can't be blocked.",
          "Transdimensional Scout — When this creature deals combat damage to a player, you may pay {3} and sacrifice it. If you do, choose a land you control. Then search your library for up to two basic land cards which have the same name as the chosen land, put them onto the battlefield tapped, then shuffle."
    ]);

  unimplemented("9833e3bd-6e7f-41b7-bf7e-ffb74ff17844", "Chronomancer", [
          "Atomic Transmutation — {1}, {T}, Sacrifice another artifact: Draw a card."
    ]);

  unimplemented("655aece2-f33a-46e0-8f80-112ae8a457fe", "Convergence of Dominion", [
          "Dynastic Command Node — As long as you control your commander, activated abilities of cards in your graveyard cost {2} less to activate. This effect can't reduce the mana in that ability's activation cost to less than one mana.",
          "Translocation Protocols — {3}, {T}: Mill three cards."
    ]);


  unimplemented("27a4b633-5a62-4d8c-8cc6-44959c311de9", "Cryptek", [
          "{1}{B}, {T}: Choose another target artifact creature you control. When that creature dies this turn, return it to the battlefield tapped under your control."
    ]);

  defineCard("e26f0fcd-d6d2-4e7b-82dd-711bc0b9dad3", "Cryptothrall", [
          "Protector — Other artifact creatures you control have hexproof."
    ], {
      staticEffects: [{ affects: allOf(OTHER, ofType('Artifact'), ofType('Creature'), YOURS), op: { layer: 6, addKeyword: 'hexproof' } }],
    });

  unimplemented("932708ae-9d5c-4561-aa8b-0d2222d37fdc", "Darkness", [
          "Prevent all combat damage that would be dealt this turn."
    ]);

  defineCard("49dddec0-d958-4810-8c6e-225fc8118c8f", "Defile", [
          "Target creature gets -1/-1 until end of turn for each Swamp you control."
    ], {
      spellAbility: {
        kind: 'spell', targets: [{ kind: 'creature' }],
        effects: [{ op: 'pumpUntilEot', target: 0, power: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 }, toughness: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 } }],
        description: 'Target creature gets -1/-1 for each Swamp controlled',
      },
    });

  unimplemented("352b64d2-2ae5-44ee-a64f-94932ef545d3", "Dread Return", [
          "Flashback—Sacrifice three creatures."
    ]);

  unimplemented("cb923c4d-1d2e-4039-90bb-72d1981b9738", "Endless Atlas", [
          "{2}, {T}: Draw a card. Activate only if you control three or more lands with the same name."
    ]);

  defineCard("899415fd-4164-42a5-a0c7-eef1967c5ec5", "Flayed One", [
          "Flesh Flayer — When this creature enters, mill three cards."
    ], {
      triggers: [{
        kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
        effects: [{ op: 'mill', count: constant(3) }], description: 'Enters — mill three cards',
      }],
    });

  unimplemented("bb1b4786-3804-486b-9fd9-85848d24d362", "Ghost Ark", [
          "Repair Barge — Whenever this Vehicle becomes crewed, each artifact creature card in your graveyard gains unearth {3} until end of turn."
    ]);

  defineCard("9a02a9a7-39d9-4763-85d3-747a0540b60b", "Gilded Lotus", [
          "{T}: Add three mana of any one color."
    ], {
      manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G'], ['W', 'U', 'B', 'R', 'G'], ['W', 'U', 'B', 'R', 'G']], linked: true }],
    });

  defineCard("2f092562-9e17-43cd-aeb8-d0567f99363e", "Go for the Throat", [
          "Destroy target nonartifact creature."
    ], {
      spellAbility: { kind: 'spell', targets: [{ kind: 'creature', filter: not(ofType('Artifact')) }], effects: [{ op: 'destroy', target: 0 }], description: 'Destroy target nonartifact creature' },
    });

  unimplemented("b3329240-c812-45ea-a7f8-4d79cd4ed515", "Hexmark Destroyer", [
          "Multi-threat Eliminator — ~ can't be blocked except by six or more creatures."
    ]);

  unimplemented("10f274f9-9044-447b-81c9-d4906ad9e6be", "Illuminor Szeras", [
          "Secrets of the Soul — {T}, Sacrifice another creature: Add an amount of {B} equal to the sacrificed creature's mana value."
    ]);

  unimplemented("425fea06-76ec-4cd9-bd3b-750504fd7fd2", "Imotekh the Stormlord", [
          "Phaeron — Whenever one or more artifact cards leave your graveyard, create two 2/2 black Necron Warrior artifact creature tokens.",
          "Grand Strategist — At the beginning of combat on your turn, another target artifact creature you control gets +2/+2 and gains menace until end of turn."
    ]);

  unimplemented("9e6a3df4-67a3-452e-a6ef-f04dbadb21ef", "Living Death", [
          "Each player exiles all creature cards from their graveyard, then sacrifices all creatures they control, then puts all cards they exiled this way onto the battlefield."
    ]);

  unimplemented("fd03f20a-d365-48fb-8b2a-ad4b502a0045", "Lokhust Heavy Destroyer", [
          "Enmitic Exterminator — When this creature enters, each player sacrifices a creature of their choice."
    ]);

  unimplemented("d6b2c998-a226-426c-a40d-6e6007041bfe", "Mask of Memory", [
          "Whenever equipped creature deals combat damage to a player, you may draw two cards. If you do, discard a card."
    ]);

  defineCard("698e79ec-c2bc-4973-a095-f3c57b50e39c", "Mutilate", [
          "All creatures get -1/-1 until end of turn for each Swamp you control."
    ], {
      spellAbility: {
        kind: 'spell', targets: [],
        effects: [{ op: 'pumpEachUntilEot', selector: ofType('Creature'), power: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 }, toughness: { kind: 'times', of: { kind: 'countPermanents', selector: ofSubtype('Swamp'), scope: 'you' }, n: -1 } }],
        description: 'All creatures get -1/-1 for each Swamp controlled',
      },
    });

  unimplemented("2549bc57-9ffb-4053-9f10-f2a5f792b845", "Myriad Landscape", [
          "{2}, {T}, Sacrifice this land: Search your library for up to two basic land cards that share a land type, put them onto the battlefield tapped, then shuffle."
    ]);

  unimplemented("994bc16d-fdc6-475c-96df-beeb4d5aa03e", "Mystic Forge", [
          "You may cast artifact spells and colorless spells from the top of your library.",
          "{T}, Pay 1 life: Exile the top card of your library."
    ]);

  unimplemented("45866598-4ee4-46b6-ade2-ffcdbe98e58f", "Necron Deathmark", [
          "Synaptic Disintegrator — When this creature enters, destroy up to one target creature and target player mills three cards."
    ]);

  unimplemented("20932bca-52be-4288-9c7d-4154650c5ec9", "Necron Monolith", [
          "Eternity Gate — Whenever this Vehicle attacks, mill three cards. For each creature card milled this way, create a 2/2 black Necron Warrior artifact creature token."
    ]);

  unimplemented("2c0de95f-4269-439c-a1bc-faa11348b185", "Necron Overlord", [
          "Relentless March — {X}, {T}, Tap X untapped artifacts you control: Target opponent loses X life."
    ]);

  defineCard("dea9741a-3360-4a17-aeea-a854e2174d25", "Night Scythe", [
          "Invasion Beams — When this Vehicle enters, create a 2/2 black Necron Warrior artifact creature token."
    ], {
      triggers: [{
        kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
        effects: [{ op: 'createToken', count: constant(1), spec: NECRON_WARRIOR_2_2 }],
        description: 'Enters — create a Necron Warrior token',
      }],
    });

  unimplemented("473a7998-669d-4181-83fe-f178a2e781f0", "Out of the Tombs", [
          "At the beginning of your upkeep, put two eon counters on this enchantment, then mill cards equal to the number of eon counters on it.",
          "If you would draw a card while your library has no cards in it, instead return a creature card from your graveyard to the battlefield. If you can't, you lose the game."
    ]);

  defineCard("b3ff8da4-f2cc-41c3-8950-9cc531854b78", "Plasmancer", [
          "Dynastic Advisor — When this creature enters, search your library for a basic Swamp card, reveal it, put it into your hand, then shuffle."
    ], {
      triggers: [{
        kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [],
        effects: [
          { op: 'searchLibrary', filter: allOf(ofType('Land'), ofSupertype('Basic'), ofSubtype('Swamp')), destinations: [{ zone: 'hand' }] },
          { op: 'shuffle' },
        ], description: 'Enters — search for a basic Swamp',
      }],
    });

  defineCard("589b742c-fee5-413a-a56c-4d4ffaf0f73d", "Psychomancer", [
          "Harbinger of Despair — Whenever this creature or another nontoken artifact you control is put into a graveyard from the battlefield or is put into exile from the battlefield, target opponent loses 1 life and you gain 1 life."
    ], {
      triggers: [{ kind: 'triggered', trigger: { when: 'dies', subject: { kind: 'permanent', selector: allOf(ofType('Artifact'), not(IS_TOKEN), YOURS) } }, targets: [{ kind: 'player' }], effects: [{ op: 'loseLife', amount: constant(1) }, { op: 'gainLife', amount: constant(1) }], description: 'An artifact leaves — target opponent loses 1 and you gain 1' }],
    });

  unimplemented("c23e5b80-08d2-4e24-9908-fe2aa4f30f6f", "Reliquary Tower", [
          "You have no maximum hand size."
    ]);

  unimplemented("b410f294-cbb6-4016-981f-808fd9b7bbae", "Resurrection Orb", [
          "Whenever equipped creature dies, return that card to the battlefield under its owner's control at the beginning of the next end step."
    ]);

  unimplemented("0192ba05-6144-4fec-a803-462ecdf64195", "Royal Warden", [
          "Phalanx Commander — When this creature enters, create two tapped 2/2 black Necron Warrior artifact creature tokens."
    ]);

  unimplemented("7388a797-d40d-4783-a281-d17bc159b856", "Sautekh Immortal", [
          "Elite Troops — ~ enters with a +1/+1 counter on it for each creature that died this turn."
    ]);

  unimplemented("ce08aff3-efe6-4186-9557-274e00a7ca38", "Sceptre of Eternal Glory", [
          "{T}: Add three mana of any one color. Activate only if you control three or more lands with the same name."
    ]);

  unimplemented("6c85271c-c711-49b0-a72e-9e576c33714d", "Sculpting Steel", [
          "You may have this artifact enter as a copy of any artifact on the battlefield."
    ]);

  unimplemented("eedd5a17-d0fe-4a13-8f2c-f343bfa43f92", "Shard of the Nightbringer", [
          "Drain Life — When this creature enters, if you cast it, target opponent loses half their life, rounded up. You gain life equal to the life lost this way."
    ]);

  unimplemented("d04d2434-121e-4420-abfc-fa21ad5577c3", "Shard of the Void Dragon", [
          "Spear of the Void Dragon — Whenever this creature attacks, each opponent sacrifices a nonland permanent of their choice.",
          "Matter Absorption — Whenever an artifact is put into a graveyard from the battlefield or is put into exile from the battlefield, put two +1/+1 counters on this creature."
    ]);

  unimplemented("f96fcb37-5f17-4231-b1a2-64f5fe45730b", "Skorpekh Destroyer", [
          "Hyperphase Threshers — Whenever an artifact you control enters, this creature gains first strike until end of turn."
    ]);

  unimplemented("3f97541e-34f3-4f7f-8ac2-7167b2ec9b33", "Technomancer", [
          "When this creature enters, mill three cards, then return any number of artifact creature cards with total mana value 6 or less from your graveyard to the battlefield."
    ]);

  unimplemented("5924cbb0-19b5-449c-a7c5-722e744a54f8", "The War in Heaven", [
          "unsupported layout \"saga\"",
          "I — You draw three cards and you lose 3 life.",
          "II — Mill three cards.",
          "III — Choose up to three target creature cards with total mana value 8 or less in your graveyard. Return each of them to the battlefield with a necrodermis counter on it. They're artifacts in addition to their other types."
    ]);

  unimplemented("97f9aa5e-e34d-4029-9213-b32ebaf9859c", "Their Name Is Death", [
          "Destroy all nonartifact creatures."
    ]);

  unimplemented("8cd45064-2ad9-4247-902e-aefaf3bc1a43", "Their Number Is Legion", [
          "Create X tapped 2/2 black Necron Warrior artifact creature tokens, then you gain life equal to the number of artifacts you control. Exile ~.",
          "You may cast this card from your graveyard."
    ]);

  unimplemented("9965d9c5-2ebf-4a6c-930e-55c5890979be", "Thought Vessel", [
          "You have no maximum hand size."
    ]);

  unimplemented("c857de66-f4e0-4e97-ad01-fac623af8225", "Tomb Blade", [
          "Whenever this creature deals combat damage to a player, that player loses life equal to the number of creatures they control unless they sacrifice a creature of their choice."
    ]);

  unimplemented("986f510c-e2ec-423e-a443-51a169939558", "Tomb Fortress", [
          "{2}{B}{B}{B}, {T}, Exile this land: Mill four cards, then return a creature card from your graveyard to the battlefield. Activate only as a sorcery."
    ]);

  defineCard("1ef3b48a-55ef-422e-ac7f-e1c1057eec2c", "Trazyn the Infinite", [
          "Prismatic Gallery — As long as ~ is on the battlefield, it has all activated abilities of all artifact cards in your graveyard."
    ], {
      activatedAbilities: [{ costs: [], timing: 'any', ability: { kind: 'activated', targets: [], effects: [{ op: 'noOp' }], description: 'Use an activated ability from an artifact card in your graveyard' } }],
    });

  unimplemented("52aa5a79-db0e-4eaa-b2df-e41674c47794", "Triarch Praetorian", [
          "Dynastic Codes — When this creature enters from a graveyard, you draw two cards and you lose 2 life."
    ]);

  unimplemented("1b3ae9c3-1940-4fb8-a47c-2d9e1790f4a3", "Triarch Stalker", [
          "Targeting Relay — At the beginning of combat on your turn, choose an opponent.",
          "Creatures attacking the last chosen player have menace."
    ]);

}

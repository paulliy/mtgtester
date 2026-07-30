/**
 * Authored card overrides for silverquill-influence.txt.
 */

import { registerOverride } from './index';
import { ofSubtype } from '../selector';
import { parseManaCost } from '../../mana/cost';

const FLICKERING_WARD_DEF = {
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
    affects: { kind: 'attachedToSource' as const },
    op: { layer: 6 as const, addProtectionFromChosenColor: true as const },
  }],
  activatedAbilities: [{
    costs: [{ kind: 'mana' as const, cost: parseManaCost('{W}').cost! }],
    timing: 'any' as const,
    ability: {
      kind: 'activated' as const,
      targets: [],
      effects: [{ op: 'returnToHand' as const, target: 'source' as const }],
      description: "Return this Aura to its owner's hand",
    },
  }],
};

export function registerSILVERQUILL_INFLUENCEOverrides(): void {
  registerOverride({
    oracleId: "9c54bd34-667d-415c-ad26-82e0eb0ff409",
    name: "Killian, Decisive Mentor",
    handledLines: [
          "Whenever an enchantment you control enters, tap up to one target creature and goad it.",
          "Whenever one or more creatures that are enchanted by an Aura you control attack, draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-killian-decisive-mentor",
    name: "Killian, Decisive Mentor",
    handledLines: [
          "Whenever an enchantment you control enters, tap up to one target creature and goad it.",
          "Whenever one or more creatures that are enchanted by an Aura you control attack, draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "09b7ea91-2620-4c45-af3c-60bbeab89966",
    name: "Eiganjo Dynastorian // Replenish",
    handledLines: [
          "unsupported layout \"prepare\"",
          "Whenever you attack with two or more creatures, this creature becomes prepared."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-eiganjo-dynastorian-replenish",
    name: "Eiganjo Dynastorian // Replenish",
    handledLines: [
          "unsupported layout \"prepare\"",
          "Whenever you attack with two or more creatures, this creature becomes prepared."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "6c948f71-5c86-450c-8828-df4d8deaf1dd",
    name: "Intermediate Chirography",
    handledLines: [
          "unsupported layout \"class\"",
          "When this Class enters, create a 2/1 white and black Inkling creature token with flying.",
          "{1}{B}: Level 2",
          "Whenever you lose life for the first time each turn, put a +1/+1 counter on target creature you control.",
          "{2}{B}: Level 3",
          "At the beginning of each end step, if a modified creature died under your control this turn, create a 2/1 white and black Inkling creature token with flying."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-intermediate-chirography",
    name: "Intermediate Chirography",
    handledLines: [
          "unsupported layout \"class\"",
          "When this Class enters, create a 2/1 white and black Inkling creature token with flying.",
          "{1}{B}: Level 2",
          "Whenever you lose life for the first time each turn, put a +1/+1 counter on target creature you control.",
          "{2}{B}: Level 3",
          "At the beginning of each end step, if a modified creature died under your control this turn, create a 2/1 white and black Inkling creature token with flying."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "64c986f0-e786-419c-9b51-8c316c8fae0e",
    name: "Scriv, the Obligator",
    handledLines: [
          "Whenever ~ enters or attacks, create a white Aura enchantment token named Contract attached to target creature an opponent controls. The token has enchant creature and \"Whenever enchanted creature attacks, it gets +2/+0 until end of turn if it's attacking one of your opponents. Otherwise, its controller loses 2 life.\""
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-scriv-the-obligator",
    name: "Scriv, the Obligator",
    handledLines: [
          "Whenever ~ enters or attacks, create a white Aura enchantment token named Contract attached to target creature an opponent controls. The token has enchant creature and \"Whenever enchanted creature attacks, it gets +2/+0 until end of turn if it's attacking one of your opponents. Otherwise, its controller loses 2 life.\""
    ],
    def: {},
  });

  registerOverride({
    oracleId: "6a9cc11b-a223-46f0-bf58-c1e08ad1253d",
    name: "Forum Filibuster",
    handledLines: [
          "At the beginning of your upkeep, create a 2/1 white and black Inkling creature token with flying. When you do, return up to one target Aura or Equipment card from your graveyard to the battlefield attached to that token."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-forum-filibuster",
    name: "Forum Filibuster",
    handledLines: [
          "At the beginning of your upkeep, create a 2/1 white and black Inkling creature token with flying. When you do, return up to one target Aura or Equipment card from your graveyard to the battlefield attached to that token."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "dbb8a3d9-6b1b-4ad1-b8b9-f92ead03d1d9",
    name: "Coercive Impetus",
    handledLines: [
          "Enchanted creature gets +1/+1 and is goaded.",
          "Whenever enchanted creature attacks, you draw a card and lose 1 life."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-coercive-impetus",
    name: "Coercive Impetus",
    handledLines: [
          "Enchanted creature gets +1/+1 and is goaded.",
          "Whenever enchanted creature attacks, you draw a card and lose 1 life."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "cdfa9de4-7d7d-4638-8ac4-793ece6372dd",
    name: "Changing Loyalty",
    handledLines: [
          "Replicate {2}",
          "When enchanted creature dies, return it to the battlefield under your control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-changing-loyalty",
    name: "Changing Loyalty",
    handledLines: [
          "Replicate {2}",
          "When enchanted creature dies, return it to the battlefield under your control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "27c366cf-00d7-47d4-9577-736bfc4a3b81",
    name: "Defacing Duskmage // Vandal's Edit",
    handledLines: [
          "unsupported layout \"prepare\"",
          "Whenever an opponent draws their second card each turn, this creature becomes prepared."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-defacing-duskmage-vandal-s-edit",
    name: "Defacing Duskmage // Vandal's Edit",
    handledLines: [
          "unsupported layout \"prepare\"",
          "Whenever an opponent draws their second card each turn, this creature becomes prepared."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "6c25c6b5-d98c-4eb4-aacd-b6960a8779a9",
    name: "Herald of Amity",
    handledLines: [
          "When this creature enters, exile the top eight cards of your library. You may cast an Aura spell from among them without paying its mana cost. Then put the rest on the bottom of your library in a random order.",
          "Whenever this creature attacks, it gets +X/+X until end of turn, where X is the number of Auras you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-herald-of-amity",
    name: "Herald of Amity",
    handledLines: [
          "When this creature enters, exile the top eight cards of your library. You may cast an Aura spell from among them without paying its mana cost. Then put the rest on the bottom of your library in a random order.",
          "Whenever this creature attacks, it gets +X/+X until end of turn, where X is the number of Auras you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c22e5fc6-9b4e-4197-b472-70d168eb4330",
    name: "Redemption Arc",
    handledLines: [
          "Enchanted creature has indestructible and is goaded.",
          "{1}{W}: Exile enchanted creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-redemption-arc",
    name: "Redemption Arc",
    handledLines: [
          "Enchanted creature has indestructible and is goaded.",
          "{1}{W}: Exile enchanted creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "276eccd6-4a76-46e8-b604-94472e618115",
    name: "Ghoulish Impetus",
    handledLines: [
          "Enchanted creature gets +1/+1, has deathtouch, and is goaded.",
          "When enchanted creature dies, return this card to the battlefield at the beginning of the next end step."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-ghoulish-impetus",
    name: "Ghoulish Impetus",
    handledLines: [
          "Enchanted creature gets +1/+1, has deathtouch, and is goaded.",
          "When enchanted creature dies, return this card to the battlefield at the beginning of the next end step."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "a3b3b9ae-1e48-481d-80a5-7e2a26cf2f50",
    name: "Screams from Within",
    handledLines: [
          "When enchanted creature dies, return this card from your graveyard to the battlefield."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-screams-from-within",
    name: "Screams from Within",
    handledLines: [
          "When enchanted creature dies, return this card from your graveyard to the battlefield."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ad3bf726-e0c2-4038-a66e-9a9dff439563",
    name: "Raffine's Guidance",
    handledLines: [
          "You may cast this card from your graveyard by paying {2}{W} rather than paying its mana cost."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-raffine-s-guidance",
    name: "Raffine's Guidance",
    handledLines: [
          "You may cast this card from your graveyard by paying {2}{W} rather than paying its mana cost."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "bd92cacd-c7d8-43a2-a261-ea4754fefdc5",
    name: "Sage's Reverie",
    handledLines: [
          "When this Aura enters, draw a card for each Aura you control that's attached to a creature.",
          "Enchanted creature gets +1/+1 for each Aura you control that's attached to a creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-sage-s-reverie",
    name: "Sage's Reverie",
    handledLines: [
          "When this Aura enters, draw a card for each Aura you control that's attached to a creature.",
          "Enchanted creature gets +1/+1 for each Aura you control that's attached to a creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "0a7d6489-b239-4ce8-aea3-7b5d0e436f70",
    name: "Sentinel's Eyes",
    handledLines: [
          "Escape—{W}, Exile two other cards from your graveyard."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-sentinel-s-eyes",
    name: "Sentinel's Eyes",
    handledLines: [
          "Escape—{W}, Exile two other cards from your graveyard."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ff3de07d-86c3-49e1-9de0-97c85301ff93",
    name: "Parasitic Impetus",
    handledLines: [
          "Enchanted creature gets +2/+2 and is goaded.",
          "Whenever enchanted creature attacks, its controller loses 2 life and you gain 2 life."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-parasitic-impetus",
    name: "Parasitic Impetus",
    handledLines: [
          "Enchanted creature gets +2/+2 and is goaded.",
          "Whenever enchanted creature attacks, its controller loses 2 life and you gain 2 life."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "da93264e-4e04-401a-9809-e4e1056cf604",
    name: "Inkshield",
    handledLines: [
          "Prevent all combat damage that would be dealt to you this turn. For each 1 damage prevented this way, create a 2/1 white and black Inkling creature token with flying."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-inkshield",
    name: "Inkshield",
    handledLines: [
          "Prevent all combat damage that would be dealt to you this turn. For each 1 damage prevented this way, create a 2/1 white and black Inkling creature token with flying."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ee7ebbc1-2f9e-4867-a522-424869b6d772",
    name: "Combat Calligrapher",
    handledLines: [
          "Inklings can't attack you or planeswalkers you control.",
          "Whenever a player attacks one of your opponents, that attacking player creates a tapped 2/1 white and black Inkling creature token with flying that's attacking that opponent."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-combat-calligrapher",
    name: "Combat Calligrapher",
    handledLines: [
          "Inklings can't attack you or planeswalkers you control.",
          "Whenever a player attacks one of your opponents, that attacking player creates a tapped 2/1 white and black Inkling creature token with flying that's attacking that opponent."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "a3b39590-34b7-4fd0-877f-748e6df30e88",
    name: "Hateful Eidolon",
    handledLines: [
          "Whenever an enchanted creature dies, draw a card for each Aura you controlled that was attached to it."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-hateful-eidolon",
    name: "Hateful Eidolon",
    handledLines: [
          "Whenever an enchanted creature dies, draw a card for each Aura you controlled that was attached to it."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c0d8fef4-65f4-4769-982d-b397d2b7e977",
    name: "Animate Dead",
    handledLines: [
          "Enchant creature card in a graveyard",
          "When this Aura enters, if it's on the battlefield, it loses \"enchant creature card in a graveyard\" and gains \"enchant creature put onto the battlefield with this Aura.\" Return enchanted creature card to the battlefield under your control and attach this Aura to it. When this Aura leaves the battlefield, that creature's controller sacrifices it."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-animate-dead",
    name: "Animate Dead",
    handledLines: [
          "Enchant creature card in a graveyard",
          "When this Aura enters, if it's on the battlefield, it loses \"enchant creature card in a graveyard\" and gains \"enchant creature put onto the battlefield with this Aura.\" Return enchanted creature card to the battlefield under your control and attach this Aura to it. When this Aura leaves the battlefield, that creature's controller sacrifices it."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "349ea6c7-6b3e-417f-b082-b712e2b1635b",
    name: "Forum of Amity",
    handledLines: [
          "{2}{W}{B}, {T}: Surveil 1."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-forum-of-amity",
    name: "Forum of Amity",
    handledLines: [
          "{2}{W}{B}, {T}: Surveil 1."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "2143f413-7baa-4fd6-a7ca-32f52bfa553f",
    name: "Shadrix Silverquill",
    handledLines: [
          "At the beginning of combat on your turn, you may choose two. Each mode must target a different player.",
          "• Target player creates a 2/1 white and black Inkling creature token with flying.",
          "• Target player draws a card and loses 1 life.",
          "• Target player puts a +1/+1 counter on each creature they control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-shadrix-silverquill",
    name: "Shadrix Silverquill",
    handledLines: [
          "At the beginning of combat on your turn, you may choose two. Each mode must target a different player.",
          "• Target player creates a 2/1 white and black Inkling creature token with flying.",
          "• Target player draws a card and loses 1 life.",
          "• Target player puts a +1/+1 counter on each creature they control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "30ac68e6-160a-41f9-9f0f-0e0eef383150",
    name: "Arcane Lighthouse",
    handledLines: [
          "{1}, {T}: Until end of turn, creatures your opponents control lose hexproof and shroud and can't have hexproof or shroud."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-arcane-lighthouse",
    name: "Arcane Lighthouse",
    handledLines: [
          "{1}, {T}: Until end of turn, creatures your opponents control lose hexproof and shroud and can't have hexproof or shroud."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "b8602f19-6fc2-43c4-b0c4-2cd11d5dbda2",
    name: "Keen Duelist",
    handledLines: [
          "At the beginning of your upkeep, you and target opponent each reveal the top card of your library. You each lose life equal to the mana value of the card revealed by the other player. You each put the card you revealed into your hand."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-keen-duelist",
    name: "Keen Duelist",
    handledLines: [
          "At the beginning of your upkeep, you and target opponent each reveal the top card of your library. You each lose life equal to the mana value of the card revealed by the other player. You each put the card you revealed into your hand."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "c8decfdf-1421-4649-acde-5215e7f08bb9",
    name: "Martial Impetus",
    handledLines: [
          "Enchanted creature gets +1/+1 and is goaded.",
          "Whenever enchanted creature attacks, each other creature that's attacking one of your opponents gets +1/+1 until end of turn."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-martial-impetus",
    name: "Martial Impetus",
    handledLines: [
          "Enchanted creature gets +1/+1 and is goaded.",
          "Whenever enchanted creature attacks, each other creature that's attacking one of your opponents gets +1/+1 until end of turn."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "d13fc657-c6fc-4394-bc70-691050550226",
    name: "Sheltered by Ghosts",
    handledLines: [
          "When this Aura enters, exile target nonland permanent an opponent controls until this Aura leaves the battlefield.",
          "Enchanted creature gets +1/+0 and has lifelink and ward {2}."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-sheltered-by-ghosts",
    name: "Sheltered by Ghosts",
    handledLines: [
          "When this Aura enters, exile target nonland permanent an opponent controls until this Aura leaves the battlefield.",
          "Enchanted creature gets +1/+0 and has lifelink and ward {2}."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "4b8183e6-4ff2-4254-9ee0-0ebbf8cef4a3",
    name: "Fallen Ideal",
    handledLines: [
          "Enchanted creature has flying and \"Sacrifice a creature: ~ gets +2/+1 until end of turn.\"",
          "When this Aura is put into a graveyard from the battlefield, return it to its owner's hand."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-fallen-ideal",
    name: "Fallen Ideal",
    handledLines: [
          "Enchanted creature has flying and \"Sacrifice a creature: ~ gets +2/+1 until end of turn.\"",
          "When this Aura is put into a graveyard from the battlefield, return it to its owner's hand."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "2c11c72f-5b04-47d8-bdf8-8d9d197ebc1b",
    name: "Gift of Immortality",
    handledLines: [
          "When enchanted creature dies, return that card to the battlefield under its owner's control. Return this card to the battlefield attached to that creature at the beginning of the next end step."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-gift-of-immortality",
    name: "Gift of Immortality",
    handledLines: [
          "When enchanted creature dies, return that card to the battlefield under its owner's control. Return this card to the battlefield attached to that creature at the beginning of the next end step."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "79085dea-8daa-41c0-a975-61e3e6da2e26",
    name: "Shielded by Faith",
    handledLines: [
          "Whenever a creature enters, you may attach this Aura to that creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-shielded-by-faith",
    name: "Shielded by Faith",
    handledLines: [
          "Whenever a creature enters, you may attach this Aura to that creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "441b51b0-ecd0-466d-9ca8-e754eb563aec",
    name: "Eidolon of Countless Battles",
    handledLines: [
          "Bestow {2}{W}{W}",
          "~ and enchanted creature each get +1/+1 for each creature you control and +1/+1 for each Aura you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-eidolon-of-countless-battles",
    name: "Eidolon of Countless Battles",
    handledLines: [
          "Bestow {2}{W}{W}",
          "~ and enchanted creature each get +1/+1 for each creature you control and +1/+1 for each Aura you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e828b189-0e8f-43b8-b909-4c23e742e028",
    name: "Ghostly Prison",
    handledLines: [
          "Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-ghostly-prison",
    name: "Ghostly Prison",
    handledLines: [
          "Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "d2d9ecea-7925-420e-98b9-2f87f41f387c",
    name: "Land Tax",
    handledLines: [
          "At the beginning of your upkeep, if an opponent controls more lands than you, you may search your library for up to three basic land cards, reveal them, put them into your hand, then shuffle."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-land-tax",
    name: "Land Tax",
    handledLines: [
          "At the beginning of your upkeep, if an opponent controls more lands than you, you may search your library for up to three basic land cards, reveal them, put them into your hand, then shuffle."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "f08f7814-4585-41dd-b82e-ed2ef5e24242",
    name: "Transcendent Envoy",
    handledLines: [
          "Aura spells you cast cost {1} less to cast."
    ],
    def: { ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 1 }, filter: ofSubtype('Aura') }] },
  });
  registerOverride({
    oracleId: "oracle-transcendent-envoy",
    name: "Transcendent Envoy",
    handledLines: [
          "Aura spells you cast cost {1} less to cast."
    ],
    def: { ruleStatics: [{ kind: 'costReduction', amount: { kind: 'const', n: 1 }, filter: ofSubtype('Aura') }] },
  });

  registerOverride({
    oracleId: "f43f5855-f297-4433-984b-18263b734cfc",
    name: "Eriette of the Charmed Apple",
    handledLines: [
          "Each creature that's enchanted by an Aura you control can't attack you or planeswalkers you control.",
          "At the beginning of your end step, each opponent loses X life and you gain X life, where X is the number of Auras you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-eriette-of-the-charmed-apple",
    name: "Eriette of the Charmed Apple",
    handledLines: [
          "Each creature that's enchanted by an Aura you control can't attack you or planeswalkers you control.",
          "At the beginning of your end step, each opponent loses X life and you gain X life, where X is the number of Auras you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e233cb5b-7237-4271-8157-9179cc897b6c",
    name: "Killian, Ink Duelist",
    handledLines: [
          "Spells you cast that target a creature cost {2} less to cast."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-killian-ink-duelist",
    name: "Killian, Ink Duelist",
    handledLines: [
          "Spells you cast that target a creature cost {2} less to cast."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "3e2ae59a-40a1-46ca-8f24-3231ebd4e4eb",
    name: "Flickering Ward",
    handledLines: [
          "As this Aura enters, choose a color.",
          "Enchanted creature has protection from the chosen color. This effect doesn't remove this Aura.",
          "{W}: Return this Aura to its owner's hand."
    ],
    def: FLICKERING_WARD_DEF,
  });
  registerOverride({
    oracleId: "oracle-flickering-ward",
    name: "Flickering Ward",
    handledLines: [
          "As this Aura enters, choose a color.",
          "Enchanted creature has protection from the chosen color. This effect doesn't remove this Aura.",
          "{W}: Return this Aura to its owner's hand."
    ],
    def: FLICKERING_WARD_DEF,
  });

  registerOverride({
    oracleId: "2ef0961a-0543-4371-8c2a-333881b735e5",
    name: "Tomik, Wielder of Law",
    handledLines: [
          "Affinity for planeswalkers",
          "Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, that opponent loses 3 life and you draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-tomik-wielder-of-law",
    name: "Tomik, Wielder of Law",
    handledLines: [
          "Affinity for planeswalkers",
          "Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, that opponent loses 3 life and you draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9bdc1e63-1cf9-4ddb-a7d5-f2a2eb91bdfd",
    name: "Pearl-Ear, Imperial Advisor",
    handledLines: [
          "Enchantment spells you cast have affinity for Auras.",
          "Whenever you cast an Aura spell that targets a modified permanent you control, draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-pearl-ear-imperial-advisor",
    name: "Pearl-Ear, Imperial Advisor",
    handledLines: [
          "Enchantment spells you cast have affinity for Auras.",
          "Whenever you cast an Aura spell that targets a modified permanent you control, draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "9c77eb0a-543a-41db-ba1f-aa0163837ae0",
    name: "Ajani's Chosen",
    handledLines: [
          "Whenever an enchantment you control enters, create a 2/2 white Cat creature token. If that enchantment is an Aura, you may attach it to the token."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-ajani-s-chosen",
    name: "Ajani's Chosen",
    handledLines: [
          "Whenever an enchantment you control enters, create a 2/2 white Cat creature token. If that enchantment is an Aura, you may attach it to the token."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "b4dbbf56-d7df-4183-bb48-cfc6b4d0468f",
    name: "Armored Skyhunter",
    handledLines: [
          "Whenever this creature attacks, look at the top six cards of your library. You may put an Aura or Equipment card from among them onto the battlefield. If an Equipment is put onto the battlefield this way, you may attach it to a creature you control. Put the rest of those cards on the bottom of your library in a random order."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-armored-skyhunter",
    name: "Armored Skyhunter",
    handledLines: [
          "Whenever this creature attacks, look at the top six cards of your library. You may put an Aura or Equipment card from among them onto the battlefield. If an Equipment is put onto the battlefield this way, you may attach it to a creature you control. Put the rest of those cards on the bottom of your library in a random order."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "05a4f8ff-49da-42af-add5-6248c4b0644b",
    name: "Darksteel Mutation",
    handledLines: [
          "Enchanted creature is an Insect artifact creature with base power and toughness 0/1 and has indestructible, and it loses all other abilities, card types, and creature types."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-darksteel-mutation",
    name: "Darksteel Mutation",
    handledLines: [
          "Enchanted creature is an Insect artifact creature with base power and toughness 0/1 and has indestructible, and it loses all other abilities, card types, and creature types."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "2bfc7467-1316-43d3-9ca6-ff36cc2de607",
    name: "Kor Spiritdancer",
    handledLines: [
          "~ gets +2/+2 for each Aura attached to it.",
          "Whenever you cast an Aura spell, you may draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-kor-spiritdancer",
    name: "Kor Spiritdancer",
    handledLines: [
          "~ gets +2/+2 for each Aura attached to it.",
          "Whenever you cast an Aura spell, you may draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "5acff7a3-bc84-4251-bd37-80231396ac38",
    name: "Chains of Custody",
    handledLines: [
          "When this Aura enters, exile target nonland permanent an opponent controls until this Aura leaves the battlefield."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-chains-of-custody",
    name: "Chains of Custody",
    handledLines: [
          "When this Aura enters, exile target nonland permanent an opponent controls until this Aura leaves the battlefield."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "cbcb6d9a-6ae5-4bcd-8013-2b657553764a",
    name: "Mangara, the Diplomat",
    handledLines: [
          "Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, draw a card.",
          "Whenever an opponent casts their second spell each turn, draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-mangara-the-diplomat",
    name: "Mangara, the Diplomat",
    handledLines: [
          "Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, draw a card.",
          "Whenever an opponent casts their second spell each turn, draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ac675899-25bb-4f06-9c8c-bf188024495f",
    name: "Firemane Commando",
    handledLines: [
          "Whenever you attack with two or more creatures, draw a card.",
          "Whenever another player attacks with two or more creatures, they draw a card if none of those creatures attacked you."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-firemane-commando",
    name: "Firemane Commando",
    handledLines: [
          "Whenever you attack with two or more creatures, draw a card.",
          "Whenever another player attacks with two or more creatures, they draw a card if none of those creatures attacked you."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "0c85b8f7-0bd0-4680-9ec5-d4b110460a54",
    name: "Fabled Passage",
    handledLines: [
          "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. Then if you control four or more lands, untap that land."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-fabled-passage",
    name: "Fabled Passage",
    handledLines: [
          "{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. Then if you control four or more lands, untap that land."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "2598294c-a9a7-4bef-a562-23f297a80536",
    name: "Songbirds' Blessing",
    handledLines: [
          "Whenever enchanted creature attacks, reveal cards from the top of your library until you reveal an Aura card. You may put that card onto the battlefield. If you don't, put it into your hand. Put the rest on the bottom of your library in a random order."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-songbirds-blessing",
    name: "Songbirds' Blessing",
    handledLines: [
          "Whenever enchanted creature attacks, reveal cards from the top of your library until you reveal an Aura card. You may put that card onto the battlefield. If you don't, put it into your hand. Put the rest on the bottom of your library in a random order."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "81a51328-b995-4f3b-90bc-a20ae21dd254",
    name: "Spirit Mantle",
    handledLines: [
          "Enchanted creature gets +1/+1 and has protection from creatures."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-spirit-mantle",
    name: "Spirit Mantle",
    handledLines: [
          "Enchanted creature gets +1/+1 and has protection from creatures."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "e1d294e8-67b1-4a4a-86b8-f98f28a327d9",
    name: "Promise of Loyalty",
    handledLines: [
          "Each player puts a vow counter on a creature they control and sacrifices the rest. Each of those creatures can't attack you or planeswalkers you control for as long as it has a vow counter on it."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-promise-of-loyalty",
    name: "Promise of Loyalty",
    handledLines: [
          "Each player puts a vow counter on a creature they control and sacrifices the rest. Each of those creatures can't attack you or planeswalkers you control for as long as it has a vow counter on it."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ff6b52b7-ae3c-465b-b10e-901160e5230e",
    name: "Nils, Discipline Enforcer",
    handledLines: [
          "At the beginning of your end step, for each player, put a +1/+1 counter on up to one target creature that player controls.",
          "Each creature with one or more counters on it can't attack you or planeswalkers you control unless its controller pays {X}, where X is the number of counters on that creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-nils-discipline-enforcer",
    name: "Nils, Discipline Enforcer",
    handledLines: [
          "At the beginning of your end step, for each player, put a +1/+1 counter on up to one target creature that player controls.",
          "Each creature with one or more counters on it can't attack you or planeswalkers you control unless its controller pays {X}, where X is the number of counters on that creature."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "7e00b0cd-d212-4604-ba07-da21f4fe00b0",
    name: "Sram, Senior Edificer",
    handledLines: [
          "Whenever you cast an Aura, Equipment, or Vehicle spell, draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-sram-senior-edificer",
    name: "Sram, Senior Edificer",
    handledLines: [
          "Whenever you cast an Aura, Equipment, or Vehicle spell, draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "3635e4e5-e655-45f4-a444-39756f55129a",
    name: "Eldrazi Conscription",
    handledLines: [
          "unsupported card type \"Kindred\"",
          "Enchanted creature gets +10/+10 and has trample and annihilator 2."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-eldrazi-conscription",
    name: "Eldrazi Conscription",
    handledLines: [
          "unsupported card type \"Kindred\"",
          "Enchanted creature gets +10/+10 and has trample and annihilator 2."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "ad09b3c3-c8e7-481c-8c45-e7f234935117",
    name: "Anguished Unmaking",
    handledLines: [
          "Exile target nonland permanent. You lose 3 life."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [{ kind: 'nonlandPermanent' }], effects: [{ op: 'exile', target: 0 }, { op: 'loseLife', amount: { kind: 'const', n: 3 } }], description: 'Exile target nonland permanent; lose three life' },
    },
  });
  registerOverride({
    oracleId: "oracle-anguished-unmaking",
    name: "Anguished Unmaking",
    handledLines: [
          "Exile target nonland permanent. You lose 3 life."
    ],
    def: {
      spellAbility: { kind: 'spell', targets: [{ kind: 'nonlandPermanent' }], effects: [{ op: 'exile', target: 0 }, { op: 'loseLife', amount: { kind: 'const', n: 3 } }], description: 'Exile target nonland permanent; lose three life' },
    },
  });

  registerOverride({
    oracleId: "34b90d3e-f48c-41ff-b3e4-5cab7a9cd597",
    name: "Secret Rendezvous",
    handledLines: [
          "You and target opponent each draw three cards."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-secret-rendezvous",
    name: "Secret Rendezvous",
    handledLines: [
          "You and target opponent each draw three cards."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "42bf259d-4bb9-49c3-b4ec-223dca62f4d6",
    name: "Fetid Heath",
    handledLines: [
          "{W/B}, {T}: Add {W}{W}, {W}{B}, or {B}{B}."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-fetid-heath",
    name: "Fetid Heath",
    handledLines: [
          "{W/B}, {T}: Add {W}{W}, {W}{B}, or {B}{B}."
    ],
    def: {},
  });


  registerOverride({
    oracleId: "04b7362d-0490-4cb0-b5d7-2a7732f659ce",
    name: "Bojuka Bog",
    handledLines: [
          "When this land enters, exile target player's graveyard."
    ],
    def: { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [{ kind: 'player' }], effects: [{ op: 'exileTargetPlayerGraveyard', target: 0 }], description: 'Enters � exile target player�s graveyard' }] },
  });
  registerOverride({
    oracleId: "oracle-bojuka-bog",
    name: "Bojuka Bog",
    handledLines: [
          "When this land enters, exile target player's graveyard."
    ],
    def: { triggers: [{ kind: 'triggered', trigger: { when: 'enters', subject: { kind: 'self' } }, targets: [{ kind: 'player' }], effects: [{ op: 'exileTargetPlayerGraveyard', target: 0 }], description: 'Enters � exile target player�s graveyard' }] },
  });

  registerOverride({
    oracleId: "c9fc13d6-bd10-47bc-b2b6-7f67a1f3371e",
    name: "Shineshadow Snarl",
    handledLines: [
          "As this land enters, you may reveal a Plains or Swamp card from your hand. If you don't, this land enters tapped."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-shineshadow-snarl",
    name: "Shineshadow Snarl",
    handledLines: [
          "As this land enters, you may reveal a Plains or Swamp card from your hand. If you don't, this land enters tapped."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "8ba36878-0816-44c7-b543-8ebfc28c2ecd",
    name: "Angelic Destiny",
    handledLines: [
          "Enchanted creature gets +4/+4, has flying and first strike, and is an Angel in addition to its other types.",
          "When enchanted creature dies, return this card to its owner's hand."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-angelic-destiny",
    name: "Angelic Destiny",
    handledLines: [
          "Enchanted creature gets +4/+4, has flying and first strike, and is an Angel in addition to its other types.",
          "When enchanted creature dies, return this card to its owner's hand."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "d11e627b-8a48-411d-a261-2c9a02a758ba",
    name: "Breena, the Demagogue",
    handledLines: [
          "Whenever a player attacks one of your opponents, if that opponent has more life than another of your opponents, that attacking player draws a card and you put two +1/+1 counters on a creature you control."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-breena-the-demagogue",
    name: "Breena, the Demagogue",
    handledLines: [
          "Whenever a player attacks one of your opponents, if that opponent has more life than another of your opponents, that attacking player draws a card and you put two +1/+1 counters on a creature you control."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "3edf9201-265f-4cd9-b27b-8073bf1a4cf2",
    name: "Desolate Mire",
    handledLines: [
          "{1}, {T}: Add {W}{B}."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-desolate-mire",
    name: "Desolate Mire",
    handledLines: [
          "{1}, {T}: Add {W}{B}."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "eb735501-19e7-4910-aa6a-6667fff6f4e5",
    name: "Study Hall",
    handledLines: [
          "{1}, {T}: Add one mana of any color. When you spend this mana to cast your commander, scry X, where X is the number of times it's been cast from the command zone this game."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-study-hall",
    name: "Study Hall",
    handledLines: [
          "{1}, {T}: Add one mana of any color. When you spend this mana to cast your commander, scry X, where X is the number of times it's been cast from the command zone this game."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "71c52bf5-2a5d-488e-8b15-7ef290e4b77d",
    name: "War Room",
    handledLines: [
          "{3}, {T}, Pay life equal to the number of colors in your commanders' color identity: Draw a card."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-war-room",
    name: "War Room",
    handledLines: [
          "{3}, {T}, Pay life equal to the number of colors in your commanders' color identity: Draw a card."
    ],
    def: {},
  });

  registerOverride({
    oracleId: "2975590d-6a5b-41e5-8a3b-e9325e71226a",
    name: "Starfield Mystic",
    handledLines: [
          "Enchantment spells you cast cost {1} less to cast.",
          "Whenever an enchantment you control is put into a graveyard from the battlefield, put a +1/+1 counter on this creature."
    ],
    def: {},
  });
  registerOverride({
    oracleId: "oracle-starfield-mystic",
    name: "Starfield Mystic",
    handledLines: [
          "Enchantment spells you cast cost {1} less to cast.",
          "Whenever an enchantment you control is put into a graveyard from the battlefield, put a +1/+1 counter on this creature."
    ],
    def: {},
  });

}

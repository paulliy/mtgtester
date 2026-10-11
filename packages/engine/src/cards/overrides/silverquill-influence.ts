/**
 * Authored card overrides for silverquill-influence.txt.
 */

import { constant } from '../value';
import { ATTACHED, mana } from '../templates';
import { defineCard, unimplemented } from './index';
import { ofSubtype } from '../selector';

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
  staticEffects: [
    {
      affects: ATTACHED,
      op: { layer: 6 as const, addProtectionFromChosenColor: true as const },
    },
  ],
  activatedAbilities: [
    {
      costs: [mana('{W}')],
      timing: 'any' as const,
      ability: {
        kind: 'activated' as const,
        targets: [],
        effects: [{ op: 'returnToHand' as const, target: 'source' as const }],
        description: "Return this Aura to its owner's hand",
      },
    },
  ],
};

export function registerSILVERQUILL_INFLUENCEOverrides(): void {
  // Killian, Decisive Mentor: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  unimplemented('09b7ea91-2620-4c45-af3c-60bbeab89966', 'Eiganjo Dynastorian // Replenish', [
    'unsupported layout "prepare"',
    'Whenever you attack with two or more creatures, this creature becomes prepared.',
  ]);

  unimplemented('6c948f71-5c86-450c-8828-df4d8deaf1dd', 'Intermediate Chirography', [
    'unsupported layout "class"',
    'When this Class enters, create a 2/1 white and black Inkling creature token with flying.',
    '{1}{B}: Level 2',
    'Whenever you lose life for the first time each turn, put a +1/+1 counter on target creature you control.',
    '{2}{B}: Level 3',
    'At the beginning of each end step, if a modified creature died under your control this turn, create a 2/1 white and black Inkling creature token with flying.',
  ]);

  unimplemented('64c986f0-e786-419c-9b51-8c316c8fae0e', 'Scriv, the Obligator', [
    'Whenever ~ enters or attacks, create a white Aura enchantment token named Contract attached to target creature an opponent controls. The token has enchant creature and "Whenever enchanted creature attacks, it gets +2/+0 until end of turn if it\'s attacking one of your opponents. Otherwise, its controller loses 2 life."',
  ]);

  // Forum Filibuster: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  unimplemented('27c366cf-00d7-47d4-9577-736bfc4a3b81', "Defacing Duskmage // Vandal's Edit", [
    'unsupported layout "prepare"',
    'Whenever an opponent draws their second card each turn, this creature becomes prepared.',
  ]);

  unimplemented('6c25c6b5-d98c-4eb4-aacd-b6960a8779a9', 'Herald of Amity', [
    'When this creature enters, exile the top eight cards of your library. You may cast an Aura spell from among them without paying its mana cost. Then put the rest on the bottom of your library in a random order.',
    'Whenever this creature attacks, it gets +X/+X until end of turn, where X is the number of Auras you control.',
  ]);

  // Redemption Arc: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  // Ghoulish Impetus: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  // Screams from Within: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  // Raffine's Guidance: restored in coverage PR02 (see silverquill-influence-remaining.ts).

  unimplemented('bd92cacd-c7d8-43a2-a261-ea4754fefdc5', "Sage's Reverie", [
    "When this Aura enters, draw a card for each Aura you control that's attached to a creature.",
    "Enchanted creature gets +1/+1 for each Aura you control that's attached to a creature.",
  ]);

  unimplemented('ff3de07d-86c3-49e1-9de0-97c85301ff93', 'Parasitic Impetus', [
    'Whenever enchanted creature attacks, its controller loses 2 life and you gain 2 life.',
  ]);

  unimplemented('da93264e-4e04-401a-9809-e4e1056cf604', 'Inkshield', [
    'Prevent all combat damage that would be dealt to you this turn. For each 1 damage prevented this way, create a 2/1 white and black Inkling creature token with flying.',
  ]);

  unimplemented('ee7ebbc1-2f9e-4867-a522-424869b6d772', 'Combat Calligrapher', [
    "Inklings can't attack you or planeswalkers you control.",
    "Whenever a player attacks one of your opponents, that attacking player creates a tapped 2/1 white and black Inkling creature token with flying that's attacking that opponent.",
  ]);

  // Hateful Eidolon: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  unimplemented('c0d8fef4-65f4-4769-982d-b397d2b7e977', 'Animate Dead', [
    'Enchant creature card in a graveyard',
    'When this Aura enters, if it\'s on the battlefield, it loses "enchant creature card in a graveyard" and gains "enchant creature put onto the battlefield with this Aura." Return enchanted creature card to the battlefield under your control and attach this Aura to it. When this Aura leaves the battlefield, that creature\'s controller sacrifices it.',
  ]);

  // Forum of Amity: restored in coverage PR01. The interpreter now models enters-tapped, the
  // {W}/{B} mana ability, and the surveil activation faithfully, so no override is registered.

  unimplemented('2143f413-7baa-4fd6-a7ca-32f52bfa553f', 'Shadrix Silverquill', [
    'At the beginning of combat on your turn, you may choose two. Each mode must target a different player.',
    '• Target player creates a 2/1 white and black Inkling creature token with flying.',
    '• Target player draws a card and loses 1 life.',
    '• Target player puts a +1/+1 counter on each creature they control.',
  ]);

  unimplemented('30ac68e6-160a-41f9-9f0f-0e0eef383150', 'Arcane Lighthouse', [
    "{1}, {T}: Until end of turn, creatures your opponents control lose hexproof and shroud and can't have hexproof or shroud.",
  ]);

  unimplemented('b8602f19-6fc2-43c4-b0c4-2cd11d5dbda2', 'Keen Duelist', [
    'At the beginning of your upkeep, you and target opponent each reveal the top card of your library. You each lose life equal to the mana value of the card revealed by the other player. You each put the card you revealed into your hand.',
  ]);

  // Martial Impetus: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  // Sheltered by Ghosts: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  // Fallen Ideal: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  // Gift of Immortality: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  // Shielded by Faith: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  // Eidolon of Countless Battles: restored in coverage PR05 (see
  // silverquill-influence-remaining.ts).

  // Now handled generically as `attackTax` (`parseRuleStaticLine` in interpret.ts) — see
  // queen-marchesa-queens-gambit-remaining.ts, whose non-empty override for the same oracleId
  // this stub used to be shadowed by (last-write-wins, and that file registers after this one).

  unimplemented('d2d9ecea-7925-420e-98b9-2f87f41f387c', 'Land Tax', [
    'At the beginning of your upkeep, if an opponent controls more lands than you, you may search your library for up to three basic land cards, reveal them, put them into your hand, then shuffle.',
  ]);

  defineCard('f08f7814-4585-41dd-b82e-ed2ef5e24242', 'Transcendent Envoy', [], {
    ruleStatics: [{ kind: 'costReduction', amount: constant(1), filter: ofSubtype('Aura') }],
  });

  unimplemented('f43f5855-f297-4433-984b-18263b734cfc', 'Eriette of the Charmed Apple', [
    "Each creature that's enchanted by an Aura you control can't attack you or planeswalkers you control.",
    'At the beginning of your end step, each opponent loses X life and you gain X life, where X is the number of Auras you control.',
  ]);

  // Killian, Ink Duelist: restored in coverage PR02 (see silverquill-influence-remaining.ts).

  defineCard(
    '3e2ae59a-40a1-46ca-8f24-3231ebd4e4eb',
    'Flickering Ward',
    [
      'As this Aura enters, choose a color.',
      "Enchanted creature has protection from the chosen color. This effect doesn't remove this Aura.",
      "{W}: Return this Aura to its owner's hand.",
    ],
    FLICKERING_WARD_DEF,
  );

  unimplemented('2ef0961a-0543-4371-8c2a-333881b735e5', 'Tomik, Wielder of Law', [
    'Affinity for planeswalkers',
    'Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, that opponent loses 3 life and you draw a card.',
  ]);

  unimplemented('9bdc1e63-1cf9-4ddb-a7d5-f2a2eb91bdfd', 'Pearl-Ear, Imperial Advisor', [
    'Enchantment spells you cast have affinity for Auras.',
    'Whenever you cast an Aura spell that targets a modified permanent you control, draw a card.',
  ]);

  // Ajani's Chosen: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  unimplemented('b4dbbf56-d7df-4183-bb48-cfc6b4d0468f', 'Armored Skyhunter', [
    'Whenever this creature attacks, look at the top six cards of your library. You may put an Aura or Equipment card from among them onto the battlefield. If an Equipment is put onto the battlefield this way, you may attach it to a creature you control. Put the rest of those cards on the bottom of your library in a random order.',
  ]);

  unimplemented('05a4f8ff-49da-42af-add5-6248c4b0644b', 'Darksteel Mutation', [
    'Enchanted creature is an Insect artifact creature with base power and toughness 0/1 and has indestructible, and it loses all other abilities, card types, and creature types.',
  ]);

  // Kor Spiritdancer: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  unimplemented('5acff7a3-bc84-4251-bd37-80231396ac38', 'Chains of Custody', [
    'When this Aura enters, exile target nonland permanent an opponent controls until this Aura leaves the battlefield.',
  ]);

  unimplemented('cbcb6d9a-6ae5-4bcd-8013-2b657553764a', 'Mangara, the Diplomat', [
    'Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, draw a card.',
    'Whenever an opponent casts their second spell each turn, draw a card.',
  ]);

  unimplemented('ac675899-25bb-4f06-9c8c-bf188024495f', 'Firemane Commando', [
    'Whenever you attack with two or more creatures, draw a card.',
    'Whenever another player attacks with two or more creatures, they draw a card if none of those creatures attacked you.',
  ]);

  unimplemented('0c85b8f7-0bd0-4680-9ec5-d4b110460a54', 'Fabled Passage', [
    '{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. Then if you control four or more lands, untap that land.',
  ]);

  unimplemented('2598294c-a9a7-4bef-a562-23f297a80536', "Songbirds' Blessing", [
    "Whenever enchanted creature attacks, reveal cards from the top of your library until you reveal an Aura card. You may put that card onto the battlefield. If you don't, put it into your hand. Put the rest on the bottom of your library in a random order.",
  ]);

  unimplemented('81a51328-b995-4f3b-90bc-a20ae21dd254', 'Spirit Mantle', [
    'Enchanted creature gets +1/+1 and has protection from creatures.',
  ]);

  unimplemented('e1d294e8-67b1-4a4a-86b8-f98f28a327d9', 'Promise of Loyalty', [
    "Each player puts a vow counter on a creature they control and sacrifices the rest. Each of those creatures can't attack you or planeswalkers you control for as long as it has a vow counter on it.",
  ]);

  unimplemented('ff6b52b7-ae3c-465b-b10e-901160e5230e', 'Nils, Discipline Enforcer', [
    'At the beginning of your end step, for each player, put a +1/+1 counter on up to one target creature that player controls.',
    "Each creature with one or more counters on it can't attack you or planeswalkers you control unless its controller pays {X}, where X is the number of counters on that creature.",
  ]);

  unimplemented('7e00b0cd-d212-4604-ba07-da21f4fe00b0', 'Sram, Senior Edificer', [
    'Whenever you cast an Aura, Equipment, or Vehicle spell, draw a card.',
  ]);

  // Eldrazi Conscription: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  // Anguished Unmaking: no override needed — "Exile target X. You lose N life." now parses
  // generically (the existing "exile target …" rule plus the new "you lose N life" sentence),
  // and there's no token/typeLine divergence risk here the way the token-creating removal spells
  // above have. Deleted rather than kept-empty.

  unimplemented('34b90d3e-f48c-41ff-b3e4-5cab7a9cd597', 'Secret Rendezvous', [
    'You and target opponent each draw three cards.',
  ]);

  defineCard(
    '04b7362d-0490-4cb0-b5d7-2a7732f659ce',
    'Bojuka Bog',
    ["When this land enters, exile target player's graveyard."],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'enters', subject: { kind: 'self' } },
          targets: [{ kind: 'player' }],
          effects: [{ op: 'exileTargetPlayerGraveyard', target: 0 }],
          description: 'Enters — exile target player’s graveyard',
        },
      ],
    },
  );

  unimplemented('c9fc13d6-bd10-47bc-b2b6-7f67a1f3371e', 'Shineshadow Snarl', [
    "As this land enters, you may reveal a Plains or Swamp card from your hand. If you don't, this land enters tapped.",
  ]);

  // Angelic Destiny: restored in coverage PR05 (see silverquill-influence-remaining.ts).

  unimplemented('d11e627b-8a48-411d-a261-2c9a02a758ba', 'Breena, the Demagogue', [
    'Whenever a player attacks one of your opponents, if that opponent has more life than another of your opponents, that attacking player draws a card and you put two +1/+1 counters on a creature you control.',
  ]);

  unimplemented('eb735501-19e7-4910-aa6a-6667fff6f4e5', 'Study Hall', [
    "{1}, {T}: Add one mana of any color. When you spend this mana to cast your commander, scry X, where X is the number of times it's been cast from the command zone this game.",
  ]);

  unimplemented('71c52bf5-2a5d-488e-8b15-7ef290e4b77d', 'War Room', [
    "{3}, {T}, Pay life equal to the number of colors in your commanders' color identity: Draw a card.",
  ]);

  unimplemented('2975590d-6a5b-41e5-8a3b-e9325e71226a', 'Starfield Mystic', [
    'Enchantment spells you cast cost {1} less to cast.',
    'Whenever an enchantment you control is put into a graveyard from the battlefield, put a +1/+1 counter on this creature.',
  ]);
}

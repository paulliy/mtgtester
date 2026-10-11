/** Remaining authored overrides for silverquill-influence.txt. */

import type { CardDefinition } from '../definition';
import type { KeywordAbility } from '../ability';
import { ATTACHED, auraBuff as auraBuffStatics, mana, TAP } from '../templates';
import { allOf, ofSubtype, ofSupertype, ofType, YOURS } from '../selector';
import { constant } from '../value';
import { defineCard as defineCardImpl, unimplemented, unsupportedCard } from './index';

const AURA_TYPE = ofSubtype('Aura');
const ENCHANTMENTS = ofType('Enchantment');
// These aliases track normalized Oracle wording. They do not justify approximate
// behavior: cards with missing semantics must remain unimplemented.
const HANDLED_LINE_FIXES: Record<string, string[]> = {
  'bd92cacd-c7d8-43a2-a261-ea4754fefdc5': [
    "When this Aura enters, draw a card for each Aura you control that's attached to a creature.",
    "Enchanted creature gets +1/+1 for each Aura you control that's attached to a creature.",
  ],
  '64c986f0-e786-419c-9b51-8c316c8fae0e': [
    'Whenever ~ enters or attacks, create a white Aura enchantment token named Contract attached to target creature an opponent controls. The token has enchant creature and "Whenever enchanted creature attacks, it gets +2/+0 until end of turn if it\'s attacking one of your opponents. Otherwise, its controller loses 2 life."',
  ],
  '0a7d6489-b239-4ce8-aea3-7b5d0e436f70': [
    'unrecognized rules text: "Enchanted creature gets +1/+1 and has vigilance."',
  ],
  'c9fc13d6-bd10-47bc-b2b6-7f67a1f3371e': [
    "As this land enters, you may reveal a Plains or Swamp card from your hand. If you don't, this land enters tapped.",
  ],
  '2598294c-a9a7-4bef-a562-23f297a80536': [
    "Whenever enchanted creature attacks, reveal cards from the top of your library until you reveal an Aura card. You may put that card onto the battlefield. If you don't, put it into your hand. Put the rest on the bottom of your library in a random order.",
  ],
  'eb735501-19e7-4910-aa6a-6667fff6f4e5': [
    'unsupported mana production: "{1}, {T}: Add one mana of any color. When you spend this mana to cast your commander, scry X, where X is the number of times it\'s been cast from the command zone this game."',
  ],
  '2ef0961a-0543-4371-8c2a-333881b735e5': [
    'Affinity for planeswalkers',
    'Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, that opponent loses 3 life and you draw a card.',
  ],
  '71c52bf5-2a5d-488e-8b15-7ef290e4b77d': [
    'unrecognized rules text: "{3}, {T}, Pay life equal to the number of colors in your commanders\' color identity: Draw a card."',
  ],
};
// Keep authored patches type-checked against the engine definition.
const defineCard = (
  oracleId: string,
  name: string,
  handledLines: string[],
  def: Partial<CardDefinition>,
) => defineCardImpl(oracleId, name, HANDLED_LINE_FIXES[oracleId] ?? handledLines, def);
/**
 * `def` REPLACES the interpreted `staticEffects` wholesale (`applyOverride` is a shallow spread),
 * so an override for an Aura whose printed line ends "and is goaded" has to carry the goad here
 * or the card silently loses it — the buff ships, the goad does not, and nothing reports it.
 */
const auraBuff = (
  power: number,
  toughness: number,
  keywords: KeywordAbility[] = [],
  goaded = false,
): Partial<CardDefinition> => ({
  staticEffects: [
    ...auraBuffStatics(power, toughness, keywords),
    ...(goaded ? [{ affects: ATTACHED, op: { layer: 6 as const, addGoad: true as const } }] : []),
  ],
});

export function registerSILVERQUILL_INFLUENCE_REMAININGOverrides(): void {
  // Ajani's Chosen: restored in coverage PR05. The interpreter reads the Cat token and the optional
  // attach of an entering Aura to it, so no override remains.
  // Angelic Destiny: restored in coverage PR05. The interpreter reads the +4/+4, flying and first
  // strike, and the Angel creature type as a layer 4 addition on the enchanted creature, and
  // returns this Aura card from the graveyard to its owner's hand when that creature dies.
  // Animate Dead: restored in coverage PR05. The interpreter reads Enchant creature card in a
  // graveyard as a graveyard-card target the Aura stays legal on, and the enters trigger swaps it
  // to the creature it returns under your control, attaches with a new timestamp, and sacrifices
  // that creature when the Aura leaves.
  // Catalog audit silverquill-remaining-batch-1: hexproof/shroud strip authored as menace.
  unsupportedCard(
    '30ac68e6-160a-41f9-9f0f-0e0eef383150',
    'Arcane Lighthouse',
    'Hexproof/shroud removal is implemented as granting menace.',
  );
  // Catalog audit silverquill-remaining-batch-2: any artifact, attach omitted.
  unsupportedCard(
    'b4dbbf56-d7df-4183-bb48-cfc6b4d0468f',
    'Armored Skyhunter',
    'Equipment filter is any artifact, and attach is omitted.',
  );
  defineCard('5acff7a3-bc84-4251-bd37-80231396ac38', 'Chains of Custody', [], {
    triggers: [
      {
        kind: 'triggered',
        trigger: { when: 'enters', subject: { kind: 'self' } },
        targets: [{ kind: 'nonlandPermanent', controller: 'opponent' }],
        effects: [{ op: 'exileUntilSourceLeaves', targetSlot: 0 }],
        description: 'Exile target opposing nonland permanent until Chains of Custody leaves',
      },
    ],
  });
  defineCard('dbb8a3d9-6b1b-4ad1-b8b9-f92ead03d1d9', 'Coercive Impetus', [], {
    ...auraBuff(1, 1, [], true),
    triggers: [
      {
        kind: 'triggered',
        trigger: { when: 'attacks', subject: { kind: 'permanent', selector: ATTACHED } },
        targets: [],
        effects: [
          { op: 'draw', count: constant(1) },
          { op: 'loseLife', amount: constant(1) },
        ],
        description: 'When the enchanted creature attacks, draw and lose 1 life',
      },
    ],
  });
  defineCard(
    '05a4f8ff-49da-42af-add5-6248c4b0644b',
    'Darksteel Mutation',
    [
      'unrecognized rules text: "Enchanted creature is an Insect artifact creature with base power and toughness 0/1 and has indestructible, and it loses all other abilities, card types, and creature types."',
    ],
    {
      staticEffects: [
        {
          affects: ATTACHED,
          op: { layer: 4, setTypes: ['Artifact', 'Creature'], setSubtypes: ['Insect'] },
        },
        { affects: ATTACHED, op: { layer: 6, loseAllAbilities: true } },
        { affects: ATTACHED, op: { layer: 6, addKeyword: 'indestructible' } },
        {
          affects: ATTACHED,
          op: { layer: 7, sublayer: 'b', power: constant(0), toughness: constant(1) },
        },
      ],
    },
  );
  // Catalog audit silverquill-remaining-batch-2: Prepare claimed as a pump on any draw step.
  unsupportedCard(
    '27c366cf-00d7-47d4-9577-736bfc4a3b81',
    "Defacing Duskmage // Vandal's Edit",
    'Prepare is implemented as a pump trigger on any draw step.',
  );
  // The line now parses generically too, but as a stack-based ACTIVATED ability
  // (`interpret.ts`'s `MANA_ABILITY_RE` case in `parseEffectSentence` — a mana ability's cost
  // can't include mana, CR 605.1a), not the `manaAbilities` (never-uses-the-stack) shape this
  // override deliberately keeps. handledLines emptied rather than changing the def: switching
  // this land off `manaAbilities` is a real behavior change (a stack ability can be responded
  // to; a mana ability can't) outside the scope of a drift-guard cleanup.
  // `activatedAbilities: []` clears the interpreter's own stack-based reading of this same line —
  // without it, `applyOverride`'s shallow merge leaves the interpreted activated ability sitting
  // alongside this override's mana ability, offering the land's mana twice (once uncounterable,
  // once respondable) for one printed line.
  // Eidolon of Countless Battles: restored in coverage PR05. The interpreter reads Bestow as an
  // alternative cost that casts it as a bestowed Aura (CR 702.103), and the buff as two additive
  // statics on this creature and the enchanted creature: +1/+1 per creature you control and +1/+1
  // per Aura you control.
  // Catalog audit silverquill-remaining-batch-2: Prepare claimed as a self-attack pump.
  unsupportedCard(
    '09b7ea91-2620-4c45-af3c-60bbeab89966',
    'Eiganjo Dynastorian // Replenish',
    'Prepare is implemented as a pump trigger when this creature attacks.',
  );
  // Eldrazi Conscription: restored in coverage PR05. The interpreter accepts the Kindred card type
  // (CR 308) and grants +10/+10, trample and annihilator 2 to the enchanted creature, the
  // annihilator as an attack trigger whose defending player sacrifices two permanents of their
  // choice.
  // Catalog audit silverquill-remaining-batch-2: cannot-attack-you static omitted.
  unsupportedCard(
    'f43f5855-f297-4433-984b-18263b734cfc',
    'Eriette of the Charmed Apple',
    'Cannot-attack-you static is claimed without an implementation.',
  );
  // Fallen Ideal: restored in coverage PR05. Grants flying and the sacrifice ability to the
  // enchanted creature, which may sacrifice itself; returns this card to its owner's hand from the
  // graveyard.
  // Catalog audit silverquill-remaining-batch-1: both triggers make you draw.
  unsupportedCard(
    'ac675899-25bb-4f06-9c8c-bf188024495f',
    'Firemane Commando',
    'Both attack triggers make you draw, ignoring the other-player and not-attacked-you clauses.',
  );
  // Forum Filibuster: restored in coverage PR05. The interpreter reads the Inkling token and its
  // reflexive return of an Aura or Equipment card attached to that token, so no override remains.
  // Ghoulish Impetus: restored in coverage PR05. The interpreter reads the +1/+1, deathtouch and
  // goad on the enchanted creature, and its dies trigger as returning this card to the battlefield
  // at the beginning of the next end step, choosing a creature to enchant as it enters.
  // Gift of Immortality: restored in coverage PR05. The interpreter reads the dies trigger as
  // returning that creature card under its owner's control, then returning this Aura card at the
  // beginning of the next end step attached to that creature, staying put if the creature is gone
  // or it can't be attached.
  // Hateful Eidolon: restored in coverage PR05. The interpreter reads the dies trigger on any
  // enchanted creature and draws one card per Aura you controlled that was attached to it, from the
  // creature's last-known facts.
  // Catalog audit silverquill-remaining-batch-2: exile-and-cast authored as look-and-put.
  unsupportedCard(
    '6c25c6b5-d98c-4eb4-aacd-b6960a8779a9',
    'Herald of Amity',
    'Exile-and-cast-Aura is implemented as lookAtTopN putting an Aura onto the battlefield.',
  );
  // Catalog audit silverquill-remaining-batch-2: class levels claimed without an implementation.
  unsupportedCard(
    '6c948f71-5c86-450c-8828-df4d8deaf1dd',
    'Intermediate Chirography',
    'Class levels and later abilities are claimed without an implementation.',
  );
  // Catalog audit silverquill-remaining-batch-2: mutual reveal authored as Dark Confidant.
  unsupportedCard(
    'b8602f19-6fc2-43c4-b0c4-2cd11d5dbda2',
    'Keen Duelist',
    'Mutual reveal is implemented as drawRevealTopLoseManaValue on you only.',
  );
  // Killian, Decisive Mentor: restored in coverage PR05. The interpreter reads the enchantment-
  // enters trigger as tap and goad up to one target creature, and the attack trigger as one draw
  // per batch of attackers that includes a creature enchanted by an Aura you control.
  // Killian, Ink Duelist: restored in coverage PR02. The interpreter reads the target-dependent
  // cost reduction, so no override remains.
  // Kor Spiritdancer: restored in coverage PR05. The interpreter reads the layer 7d +2/+2 per Aura
  // attached to this creature (any controller) and the optional draw on casting an Aura spell.
  // Catalog audit silverquill-remaining-batch-3: "you may" and reveal are omitted.
  // Coverage PR01 (was contained by silverquill-remaining-batch-3): an intervening-if upkeep
  // trigger (checked as it triggers and as it resolves, CR 603.4), "you may" on resolution, and a
  // revealed search for up to three basic lands into hand.
  defineCard(
    'd2d9ecea-7925-420e-98b9-2f87f41f387c',
    'Land Tax',
    [
      'At the beginning of your upkeep, if an opponent controls more lands than you, you may search your library for up to three basic land cards, reveal them, put them into your hand, then shuffle.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'upkeep',
            player: 'you',
            condition: { kind: 'opponentControlsMore', selector: ofType('Land') },
          },
          optional: true,
          targets: [],
          effects: [
            {
              op: 'searchLibrary',
              filter: allOf(ofSupertype('Basic'), ofType('Land')),
              destinations: [{ zone: 'hand' }],
              count: constant(3),
              allowFailToFind: true,
              reveal: true,
            },
            { op: 'shuffle' },
          ],
          description:
            'You may search for up to three basic lands, reveal them, and put them into your hand',
        },
      ],
    },
  );
  // Martial Impetus: restored in coverage PR05. The interpreter reads the +1/+1 and goad on the
  // enchanted creature, and its attack trigger pumps each other creature attacking an opponent of
  // the Aura's controller, not every creature in combat.
  defineCard(
    'ff3de07d-86c3-49e1-9de0-97c85301ff93',
    'Parasitic Impetus',
    [
      'unrecognized rules text: "Whenever enchanted creature attacks, its controller loses 2 life and you gain 2 life."',
    ],
    {
      ...auraBuff(2, 2, [], true),
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'attacks', subject: { kind: 'permanent', selector: ATTACHED } },
          targets: [],
          effects: [
            { op: 'loseLifeTarget', target: 'eventPlayer', amount: constant(2) },
            { op: 'gainLife', amount: constant(2) },
          ],
          description: 'When the enchanted creature attacks, its controller loses 2 and you gain 2',
        },
      ],
    },
  );
  // Affinity plus targeting a modified permanent is not fully modeled.
  unimplemented('9bdc1e63-1cf9-4ddb-a7d5-f2a2eb91bdfd', 'Pearl-Ear, Imperial Advisor', []);
  // Catalog audit silverquill-remaining-batch-3: keep-one sacrifice and vow attack restriction.
  unsupportedCard(
    'e1d294e8-67b1-4a4a-86b8-f98f28a327d9',
    'Promise of Loyalty',
    'Keep-one sacrifice, vow counters, and attack restriction are unimplemented.',
  );
  // Raffine's Guidance: restored in coverage PR02. The interpreter reads the {2}{W} graveyard
  // recast as an alternative cost, so no override remains.
  // Redemption Arc: restored in coverage PR05. The interpreter reads the granted indestructible and
  // goad, and the untargeted exile of the enchanted creature, so no override remains.
  // Needs counts of your Auras attached to creatures for both draw and continuous power.
  unimplemented('bd92cacd-c7d8-43a2-a261-ea4754fefdc5', 'Sage’s Reverie', []);
  // Screams from Within: restored in coverage PR05. The interpreter reads the enchanted creature's
  // dies trigger as returning this card from your graveyard to the battlefield, choosing a creature
  // to enchant as it enters (CR 303.4f) and staying in the graveyard if there is none.
  // Current Oracle text creates Contract Auras; the Inkling approximation is incorrect.
  unimplemented('64c986f0-e786-419c-9b51-8c316c8fae0e', 'Scriv, the Obligator', []);
  // Sheltered by Ghosts: restored in coverage PR05. The interpreter reads the enters trigger as
  // exile target nonland permanent an opponent controls until this Aura leaves the battlefield, and
  // grants +1/+0, lifelink and ward {2} to the enchanted creature.
  // Shielded by Faith: restored in coverage PR05. The interpreter reads the optional attach to each
  // entering creature, so no override remains.
  defineCard(
    'c9fc13d6-bd10-47bc-b2b6-7f67a1f3371e',
    'Shineshadow Snarl',
    [
      'unrecognized rules text: "Shineshadow Snarl enters the battlefield tapped unless you reveal a Plains or Swamp card from your hand."',
    ],
    { entersTappedUnless: { kind: 'mayRevealCardFromHand', subtypes: ['Plains', 'Swamp'] } },
  );
  // Catalog audit silverquill-remaining-batch-3: reveal-until-Aura is unimplemented.
  unsupportedCard(
    '2598294c-a9a7-4bef-a562-23f297a80536',
    "Songbirds' Blessing",
    'Reveal-until-Aura with optional battlefield and hand fallback is unimplemented.',
  );
  // Catalog audit silverquill-remaining-batch-3: protection from creatures is unimplemented.
  unsupportedCard(
    '81a51328-b995-4f3b-90bc-a20ae21dd254',
    'Spirit Mantle',
    'Protection from creatures is unimplemented.',
  );
  defineCard(
    '7e00b0cd-d212-4604-ba07-da21f4fe00b0',
    'Sram, Senior Edificer',
    [
      'unrecognized rules text: "Whenever you cast an Aura, Equipment, or Vehicle spell, draw a card."',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'castsSpell',
            caster: 'you',
            filter: {
              kind: 'anyOf',
              of: [AURA_TYPE, ofSubtype('Equipment'), ofSubtype('Vehicle')],
            },
          },
          targets: [],
          effects: [{ op: 'draw', count: constant(1) }],
          description: 'Cast an Aura, Equipment, or Vehicle — draw a card',
        },
      ],
    },
  );
  // Starfield Mystic: the interpreter now reads both the cost-reduction line and the bare
  // "is put into a graveyard from the battlefield" head; the reviewed definition below stays as
  // the authored behavior and claims no raw-parser lines.
  defineCard('2975590d-6a5b-41e5-8a3b-e9325e71226a', 'Starfield Mystic', [], {
    ruleStatics: [{ kind: 'costReduction', amount: constant(1), filter: ENCHANTMENTS }],
    triggers: [
      {
        kind: 'triggered',
        trigger: {
          when: 'dies',
          subject: { kind: 'permanent', selector: allOf(ENCHANTMENTS, YOURS) },
        },
        targets: [],
        effects: [{ op: 'putCounters', counter: '+1/+1', count: constant(1), target: 'source' }],
        description: 'When your enchantment dies, put a +1/+1 counter on Starfield Mystic',
      },
    ],
  });
  // Catalog audit silverquill-remaining-batch-2: current Oracle is affinity + opponent-attacks.
  unsupportedCard(
    '2ef0961a-0543-4371-8c2a-333881b735e5',
    'Tomik, Wielder of Law',
    'Affinity and opponent-attacks trigger are implemented as a self-attack drain.',
  );
  defineCard(
    '71c52bf5-2a5d-488e-8b15-7ef290e4b77d',
    'War Room',
    [HANDLED_LINE_FIXES['71c52bf5-2a5d-488e-8b15-7ef290e4b77d']![0]!],
    {
      activatedAbilities: [
        {
          costs: [
            mana('{3}'),
            TAP,
            { kind: 'payLifeValue', amount: { kind: 'commanderIdentityColorCount' } },
          ],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [{ op: 'draw', count: constant(1) }],
            description: "Pay life equal to your commanders' color identity colors: draw a card",
          },
        },
      ],
    },
  );
}

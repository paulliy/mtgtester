/** PR11b authored layout cards: MDFC spell faces, transform, Class, Sagas, split cards, prepare, Rooms. */
import type { CardDefinition } from '../definition';
import { allOf, anyOf, ofType, SELF, YOURS } from '../selector';
import {
  activated,
  loyaltyAbility,
  mana,
  manaCost,
  onCast,
  onChapter,
  onDies,
  spell,
  TAP,
  targetSlots,
  triggered,
} from '../templates';
import { CONSTRUCT_0_0_ARTIFACT_COUNT, INKLING_2_1_FLYING } from '../tokens';
import { constant } from '../value';
import { extendCard, replaceCard } from './index';

export function registerCoveragePr11bOverrides(): void {
  registerPr11bModalSpellFaces();
  registerPr11bTransform();
  registerPr11bClass();
  registerPr11bSagas();
  registerPr11bModalBackFaces();
  registerPr11bPrepare();
}

/** PR11.02, .04: spell // land modal DFCs whose land backs were already authored. */
function registerPr11bModalSpellFaces(): void {
  // PR11.02: the life loss and the grant both need the target to be legal on resolution (CR
  // 608.2b). The granted trigger belongs to that creature object only, so a creature it returned
  // that dies again the same turn stays in the graveyard (CR 400.7).
  const rebirth = targetSlots({ creature: { kind: 'creature' } });
  replaceCard(
    'a731e87b-8d99-4b64-8ee3-8e540d652366',
    'Malakir Rebirth // Malakir Mire',
    [
      'Choose target creature. You lose 2 life. Until end of turn, that creature gains "When this creature dies, return it to the battlefield tapped under its owner\'s control."',
    ],
    {
      spellAbility: spell({
        targets: rebirth.targets,
        effects: [
          { op: 'loseLife', amount: constant(2) },
          {
            op: 'grantAbilityUntilEot',
            target: rebirth.slot.creature,
            ability: triggered(onDies(), {
              effects: [{ op: 'returnDiedSourceToBattlefield', tapped: true }],
              description:
                "When this creature dies, return it to the battlefield tapped under its owner's control",
            }),
          },
        ],
        description:
          'Choose target creature. You lose 2 life. Until end of turn, it gains "When this creature dies, return it to the battlefield tapped"',
      }),
    },
    'PR11b authors the Malakir Rebirth spell face beside the existing Malakir Mire land face.',
  );

  // PR11.04: any number includes none; the draw counts the cards actually put on the bottom.
  replaceCard(
    'ff0ab867-b710-4b1a-baed-95fc3cf68f79',
    'Valakut Awakening // Valakut Stoneforge',
    [
      'Put any number of cards from your hand on the bottom of your library, then draw that many cards plus one.',
    ],
    {
      spellAbility: spell({
        effects: [{ op: 'putAnyFromHandOnBottomThenDraw', extra: 1 }],
        description:
          'Put any number of cards from your hand on the bottom of your library, then draw that many plus one',
      }),
    },
    'PR11b authors the Valakut Awakening spell face beside the existing Valakut Stoneforge land face.',
  );
}

/** PR11.23: a transforming DFC whose front face flips on a three-creature attack. */
function registerPr11bTransform(): void {
  // PR11.23: the attack count is part of the event (CR 508.2a, 603.2), not an intervening if.
  // Adanto, the First Fort's mana and token abilities are read from the interpreted back face,
  // and a doubled trigger turns the card over once (CR 701.27f).
  extendCard(
    'f7d8b91b-6541-4d3e-af51-7e000eac69c1',
    "Legion's Landing // Adanto, the First Fort",
    ['When you attack with three or more creatures, transform ~.'],
    {
      triggers: [
        triggered(
          { when: 'attackDeclared', attacker: 'you', minAttackers: 3 },
          {
            effects: [{ op: 'transformSelf' }],
            description: "When you attack with three or more creatures, transform Legion's Landing",
          },
        ),
      ],
    },
  );
}

/** PR11.14: a Class whose levels are gained in order at sorcery speed (CR 716). */
function registerPr11bClass(): void {
  // PR11.14: level 2's trigger only exists from level 2 on, and "for the first time each turn"
  // is part of the life-loss event, so a Class that levels up after its controller has already
  // lost life that turn waits for the next turn. Level 3's end-step check is an intervening if
  // over a modified creature (CR 700.9) that died while its controller was this Class's.
  const levelUp = (cost: string, level: number) => ({
    ...activated({
      costs: [mana(cost)],
      timing: 'sorcery',
      effects: [{ op: 'gainClassLevel', level }],
      description: `${cost}: Gain Class level ${level}`,
    }),
    condition: { kind: 'sourceClassLevel', cmp: '==', n: level - 1 } as const,
  });
  const grown = targetSlots({ creature: { kind: 'creature', controller: 'you' } });
  replaceCard(
    '6c948f71-5c86-450c-8828-df4d8deaf1dd',
    'Intermediate Chirography',
    [
      'unsupported layout "class"',
      'unrecognized rules text: "When this Class enters, create a 2/1 white and black Inkling creature token with flying."',
      'unrecognized rules text: "{1}{B}: Level 2"',
      'unrecognized rules text: "Whenever you lose life for the first time each turn, put a +1/+1 counter on target creature you control."',
      'unrecognized rules text: "{2}{B}: Level 3"',
      'unrecognized rules text: "At the beginning of each end step, if a modified creature died under your control this turn, create a 2/1 white and black Inkling creature token with flying."',
    ],
    {
      triggers: [
        triggered(
          { when: 'enters', subject: { kind: 'self' } },
          {
            effects: [{ op: 'createToken', spec: INKLING_2_1_FLYING, count: constant(1) }],
            description: 'When this Class enters, create a 2/1 white and black Inkling with flying',
          },
        ),
      ],
      activatedAbilities: [levelUp('{1}{B}', 2), levelUp('{2}{B}', 3)],
      staticEffects: [
        {
          affects: SELF,
          condition: { kind: 'sourceClassLevel', cmp: '>=', n: 2 },
          op: {
            layer: 6,
            addTrigger: triggered(
              { when: 'losesLife', player: 'you', firstTimeEachTurn: true },
              {
                targets: grown.targets,
                effects: [
                  {
                    op: 'putCounters',
                    target: grown.slot.creature,
                    counter: '+1/+1',
                    count: constant(1),
                  },
                ],
                description:
                  'Whenever you lose life for the first time each turn, put a +1/+1 counter on target creature you control',
              },
            ),
          },
        },
        {
          affects: SELF,
          condition: { kind: 'sourceClassLevel', cmp: '>=', n: 3 },
          op: {
            layer: 6,
            addTrigger: triggered(
              { when: 'endStep', player: 'each' },
              {
                condition: { kind: 'modifiedCreatureDiedUnderYourControlThisTurn' },
                effects: [{ op: 'createToken', spec: INKLING_2_1_FLYING, count: constant(1) }],
                description:
                  'At the beginning of each end step, if a modified creature died under your control this turn, create a 2/1 white and black Inkling with flying',
              },
            ),
          },
        },
      ],
    },
    'PR11b implements the Class levels, the first-life-loss trigger and the modified-death check.',
  );
}

/** PR11.13, .21: Sagas — a lore counter as each enters and at each precombat main (CR 714). */
function registerPr11bSagas(): void {
  // PR11.13: the chapter III targets are chosen as the trigger goes on the stack, with the total
  // mana value budget checked then and again on resolution (CR 601.2c, 608.2b). The returned
  // creatures enter as artifacts with their counter, and stay artifacts while they remain.
  const returned = targetSlots({
    creatures: {
      kind: 'cardInGraveyard',
      filter: ofType('Creature'),
      count: { min: 0, max: 3 },
      totalManaValueAtMost: 8,
    },
  });
  replaceCard(
    '5924cbb0-19b5-449c-a7c5-722e744a54f8',
    'The War in Heaven',
    [
      'unsupported layout "saga"',
      'I — You draw three cards and you lose 3 life.',
      'II — Mill three cards.',
      "III — Choose up to three target creature cards with total mana value 8 or less in your graveyard. Return each of them to the battlefield with a necrodermis counter on it. They're artifacts in addition to their other types.",
    ],
    {
      triggers: [
        triggered(onChapter(1), {
          effects: [
            { op: 'draw', count: constant(3) },
            { op: 'loseLife', amount: constant(3) },
          ],
          description: 'I — You draw three cards and you lose 3 life',
        }),
        triggered(onChapter(2), {
          effects: [{ op: 'mill', count: constant(3) }],
          description: 'II — Mill three cards',
        }),
        triggered(onChapter(3), {
          targets: returned.targets,
          effects: [
            {
              op: 'reanimateEachChosen',
              targetSlot: returned.slot.creatures,
              counter: 'necrodermis',
              addTypes: ['Artifact'],
            },
          ],
          description:
            'III — Return up to three target creature cards with total mana value 8 or less from your graveyard to the battlefield with a necrodermis counter, as artifacts',
        }),
      ],
    },
    'PR11b implements Saga chapters, so the chapter abilities trigger on lore counters.',
  );

  // PR11.21: each "gains" lasts for as long as the Saga stays this object (CR 611.2c), so it
  // keeps both abilities until chapter III resolves and it is sacrificed (CR 714.4). Chapter III
  // reads the printed mana cost, so an {X} artifact or one without a mana cost is not found.
  replaceCard(
    '4c6a0c30-b547-4eff-8ff4-0ca25803c076',
    "Urza's Saga",
    [
      'unsupported layout "saga"',
      'unrecognized rules text: "I — ~ gains "{T}: Add {C}.""',
      'unrecognized rules text: "II — ~ gains "{2}, {T}: Create a 0/0 colorless Construct artifact creature token with \'~ gets +1/+1 for each artifact you control.\'""',
      'unrecognized rules text: "III — Search your library for an artifact card with mana cost {0} or {1}, put it onto the battlefield, then shuffle."',
    ],
    {
      triggers: [
        triggered(onChapter(1), {
          effects: [{ op: 'sourceGainsAbility', manaAbility: { units: [['C']] } }],
          description: 'I — This Saga gains "{T}: Add {C}"',
        }),
        triggered(onChapter(2), {
          effects: [
            {
              op: 'sourceGainsAbility',
              activatedAbility: activated({
                costs: [mana('{2}'), TAP],
                effects: [
                  { op: 'createToken', spec: CONSTRUCT_0_0_ARTIFACT_COUNT, count: constant(1) },
                ],
                description:
                  '{2}, {T}: Create a 0/0 Construct artifact token with "This creature gets +1/+1 for each artifact you control"',
              }),
            },
          ],
          description:
            'II — This Saga gains "{2}, {T}: Create a 0/0 colorless Construct artifact creature token"',
        }),
        triggered(onChapter(3), {
          effects: [
            {
              op: 'searchLibrary',
              filter: allOf(ofType('Artifact'), { kind: 'manaCostIs', manaCosts: ['{0}', '{1}'] }),
              destinations: [{ zone: 'battlefield' }],
            },
            { op: 'shuffle' },
          ],
          description:
            'III — Search your library for an artifact card with mana cost {0} or {1}, put it onto the battlefield, then shuffle',
        }),
      ],
    },
    "PR11b implements Saga chapters and the abilities Urza's Saga gains.",
  );
}

/** PR11.10, .27: modal DFCs whose back face is a spell rather than a land. */
function registerPr11bModalBackFaces(): void {
  // PR11.10: the opponent who cast the spell decides whether to pay as the trigger resolves; if
  // they don't, its controller may copy the spell, using its last known information if it has
  // left the stack, and may choose new targets (CR 707.10). Explore the Vastlands is the back
  // face's sorcery (CR 712.11): each player picks in APNAP order, then all of them move.
  const vastlandsText =
    'Each player looks at the top five cards of their library and may reveal a land card and/or an instant or sorcery card from among them. Each player puts the cards they revealed this way into their hand and the rest on the bottom of their library in a random order. Each player gains 3 life.';
  const vastlands: CardDefinition = {
    oracleId: '6556c4c0-b10d-4208-821b-0c0a49abd188',
    name: 'Explore the Vastlands',
    typeLine: 'Sorcery',
    supertypes: [],
    types: ['Sorcery'],
    subtypes: [],
    colors: [],
    colorIdentity: [],
    manaCost: manaCost('{3}'),
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    triggers: [],
    staticEffects: [],
    ruleStatics: [],
    spellAbility: spell({
      effects: [
        {
          op: 'eachPlayerLooksAtTopRevealsToHand',
          count: 5,
          picks: [ofType('Land'), anyOf(ofType('Instant'), ofType('Sorcery'))],
        },
        { op: 'eachPlayerGainsLife', amount: constant(3) },
      ],
      description:
        'Each player looks at their top five cards, may reveal a land and an instant or sorcery card and puts them into their hand, then gains 3 life',
    }),
    modeled: true,
    unmodeledReasons: [],
  };
  replaceCard(
    '6556c4c0-b10d-4208-821b-0c0a49abd188',
    'Wandering Archaic // Explore the Vastlands',
    [
      'unsupported layout "modal_dfc"',
      'unrecognized rules text: "Whenever an opponent casts an instant or sorcery spell, they may pay {2}. If they don\'t, you may copy that spell. You may choose new targets for the copy."',
    ],
    {
      name: 'Wandering Archaic',
      triggers: [
        triggered(onCast('opponent', anyOf(ofType('Instant'), ofType('Sorcery'))), {
          effects: [
            {
              op: 'unlessPays',
              payer: 'eventPlayer',
              cost: manaCost('{2}'),
              then: [{ op: 'copyCastSpell', optional: true }],
            },
          ],
          description:
            "Whenever an opponent casts an instant or sorcery spell, they may pay {2}. If they don't, you may copy that spell and choose new targets for the copy",
        }),
      ],
      alternativeCasts: [
        {
          kind: 'mdfc',
          name: vastlands.name,
          typeLine: vastlands.typeLine,
          manaCost: vastlands.manaCost!,
          ability: vastlands.spellAbility!,
          spellFace: vastlands,
          spellFaceText: {
            oracleText: vastlandsText,
            manaCost: '{3}',
            frontOracleText:
              "Whenever an opponent casts an instant or sorcery spell, they may pay {2}. If they don't, you may copy that spell. You may choose new targets for the copy.",
            frontManaCost: '{5}',
          },
          description: 'Cast Explore the Vastlands',
        },
      ],
    },
    'PR11b implements the pay-or-copy cast trigger and the Explore the Vastlands sorcery face.',
  );

  // PR11.27: Mila's first trigger counts only attacks on your planeswalkers, not on you (CR
  // 506.2). Lukka's -2 haste lasts as long as that object stays, and the delayed exile at your
  // next upkeep remembers that object only (CR 400.7). The emblem's damage comes from the
  // creature that entered, using its power as the trigger resolves (CR 608.2h).
  const reanimated = targetSlots({
    card: { kind: 'cardInGraveyard', filter: ofType('Creature') },
  });
  const struck = targetSlots({ target: { kind: 'anyTarget' } });
  const lukkaText =
    '+1: You may discard a card. If you do, draw a card. If a creature card was discarded this way, draw two cards instead.\n\u22122: Return target creature card from your graveyard to the battlefield. It gains haste. Exile it at the beginning of your next upkeep.\n\u22127: You get an emblem with "Whenever a creature you control enters, it deals damage equal to its power to any target."';
  const milaText =
    'Whenever an opponent attacks one or more planeswalkers you control, put a loyalty counter on each planeswalker you control.\nWhenever a permanent you control becomes the target of a spell or ability an opponent controls, you may draw a card.';
  const lukka: CardDefinition = {
    oracleId: 'ee524e82-35c4-4cae-b65e-3e147eac2927',
    name: 'Lukka, Wayward Bonder',
    typeLine: 'Legendary Planeswalker \u2014 Lukka',
    supertypes: ['Legendary'],
    types: ['Planeswalker'],
    subtypes: ['Lukka'],
    colors: ['R'],
    colorIdentity: ['W', 'R'],
    manaCost: manaCost('{4}{R}{R}'),
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: 5,
    defense: null,
    keywords: [],
    manaAbilities: [],
    entersTapped: false,
    triggers: [],
    staticEffects: [],
    ruleStatics: [],
    spellAbility: spell({ effects: [] }),
    activatedAbilities: [
      loyaltyAbility(1, {
        effects: [
          {
            op: 'mayDiscardThenDraw',
            count: 1,
            instead: { filter: ofType('Creature'), count: 2 },
          },
        ],
        description:
          'You may discard a card. If you do, draw a card, or two cards if it was a creature card',
      }),
      loyaltyAbility(-2, {
        targets: reanimated.targets,
        effects: [
          {
            op: 'reanimateTargetHasteExileAtYourNextEndStep',
            target: reanimated.slot.card,
            exileAt: 'yourNextUpkeep',
          },
        ],
        description:
          'Return target creature card from your graveyard to the battlefield. It gains haste. Exile it at the beginning of your next upkeep',
      }),
      loyaltyAbility(-7, {
        effects: [
          {
            op: 'createEmblem',
            name: 'Lukka, Wayward Bonder emblem',
            abilities: [
              triggered(
                {
                  when: 'enters',
                  subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
                },
                {
                  targets: struck.targets,
                  effects: [
                    {
                      op: 'dealDamage',
                      target: struck.slot.target,
                      amount: { kind: 'powerOfTriggerObject' },
                      source: 'triggerObject',
                    },
                  ],
                  description:
                    'Whenever a creature you control enters, it deals damage equal to its power to any target',
                },
              ),
            ],
          },
        ],
        description:
          'You get an emblem with "Whenever a creature you control enters, it deals damage equal to its power to any target"',
      }),
    ],
    modeled: true,
    unmodeledReasons: [],
  };
  replaceCard(
    'ee524e82-35c4-4cae-b65e-3e147eac2927',
    'Mila, Crafty Companion // Lukka, Wayward Bonder',
    [
      'unsupported layout "modal_dfc"',
      'unrecognized rules text: "Whenever an opponent attacks one or more planeswalkers you control, put a loyalty counter on each planeswalker you control."',
    ],
    {
      name: 'Mila, Crafty Companion',
      triggers: [
        triggered(
          {
            when: 'attackDeclared',
            attacker: 'opponent',
            attacking: { who: 'you', planeswalkers: true, planeswalkersOnly: true },
          },
          {
            effects: [
              {
                op: 'putCountersEach',
                selector: allOf(ofType('Planeswalker'), YOURS),
                counter: 'loyalty',
                count: 1,
              },
            ],
            description:
              'Whenever an opponent attacks one or more planeswalkers you control, put a loyalty counter on each planeswalker you control',
          },
        ),
        triggered(
          { when: 'becomesTargeted', subject: { kind: 'permanent', selector: YOURS } },
          {
            optional: true,
            effects: [{ op: 'draw', count: constant(1) }],
            description:
              'Whenever a permanent you control becomes the target of a spell or ability an opponent controls, you may draw a card',
          },
        ),
      ],
      alternativeCasts: [
        {
          kind: 'mdfc',
          name: lukka.name,
          typeLine: lukka.typeLine,
          manaCost: lukka.manaCost!,
          ability: lukka.spellAbility!,
          spellFace: lukka,
          spellFaceText: {
            oracleText: lukkaText,
            manaCost: '{4}{R}{R}',
            frontOracleText: milaText,
            frontManaCost: '{1}{W}{W}',
          },
          description: 'Cast Lukka, Wayward Bonder',
        },
      ],
    },
    "PR11b implements Mila's planeswalker-attack trigger and the Lukka, Wayward Bonder face.",
  );
}

/** A prepare spell's own characteristics (CR 722.2): an instant or sorcery with one ability. */
function prepareSpellFace(face: {
  oracleId: string;
  name: string;
  type: 'Instant' | 'Sorcery';
  cost: string;
  colors: CardDefinition['colors'];
  spellAbility: CardDefinition['spellAbility'];
}): CardDefinition {
  return {
    oracleId: face.oracleId as CardDefinition['oracleId'],
    name: face.name,
    typeLine: face.type,
    supertypes: [],
    types: [face.type],
    subtypes: [],
    colors: face.colors,
    colorIdentity: face.colors,
    manaCost: manaCost(face.cost),
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    triggers: [],
    staticEffects: [],
    ruleStatics: [],
    spellAbility: face.spellAbility,
    modeled: true,
    unmodeledReasons: [],
  };
}

/** PR11.06, .07: preparation cards (CR 722). */
function registerPr11bPrepare(): void {
  // PR11.06: "their second card each turn" is that draw itself, part of the event, so a third
  // draw before the trigger resolves changes nothing. Becoming prepared makes a castable copy of
  // Vandal's Edit in exile; casting it unprepares Duskmage (CR 722.3c).
  replaceCard(
    '27c366cf-00d7-47d4-9577-736bfc4a3b81',
    "Defacing Duskmage // Vandal's Edit",
    [
      'unsupported layout "prepare"',
      'unrecognized rules text: "Whenever an opponent draws their second card each turn, this creature becomes prepared."',
    ],
    {
      name: 'Defacing Duskmage',
      triggers: [
        triggered(
          { when: 'drawsCard', player: 'opponent', ordinalThisTurn: 2 },
          {
            effects: [{ op: 'becomePrepared' }],
            description:
              'Whenever an opponent draws their second card each turn, this creature becomes prepared',
          },
        ),
      ],
      prepareSpell: prepareSpellFace({
        oracleId: '27c366cf-00d7-47d4-9577-736bfc4a3b81',
        name: "Vandal's Edit",
        type: 'Instant',
        cost: '{1}{W}{B}',
        colors: ['W', 'B'],
        spellAbility: spell({
          effects: [
            { op: 'draw', count: constant(2) },
            { op: 'eachPlayerLosesLife', amount: constant(2) },
          ],
          description: 'Draw two cards. Each player loses 2 life',
        }),
      }),
    },
    "PR11b implements prepare and the opponent's-second-draw trigger.",
  );

  // PR11.07: attacking with two or more creatures is the declaration itself (CR 508.1).
  replaceCard(
    '09b7ea91-2620-4c45-af3c-60bbeab89966',
    'Eiganjo Dynastorian // Replenish',
    [
      'unsupported layout "prepare"',
      'unrecognized rules text: "Whenever you attack with two or more creatures, this creature becomes prepared."',
    ],
    {
      name: 'Eiganjo Dynastorian',
      triggers: [
        triggered(
          { when: 'attackDeclared', attacker: 'you', minAttackers: 2 },
          {
            effects: [{ op: 'becomePrepared' }],
            description:
              'Whenever you attack with two or more creatures, this creature becomes prepared',
          },
        ),
      ],
      prepareSpell: prepareSpellFace({
        oracleId: '09b7ea91-2620-4c45-af3c-60bbeab89966',
        name: 'Replenish',
        type: 'Sorcery',
        cost: '{3}{W}',
        colors: ['W'],
        spellAbility: spell({
          effects: [
            { op: 'graveyardToBattlefieldEach', filter: ofType('Enchantment'), scope: 'you' },
          ],
          description: 'Return all enchantment cards from your graveyard to the battlefield',
        }),
      }),
    },
    'PR11b implements prepare and the two-attacker trigger.',
  );
}

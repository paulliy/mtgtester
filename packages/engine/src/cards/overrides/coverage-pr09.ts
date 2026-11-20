import { CITIZEN_1_1_GREEN_WHITE } from '../tokens';
/** PR09 authored library operations. Review/evidence status is tracked separately in the manifest. */
import { allOf, anyOf, not, ofColor, ofType, ofSubtype, SELF, YOURS } from '../selector';
import {
  activated,
  targetSlots,
  mana,
  TAP,
  spell,
  ATTACHED,
  onCast,
  onEtb,
  onBeginCombat,
  onEndStep,
  onUpkeep,
  triggered,
  whenAttacks,
} from '../templates';
import { constant } from '../value';
import { counterSpellTarget } from '../target-builders';
import { replaceCard } from './index';

/** Replace contained approximations only with complete printed abilities. */
export function registerCoveragePr09Overrides(): void {
  // PR09: real shuffle/zone transitions and a public reveal, including a nonpermanent result.
  const chaosWarpTarget = targetSlots({ permanent: { kind: 'permanent' } });
  replaceCard(
    '07a0cba9-8768-4fd9-a3d5-b0f83b4bf8e8',
    'Chaos Warp',
    [
      "The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it's a permanent card, they put it onto the battlefield.",
    ],
    {
      spellAbility: spell({
        targets: chaosWarpTarget.targets,
        effects: [{ op: 'chaosWarp', target: chaosWarpTarget.slot.permanent }],
        description:
          'Its owner shuffles target permanent into their library, reveals the top card, and puts it onto the battlefield if it is a permanent',
      }),
    },
    'PR09 restores the publicly revealed owner-library shuffle through real zone changes.',
  );

  const duelist = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
  const carnosaur = targetSlots({
    permanent: { kind: 'permanent', filter: anyOf(ofType('Creature'), ofType('Planeswalker')) },
  });
  const celebrate = targetSlots({
    permanents: {
      kind: 'nonlandPermanent',
      controller: 'opponent',
      perPlayer: true,
      count: { min: 0, max: 1 },
    },
  });
  const trickery = targetSlots({ spell: counterSpellTarget() });
  const grenzo = targetSlots({ creature: { kind: 'creature', controller: 'eventPlayer' } });
  const powerPack = targetSlots({
    card: {
      kind: 'cardInGraveyard',
      graveyardOwnerScope: 'controller',
      filter: anyOf(ofType('Instant'), ofType('Sorcery')),
      random: true,
    },
  });
  replaceCard(
    'e91240bc-4a13-4131-9379-5ddac6555f4a',
    'Adaptive Omnitool',
    // The look-at-the-top grammar reads the attack line now (Phase 4 batch 2); the reviewed def
    // stays, the same lookAtTopN IR.
    [],
    {
      triggers: [
        triggered(whenAttacks(ATTACHED), {
          effects: [
            {
              op: 'lookAtTopN',
              count: 6,
              mayPut: { filter: ofType('Artifact'), destination: { zone: 'hand' }, reveal: true },
              rest: 'bottomRandom',
            },
          ],
          description:
            'Look at six; you may reveal an artifact and put it into your hand, then randomly bottom the rest',
        }),
      ],
    },
    'PR09 restores the exact pinned library clause with real zone transitions and explicit choices.',
  );
  replaceCard(
    'b4dbbf56-d7df-4183-bb48-cfc6b4d0468f',
    'Armored Skyhunter',
    [
      'unrecognized rules text: "Whenever this creature attacks, look at the top six cards of your library. You may put an Aura or Equipment card from among them onto the battlefield. If an Equipment is put onto the battlefield this way, you may attach it to a creature you control. Put the rest of those cards on the bottom of your library in a random order."',
    ],
    {
      triggers: [
        triggered(whenAttacks(SELF), {
          effects: [
            {
              op: 'lookAtTopN',
              count: 6,
              mayPut: {
                filter: anyOf(
                  allOf(ofType('Enchantment'), ofSubtype('Aura')),
                  allOf(ofType('Artifact'), ofSubtype('Equipment')),
                ),
                destination: { zone: 'battlefield' },
                attachEquipment: true,
              },
              rest: 'bottomRandom',
            },
          ],
          description:
            'Look at six; you may put an Aura or Equipment onto the battlefield, optionally attach Equipment to your creature, then randomly bottom the rest',
        }),
      ],
    },
    'PR09 restores the exact pinned library clause with real zone transitions and explicit choices.',
  );
  replaceCard(
    'b8602f19-6fc2-43c4-b0c4-2cd11d5dbda2',
    'Keen Duelist',
    [
      'unrecognized rules text: "At the beginning of your upkeep, you and target opponent each reveal the top card of your library. You each lose life equal to the mana value of the card revealed by the other player. You each put the card you revealed into your hand."',
    ],
    {
      triggers: [
        triggered(onUpkeep(), {
          targets: duelist.targets,
          effects: [{ op: 'mutualRevealTopLoseManaValue', target: duelist.slot.opponent }],
          description:
            'You and target opponent reveal and put your top cards into hand, each losing life equal to the other card’s mana value',
        }),
      ],
    },
    'PR09 restores the exact pinned library clause with real zone transitions and explicit choices.',
  );
  replaceCard(
    '9a63f950-2e8a-4617-896c-1d0af538dbc7',
    'Szarekh, the Silent King',
    [
      'unrecognized rules text: "My Will Be Done — Whenever ~ attacks, mill three cards. You may put an artifact creature card or Vehicle card from among the cards milled this way into your hand."',
    ],
    {
      triggers: [
        triggered(whenAttacks(SELF), {
          effects: [{ op: 'millAndChooseArtifact' }],
          description:
            'Mill three; you may return one artifact creature or Vehicle milled this way to your hand',
        }),
      ],
    },
    'PR09 restores the exact pinned library clause with real zone transitions and explicit choices.',
  );
  replaceCard(
    '504cc26d-3fd5-4391-9d30-f0614e5c8bbc',
    'Dream Pillager',
    [
      'unrecognized rules text: "Whenever this creature deals combat damage to a player, exile that many cards from the top of your library. Until end of turn, you may cast spells from among those exiled cards."',
    ],
    {
      triggers: [
        triggered(
          { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
          {
            effects: [
              { op: 'exileTopNPlayableUntilEot', count: { kind: 'damageDealt' }, castOnly: true },
            ],
            description:
              'Exile that many cards; until end of turn you may cast spells from among them',
          },
        ),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '470ec98e-120c-446d-ade6-7d80aa836b55',
    'Aetherworks Marvel',
    [
      'unrecognized rules text: "Whenever a permanent you control is put into a graveyard, you get {E} ."',
      'unrecognized rules text: "{T}, Pay six {E}: Look at the top six cards of your library. You may cast a spell from among them without paying its mana cost. Put the rest on the bottom of your library in a random order."',
    ],
    {
      triggers: [
        triggered(
          { when: 'dies', subject: { kind: 'permanent', selector: YOURS } },
          {
            effects: [{ op: 'gainEnergy', amount: constant(1) }],
            description: 'Whenever a permanent you control is put into a graveyard, get one energy',
          },
        ),
      ],
      activatedAbilities: [
        activated({
          costs: [TAP, { kind: 'payEnergy', amount: 6 }],
          effects: [{ op: 'lookAtTopNCastOneFree', count: 6 }],
          description: 'Look at six, optionally cast one spell for free, randomly bottom the rest',
        }),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '6c25c6b5-d98c-4eb4-aacd-b6960a8779a9',
    'Herald of Amity',
    [
      'unrecognized rules text: "When this creature enters, exile the top eight cards of your library. You may cast an Aura spell from among them without paying its mana cost. Then put the rest on the bottom of your library in a random order."',
      'unrecognized rules text: "Whenever this creature attacks, it gets +X/+X until end of turn, where X is the number of Auras you control."',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [
            {
              op: 'lookAtTopNCastOneFree',
              count: 8,
              filter: allOf(ofType('Enchantment'), ofSubtype('Aura')),
              visibility: 'exile',
            },
          ],
          description: 'Exile eight; optionally cast one Aura for free, randomly bottom the rest',
        }),
        triggered(whenAttacks(SELF), {
          effects: [
            {
              op: 'pumpUntilEot',
              target: 'source',
              power: { kind: 'countPermanents', selector: ofSubtype('Aura'), scope: 'you' },
              toughness: { kind: 'countPermanents', selector: ofSubtype('Aura'), scope: 'you' },
            },
          ],
          description: 'Get +X/+X until end of turn for your Auras',
        }),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '994bc16d-fdc6-475c-96df-beeb4d5aa03e',
    'Mystic Forge',
    [
      'unrecognized rules text: "You may cast artifact spells and colorless spells from the top of your library."',
      'unrecognized rules text: "{T}, Pay 1 life: Exile the top card of your library."',
    ],
    {
      ruleStatics: [
        { kind: 'lookTopLibrary' },
        {
          kind: 'castFromZone',
          zone: 'libraryTop',
          filter: anyOf(
            ofType('Artifact'),
            not(anyOf(ofColor('W'), ofColor('U'), ofColor('B'), ofColor('R'), ofColor('G'))),
          ),
        },
      ],
      activatedAbilities: [
        activated({
          costs: [TAP, { kind: 'payLife', amount: 1 }],
          effects: [{ op: 'exileLibraryTop', player: 'you' }],
          description: 'Exile the top card of your library',
        }),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '2598294c-a9a7-4bef-a562-23f297a80536',
    "Songbirds' Blessing",
    [
      'unrecognized rules text: "Whenever enchanted creature attacks, reveal cards from the top of your library until you reveal an Aura card. You may put that card onto the battlefield. If you don\'t, put it into your hand. Put the rest on the bottom of your library in a random order."',
    ],
    {
      triggers: [
        triggered(whenAttacks(ATTACHED), {
          effects: [{ op: 'revealUntilAura' }],
          description:
            'Reveal until an Aura; optionally put it onto the battlefield or put it into hand, randomly bottom the rest',
        }),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '7514e401-7aa1-405d-9f7a-312b4e630cc2',
    'Etali, Primal Conqueror // Etali, Primal Sickness',
    [
      'unrecognized rules text: "When ~ enters, each player exiles cards from the top of their library until they exile a nonland card. You may cast any number of spells from among the nonland cards exiled this way without paying their mana costs."',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [{ op: 'exileEachUntilNonlandCast' }],
          description:
            'Each player exiles until nonland; you may cast any number of those nonland cards for free',
        }),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '0866a630-d962-4aa9-a15f-08b2947540ef',
    'Cosmic Cube',
    [
      'unrecognized rules text: "Whenever you attack, look at the top six cards of your library. You may cast a spell from among them with mana value less than or equal to the greatest power among attacking creatures you control without paying its mana cost. Put the rest on the bottom of your library in a random order."',
    ],
    {
      triggers: [
        triggered(
          { when: 'attackDeclared', attacker: 'you' },
          {
            effects: [
              {
                op: 'lookAtTopNCastOneFree',
                count: 6,
                maxManaValue: {
                  kind: 'greatestPowerAmong',
                  selector: allOf(ofType('Creature'), { kind: 'combatRole', role: 'attacking' }),
                  scope: 'you',
                },
              },
            ],
            description:
              'Look at six; cast a spell for free up to your greatest attacking power, randomly bottom the rest',
          },
        ),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    'c7aecca5-2f67-4245-ab2d-e723d8b23a67',
    'Expressive Iteration',
    [
      'unrecognized rules text: "Look at the top three cards of your library. Put one of them into your hand, put one of them on the bottom of your library, and exile one of them. You may play the exiled card this turn."',
    ],
    {
      spellAbility: spell({
        effects: [{ op: 'partitionLibrary', count: 3, mode: 'handBottomExile' }],
        description: 'Look at three; one to hand, one to bottom, exile one playable this turn',
      }),
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    'af20f452-5cb9-47cc-9a81-71f23204ddd0',
    'Franklin Richards, Ascendant',
    [
      'unrecognized rules text: "At the beginning of combat on your turn, if you\'ve cast a noncreature spell this turn, discover 6."',
    ],
    {
      triggers: [
        triggered(onBeginCombat(), {
          condition: { kind: 'castSpellThisTurn', category: 'noncreature', cmp: '>=', n: 1 },
          effects: [{ op: 'discover', count: constant(6) }],
          description: 'If you cast a noncreature spell this turn, discover six',
        }),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '06f42f49-32f0-413b-8437-b8efa4d647c2',
    'Genesis Ultimatum',
    [
      'unrecognized rules text: "Look at the top five cards of your library. Put any number of permanent cards from among them onto the battlefield and the rest into your hand. Exile ~."',
    ],
    {
      spellAbility: spell({
        effects: [
          { op: 'partitionLibrary', count: 5, mode: 'permanentsAndHand' },
          { op: 'exileResolvingSpell' },
        ],
        description:
          'Look at five; put any number of permanents onto the battlefield and the rest into hand; exile this spell',
      }),
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    'ad9d969e-def5-45a3-b65b-0c776f62ef0e',
    'Into the Time Vortex',
    ['instant/sorcery with no interpretable effect'],
    {
      keywords: ['cascade', 'rebound'],
      spellAbility: spell({ effects: [], description: 'Cascade; rebound' }),
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '15fbb7b1-c62d-4f82-9f35-2c10299779f4',
    'Lurking Predators',
    [
      'unrecognized rules text: "Whenever an opponent casts a spell, reveal the top card of your library. If it\'s a creature card, put it onto the battlefield. Otherwise, you may put that card on the bottom of your library."',
    ],
    {
      triggers: [
        triggered(onCast('opponent'), {
          effects: [{ op: 'revealCreatureOrBottom' }],
          description:
            'Reveal top; put a creature onto the battlefield, otherwise optionally bottom it',
        }),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    'd4b5e09b-9ca2-4b51-a4f8-080741810df8',
    "Mind's Dilation",
    [
      'unrecognized rules text: "Whenever an opponent casts their first spell each turn, that player exiles the top card of their library. If it\'s a nonland card, you may cast it without paying its mana cost."',
    ],
    {
      triggers: [
        triggered(
          { when: 'castsSpell', caster: 'opponent', ordinal: 1 },
          {
            effects: [{ op: 'exileLibraryTop', player: 'eventPlayer', castFree: true }],
            description:
              'That opponent exiles their top card; you may cast a nonland card exiled this way for free',
          },
        ),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '6e27956e-ba2f-41a9-8e39-ec54424591b6',
    'Monstrous Vortex',
    [
      'unrecognized rules text: "Whenever you cast a creature spell with power 5 or greater, discover X, where X is that spell\'s mana value."',
    ],
    {
      triggers: [
        triggered(onCast('you', allOf(ofType('Creature'), { kind: 'powerAtLeast', n: 5 })), {
          effects: [{ op: 'discover', count: { kind: 'spellManaValue' } }],
          description:
            'Discover X, where X is the mana value of the creature spell with power five or greater',
        }),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '52714c3c-6821-44dd-88ba-813554df9914',
    'Path of Discovery',
    ['unrecognized rules text: "Whenever a creature you control enters, it explores."'],
    {
      triggers: [
        triggered(
          {
            when: 'enters',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
          },
          {
            effects: [{ op: 'explore', target: 'triggerObject' }],
            description: 'The entering creature explores',
          },
        ),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '10d482fd-e034-4187-b148-51fe15885360',
    "Sunbird's Invocation",
    [
      'unrecognized rules text: "Whenever you cast a spell from your hand, reveal the top X cards of your library, where X is that spell\'s mana value. You may cast a spell with mana value X or less from among cards revealed this way without paying its mana cost. Put the rest on the bottom of your library in a random order."',
    ],
    {
      triggers: [
        triggered(
          { when: 'castsSpell', caster: 'you', castFrom: 'hand' },
          {
            effects: [
              {
                op: 'lookAtTopNCastOneFree',
                count: { kind: 'spellManaValue' },
                maxManaValue: { kind: 'spellManaValue' },
                visibility: 'reveal',
              },
            ],
            description:
              'Reveal X; optionally cast a spell with mana value X or less for free, randomly bottom the rest',
          },
        ),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    '119d9671-61ba-4629-89b1-f94bdec5cb74',
    'Chimil, the Inner Sun',
    [
      'unrecognized rules text: "Spells you control can\'t be countered."',
      'unrecognized rules text: "At the beginning of your end step, discover 5."',
    ],
    {
      ruleStatics: [{ kind: 'cantBeCountered' }],
      triggers: [
        triggered(onEndStep(), {
          effects: [{ op: 'discover', count: constant(5) }],
          description: 'At your end step, discover five',
        }),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  replaceCard(
    'f2ef8bda-373d-4387-900d-0f1b6ccf72e9',
    'Trumpeting Carnosaur',
    ['unrecognized rules text: "When this creature enters, discover 5."'],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [{ op: 'discover', count: constant(5) }],
          description: 'Discover five',
        }),
      ],
      activatedAbilities: [
        activated({
          zone: 'hand',
          costs: [mana('{2}{R}'), { kind: 'discardSelf' }],
          targets: carnosaur.targets,
          effects: [{ op: 'dealDamage', target: carnosaur.slot.permanent, amount: constant(3) }],
          description:
            'Discard this card and pay {2}{R}: deal three to target creature or planeswalker',
        }),
      ],
    },
    'PR09 composes exact library, casting, and keyword instructions through the production engine.',
  );
  // New Generation's Technique is interpreted: the sneak parse rule reproduces this override.
  replaceCard(
    'd51136fa-3c13-48a5-83fd-51fe00010a4b',
    'Celebrate the Mountain-king',
    [
      'unrecognized rules text: "When this enchantment enters, for each opponent, exile up to one target nonland permanent that player controls until this enchantment leaves the battlefield."',
      'unrecognized rules text: "When this enchantment enters, recruit."',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          targets: celebrate.targets,
          effects: [
            { op: 'exileEachChosenUntilSourceLeaves', targetSlot: celebrate.slot.permanents },
          ],
          description:
            'For each opponent, exile up to one target nonland permanent that player controls until this enchantment leaves',
        }),
        triggered(onEtb(), {
          effects: [{ op: 'recruit' }],
          description:
            'Recruit: draw then discard, creating a Human Soldier if a nonland was discarded',
        }),
      ],
    },
    'PR09 implements each independent enter/attack clause with linked exile and real choices.',
  );
  replaceCard(
    '2e420001-2b3d-4eb7-b01c-3a49d5e241c2',
    'Rabble Rousing',
    [
      'unrecognized rules text: "Hideaway 5"',
      'unrecognized rules text: "Whenever you attack with one or more creatures, create that many 1/1 green and white Citizen creature tokens. Then if you control ten or more creatures, you may play the exiled card without paying its mana cost."',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [{ op: 'hideaway', count: 5 }],
          description: 'Hideaway five',
        }),
        triggered(
          { when: 'attackDeclared', attacker: 'you' },
          {
            effects: [
              { op: 'createToken', spec: CITIZEN_1_1_GREEN_WHITE, count: { kind: 'triggerCount' } },
              {
                op: 'conditionalEffect',
                condition: {
                  kind: 'countPermanents',
                  selector: ofType('Creature'),
                  scope: 'you',
                  cmp: '>=',
                  n: 10,
                },
                then: [{ op: 'playExiledCardFree' }],
                else: [],
              },
            ],
            description:
              'Create a Citizen for each attacker, then if you control ten creatures you may play the linked exiled card for free',
          },
        ),
      ],
    },
    'PR09 implements each independent enter/attack clause with linked exile and real choices.',
  );
  replaceCard(
    '6623cb85-fb1e-4561-8b21-0977c25096c2',
    "Tibalt's Trickery",
    [
      'unrecognized rules text: "Counter target spell. Choose 1, 2, or 3 at random. Its controller mills that many cards, then exiles cards from the top of their library until they exile a nonland card with a different name than that spell. They may cast that card without paying its mana cost. Then they put the exiled cards on the bottom of their library in a random order."',
    ],
    {
      spellAbility: spell({
        targets: trickery.targets,
        effects: [{ op: 'trickery', target: trickery.slot.spell }],
        description:
          'Counter target spell; randomly mill one to three, exile to a different nonland name, optionally cast it free, randomly bottom the rest',
      }),
    },
    'PR09 implements the pinned spell and modal permission through normal engine paths.',
  );
  replaceCard(
    '80788290-1569-4c7f-b263-b4da7b31a9d1',
    'Grenzo, Havoc Raiser',
    [
      'unrecognized rules text: "Whenever a creature you control deals combat damage to a player, choose one \u2014"',
      'unrecognized rules text: "\u2022 Goad target creature that player controls."',
      'unrecognized rules text: "\u2022 Exile the top card of that player\'s library. Until end of turn, you may cast that card and you may spend mana as though it were mana of any color to cast that spell."',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'dealsCombatDamageToPlayer',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
          },
          {
            targets: grenzo.targets,
            effects: [],
            modes: {
              minChoices: 1,
              maxChoices: 1,
              options: [
                {
                  targetSlots: [grenzo.slot.creature],
                  effects: [{ op: 'goad', target: grenzo.slot.creature }],
                  description: 'Goad target creature controlled by the damaged player',
                },
                {
                  targetSlots: [],
                  effects: [
                    {
                      op: 'exileLibraryTop',
                      player: 'eventPlayer',
                      grantCastUntilEot: true,
                      spendAsAnyColor: true,
                    },
                  ],
                  description:
                    'Exile their top card; until end of turn you may cast it, spending mana as any color',
                },
              ],
            },
            description:
              'Choose goad or exile the damaged player’s top card with a paid cast permission',
          },
        ),
      ],
    },
    'PR09 implements the pinned spell and modal permission through normal engine paths.',
  );
  replaceCard(
    '3d5c98ff-fcf1-42bd-9533-2648791a4f45',
    'Power Pack',
    [
      'unrecognized rules text: "Whenever ~ deals combat damage to a player, exile target instant or sorcery card from your graveyard chosen at random. At the beginning of your next upkeep, you may cast that card without paying its mana cost. If that spell would be put into your graveyard, exile it instead."',
    ],
    {
      triggers: [
        triggered(
          { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
          {
            targets: powerPack.targets,
            effects: [{ op: 'exileAndCastNextUpkeep', target: powerPack.slot.card }],
            description:
              'Exile a random target instant or sorcery in your graveyard; at your next upkeep optionally cast it free, exiling it if it would go to your graveyard',
          },
        ),
      ],
    },
    'PR09 implements random announcement and exact-object one-shot delayed casting.',
  );
  replaceCard(
    'fd4f0315-567a-4cc5-bc7e-88a9d2cee910',
    'Improvisation Capstone',
    [
      'unrecognized rules text: "Exile cards from the top of your library until you exile cards with total mana value 4 or greater. You may cast any number of spells from among them without paying their mana costs."',
      'unrecognized rules text: "Paradigm"',
    ],
    {
      spellAbility: spell({
        effects: [{ op: 'capstoneParadigm', minimumManaValue: 4 }],
        description:
          'Exile to total mana value four or greater; optionally cast any number of those spells free. Paradigm: exile this spell and copy it each of your future first main phases after its first resolution',
      }),
    },
    'PR09 implements total-mana-value reveal, normal free casts, and a permanent Paradigm delayed trigger.',
  );
}

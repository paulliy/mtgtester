/**
 * Coverage PR07 (docs/plans/card-coverage-chunks.md): combat requirements, restrictions and extra
 * combats. Authored cards that have no interpreter reading. This file is not part of the catalog
 * audit inventory; the cards PR07 restores are gated by `tests/pr07-card-coverage.test.ts`.
 */

import {
  activated,
  grantsKeyword,
  spell,
  onAttacks,
  onBeginCombat,
  onCombatDamageToPlayer,
  onEndStep,
  onEtb,
  onUpkeep,
  targetSlots,
  triggered,
  whenAttacks,
  whenPermanent,
} from '../templates';
import { allOfConditions, countPermanents } from '../condition';
import type { TokenSpec } from '../ability';
import { constant } from '../value';
import { BEAST_4_4_WHITE_CANT_ACT_ALONE, creatureToken, INKLING_2_1_FLYING } from '../tokens';
import {
  allOf,
  HAS_ANY_COUNTER,
  IS_TOKEN,
  named,
  OPPONENTS,
  ofSubtype,
  ofType,
  SELF,
  YOURS,
} from '../selector';
import { defineCard } from './index';

export function registerCoveragePr07Overrides(): void {
  // Lightning Runner: the energy is gained, then paid, as one resolution (the payment is not a
  // reflexive trigger). Paying untaps only creatures you control, and the extra combat phase is
  // created during combat, so it is the phase right after this one (CR 500.8).
  defineCard(
    '2f82b232-21ff-44cc-bc35-0999a1d1c52f',
    'Lightning Runner',
    [
      'Whenever this creature attacks, you get {E}{E} , then you may pay eight {E}. If you pay, untap all creatures you control, and after this phase, there is an additional combat phase.',
    ],
    {
      triggers: [
        triggered(onAttacks(), {
          effects: [
            { op: 'gainEnergy', amount: constant(2) },
            {
              op: 'mayPayEnergy',
              amount: constant(8),
              then: [
                { op: 'untapEach', selector: allOf(ofType('Creature'), YOURS) },
                { op: 'extraCombatPhase' },
              ],
            },
          ],
          description:
            'Whenever this creature attacks, you get {E}{E}, then you may pay eight {E}. If you pay, untap all creatures you control, and after this phase, there is an additional combat phase',
        }),
      ],
    },
  );

  // Firkraag, Cunning Instigator: the first ability triggers once for each opponent attacked by
  // one or more of your Dragons (a planeswalker attack is not an attack on that opponent), and
  // the goaded creature is one that opponent controls. The second is an intervening-if about the
  // creature that dealt the damage, not Firkraag (CR 603.4): it must have been required to attack
  // this combat, and the damage went to one of YOUR opponents, which can be a player another
  // opponent's creature attacked. Both are checked as the ability triggers and as it resolves,
  // from last known information if that creature has left the battlefield (CR 608.2h).
  const goad = targetSlots({ creature: { kind: 'creature', controller: 'eventPlayer' } });
  defineCard(
    '81dad7c5-5950-4c45-adb0-cf1a15a74250',
    'Firkraag, Cunning Instigator',
    [
      'Whenever one or more Dragons you control attack an opponent, goad target creature that player controls.',
      'Whenever a creature deals combat damage to one of your opponents, if that creature had to attack this combat, you put a +1/+1 counter on ~ and you draw a card.',
    ],
    {
      triggers: [
        triggered(whenAttacks(allOf(ofSubtype('Dragon'), YOURS), { aggregate: 'byEventPlayer' }), {
          targets: goad.targets,
          effects: [{ op: 'goad', target: goad.slot.creature }],
          description:
            'Whenever one or more Dragons you control attack an opponent, goad target creature that player controls',
        }),
        triggered(whenPermanent('dealsCombatDamageToPlayer', ofType('Creature')), {
          condition: allOfConditions(
            { kind: 'triggerObjectHadToAttackThisCombat' },
            { kind: 'triggerObjectAttackingOpponent' },
          ),
          effects: [
            { op: 'putCountersEach', selector: SELF, counter: '+1/+1', count: 1 },
            { op: 'draw', count: constant(1) },
          ],
          description:
            'Whenever a creature deals combat damage to one of your opponents, if that creature had to attack this combat, you put a +1/+1 counter on Firkraag and you draw a card',
        }),
      ],
    },
  );

  // Eriette of the Charmed Apple: the restriction covers every creature enchanted by an Aura you
  // control (that Aura may be any Aura, on any creature), whoever controls the creature. The
  // drain counts ALL Auras you control, attached to anything or not, once as it resolves.
  const aurasYouControl = {
    kind: 'countPermanents',
    selector: allOf(ofSubtype('Aura'), YOURS),
    scope: 'you',
  } as const;
  defineCard(
    'f43f5855-f297-4433-984b-18263b734cfc',
    'Eriette of the Charmed Apple',
    [
      "Each creature that's enchanted by an Aura you control can't attack you or planeswalkers you control.",
      'At the beginning of your end step, each opponent loses X life and you gain X life, where X is the number of Auras you control.',
    ],
    {
      ruleStatics: [
        {
          kind: 'attackRestriction',
          filter: { kind: 'enchantedByAuraYouControl' },
          includePlaneswalkers: true,
        },
      ],
      triggers: [
        triggered(onEndStep('you'), {
          effects: [
            { op: 'eachOpponentLosesLife', amount: aurasYouControl },
            { op: 'gainLife', amount: aurasYouControl },
          ],
          description:
            'At the beginning of your end step, each opponent loses X life and you gain X life, where X is the number of Auras you control',
        }),
      ],
    },
  );

  // Rite of the Raging Storm: the restriction names the creatures, so a Lightning Rager made by
  // any other source is covered too, and a copy of one is not (a copy has the copied name).
  // Each player's upkeep gives THAT player (not Rite's controller) the token, and the token's own
  // ability sacrifices it at the beginning of the next end step, whoever's turn it is.
  const LIGHTNING_RAGER: TokenSpec = {
    ...creatureToken({
      name: 'Lightning Rager',
      subtypes: ['Elemental'],
      colors: ['R'],
      power: 5,
      toughness: 1,
      keywords: ['trample', 'haste'],
    }),
    triggers: [
      triggered(onEndStep('each'), {
        effects: [{ op: 'sacrifice', target: 'source' }],
        description: 'At the beginning of the end step, sacrifice this token',
      }),
    ],
  };
  defineCard(
    '984f92dd-cb9b-4421-a8e6-75bfe566be10',
    'Rite of the Raging Storm',
    [
      "Creatures named Lightning Rager can't attack you or planeswalkers you control.",
      'At the beginning of each player\'s upkeep, that player creates a 5/1 red Elemental creature token named Lightning Rager. It has trample, haste, and "At the beginning of the end step, sacrifice this token."',
    ],
    {
      ruleStatics: [
        {
          kind: 'attackRestriction',
          filter: named('Lightning Rager'),
          includePlaneswalkers: true,
        },
      ],
      triggers: [
        triggered(onUpkeep('each'), {
          effects: [
            {
              op: 'createTokenForPlayer',
              target: 'eventPlayer',
              spec: LIGHTNING_RAGER,
              count: constant(1),
            },
          ],
          description:
            'At the beginning of each player\'s upkeep, that player creates a 5/1 red Elemental creature token named Lightning Rager with trample, haste, and "At the beginning of the end step, sacrifice this token."',
        }),
      ],
    },
  );

  // Nils, Discipline Enforcer: the trigger has one optional target slot for each player in the
  // game (you included), each a creature that player controls, chosen as it goes on the stack
  // (CR 603.3d); each target that is still legal as it resolves gets a +1/+1 counter. The static
  // is a tax, not a ban: a creature with counters on it (of any kind) can attack you or your
  // planeswalkers if its controller pays {X}, X being the counters on that creature, which is
  // charged per creature and never forced (CR 508.1d).
  const grow = targetSlots({
    creature: { kind: 'creature', count: { min: 0, max: 1 }, perPlayer: true },
  });
  defineCard(
    'ff6b52b7-ae3c-465b-b10e-901160e5230e',
    'Nils, Discipline Enforcer',
    [
      'At the beginning of your end step, for each player, put a +1/+1 counter on up to one target creature that player controls.',
      "Each creature with one or more counters on it can't attack you or planeswalkers you control unless its controller pays {X}, where X is the number of counters on that creature.",
    ],
    {
      ruleStatics: [
        {
          kind: 'attackRestriction',
          filter: allOf(ofType('Creature'), HAS_ANY_COUNTER),
          includePlaneswalkers: true,
          cost: { perCounterOnCreature: true },
        },
      ],
      triggers: [
        triggered(onEndStep('you'), {
          targets: grow.targets,
          effects: [
            {
              op: 'putCountersEachChosen',
              targetSlot: grow.slot.creature,
              counter: '+1/+1',
              count: 1,
            },
          ],
          description:
            'At the beginning of your end step, for each player, put a +1/+1 counter on up to one target creature that player controls',
        }),
      ],
    },
  );

  // Combat Calligrapher: the static covers every Inkling, token or not, whoever controls it. The
  // trigger is per attacked opponent of yours (an attack on a planeswalker is not an attack on that
  // opponent): the ATTACKING player, who may be you, creates the token, tapped and attacking that
  // opponent. It was put onto the battlefield attacking, never declared as an attacker, so no
  // attack trigger sees it and the restriction above does not apply to it (CR 506.3, 508.4).
  defineCard(
    'ee7ebbc1-2f9e-4867-a522-424869b6d772',
    'Combat Calligrapher',
    [
      "Inklings can't attack you or planeswalkers you control.",
      "Whenever a player attacks one of your opponents, that attacking player creates a tapped 2/1 white and black Inkling creature token with flying that's attacking that opponent.",
    ],
    {
      ruleStatics: [
        {
          kind: 'attackRestriction',
          filter: ofSubtype('Inkling'),
          includePlaneswalkers: true,
        },
      ],
      triggers: [
        triggered(
          {
            when: 'attackDeclared',
            attacker: 'any',
            attacking: { who: 'opponent', planeswalkers: false },
            perDefender: true,
          },
          {
            effects: [
              {
                op: 'createTokenAttacking',
                spec: INKLING_2_1_FLYING,
                count: constant(1),
                player: 'eventPlayer',
                defender: 'attackedPlayer',
              },
            ],
            description:
              "Whenever a player attacks one of your opponents, that attacking player creates a tapped 2/1 white and black Inkling creature token with flying that's attacking that opponent",
          },
        ),
      ],
    },
  );

  // Goblin Spymaster: the token is made for the opponent whose end step it is, not for Spymaster's
  // controller. Its static is the token's own ability, so "you" is whoever controls the token: it
  // covers creatures that player controls later on, and ends when the token leaves the battlefield.
  const GOBLIN_SPY: TokenSpec = {
    ...creatureToken({
      name: 'Goblin',
      subtypes: ['Goblin'],
      colors: ['R'],
      power: 1,
      toughness: 1,
    }),
    staticEffects: [
      {
        affects: allOf(ofType('Creature'), YOURS),
        op: { layer: 6, setMustAttackEachCombat: true },
      },
    ],
  };
  defineCard(
    'ec08df88-3c13-4940-a090-0c502b9b12f1',
    'Goblin Spymaster',
    [
      'At the beginning of each opponent\'s end step, that player creates a 1/1 red Goblin creature token with "Creatures you control attack each combat if able."',
    ],
    {
      triggers: [
        triggered(onEndStep('opponent'), {
          effects: [
            {
              op: 'createTokenForPlayer',
              target: 'eventPlayer',
              spec: GOBLIN_SPY,
              count: constant(1),
            },
          ],
          description:
            'At the beginning of each opponent\'s end step, that player creates a 1/1 red Goblin creature token with "Creatures you control attack each combat if able."',
        }),
      ],
    },
  );

  // Toby, Beastie Befriender: the Beast's restriction is its own ability, so it is lost with the
  // token's abilities and applies to that token only (CR 506.5: it attacks or blocks alone when it
  // is the only creature declared as an attacker, or as a blocker by its controller). The flying
  // static is checked continuously: it applies exactly while you control four or more creature
  // tokens, and covers every creature token you control, whoever created it.
  const creatureTokens = allOf(ofType('Creature'), IS_TOKEN);
  defineCard(
    'b4c27c89-fa50-4cf0-bf37-039732d16fef',
    'Toby, Beastie Befriender',
    [
      'When ~ enters, create a 4/4 white Beast creature token with "~ can\'t attack or block alone."',
      'As long as you control four or more creature tokens, creature tokens you control have flying.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [
            { op: 'createToken', spec: BEAST_4_4_WHITE_CANT_ACT_ALONE, count: constant(1) },
          ],
          description:
            'When Toby enters, create a 4/4 white Beast creature token with "This token can\'t attack or block alone."',
        }),
      ],
      staticEffects: [
        {
          ...grantsKeyword(allOf(creatureTokens, YOURS), 'flying'),
          condition: countPermanents(creatureTokens, 'you', '>=', 4),
        },
      ],
    },
  );

  // Life of the Party: the attack trigger's X is the number of creatures you control as it
  // resolves. The enters trigger is an intervening-if (CR 603.4) about the permanent that
  // entered: with a token it never triggers. EACH opponent creates their own copy (so any
  // replacement of THEIR token creation applies and the copy is theirs), and the ability's
  // controller goads every copy for the rest of the game. It copies Life of the Party with its
  // last known copiable values if it has already left the battlefield (CR 608.2h).
  defineCard(
    'b2d1f87b-a11f-43eb-8b89-b48945320d73',
    'Life of the Party',
    [
      'Whenever ~ attacks, it gets +X/+0 until end of turn, where X is the number of creatures you control.',
      "When ~ enters, if it's not a token, each opponent creates a token that's a copy of it. The tokens are goaded for the rest of the game.",
    ],
    {
      triggers: [
        triggered(onAttacks(), {
          effects: [
            {
              op: 'pumpUntilEot',
              target: 'source',
              power: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' },
              toughness: 0,
            },
          ],
          description:
            'Whenever Life of the Party attacks, it gets +X/+0 until end of turn, where X is the number of creatures you control',
        }),
        triggered(onEtb(), {
          condition: { kind: 'sourceMatches', selector: { kind: 'not', of: IS_TOKEN } },
          effects: [
            {
              op: 'createTokenCopyOf',
              ref: 'source',
              count: constant(1),
              eachOpponent: true,
              goadedForRestOfGame: true,
            },
          ],
          description:
            "When Life of the Party enters, if it's not a token, each opponent creates a token that's a copy of it. The tokens are goaded for the rest of the game",
        }),
      ],
    },
  );

  // Kardur, Doomscourge: the enters ability is an attack REQUIREMENT with a duration, not a goad:
  // it covers every creature your opponents control, now and later (CR 611.2c), until your next
  // turn begins, and has two parts that are counted separately (CR 508.1d): attack each combat,
  // and attack a player other than you. A planeswalker attack obeys only the first, so a creature
  // that can attack another player must, and one that can't must still attack you or a
  // planeswalker. The death trigger needs the creature to have been ATTACKING as it died, read
  // from last known information, so a blocker never counts.
  defineCard(
    'bc14356c-3a1a-47af-9a6e-2b449de0331f',
    'Kardur, Doomscourge',
    [
      'When ~ enters, until your next turn, creatures your opponents control attack each combat if able and attack a player other than you if able.',
      'Whenever an attacking creature dies, each opponent loses 1 life and you gain 1 life.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [
            {
              op: 'addAttackRequirement',
              selector: allOf(ofType('Creature'), { kind: 'controller', who: 'opponents' }),
              requirements: [{ kind: 'anyAttack' }, { kind: 'notPlayer', player: 'you' }],
              duration: 'untilYourNextTurn',
            },
          ],
          description:
            'When Kardur enters, until your next turn, creatures your opponents control attack each combat if able and attack a player other than you if able',
        }),
        triggered(
          whenPermanent(
            'dies',
            allOf(ofType('Creature'), { kind: 'combatRole', role: 'attacking' }),
          ),
          {
            effects: [
              { op: 'eachOpponentLosesLife', amount: constant(1) },
              { op: 'gainLife', amount: constant(1) },
            ],
            description:
              'Whenever an attacking creature dies, each opponent loses 1 life and you gain 1 life',
          },
        ),
      ],
    },
  );

  // Galactus, Devourer of Worlds: Insatiable Hunger is a requirement of Galactus itself (it is
  // lost with its abilities), not a goad: it attacks an opponent with the most life among its
  // controller's opponents, any of them on a tie, read as attackers are declared. Only a player
  // obeys it, never a planeswalker, and when it can't attack such a player nothing is required.
  // It does not apply while you control a creature named Silver Surfer, Galactus's Herald. Flying,
  // trample, indestructible and the exile trigger are read by the interpreter.
  defineCard(
    '4232995b-68c0-4514-8cde-bc62b9d1cbaa',
    'Galactus, Devourer of Worlds',
    [
      "Insatiable Hunger — ~ attacks an opponent with the most life among your opponents each combat if able unless you control a creature named Silver Surfer, ~'s Herald.",
    ],
    {
      ruleStatics: [
        {
          kind: 'attackRequirement',
          target: 'opponentWithMostLife',
          unless: countPermanents(
            allOf(ofType('Creature'), named("Silver Surfer, Galactus's Herald")),
            'you',
            '>=',
            1,
          ),
        },
      ],
    },
  );

  // Silver Surfer, Galactus's Herald: the search is "you may": declining searches nothing and
  // shuffles nothing, while searching and finding no card still shuffles (the shuffle is part of
  // the search). The found card is revealed. The damage trigger targets any creature; the
  // requirement names that creature and THE DAMAGED PLAYER, and lasts until the end of your next
  // turn (it ends in that turn's cleanup step). A planeswalker never obeys "attacks that player".
  const surfer = targetSlots({ creature: { kind: 'creature' } });
  defineCard(
    'be02005c-0e37-4dba-ac8e-3c69d06bbec2',
    "Silver Surfer, Galactus's Herald",
    [
      'When ~ enters, you may search your library for a card named Galactus, Devourer of Worlds, reveal it, put it into your hand, then shuffle.',
      'Whenever ~ deals combat damage to a player, until the end of your next turn, target creature attacks that player each combat if able.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          optional: true,
          effects: [
            {
              op: 'searchLibrary',
              filter: named('Galactus, Devourer of Worlds'),
              destinations: [{ zone: 'hand' }],
              allowFailToFind: true,
              reveal: true,
            },
            { op: 'shuffle' },
          ],
          description:
            'When Silver Surfer enters, you may search your library for a card named Galactus, Devourer of Worlds, reveal it, put it into your hand, then shuffle',
        }),
        triggered(onCombatDamageToPlayer(), {
          targets: surfer.targets,
          effects: [
            {
              op: 'addAttackRequirement',
              target: surfer.slot.creature,
              requirements: [{ kind: 'player', player: 'eventPlayer' }],
              duration: 'endOfYourNextTurn',
            },
          ],
          description:
            'Whenever Silver Surfer deals combat damage to a player, until the end of your next turn, target creature attacks that player each combat if able',
        }),
      ],
    },
  );

  // Taunt from the Rampart: "those creatures" are the ones goaded, a set fixed as this resolves
  // (CR 611.2c), so creatures an opponent gets later are neither goaded nor kept from blocking, and
  // a creature that changes hands stays in it. The goad and the can't-block both end as your next
  // turn begins.
  const opponentCreatures = allOf(ofType('Creature'), { kind: 'controller', who: 'opponents' });
  defineCard(
    '9138a768-d01d-4603-9bae-d3bff6cd2f61',
    'Taunt from the Rampart',
    [
      "Goad all creatures your opponents control. Until your next turn, those creatures can't block.",
    ],
    {
      spellAbility: spell({
        effects: [
          { op: 'goadEachOpponent' },
          { op: 'cantBlockEach', selector: opponentCreatures, duration: 'untilYourNextTurn' },
        ],
        description:
          "Goad all creatures your opponents control. Until your next turn, those creatures can't block",
      }),
    },
  );

  // Hexmark Destroyer: not "can't be blocked" and not menace: either nobody blocks it or six or
  // more creatures do (CR 509.1b), counted across the whole declaration of its defending player.
  // The rule is its own, so it is lost with its abilities, and a copy has it. Unearth is read by
  // the interpreter.
  defineCard(
    'b3329240-c812-45ea-a7f8-4d79cd4ed515',
    'Hexmark Destroyer',
    ["Multi-threat Eliminator — ~ can't be blocked except by six or more creatures."],
    { ruleStatics: [{ kind: 'minBlockers', minimum: 6 }] },
  );

  // Champion of Lambholt: a rule static of the Champion itself, so it is lost with its abilities
  // and a copy has it, and it compares against the Champion's CURRENT power (counters, anthems).
  // It restricts blocks of creatures its controller controls, whoever the blockers are. The
  // counter trigger is read by the interpreter.
  defineCard(
    'c549b0fd-1e08-4873-952e-a14dc45a0fd2',
    'Champion of Lambholt',
    ["Creatures with power less than this creature's power can't block creatures you control."],
    {
      ruleStatics: [
        { kind: 'cantBlockCreatures', attackerFilter: YOURS, blockerPowerLessThanSource: true },
      ],
    },
  );

  // Pramikon, Sky Rampart: the direction is chosen as it enters (a replacement, so it exists
  // before anything can attack) and the restriction is a rule static of Pramikon itself, so it is
  // lost with its abilities and gone when it leaves. Flying and defender are read by the interpreter.
  defineCard(
    '377d0fa7-1b3d-4b97-b066-dceeff3734d0',
    'Pramikon, Sky Rampart',
    [
      'As ~ enters, choose left or right.',
      'Each player may attack only the nearest opponent in the chosen direction and planeswalkers controlled by that opponent.',
    ],
    {
      entersChoosingOption: {
        prompt: 'choose left or right',
        options: [
          { key: 'left', label: 'Left' },
          { key: 'right', label: 'Right' },
        ],
      },
      ruleStatics: [{ kind: 'attackOnlyNearestOpponent' }],
    },
  );

  const teyo = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
  // Teyo, Geometric Tactician: the Wall token line is read by the interpreter. The −2 asks
  // left or right as it resolves and the limit is game state until the controller's next turn,
  // so a newer −2 replaces the older one and Pramikon's static still applies beside it.
  defineCard(
    '0dfdf1a1-a3a9-490f-bd9d-dcba088c6785',
    'Teyo, Geometric Tactician',
    [
      '+1: You and target opponent each draw a card.',
      '−2: Choose left or right. Until your next turn, each player may attack only the nearest opponent in the last chosen direction and planeswalkers controlled by that opponent.',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [{ kind: 'loyalty', delta: 1 }],
          timing: 'sorcery',
          targets: teyo.targets,
          effects: [{ op: 'drawTargetAndController', target: teyo.slot.opponent }],
          description: '+1: You and target opponent each draw a card',
        }),
        activated({
          costs: [{ kind: 'loyalty', delta: -2 }],
          timing: 'sorcery',
          effects: [
            {
              op: 'chooseOne',
              options: (['left', 'right'] as const).map((direction) => ({
                description: direction === 'left' ? 'Left' : 'Right',
                effects: [
                  { op: 'limitAttacksToNearestOpponent', direction, duration: 'untilYourNextTurn' },
                ],
              })),
            },
          ],
          description:
            '−2: Choose left or right. Until your next turn, each player may attack only the nearest opponent in the last chosen direction and planeswalkers controlled by that opponent',
        }),
      ],
    },
  );

  // Triarch Stalker: the choice is made as the trigger resolves and stored on the Stalker itself,
  // so each new choice replaces the last ("the last chosen player") and a copy starts with none.
  // Menace goes to creatures of any controller attacking that player (not their planeswalkers).
  defineCard(
    '1b3ae9c3-1940-4fb8-a47c-2d9e1790f4a3',
    'Triarch Stalker',
    [
      'Targeting Relay — At the beginning of combat on your turn, choose an opponent.',
      'Creatures attacking the last chosen player have menace.',
    ],
    {
      triggers: [
        triggered(onBeginCombat('you'), {
          effects: [{ op: 'chooseOpponentForSource' }],
          description: 'At the beginning of combat on your turn, choose an opponent',
        }),
      ],
      staticEffects: [
        grantsKeyword(allOf(ofType('Creature'), { kind: 'attackingChosenPlayer' }), 'menace'),
      ],
    },
  );

  // Illusionist's Gambit: castable only in the declare blockers step of an opponent's turn. It
  // removes every creature attacking when it resolves (a fixed set, CR 611.2c) and untaps them;
  // the additional combat comes right after this phase, and for that combat only those creatures
  // must attack if able and can't attack you or planeswalkers you control (restrictions win).
  defineCard(
    '333745d9-e930-439b-94d6-3aeea2877f69',
    "Illusionist's Gambit",
    [
      "Cast this spell only during the declare blockers step on an opponent's turn.",
      "Remove all attacking creatures from combat and untap them. After this phase, there is an additional combat phase. Each of those creatures attacks that combat if able. They can't attack you or planeswalkers you control that combat.",
    ],
    {
      castRestriction: allOfConditions(
        { kind: 'duringStep', step: 'declareBlockers' },
        { kind: 'notYourTurn' },
      ),
      spellAbility: spell({
        effects: [
          {
            op: 'removeAttackersFromCombat',
            untap: true,
            thenCombat: true,
          },
        ],
        description:
          "Remove all attacking creatures from combat and untap them. After this phase, there is an additional combat phase. Each of those creatures attacks that combat if able. They can't attack you or planeswalkers you control that combat",
      }),
    },
  );

  // Moraug, Fury of Akoum: the pump reads how many times EACH creature has attacked, so it is a
  // per-object value in the layer, counting declared attacks only (a token put onto the
  // battlefield attacking never attacked). The landfall trigger is an intervening-if about the
  // phase (your main phase, checked as it triggers and as it resolves); the additional combat goes
  // right after that main phase and untaps your creatures at its beginning, as a trigger.
  defineCard(
    '6288c0cb-cf32-4ae9-abf0-104ec71654fa',
    'Moraug, Fury of Akoum',
    [
      'Each creature you control gets +1/+0 for each time it has attacked this turn.',
      "Whenever a land you control enters, if it's your main phase, there's an additional combat phase after this phase. At the beginning of that combat, untap all creatures you control.",
    ],
    {
      staticEffects: [
        {
          affects: allOf(ofType('Creature'), YOURS),
          op: {
            layer: 7,
            sublayer: 'd',
            power: { kind: 'timesAttackedThisTurn' },
            toughness: 0,
          },
        },
      ],
      triggers: [
        triggered(whenPermanent('enters', allOf(ofType('Land'), YOURS)), {
          condition: { kind: 'duringYourMainPhase' },
          effects: [{ op: 'extraCombatPhase', untapYourCreatures: true }],
          description:
            "Landfall — Whenever a land you control enters, if it's your main phase, there's an additional combat phase after this phase. At the beginning of that combat, untap all creatures you control",
        }),
      ],
    },
  );

  // Siren's Call: castable on an opponent's turn before attackers are declared. "Attack this turn
  // if able" is a rules modification from a resolving spell, read live for the active player's
  // creatures so ones that arrive later are covered too (CR 611.2c). The delayed trigger destroys
  // the non-Walls that player controls at the next end step that neither attacked (declared
  // attackers only) nor were put under their control after their turn began.
  defineCard(
    '269fc857-a052-4f0a-9759-467ccf42bebb',
    "Siren's Call",
    [
      "Cast this spell only during an opponent's turn, before attackers are declared.",
      'Creatures the active player controls attack this turn if able.',
      "At the beginning of the next end step, destroy all non-Wall creatures that player controls that didn't attack this turn. Ignore this effect for each creature the player didn't control continuously since the beginning of the turn.",
    ],
    {
      castRestriction: allOfConditions(
        { kind: 'notYourTurn' },
        { kind: 'beforeAttackersDeclared' },
      ),
      spellAbility: spell({
        effects: [
          {
            op: 'addAttackRequirement',
            selector: allOf(ofType('Creature'), YOURS),
            relativeTo: 'activePlayer',
            requirements: [{ kind: 'anyAttack' }],
            duration: 'thisTurn',
          },
          {
            op: 'registerDelayedTrigger',
            when: 'endStep',
            expiry: 'endStep',
            affectedPlayer: 'activePlayer',
            ability: triggered(onEndStep('each'), {
              effects: [
                {
                  op: 'destroyEach',
                  selector: allOf(
                    ofType('Creature'),
                    { kind: 'not', of: ofSubtype('Wall') },
                    { kind: 'controller', who: 'eventPlayer' },
                    { kind: 'not', of: { kind: 'attackedThisTurn' } },
                    { kind: 'controlledSinceTurnStart' },
                  ),
                },
              ],
              description:
                "Destroy all non-Wall creatures that player controls that didn't attack this turn, ignoring each they didn't control continuously since the beginning of the turn",
            }),
          },
        ],
        description:
          "Creatures the active player controls attack this turn if able. At the beginning of the next end step, destroy all non-Wall creatures that player controls that didn't attack this turn, ignoring each they didn't control continuously since the beginning of the turn",
      }),
    },
  );

  // War's Toll: the trigger is about a land tapped to activate a mana ability by an opponent (the
  // event player is whoever tapped it); tapping lands by an effect does not count, so the trigger's
  // own tapping cannot loop. The second line is a rule static read on each opponent's whole attack
  // declaration, not a goad on creatures.
  defineCard(
    'ba4e4afb-24bb-47de-aba8-89d21b11d45c',
    "War's Toll",
    [
      'Whenever an opponent taps a land for mana, tap all lands that player controls.',
      'If a creature an opponent controls attacks, all creatures that opponent controls attack if able.',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'becomesTapped',
            subject: { kind: 'permanent', selector: allOf(ofType('Land'), OPPONENTS) },
            forMana: true,
          },
          {
            effects: [
              {
                op: 'tapEach',
                selector: allOf(ofType('Land'), { kind: 'controller', who: 'eventPlayer' }),
              },
            ],
            description:
              'Whenever an opponent taps a land for mana, tap all lands that player controls',
          },
        ),
      ],
      ruleStatics: [{ kind: 'opponentsAttackWithAll' }],
    },
  );

  // Willie Lumpkin: its controller draws, then the damaged player chooses whether to draw; only if
  // they do, they can't attack its controller or their planeswalkers during THEIR next turn (not
  // "until your next turn": it lasts only while they are the active player in that turn). It is a
  // rules modification on the player (CR 611.2c), so creatures they get later are covered too.
  // Battles are not modeled, so "permanents you control" covers the player and planeswalkers.
  defineCard(
    'b08633e9-7b8f-4f69-a3b7-8d982b17574c',
    'Willie Lumpkin, Postman',
    [
      "Whenever ~ deals combat damage to an opponent, you draw a card and that player may draw a card. If they do, that player can't attack you or permanents you control during their next turn.",
    ],
    {
      triggers: [
        triggered(whenPermanent('dealsCombatDamageToPlayer', SELF), {
          effects: [
            { op: 'draw', count: constant(1) },
            {
              op: 'eventPlayerMayDraw',
              then: [
                {
                  op: 'addAttackRequirement',
                  selector: allOf(ofType('Creature'), YOURS),
                  relativeTo: 'eventPlayer',
                  requirements: [],
                  cantAttack: 'you',
                  duration: 'duringTheirNextTurn',
                },
              ],
            },
          ],
          description:
            "Whenever Willie Lumpkin deals combat damage to an opponent, you draw a card and that player may draw a card. If they do, that player can't attack you or permanents you control during their next turn",
        }),
      ],
    },
  );

  // Fight or Flight: the enchantment's controller separates the creatures that player controls (CR
  // 700.3), the player whose turn it is chooses a pile, and only creatures in it can attack this
  // turn. Creatures that arrive afterwards are in neither pile, and the trigger fires again at the
  // beginning of an extra combat, so a creature must then be in every pile chosen this turn.
  defineCard(
    '2fc42640-983a-49ca-9020-7756135077b4',
    'Fight or Flight',
    [
      "At the beginning of combat on each opponent's turn, separate all creatures that player controls into two piles. Only creatures in the pile of their choice can attack this turn.",
    ],
    {
      triggers: [
        triggered(onBeginCombat('opponent'), {
          effects: [{ op: 'separateIntoPilesLimitAttackers' }],
          description:
            "At the beginning of combat on each opponent's turn, separate all creatures that player controls into two piles. Only creatures in the pile of their choice can attack this turn",
        }),
      ],
    },
  );
}

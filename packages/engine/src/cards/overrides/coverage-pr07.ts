/**
 * Coverage PR07 (docs/plans/card-coverage-chunks.md): combat requirements, restrictions and extra
 * combats. Authored cards that have no interpreter reading. This file is not part of the catalog
 * audit inventory; the cards PR07 restores are gated by `tests/pr07-card-coverage.test.ts`.
 */

import {
  grantsKeyword,
  onAttacks,
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
}

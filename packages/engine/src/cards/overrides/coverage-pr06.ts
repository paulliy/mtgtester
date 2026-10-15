/**
 * Coverage PR06 (docs/plans/card-coverage-chunks.md): cards that had no registration at all, and
 * containment for cards that PR06's engine work happened to make readable before their own
 * evidence lands. This file is not part of the catalog audit inventory; the cards PR06 restores
 * are gated by `tests/pr06-card-coverage.test.ts`.
 */

import {
  manaCost,
  onAttacks,
  onEtb,
  spell,
  targetSlots,
  triggered,
  whenAttacks,
  whenPermanent,
} from '../templates';
import { constant } from '../value';
import { allOf, ofType, OPPONENTS, OTHER, withKeyword, YOURS } from '../selector';
import { defineCard, extendCard, unsupportedCard } from './index';

export function registerCoveragePr06Overrides(): void {
  // Flameblast Dragon: "if you do" is not a reflexive trigger (only "when you do" is, CR 603.12).
  // The ability targets, so the target is chosen when the trigger goes on the stack (CR 603.3d);
  // X is chosen and the cost paid on resolution (CR 107.3b), and the Dragon deals the damage
  // (last known information if it has left the battlefield, CR 608.2h).
  const blast = targetSlots({ victim: { kind: 'anyTarget' } });
  defineCard(
    '3180ee4f-66d7-4b73-bc10-9ee0c790ec18',
    'Flameblast Dragon',
    [
      'Whenever this creature attacks, you may pay {X}{R}. If you do, it deals X damage to any target.',
    ],
    {
      triggers: [
        triggered(onAttacks(), {
          targets: blast.targets,
          effects: [
            {
              op: 'mayPayXThenDealDamage',
              target: blast.slot.victim,
              templatedCost: manaCost('{X}{R}'),
            },
          ],
          description:
            'Whenever this creature attacks, you may pay {X}{R}. If you do, it deals X damage to any target',
        }),
      ],
    },
  );

  // Firemane Commando: both abilities trigger once as the attack is declared, when that player
  // declares two or more attackers, whoever or whatever they attack (planeswalkers included). The
  // count is a trigger condition checked as the attack is declared, not an intervening-if. "They"
  // in the second is the attacking player, who draws unless any of those creatures attacked YOU,
  // the player and not your planeswalkers, as declared, so a creature later removed from combat
  // still attacked you. That is judged as the ability resolves, from the declaration.
  defineCard(
    'ac675899-25bb-4f06-9c8c-bf188024495f',
    'Firemane Commando',
    [
      'Whenever you attack with two or more creatures, draw a card.',
      'Whenever another player attacks with two or more creatures, they draw a card if none of those creatures attacked you.',
    ],
    {
      triggers: [
        triggered(
          { when: 'attackDeclared', attacker: 'you', minAttackers: 2 },
          {
            effects: [{ op: 'draw', count: constant(1) }],
            description: 'Whenever you attack with two or more creatures, draw a card',
          },
        ),
        triggered(
          { when: 'attackDeclared', attacker: 'otherPlayer', minAttackers: 2 },
          {
            effects: [
              {
                op: 'conditionalEffect',
                condition: { kind: 'attackWasNotAtYou' },
                then: [{ op: 'draw', count: constant(1), player: 'eventPlayer' }],
                else: [],
              },
            ],
            description:
              'Whenever another player attacks with two or more creatures, they draw a card if none of those creatures attacked you',
          },
        ),
      ],
    },
  );

  // Breena, the Demagogue: triggers once for each attacked opponent of yours, per declaration, for
  // any player's attack, yours included: a player attacking two of your opponents triggers it twice,
  // and an attack on an opponent's planeswalker is not an attack on that opponent. Intervening-if
  // (CR 603.4): that opponent has more life than at least one other of your opponents, checked as
  // the attack is declared and as the ability resolves. The attacking player, the event player,
  // draws; you put the counters on a creature you control, chosen as it resolves, not targeted.
  defineCard(
    'd11e627b-8a48-411d-a261-2c9a02a758ba',
    'Breena, the Demagogue',
    [
      'Whenever a player attacks one of your opponents, if that opponent has more life than another of your opponents, that attacking player draws a card and you put two +1/+1 counters on a creature you control.',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'attackDeclared',
            attacker: 'any',
            attacking: { who: 'opponent', planeswalkers: false },
            perDefender: true,
          },
          {
            condition: { kind: 'attackedPlayerHasMoreLifeThanAnotherOpponent' },
            effects: [
              { op: 'draw', count: constant(1), player: 'eventPlayer' },
              { op: 'putCountersOnCreatureOfChoice', counter: '+1/+1', count: 2 },
            ],
            description:
              'Whenever a player attacks one of your opponents, if that opponent has more life than another of your opponents, that attacking player draws a card and you put two +1/+1 counters on a creature you control',
          },
        ),
      ],
    },
  );

  // Ever-Watching Threshold: triggers once as an opponent declares an attack. Intervening-if
  // (CR 603.4): at least one of that player's attackers is attacking you or a planeswalker you
  // control, checked as the attack is declared and as the ability resolves, counting only creatures
  // still attacking you or a planeswalker still in combat then.
  defineCard(
    'c6639b52-b51d-46e7-a83c-c4621b1cecaa',
    'Ever-Watching Threshold',
    [
      'Whenever an opponent attacks, if they attacked you and/or a planeswalker you control, draw a card.',
    ],
    {
      triggers: [
        triggered(
          { when: 'attackDeclared', attacker: 'opponent' },
          {
            condition: { kind: 'attackGroupAttackingYou', planeswalkers: true, cmp: '>=', n: 1 },
            effects: [{ op: 'draw', count: constant(1) }],
            description:
              'Whenever an opponent attacks, if they attacked you and/or a planeswalker you control, draw a card',
          },
        ),
      ],
    },
  );

  // Mangara, the Diplomat: the second-spell line (castsSpell, ordinal 2) and lifelink are read by
  // the interpreter; the stored note about that line was a misreading of the Oracle text. The
  // attack ability triggers once per declaration by an opponent. Its intervening-if (CR 603.4) is
  // that two or more of that player's attackers are attacking you or a planeswalker you control,
  // checked as the attack is declared and again on resolution against the creatures still
  // attacking you and the planeswalkers still in combat.
  extendCard(
    'cbcb6d9a-6ae5-4bcd-8013-2b657553764a',
    'Mangara, the Diplomat',
    [
      'Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, draw a card.',
    ],
    {
      triggers: [
        triggered(
          { when: 'attackDeclared', attacker: 'opponent' },
          {
            condition: { kind: 'attackGroupAttackingYou', planeswalkers: true, cmp: '>=', n: 2 },
            effects: [{ op: 'draw', count: constant(1) }],
            description:
              'Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, draw a card',
          },
        ),
      ],
    },
  );

  // Tomik, Wielder of Law: the interpreter reads affinity for planeswalkers (generic mana only, CR
  // 702.41a) and flying, vigilance. The attack ability is Mangara's trigger: once per declaration by
  // an opponent, with the intervening-if (CR 603.4) that two or more of that player's attackers are
  // attacking you or a planeswalker you control, checked as the attack is declared and as it
  // resolves. "That opponent" is the attacking player, the event player, who loses 3 life; you draw.
  extendCard(
    '2ef0961a-0543-4371-8c2a-333881b735e5',
    'Tomik, Wielder of Law',
    [
      'Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, that opponent loses 3 life and you draw a card.',
    ],
    {
      triggers: [
        triggered(
          { when: 'attackDeclared', attacker: 'opponent' },
          {
            condition: { kind: 'attackGroupAttackingYou', planeswalkers: true, cmp: '>=', n: 2 },
            effects: [
              { op: 'loseLifeTarget', target: 'eventPlayer', amount: constant(3) },
              { op: 'draw', count: constant(1) },
            ],
            description:
              'Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you and/or planeswalkers you control, that opponent loses 3 life and you draw a card',
          },
        ),
      ],
    },
  );

  // Frontier Warmonger: triggers once for each opponent of yours that creatures attack, per
  // declaration, for any player's attack, yours included. The group is exactly the creatures that
  // attack that opponent or a planeswalker they control (an attack on a planeswalker is an attack on
  // it for this card), bound when the ability triggers: "those creatures" gain menace until end of
  // turn as it resolves, even if some have since left combat, and nothing else does.
  defineCard(
    '9cb741ae-14d6-4a8d-bfad-703abfe3682c',
    'Frontier Warmonger',
    [
      'Whenever one or more creatures attack one of your opponents or a planeswalker they control, those creatures gain menace until end of turn.',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'attackDeclared',
            attacker: 'any',
            attacking: { who: 'opponent', planeswalkers: true },
            perDefender: true,
          },
          {
            effects: [{ op: 'grantKeywordToAttackGroupUntilEot', keyword: 'menace' }],
            description:
              'Whenever one or more creatures attack one of your opponents or a planeswalker they control, those creatures gain menace until end of turn',
          },
        ),
      ],
    },
  );

  // Tenuous Truce: "Enchant opponent" is read by the interpreter (the Aura's one target is an
  // opponent, and it is attached to that player). At the beginning of the enchanted opponent's end
  // step, and only theirs, you and that player each draw a card. The sacrifice is two triggers on
  // the attackDeclared event: when you declare an attack with any creature at the enchanted
  // opponent or a planeswalker they control, or when they declare any attacker at you or a
  // planeswalker you control; the Aura sacrifices itself.
  extendCard(
    'f0bf2923-aea2-4bac-b061-64bc84437ef1',
    'Tenuous Truce',
    [
      "At the beginning of enchanted opponent's end step, you and that player each draw a card.",
      'When you attack enchanted opponent or a planeswalker they control or when they attack you or a planeswalker you control, sacrifice this Aura.',
    ],
    {
      triggers: [
        triggered(
          { when: 'endStep', player: 'enchanted' },
          {
            effects: [
              { op: 'draw', count: constant(1) },
              { op: 'draw', count: constant(1), player: 'eventPlayer' },
            ],
            description:
              "At the beginning of enchanted opponent's end step, you and that player each draw a card",
          },
        ),
        triggered(
          {
            when: 'attackDeclared',
            attacker: 'you',
            attacking: { who: 'enchantedPlayer', planeswalkers: true },
          },
          {
            effects: [{ op: 'sacrifice', target: 'source' }],
            description:
              'When you attack enchanted opponent or a planeswalker they control, sacrifice this Aura',
          },
        ),
        triggered(
          {
            when: 'attackDeclared',
            attacker: 'enchantedPlayer',
            attacking: { who: 'you', planeswalkers: true },
          },
          {
            effects: [{ op: 'sacrifice', target: 'source' }],
            description:
              'When enchanted opponent attacks you or a planeswalker you control, sacrifice this Aura',
          },
        ),
      ],
    },
  );

  // Backlash: "untapped" holds when the target is chosen and again as the spell resolves (CR
  // 608.2b), so a creature tapped in response makes the only target illegal and the spell does
  // nothing. The creature itself deals the damage, equal to its power after being tapped, to the
  // player who controls it as Backlash resolves.
  const backlash = targetSlots({ creature: { kind: 'creature', tapState: 'untapped' } });
  defineCard(
    '3db9bf7b-da4e-428f-aa5d-a0cd1afeb16c',
    'Backlash',
    [
      'Tap target untapped creature. That creature deals damage equal to its power to its controller.',
    ],
    {
      spellAbility: spell({
        targets: backlash.targets,
        effects: [
          { op: 'tapTarget', target: backlash.slot.creature },
          {
            op: 'dealDamage',
            target: { controllerOf: backlash.slot.creature },
            source: backlash.slot.creature,
            amount: { kind: 'powerOfTarget', target: backlash.slot.creature },
          },
        ],
        description:
          'Tap target untapped creature. That creature deals damage equal to its power to its controller',
      }),
    },
  );

  // Selfless Squire: the enter trigger makes a shield for the rest of the turn that covers every
  // source and both combat and noncombat damage to you (CR 615). The second ability is a
  // separate trigger of the permanent, so it works whenever the Squire is on the battlefield and
  // damage to you is prevented by anything, once per prevented source's damage, for that amount.
  defineCard(
    '7d079c78-b2a9-444f-ab54-c61c041baa6d',
    'Selfless Squire',
    [
      'When this creature enters, prevent all damage that would be dealt to you this turn.',
      'Whenever damage that would be dealt to you is prevented, put that many +1/+1 counters on this creature.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [{ op: 'createDamageShield', player: 'you' }],
          description:
            'When this creature enters, prevent all damage that would be dealt to you this turn',
        }),
        triggered(
          { when: 'damagePreventedToPlayer', player: 'you' },
          {
            effects: [
              {
                op: 'putCounters',
                target: 'source',
                counter: '+1/+1',
                count: { kind: 'damageDealt' },
              },
            ],
            description:
              'Whenever damage that would be dealt to you is prevented, put that many +1/+1 counters on this creature',
          },
        ),
      ],
    },
  );

  // Deflecting Palm: as it resolves, its controller chooses the source (CR 609.7a): a permanent or
  // a spell, tracked by object, so a source that changes zones is a new object (CR 400.7). The
  // shield prevents the next damage from it to you and ends then. The prevented amount is dealt
  // to that source's controller by Deflecting Palm right after the prevented damage, not as a
  // trigger.
  defineCard(
    'dc5dffc8-fac5-4956-bac4-1ad2cc16f6be',
    'Deflecting Palm',
    [
      "The next time a source of your choice would deal damage to you this turn, prevent that damage. If damage is prevented this way, ~ deals that much damage to that source's controller.",
    ],
    {
      spellAbility: spell({
        effects: [
          {
            op: 'createDamageShield',
            player: 'you',
            chosenSource: true,
            oneShot: true,
            reflect: 'toSourceController',
          },
        ],
        description:
          "The next time a source of your choice would deal damage to you this turn, prevent that damage. If damage is prevented this way, Deflecting Palm deals that much damage to that source's controller",
      }),
    },
  );

  // Comeuppance: one shield for the turn covering you and the planeswalkers you control as the
  // damage would be dealt, from sources you don't control, combat or not. Each prevented amount
  // is dealt by Comeuppance to the source itself when it is a creature as the damage would be
  // dealt (only if it is still on the battlefield) and otherwise to the source's controller, right
  // after the prevented damage event. Reflections that prevent each other forever are a draw.
  defineCard(
    '01f29158-2dc9-4b9d-b726-add5d3fd5782',
    'Comeuppance',
    [
      "Prevent all damage that would be dealt to you and planeswalkers you control this turn by sources you don't control. If damage from a creature source is prevented this way, ~ deals that much damage to that creature. If damage from a noncreature source is prevented this way, ~ deals that much damage to the source's controller.",
    ],
    {
      spellAbility: spell({
        effects: [
          {
            op: 'createDamageShield',
            player: 'you',
            andPlaneswalkersYouControl: true,
            sources: 'youDontControl',
            reflect: 'toSourceCreatureElseController',
          },
        ],
        description:
          "Prevent all damage that would be dealt to you and planeswalkers you control this turn by sources you don't control",
      }),
    },
  );

  // Michiko Konda, Truth Seeker: watches damage dealt to YOU, not to your permanents, from sources an
  // opponent controls, once per source's damage event and only for damage actually dealt. The event
  // player is the source's controller, so the one who sacrifices is the opponent whose source
  // dealt it, choosing among all their permanents.
  defineCard(
    'fbe190eb-fd4b-40e7-9a17-48c96b60f653',
    'Michiko Konda, Truth Seeker',
    [
      'Whenever a source an opponent controls deals damage to you, that player sacrifices a permanent of their choice.',
    ],
    {
      triggers: [
        triggered(
          { when: 'playerDealtDamage', player: 'you', sourceController: 'opponent' },
          {
            effects: [{ op: 'eventPlayerSacrificesPermanents', count: 1 }],
            description:
              'Whenever a source an opponent controls deals damage to you, that player sacrifices a permanent of their choice',
          },
        ),
      ],
    },
  );

  // Delirium: castable only while it is another player's turn (a restriction on casting the spell
  // at all). "That player" is the player whose turn it is, so the target is a creature that player
  // controls, checked as it is chosen and again on resolution. The creature itself deals the
  // damage, equal to its power, to the player who controls it; the shield on that one object
  // (not on the controller) stops combat damage dealt to it and by it for the rest of the turn,
  // and a creature that leaves is a new object the shield no longer covers (CR 400.7).
  const delirium = targetSlots({ creature: { kind: 'creature', controller: 'activePlayer' } });
  defineCard(
    'a00e5eb6-b916-4cd6-8ff2-c02f4929abc7',
    'Delirium',
    [
      "Cast this spell only during an opponent's turn.",
      'Tap target creature that player controls. That creature deals damage equal to its power to the player. Prevent all combat damage that would be dealt to and dealt by the creature this turn.',
    ],
    {
      castRestriction: { kind: 'notYourTurn' },
      spellAbility: spell({
        targets: delirium.targets,
        effects: [
          { op: 'tapTarget', target: delirium.slot.creature },
          {
            op: 'dealDamage',
            target: { controllerOf: delirium.slot.creature },
            source: delirium.slot.creature,
            amount: { kind: 'powerOfTarget', target: delirium.slot.creature },
          },
          {
            op: 'createDamageShield',
            target: delirium.slot.creature,
            dealtTo: true,
            dealtBy: true,
            combatOnly: true,
          },
        ],
        description:
          'Tap target creature that player controls. That creature deals damage equal to its power to the player. Prevent all combat damage that would be dealt to and dealt by the creature this turn',
      }),
    },
  );

  // Thundermaw Hellkite: "those creatures" means the creatures with flying your opponents control,
  // not the creatures that were dealt damage (Gatherer ruling 2017-11-17), so a flier whose damage
  // is prevented, protection from red for one, is still tapped. Both instructions use that same
  // set as the ability resolves; nothing can change flying or control between the two
  // instructions of one resolution, so reading the selector twice is reading one set.
  const opposingFliers = allOf(ofType('Creature'), OPPONENTS, withKeyword('flying'));
  defineCard(
    'e958144e-01bc-46ff-8f56-ddf2eb098630',
    'Thundermaw Hellkite',
    [
      'When this creature enters, it deals 1 damage to each creature with flying your opponents control. Tap those creatures.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [
            { op: 'damageEach', selector: opposingFliers, amount: constant(1) },
            { op: 'tapEach', selector: opposingFliers },
          ],
          description:
            'When this creature enters, it deals 1 damage to each creature with flying your opponents control. Tap those creatures',
        }),
      ],
    },
  );

  // Arcbond: the delayed trigger is keyed to the chosen creature OBJECT (a blinked creature is a
  // new object, CR 400.7) and lasts this turn, under Arcbond's controller. Each time the creature is
  // dealt damage (simultaneous combat damage is one event, CR 510.2, 603.2c) the CREATURE deals
  // that much damage to each other creature and each player, simultaneously, with last known
  // information if the damage killed it (CR 608.2h). The damage it deals is never dealt to itself.
  const arcbond = targetSlots({ creature: { kind: 'creature' } });
  defineCard(
    '01790829-cc03-430f-a899-2f274b7dbf62',
    'Arcbond',
    [
      'Choose target creature. Whenever that creature is dealt damage this turn, it deals that much damage to each other creature and each player.',
    ],
    {
      spellAbility: spell({
        targets: arcbond.targets,
        effects: [
          {
            op: 'registerDelayedTrigger',
            when: 'dealtDamage',
            target: arcbond.slot.creature,
            expiry: 'cleanup',
            // The delayed ability is a triggered one; its head only names the event, the
            // registration above decides which creature's damage and for how long.
            ability: triggered(whenPermanent('dealtDamage', ofType('Creature')), {
              effects: [
                {
                  op: 'damageEach',
                  selector: ofType('Creature'),
                  amount: { kind: 'damageDealt' },
                  source: 'triggerObject',
                  exceptSource: true,
                },
                {
                  op: 'damageEachPlayer',
                  amount: { kind: 'damageDealt' },
                  source: 'triggerObject',
                },
              ],
              description:
                'That creature deals that much damage to each other creature and each player',
            }),
          },
        ],
        description:
          'Choose target creature. Whenever it is dealt damage this turn, it deals that much damage to each other creature and each player',
      }),
    },
  );

  // Territorial Aetherkite: "when you do" is a reflexive trigger (CR 603.12). After the energy is
  // paid, a separate ability goes on the stack, so players get priority first, and as it
  // resolves the Aetherkite deals damage equal to the energy paid to each other creature (the
  // set is read then; last known information if it has left the battlefield, CR 608.2h). Any
  // amount from one up to all your energy may be paid, not only the two just gained.
  defineCard(
    '4f63d306-cc14-405c-8424-d8990c670c74',
    'Territorial Aetherkite',
    [
      'When this creature enters, you get {E}{E} . Then you may pay one or more {E}. When you do, this creature deals that much damage to each other creature.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [
            { op: 'gainEnergy', amount: constant(2) },
            {
              op: 'mayPayEnergyThenReflexive',
              min: 1,
              then: spell({
                effects: [
                  {
                    op: 'damageEach',
                    selector: allOf(ofType('Creature'), OTHER),
                    amount: { kind: 'energyPaid' },
                  },
                ],
                description:
                  'When you do, this creature deals that much damage to each other creature',
              }),
            },
          ],
          description:
            'When this creature enters, you get {E}{E}. Then you may pay one or more {E}. When you do, this creature deals that much damage to each other creature',
        }),
      ],
    },
  );

  // Invisible Woman: "whenever you attack" is one trigger for the whole declaration (CR 603.2c).
  // The payment is made first, as the trigger resolves; only paying fires the reflexive trigger
  // (CR 603.12), which then goes on the stack and chooses its target, and counts the creatures
  // you control as that reflexive trigger resolves. The Wall token line stays interpreted.
  const boost = targetSlots({ creature: { kind: 'creature' } });
  extendCard(
    '085016ee-4429-453f-b7f3-d61065f1214e',
    'Invisible Woman',
    [
      "Whenever you attack, you may pay {R}{G}{W}{U}. When you do, target creature gets +1/+0 until end of turn for each creature you control and can't be blocked this turn.",
    ],
    {
      triggers: [
        triggered(whenAttacks(allOf(ofType('Creature'), YOURS), { aggregate: true }), {
          effects: [
            {
              op: 'mayPayManaThenReflexive',
              cost: manaCost('{R}{G}{W}{U}'),
              then: spell({
                targets: boost.targets,
                effects: [
                  {
                    op: 'pumpUntilEot',
                    target: boost.slot.creature,
                    power: { kind: 'countPermanents', selector: ofType('Creature'), scope: 'you' },
                    toughness: 0,
                  },
                  { op: 'cantBeBlockedUntilEot', target: boost.slot.creature },
                ],
                description:
                  "When you do, target creature gets +1/+0 until end of turn for each creature you control and can't be blocked this turn",
              }),
            },
          ],
          description: 'Whenever you attack, you may pay {R}{G}{W}{U}',
        }),
      ],
    },
  );

  // Binding the targeting player as the event player of "becomes the target" triggers (for
  // Thunderbreak Regent) lets the grammar read these two cards' "that player controls" targets.
  // Neither has focused engine or viewer evidence yet, so each stays contained until it does.
  unsupportedCard(
    'a30f30e3-dbbf-4cb2-b3d0-76f57dffb2dd',
    'Black Bolt, Inhuman King',
    'No focused engine or Card Test Lab evidence yet for the becomes-targeted destroy trigger.',
  );
  unsupportedCard(
    '9da65d66-71f0-4e17-a1f9-6da6cd1cfa8a',
    'Scalelord Reckoner',
    'No focused engine or Card Test Lab evidence yet for the becomes-targeted destroy trigger.',
  );
}

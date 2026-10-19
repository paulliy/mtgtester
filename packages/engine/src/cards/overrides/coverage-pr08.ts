/**
 * Coverage PR08 (docs/plans/card-coverage-chunks.md): control changes and multiplayer choices.
 *
 * Each registration lands with pinned Oracle clauses, behavioral tests and real lab scenarios.
 * Unfinished cards remain explicitly unsupported in their original deck registrations.
 */
import type { CardDefinition } from '../definition';
import { searchLibraryCards } from '../effect-builders';
import { allOf, hasCounter, ofType } from '../selector';
import {
  activated,
  mana,
  manaCost,
  onBeginCombat,
  onEndStep,
  onEtb,
  onUpkeep,
  removeCountersCost,
  spell,
  targetSlots,
  triggered,
  TAP,
  whenAttacks,
} from '../templates';
import { constant } from '../value';
import { SOLDIER_1_1, TREASURE, OGRE_3_3_RED, SPIRIT_1_1_FLYING } from '../tokens';
import { defineCard } from './index';

export const MOB_RULE_HANDLED_LINES = [
  'Choose one —',
  '• Gain control of all creatures with power 4 or greater until end of turn. Untap those creatures. They gain haste until end of turn.',
  '• Gain control of all creatures with power 3 or less until end of turn. Untap those creatures. They gain haste until end of turn.',
];

export const MOB_RULE: Partial<CardDefinition> = {
  spellAbility: spell({
    effects: [],
    modes: {
      minChoices: 1,
      maxChoices: 1,
      options: [
        {
          description:
            'Gain control of creatures with power 4 or greater until end of turn; untap them and give them haste',
          effects: [
            {
              op: 'gainControl',
              selector: allOf(ofType('Creature'), { kind: 'powerAtLeast', n: 4 }),
              duration: 'untilEndOfTurn',
              untap: true,
              grantHaste: true,
            },
          ],
        },
        {
          description:
            'Gain control of creatures with power 3 or less until end of turn; untap them and give them haste',
          effects: [
            {
              op: 'gainControl',
              selector: allOf(ofType('Creature'), { kind: 'powerAtMost', n: 3 }),
              duration: 'untilEndOfTurn',
              untap: true,
              grantHaste: true,
            },
          ],
        },
      ],
    },
    description:
      'Choose one — gain control of creatures in the chosen power range until end of turn, untap them, and they gain haste',
  }),
};

export function registerCoveragePr08Overrides(): void {
  defineCard(
    '3db8466c-864f-48ba-b617-f2c863dfdcbd',
    'Benevolent Offering',
    [
      'unrecognized rules text: "Choose an opponent. You and that player each create three 1/1 white Spirit creature tokens with flying."',
      'unrecognized rules text: "Choose an opponent. You gain 2 life for each creature you control and that player gains 2 life for each creature they control."',
    ],
    {
      spellAbility: spell({
        effects: [
          { op: 'shareTokensWithChosenOpponent', spec: SPIRIT_1_1_FLYING, count: constant(3) },
          { op: 'shareCreatureLifeWithChosenOpponent', amount: constant(2) },
        ],
        description:
          'Choose an opponent to create three Spirits each, then choose an opponent to gain life for your own creatures',
      }),
    },
  );
  const symmetryTargets = targetSlots({ players: { kind: 'player', count: { min: 2, max: 2 } } });
  defineCard(
    '6dfb50d7-359b-4644-90e3-7ecdacee7c12',
    'Scheming Symmetry',
    [
      'unrecognized rules text: "Choose two target players. Each of them searches their library for a card, then shuffles and puts that card on top."',
    ],
    {
      spellAbility: spell({
        targets: symmetryTargets.targets,
        effects: [{ op: 'schemingSymmetry', targetSlot: symmetryTargets.slot.players }],
        description:
          'Two target players each privately search, shuffle, and put the found card on top',
      }),
    },
  );
  defineCard(
    '8d0213d7-9e25-49d2-93fa-1d346cb2e869',
    'Akroan Horse',
    [
      'unrecognized rules text: "When this creature enters, an opponent gains control of it."',
      'unrecognized rules text: "At the beginning of your upkeep, each opponent creates a 1/1 white Soldier creature token."',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [
            { op: 'gainControlTarget', target: 'source', recipient: { chooseOpponent: true } },
          ],
          description: 'An opponent gains control of Akroan Horse',
        }),
        triggered(onUpkeep(), {
          effects: [{ op: 'eachOpponentCreatesTokens', spec: SOLDIER_1_1, count: constant(1) }],
          description: 'Each opponent creates a 1/1 white Soldier creature token',
        }),
      ],
    },
  );
  const reinsTargets = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
  defineCard(
    '96381388-1e82-411c-8290-1f3e909d3b5f',
    'Reins of Power',
    [
      'unrecognized rules text: "Untap all creatures you control and all creatures target opponent controls. You and that opponent each gain control of all creatures the other controls until end of turn. Those creatures gain haste until end of turn."',
    ],
    {
      spellAbility: spell({
        targets: reinsTargets.targets,
        effects: [{ op: 'swapCreatureControlUntilEot', target: reinsTargets.slot.opponent }],
        description:
          'Untap both players’ creatures, then gain control of each other’s creatures with haste until end of turn',
      }),
    },
  );
  defineCard(
    '5bb32efd-9e58-4021-bbda-4ffccfa1d601',
    'Druid of Purification',
    [
      'unrecognized rules text: "When this creature enters, starting with you, each player may choose an artifact or enchantment you don\'t control. Destroy each permanent chosen this way."',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          effects: [{ op: 'druidPurification' }],
          description:
            'Starting with you, each player may choose an artifact or enchantment you do not control. Destroy each permanent chosen this way',
        }),
      ],
    },
  );
  const humbleTargets = targetSlots({ opponent: { kind: 'player', controller: 'opponent' } });
  defineCard(
    '1582e16d-4825-4cc5-b12c-449c45e4e449',
    'Humble Defector',
    [
      '{T}: Draw two cards. Target opponent gains control of this creature. Activate only during your turn.',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [TAP],
          timing: 'yourTurn',
          targets: humbleTargets.targets,
          effects: [
            { op: 'draw', count: constant(2) },
            {
              op: 'gainControlTarget',
              target: 'source',
              recipient: { targetPlayer: humbleTargets.slot.opponent },
            },
          ],
          description:
            'Draw two cards, then target opponent gains control of Humble Defector (activate only during your turn)',
        }),
      ],
    },
  );
  const cytoplastTargets = targetSlots({
    counteredCreature: { kind: 'creature', filter: hasCounter('+1/+1') },
  });
  defineCard(
    '026ef98e-4f0a-4a6d-b74f-d17ac8b10e37',
    'Cytoplast Manipulator',
    [
      'unrecognized rules text: "{U}, {T}: Gain control of target creature with a +1/+1 counter on it for as long as this creature remains on the battlefield."',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{U}'), TAP],
          targets: cytoplastTargets.targets,
          effects: [
            {
              op: 'gainControlTarget',
              target: cytoplastTargets.slot.counteredCreature,
              duration: 'whileSourceOnBattlefield',
            },
          ],
          description:
            'Gain control of target creature with a +1/+1 counter on it for as long as Cytoplast Manipulator remains on the battlefield',
        }),
      ],
    },
  );
  defineCard(
    '8b5cffd5-5db3-4151-9275-d91387554412',
    'Cut a Deal',
    [
      'unrecognized rules text: "Each opponent draws a card, then you draw a card for each opponent who drew a card this way."',
    ],
    {
      spellAbility: spell({
        effects: [{ op: 'drawForEachOpponent' }],
        description:
          'Each opponent draws a card, then you draw a card for each opponent who drew a card this way',
      }),
    },
  );
  defineCard('acca2128-6ebb-48a5-a6a2-1bc5e4aa86ce', 'Mob Rule', MOB_RULE_HANDLED_LINES, MOB_RULE);
  // "enters with three wish counters" is read by the interpreter as `entersWithCounters` and kept;
  // only the activation below is authored here. The printed gift names no target, so the ordinary
  // source activation has no player slot at all — the recipient is chosen as the effect resolves,
  // after the search and shuffle have already been performed.
  defineCard(
    '81c70ae7-3c18-4c9b-8505-e4db9e0e6518',
    'Wishclaw Talisman',
    [
      'unrecognized rules text: "{1}, {T}, Remove a wish counter from this artifact: Search your library for a card, put it into your hand, then shuffle. An opponent gains control of this artifact. Activate only during your turn."',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{1}'), TAP, removeCountersCost('wish', 1)],
          timing: 'yourTurn',
          effects: [
            searchLibraryCards(allOf(), [{ zone: 'hand' }]),
            { op: 'shuffle' },
            {
              op: 'gainControlTarget',
              target: 'source',
              recipient: { chooseOpponent: true },
            },
          ],
          description:
            'Search your library for a card, put it into your hand, then shuffle. An opponent gains control of Wishclaw Talisman (activate only during your turn)',
        }),
      ],
    },
  );
  // Alicia Masters, Skilled Sculptor. The interpreter already models the combat line exactly as
  // printed — "if you've cast a noncreature spell this turn" is the CR 603.4 intervening-if, read
  // at the queue and again as the ability resolves — so that ability is carried across verbatim
  // rather than rewritten, with its Treasure coming from the shared token catalog. Only "Sense the
  // Good" needs authoring: it is the same global owner-restoration primitive Trostani Disciple
  // already uses, which grants every living owner each creature it owns.
  defineCard(
    '223504ba-174a-46f2-a4a2-5d663a82dfd3',
    'Alicia Masters, Skilled Sculptor',
    [
      'unrecognized rules text: "Sense the Good — At the beginning of your end step, each player gains control of all creatures they own."',
    ],
    {
      triggers: [
        triggered(onBeginCombat('you'), {
          condition: { kind: 'castSpellThisTurn', category: 'noncreature', cmp: '>=', n: 1 },
          effects: [{ op: 'createToken', spec: TREASURE, count: constant(1) }],
          description:
            "At the beginning of combat on your turn, if you've cast a noncreature spell this turn, create a Treasure token",
        }),
        triggered(onEndStep('you'), {
          effects: [{ op: 'regainControlOfOwnCreatures' }],
          description:
            'At the beginning of your end step, each player gains control of all creatures they own',
        }),
      ],
    },
  );
  // Kazuul, Tyrant of the Cliffs: a genuine intervening-if over the trigger's own event
  // permanent (CR 603.4), checked both as the attack triggers and again as the ability resolves.
  // The attacker is the trigger's EVENT OBJECT, so the payment is read back through the original
  // permanent — current controller while it lingers, departure last-known-information once it
  // has left (CR 608.2h), never a blinked reincarnation. The event-object condition rejects a
  // redirect: "if you're the defending player" follows the attack's own defender, retained
  // through removal from combat (CR 508.5) rather than the current combat assignment. An
  // opponent's planeswalker-attack is an attack for this trigger; its defending player is the
  // planeswalker's controller (CR 508.1b). Battles stay unsupported until PR11's battles
  // support lands. "Unless that creature's controller pays {3}" is an `eventObjectController`
  // payer, not the ability's controller and not the cast event player.
  defineCard(
    'f8bf3d91-cb50-48ce-88c6-cdcb37b64b57',
    'Kazuul, Tyrant of the Cliffs',
    [
      'unrecognized rules text: "Whenever a creature an opponent controls attacks, if you\'re the defending player, create a 3/3 red Ogre creature token unless that creature\'s controller pays {3}."',
    ],
    {
      triggers: [
        triggered(
          whenAttacks(allOf(ofType('Creature'), { kind: 'controller', who: 'opponents' })),
          {
            condition: { kind: 'eventObjectDefendingPlayerIsYou' },
            effects: [
              {
                op: 'unlessPays',
                payer: 'eventObjectController',
                cost: manaCost('{3}'),
                then: [{ op: 'createToken', spec: OGRE_3_3_RED, count: constant(1) }],
              },
            ],
            description:
              "Whenever a creature an opponent controls attacks, if you're the defending player, create a 3/3 red Ogre creature token unless that creature's controller pays {3}",
          },
        ),
      ],
    },
  );
}

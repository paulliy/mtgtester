/**
 * Coverage PR08 (docs/plans/card-coverage-chunks.md): control changes and multiplayer choices.
 *
 * Each registration lands with pinned Oracle clauses, behavioral tests and real lab scenarios.
 * Unfinished cards remain explicitly unsupported in their original deck registrations.
 */
import type { CardDefinition, TargetSpec } from '../definition';
import { searchLibraryCards } from '../effect-builders';
import { allOf, anyOf, hasCounter, not, ofType, ofSubtype, OPPONENTS } from '../selector';
import {
  activated,
  mana,
  manaCost,
  onBeginCombat,
  onEndStep,
  onEtb,
  onDies,
  onUpkeep,
  removeCountersCost,
  spell,
  targetSlots,
  triggered,
  TAP,
  whenAttacks,
} from '../templates';
import { constant } from '../value';
import {
  SOLDIER_1_1,
  TREASURE,
  OGRE_3_3_RED,
  SPIRIT_1_1_FLYING,
  INKLING_2_1_FLYING,
  SURVIVOR_1_1_RED,
} from '../tokens';
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
    '81c6c4f0-81ad-463c-a42b-60a73e6d70f3',
    'Alexios, Deimos of Kosmos',
    [
      'unrecognized rules text: "~ attacks each combat if able, can\'t be sacrificed, and can\'t attack its owner."',
      'unrecognized rules text: "At the beginning of each player\'s upkeep, that player gains control of ~, untaps it, and puts a +1/+1 counter on it. It gains haste until end of turn."',
    ],
    {
      staticEffects: [
        { affects: { kind: 'self' }, op: { layer: 6, setMustAttackEachCombat: true } },
      ],
      ruleStatics: [{ kind: 'cantBeSacrificed' }, { kind: 'cantAttackOwner' }],
      triggers: [
        triggered(onUpkeep('each'), {
          effects: [{ op: 'rotateSourceAtUpkeep' }],
          description:
            'The upkeep player gains control of Alexios, untaps it, puts a +1/+1 counter on it, and gives it haste until end of turn',
        }),
      ],
    },
  );
  defineCard(
    'e6f2ba06-2c92-48b7-a95f-ea6bf35aa0fe',
    "Olórin's Searing Light",
    [
      'unrecognized rules text: "Each opponent exiles a creature with the greatest power among creatures that player controls."',
      'unrecognized rules text: "If there are two or more instant and/or sorcery cards in your graveyard, ~ deals damage to each opponent equal to the power of the creature they exiled."',
    ],
    {
      spellAbility: spell({
        effects: [
          {
            op: 'sacrificeGreatestEachOpponent',
            selector: 'creature',
            metric: 'power',
            action: 'exile',
            damageIfGraveyardSpellsAtLeast: 2,
          },
        ],
        description:
          'Each opponent exiles a greatest-power creature; with spell mastery, deal that opponent its creature’s last-known power in damage',
      }),
    },
  );
  defineCard(
    '26ae37ab-91f8-4113-beb0-1154f9b62d28',
    'Varchild, Betrayer of Kjeldor',
    [
      'unrecognized rules text: "Whenever ~ deals combat damage to a player, that player creates that many 1/1 red Survivor creature tokens."',
      'unrecognized rules text: "Survivors your opponents control can\'t block, and they can\'t attack you or planeswalkers you control."',
    ],
    {
      triggers: [
        triggered(
          { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
          {
            effects: [
              {
                op: 'createTokenForPlayer',
                target: 'eventPlayer',
                spec: SURVIVOR_1_1_RED,
                count: { kind: 'damageDealt' },
              },
            ],
            description: 'The player dealt combat damage creates that many 1/1 red Survivors',
          },
        ),
        triggered(
          { when: 'leavesBattlefield', subject: { kind: 'self' } },
          {
            effects: [{ op: 'gainControl', selector: ofSubtype('Survivor') }],
            description: 'Gain control of all Survivors',
          },
        ),
      ],
      ruleStatics: [
        { kind: 'cantBlockMatching', filter: allOf(ofSubtype('Survivor'), OPPONENTS) },
        {
          kind: 'attackRestriction',
          filter: allOf(ofSubtype('Survivor'), OPPONENTS),
          includePlaneswalkers: true,
        },
      ],
    },
  );
  const differentPlayers = (targets: TargetSpec[]): TargetSpec[] =>
    targets.map((target, slot) => ({
      ...target,
      differentPlayerTargetSlots: targets
        .map((_, index) => index)
        .filter((other) => other !== slot),
    }));
  const shadrixTargets = targetSlots({
    tokenPlayer: { kind: 'player' },
    drawPlayer: { kind: 'player' },
    counterPlayer: { kind: 'player' },
  });
  defineCard(
    '2143f413-7baa-4fd6-a7ca-32f52bfa553f',
    'Shadrix Silverquill',
    [
      'unrecognized rules text: "At the beginning of combat on your turn, you may choose two. Each mode must target a different player."',
      'unrecognized rules text: "• Target player creates a 2/1 white and black Inkling creature token with flying."',
      'unrecognized rules text: "• Target player draws a card and loses 1 life."',
      'unrecognized rules text: "• Target player puts a +1/+1 counter on each creature they control."',
    ],
    {
      triggers: [
        triggered(onBeginCombat('you'), {
          targets: differentPlayers(shadrixTargets.targets),
          effects: [],
          modes: {
            minChoices: 2,
            maxChoices: 2,
            optional: true,
            options: [
              {
                description: 'Target player creates an Inkling',
                targetSlots: [shadrixTargets.slot.tokenPlayer],
                effects: [
                  {
                    op: 'createTokenForPlayer',
                    target: shadrixTargets.slot.tokenPlayer,
                    spec: INKLING_2_1_FLYING,
                    count: constant(1),
                  },
                ],
              },
              {
                description: 'Target player draws a card and loses 1 life',
                targetSlots: [shadrixTargets.slot.drawPlayer],
                effects: [
                  { op: 'drawTarget', target: shadrixTargets.slot.drawPlayer, count: constant(1) },
                  {
                    op: 'loseLifeTarget',
                    target: shadrixTargets.slot.drawPlayer,
                    amount: constant(1),
                  },
                ],
              },
              {
                description: 'Target player puts a +1/+1 counter on each creature they control',
                targetSlots: [shadrixTargets.slot.counterPlayer],
                effects: [
                  {
                    op: 'putCountersOnCreaturesTargetPlayerControls',
                    target: shadrixTargets.slot.counterPlayer,
                    counter: '+1/+1',
                    count: constant(1),
                  },
                ],
              },
            ],
          },
          description:
            'At the beginning of combat on your turn, you may choose two modes targeting different players',
        }),
      ],
    },
  );
  const lichTargets = targetSlots({
    sacrificePlayer: { kind: 'player', controller: 'opponent' },
    discardPlayer: { kind: 'player', controller: 'opponent' },
    lifePlayer: { kind: 'player', controller: 'opponent' },
  });
  defineCard(
    '6dc7f837-158f-4ccf-86a5-a07a20891ec5',
    'Vindictive Lich',
    [
      'unrecognized rules text: "When this creature dies, choose one or more. Each mode must target a different player."',
      'unrecognized rules text: "• Target opponent sacrifices a creature of their choice."',
      'unrecognized rules text: "• Target opponent discards two cards."',
      'unrecognized rules text: "• Target opponent loses 5 life."',
    ],
    {
      triggers: [
        triggered(onDies(), {
          targets: differentPlayers(lichTargets.targets),
          effects: [],
          modes: {
            minChoices: 1,
            maxChoices: 3,
            options: [
              {
                description: 'Target opponent sacrifices a creature',
                targetSlots: [lichTargets.slot.sacrificePlayer],
                effects: [
                  { op: 'sacrificeTargetPlayerCreature', target: lichTargets.slot.sacrificePlayer },
                ],
              },
              {
                description: 'Target opponent discards two cards',
                targetSlots: [lichTargets.slot.discardPlayer],
                effects: [
                  {
                    op: 'discardTarget',
                    target: lichTargets.slot.discardPlayer,
                    count: constant(2),
                  },
                ],
              },
              {
                description: 'Target opponent loses 5 life',
                targetSlots: [lichTargets.slot.lifePlayer],
                effects: [
                  {
                    op: 'loseLifeTarget',
                    target: lichTargets.slot.lifePlayer,
                    amount: constant(5),
                  },
                ],
              },
            ],
          },
          description:
            'When Vindictive Lich dies, choose one or more modes targeting different opponents',
        }),
      ],
    },
  );
  const windsTargets = targetSlots({ creature: { kind: 'creature', controller: 'opponent' } });
  defineCard(
    '499a4715-6776-461b-bee4-22ed172d455e',
    'Winds of Abandon',
    [
      'unrecognized rules text: "Exile target creature you don\'t control. For each creature exiled this way, its controller searches their library for a basic land card. Those players put those cards onto the battlefield tapped, then shuffle."',
    ],
    {
      spellAbility: spell({
        targets: windsTargets.targets,
        effects: [
          { op: 'exileCreatureAndControllerSearchBasicLand', target: windsTargets.slot.creature },
        ],
        description:
          'Exile target creature you do not control; its controller searches for a basic land, puts it onto the battlefield tapped, then shuffles',
      }),
    },
  );
  const boseijuTargets = targetSlots({
    permanent: {
      kind: 'permanent',
      controller: 'opponent',
      filter: anyOf(
        ofType('Artifact'),
        ofType('Enchantment'),
        allOf(ofType('Land'), not({ kind: 'supertype', value: 'Basic' })),
      ),
    },
  });
  defineCard(
    'bf1341dd-41a3-49f6-87ec-63170dde4324',
    'Boseiju, Who Endures',
    [
      'unrecognized rules text: "{1}{G}, Discard this card: Destroy target artifact, enchantment, or nonbasic land an opponent controls. That player may search their library for a land card with a basic land type, put it onto the battlefield, then shuffle. This ability costs {1} less to activate for each legendary creature you control."',
    ],
    {
      activatedAbilities: [
        activated({
          zone: 'hand',
          costs: [mana('{1}{G}'), { kind: 'discardSelf' }],
          targets: boseijuTargets.targets,
          effects: [
            {
              op: 'destroyTargetAndControllerMaySearchBasicTypedLand',
              target: boseijuTargets.slot.permanent,
            },
          ],
          description:
            'Channel — destroy an opposing artifact, enchantment or nonbasic land; its controller may search for a land with a basic land type',
        }),
      ],
      ruleStatics: [
        {
          kind: 'costReduction',
          appliesTo: 'activate',
          selfOnly: true,
          amount: {
            kind: 'countPermanents',
            selector: allOf(ofType('Creature'), { kind: 'supertype', value: 'Legendary' }),
            scope: 'you',
          },
        },
      ],
    },
  );
  defineCard(
    '48369aec-a991-4bef-8554-01c84302b063',
    'Aetherspouts',
    [
      'unrecognized rules text: "For each attacking creature, its owner puts it on their choice of the top or bottom of their library."',
    ],
    {
      spellAbility: spell({
        effects: [{ op: 'attackingCreaturesToOwnerLibraries' }],
        description:
          'Each attacking creature goes to the top or bottom of its owner’s library, as that owner chooses',
      }),
    },
  );
  defineCard(
    '8a29bd35-33ef-4317-9fe5-8aaff5d7d64d',
    'Tragic Arrogance',
    [
      'unrecognized rules text: "For each player, you choose from among the permanents that player controls an artifact, a creature, an enchantment, and a planeswalker. Then each player sacrifices all other nonland permanents they control."',
    ],
    {
      spellAbility: spell({
        effects: [
          {
            op: 'choosePermanentTypesThenSacrificeOthers',
            types: ['Artifact', 'Creature', 'Enchantment', 'Planeswalker'],
          },
        ],
        description:
          'Choose an artifact, creature, enchantment and planeswalker for each player; they sacrifice all other nonland permanents',
      }),
    },
  );
  // Agitator Ant. Both sentences are one unmodeled line — the printed goad lives inside the
  // reminder text, so the keyword list stayed empty — and they are one clause in the engine:
  // "each player may put two +1/+1 counters on a creature they control" is one resolution-time
  // APNAP choice set (CR 101.4), and "goad each creature that had counters put on it this way"
  // reads back exactly the placements that survived replacements with a positive amount, goaded
  // by this ability's controller until the goader's next turn begins, as tracked by the
  // existing goad store and removed in `turn.ts`.
  defineCard(
    'abe377f8-35f0-4dea-a681-91d31a36815c',
    'Agitator Ant',
    [
      'unrecognized rules text: "At the beginning of your end step, each player may put two +1/+1 counters on a creature they control. Goad each creature that had counters put on it this way."',
    ],
    {
      triggers: [
        triggered(onEndStep('you'), {
          effects: [
            { op: 'eachPlayerMayPutCountersAndGoad', counter: '+1/+1', count: constant(2) },
          ],
          description:
            'At the beginning of your end step, each player may put two +1/+1 counters on a creature they control. Goad each creature that had counters put on it this way.',
        }),
      ],
    },
  );
  // Council's Judgment. "Will of the council —" is a keyword reminder line with no rules content,
  // so only the sentence below needs authoring. The vote is untargeted, so the ability carries no
  // target slot at all: the candidate pool is every nonland permanent the caster does not control,
  // and hexproof/shroud exclude nothing. "each permanent with the most votes or tied for most
  // votes" is counted by permanent object, never by card name.
  defineCard(
    'acf4d685-a718-42f7-9a7a-dee069ae8db2',
    "Council's Judgment",
    [
      'unrecognized rules text: "Starting with you, each player votes for a nonland permanent you don\'t control. Exile each permanent with the most votes or tied for most votes."',
    ],
    {
      spellAbility: spell({
        effects: [{ op: 'voteAndExileMost', selector: allOf(not(ofType('Land')), OPPONENTS) }],
        description:
          'Starting with you, each player votes for a nonland permanent you do not control, then exile each permanent with the most votes or tied for most votes',
      }),
    },
  );
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

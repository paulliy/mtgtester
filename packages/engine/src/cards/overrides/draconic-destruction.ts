/**
 * Authored overrides for the remaining unmodeled cards in the Draconic Destruction precon
 * (ADR 0009 / ADR 0010, `packages/server/fixtures/coverage-decks/draconic-destruction.txt`).
 *
 * One module per deck (matching `urdragon.ts`'s intended shape) rather than one file per
 * card: these overrides share very little printed text with each other, but the deck itself
 * is the unit of "closed set" ADR 0009 describes — see that ADR for why chasing a specific
 * decklist's remaining cards is the tractable strategy, unlike chasing coverage in general.
 */

import { SELF_SUBJECT } from '../ability';
import { parseManaCost } from '../../mana/cost';
import { allOf, ofSubtype, YOURS } from '../selector';
import { constant } from '../value';
import { registerOverride } from './index';

registerOverride({
  oracleId: 'oracle-loaming-shaman',
  name: 'Loaming Shaman',
  handledLines: [
    'When ~ enters the battlefield, target player shuffles any number of target cards from their graveyard into their library.',
  ],
  def: {
    triggers: [
      {
        kind: 'triggered',
        trigger: { when: 'enters', subject: SELF_SUBJECT },
        targets: [
          { kind: 'player' },
          { kind: 'cardInGraveyard', count: { min: 0, max: Infinity }, graveyardOwnerSlot: 0 },
        ],
        effects: [{ op: 'shuffleChosenGraveyardCardsIntoLibrary', playerSlot: 0, cardsSlot: 1 }],
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-flameblast-dragon',
  name: 'Flameblast Dragon',
  handledLines: [
    'Whenever ~ attacks, you may pay {X}{R}. If you do, it deals X damage to any target.',
  ],
  def: {
    triggers: [
      {
        kind: 'triggered',
        trigger: { when: 'attacks', subject: SELF_SUBJECT },
        targets: [{ kind: 'anyTarget' }],
        effects: [{ op: 'mayPayXThenDealDamage', target: 0, templatedCost: parseManaCost('{X}{R}').cost! }],
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-dragonkin-berserker',
  name: 'Dragonkin Berserker',
  handledLines: [
    'Boast abilities you activate cost {1} less to activate for each Dragon you control.',
    'Boast — {4}{R}: Create a 5/5 red Dragon creature token with flying.',
  ],
  def: {
    // No general "Boast" keyword grammar exists (this precon has exactly one Boast card), so
    // the reduction is scoped by subtype instead of a real Boast-aware filter — safe here
    // because "Berserker" is unique to this card in the whole pool this deck draws from.
    ruleStatics: [
      {
        kind: 'costReduction',
        appliesTo: 'activate',
        amount: { kind: 'countPermanents', selector: allOf(ofSubtype('Dragon'), YOURS), scope: 'you' },
        filter: ofSubtype('Berserker'),
      },
    ],
    activatedAbilities: [
      {
        costs: [{ kind: 'mana', cost: parseManaCost('{4}{R}').cost! }],
        timing: 'any',
        oncePerTurn: true,
        requiresAttackedThisTurn: true,
        ability: {
          kind: 'activated',
          targets: [],
          effects: [
            {
              op: 'createToken',
              count: constant(1),
              spec: {
                name: 'Dragon',
                typeLine: 'Creature — Dragon',
                types: ['Creature'],
                subtypes: ['Dragon'],
                colors: ['R'],
                power: 5,
                toughness: 5,
                keywords: ['flying'],
              },
            },
          ],
          description: 'create a 5/5 red Dragon creature token with flying',
        },
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-thunderbreak-regent',
  name: 'Thunderbreak Regent',
  handledLines: [
    'Whenever a Dragon you control becomes the target of a spell or ability an opponent controls, ~ deals 3 damage to that player.',
  ],
  def: {
    triggers: [
      {
        kind: 'triggered',
        trigger: {
          when: 'becomesTargeted',
          subject: { kind: 'permanent', selector: allOf(ofSubtype('Dragon'), YOURS) },
        },
        targets: [],
        effects: [{ op: 'dealDamage', target: 'targetingPlayer', amount: constant(3) }],
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-steel-hellkite',
  name: 'Steel Hellkite',
  handledLines: [
    '{2}: ~ gets +1/+0 until end of turn.',
    '{X}: Destroy each nonland permanent with mana value X whose controller was dealt combat damage by this creature this turn. Activate only once each turn.',
  ],
  def: {
    activatedAbilities: [
      {
        costs: [{ kind: 'mana', cost: parseManaCost('{2}').cost! }],
        timing: 'any',
        ability: {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'pumpUntilEot', target: 'self', power: constant(1), toughness: constant(0) }],
          description: 'gets +1/+0 until end of turn',
        },
      },
      {
        costs: [{ kind: 'mana', cost: parseManaCost('{X}').cost! }],
        timing: 'any',
        oncePerTurn: true,
        ability: {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'destroyEachNonlandMVFromDamagedControllers', mv: { kind: 'xValue' } }],
          description:
            'destroy each nonland permanent with mana value X whose controller was dealt combat damage by ~ this turn',
        },
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-hoard-smelter-dragon',
  name: 'Hoard-Smelter Dragon',
  handledLines: [
    "{3}{R}: Destroy target artifact. ~ gets +X/+0 until end of turn, where X is that artifact's mana value.",
  ],
  def: {
    activatedAbilities: [
      {
        costs: [{ kind: 'mana', cost: parseManaCost('{3}{R}').cost! }],
        timing: 'any',
        ability: {
          kind: 'activated',
          targets: [{ kind: 'artifact' }],
          effects: [
            { op: 'destroy', target: 0 },
            {
              op: 'pumpUntilEot',
              target: 'self',
              power: { kind: 'manaValueOfTarget', target: 0 },
              toughness: constant(0),
            },
          ],
          description: "destroy target artifact; ~ gets +X/+0, X = that artifact's mana value",
        },
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-dragon-mage',
  name: 'Dragon Mage',
  handledLines: [
    'Whenever ~ deals combat damage to a player, each player discards their hand, then draws seven cards.',
  ],
  def: {
    triggers: [
      {
        kind: 'triggered',
        trigger: { when: 'dealsCombatDamageToPlayer', subject: SELF_SUBJECT },
        targets: [],
        effects: [{ op: 'eachPlayerDiscardHandThenDraw', count: constant(7) }],
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-runehorn-hellkite',
  name: 'Runehorn Hellkite',
  handledLines: [
    '{5}{R}, Exile this card from your graveyard: Each player discards their hand, then draws seven cards.',
  ],
  def: {
    activatedAbilities: [
      {
        costs: [
          { kind: 'mana', cost: parseManaCost('{5}{R}').cost! },
          { kind: 'exileSelfFromGraveyard' },
        ],
        timing: 'any',
        functionsInGraveyard: true,
        ability: {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'eachPlayerDiscardHandThenDraw', count: constant(7) }],
          description: 'each player discards their hand, then draws seven cards',
        },
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-dream-pillager',
  name: 'Dream Pillager',
  handledLines: [
    'Whenever ~ deals combat damage to a player, exile that many cards from the top of your library. Until end of turn, you may cast spells from among those exiled cards.',
  ],
  def: {
    triggers: [
      {
        kind: 'triggered',
        trigger: { when: 'dealsCombatDamageToPlayer', subject: SELF_SUBJECT },
        targets: [],
        effects: [{ op: 'exileTopNPlayableUntilEot', count: { kind: 'damageDealt' } }],
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-primal-might',
  name: 'Primal Might',
  handledLines: [
    "Target creature you control gets +X/+X until end of turn. Then it fights up to one target creature you don't control.",
  ],
  def: {
    spellAbility: {
      kind: 'spell',
      targets: [
        { kind: 'creature', controller: 'you' },
        { kind: 'creature', controller: 'opponent', count: { min: 0, max: 1 } },
      ],
      effects: [
        { op: 'pumpUntilEot', target: 0, power: { kind: 'xValue' }, toughness: { kind: 'xValue' } },
        { op: 'fightUpToOneChosen', a: 0, bSlot: 1 },
      ],
    },
  },
});

registerOverride({
  oracleId: 'oracle-foe-razer-regent',
  name: 'Foe-Razer Regent',
  handledLines: [
    "When ~ enters, you may have it fight target creature you don't control.",
    'Whenever a creature you control fights, put two +1/+1 counters on it at the beginning of the next end step.',
  ],
  def: {
    triggers: [
      {
        kind: 'triggered',
        optional: true,
        trigger: { when: 'enters', subject: SELF_SUBJECT },
        targets: [{ kind: 'creature', controller: 'opponent' }],
        effects: [{ op: 'fight', a: 'self', b: 0 }],
        description: 'you may have it fight target creature you don\'t control',
      },
      {
        kind: 'triggered',
        trigger: { when: 'fights', subject: { kind: 'permanent', selector: YOURS } },
        targets: [],
        effects: [
          {
            op: 'registerDelayedTrigger',
            when: 'endStep',
            expiry: 'endStep',
            target: 'triggerObject',
            ability: {
              kind: 'triggered',
              targets: [],
              effects: [{ op: 'putCounters', target: 'triggerObject', counter: '+1/+1', count: 2 }],
              description: 'put two +1/+1 counters on it',
            },
          },
        ],
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-spit-flame',
  name: 'Spit Flame',
  handledLines: [
    'Whenever a Dragon you control enters, you may pay {R}. If you do, return this card from your graveyard to your hand.',
  ],
  def: {
    triggers: [
      {
        kind: 'triggered',
        functionsInGraveyard: true,
        trigger: {
          when: 'enters',
          subject: { kind: 'permanent', selector: allOf(ofSubtype('Dragon'), YOURS) },
        },
        targets: [],
        effects: [
          {
            op: 'conditionalEffect',
            condition: { kind: 'mayPayMana', cost: parseManaCost('{R}').cost! },
            then: [{ op: 'returnSelfFromGraveyardToHand' }],
            else: [],
          },
        ],
      },
    ],
  },
});

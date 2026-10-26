import { ALL_COLORS } from '@mtg/shared';
import {
  allOf,
  anyOf,
  HAS_ANY_COUNTER,
  IS_ENCHANTED,
  IS_EQUIPPED,
  OTHER,
  ofSubtype,
  ofSupertype,
  ofType,
  powerAtLeast,
  toughnessAtLeast,
  YOURS,
} from '../selector';
import { NINJA_1_1_BLACK, RABBIT_1_1_WHITE, SPIDER_2_2_REACH_GREEN } from '../tokens';
import { constant } from '../value';
import { mana, manaCost, SAC_SELF, sacOther, spell, TAP, triggered } from '../templates';
import { defineCard, unsupportedCard } from './index';

const CREATURE = ofType('Creature');
const YOUR_CREATURES = allOf(CREATURE, YOURS);
const AURA = ofSubtype('Aura');

export function registerW2RemainingOverrides(): void {
  defineCard(
    '71bc69a5-7cec-4abd-b97d-13f8e1f9afac',
    'Baxter Building',
    ['{4}, {T}: Draw a card. Activate only if you control a creature with toughness 4 or greater.'],
    {
      activatedAbilities: [
        {
          costs: [mana('{4}'), TAP],
          timing: 'any',
          condition: {
            kind: 'countPermanents',
            selector: allOf(CREATURE, toughnessAtLeast(4)),
            scope: 'you',
            cmp: '>=',
            n: 1,
          },
          ability: {
            kind: 'activated',
            targets: [],
            effects: [{ op: 'draw', count: constant(1) }],
            description: 'Draw a card',
          },
        },
      ],
    },
  );

  // Brigid's back-face counted choice mana ability is handled by the generic mana grammar.

  defineCard(
    'a97e760a-99c8-47ea-a875-451aca913ee7',
    'Collective Effort',
    [
      'Escalate—Tap an untapped creature you control.',
      'Choose one or more —',
      '• Destroy target creature with power 4 or greater.',
      '• Destroy target enchantment.',
      '• Put a +1/+1 counter on each creature target player controls.',
    ],
    {
      spellAbility: {
        kind: 'spell',
        targets: [
          { kind: 'creature', filter: powerAtLeast(4) },
          { kind: 'enchantment' },
          { kind: 'player' },
        ],
        effects: [],
        modes: {
          minChoices: 1,
          maxChoices: 3,
          additionalCostPerChoiceBeyondFirst: [{ kind: 'tapOther', selector: YOUR_CREATURES }],
          options: [
            {
              targetSlots: [0],
              effects: [{ op: 'destroy', target: 0 }],
              description: 'Destroy target creature with power 4 or greater',
            },
            {
              targetSlots: [1],
              effects: [{ op: 'destroy', target: 1 }],
              description: 'Destroy target enchantment',
            },
            {
              targetSlots: [2],
              effects: [
                {
                  op: 'putCountersOnCreaturesTargetPlayerControls',
                  target: 2,
                  counter: '+1/+1',
                  count: 1,
                },
              ],
              description: 'Put a +1/+1 counter on each creature target player controls',
            },
          ],
        },
        description: 'Choose one or more',
      },
    },
  );

  defineCard('77ccafd9-6d76-4658-81ab-bde0454fcc15', 'Endless Foot Assault', ['Squad {1}{W}'], {
    optionalAdditionalCost: {
      mechanic: 'squad',
      cost: manaCost('{1}{W}'),
      repeatable: true,
    },
    triggers: [
      {
        kind: 'triggered',
        trigger: { when: 'enters', subject: { kind: 'self' } },
        targets: [],
        effects: [
          {
            op: 'createTokenCopyOf',
            ref: 'source',
            count: { kind: 'optionalCostCount', mechanic: 'squad' },
          },
        ],
        description: 'Squad — create copies for each squad cost paid',
      },
      {
        kind: 'triggered',
        trigger: {
          when: 'attacks',
          subject: { kind: 'permanent', selector: YOUR_CREATURES },
          aggregate: true,
        },
        targets: [],
        effects: [{ op: 'createTokenForEachOpponent', spec: NINJA_1_1_BLACK, attacking: true }],
        description: 'Whenever you attack, create an attacking Ninja for each opponent',
      },
    ],
  });

  // Catalog audit w2-remaining-batch-3: exile splices without a zone-change.
  unsupportedCard(
    '7514e401-7aa1-405d-9f7a-312b4e630cc2',
    'Etali, Primal Conqueror // Etali, Primal Sickness',
    'Exile splices library cards without a zone-change, so leave-library events are skipped.',
  );

  // Coverage PR01: the Oracle search has no reveal; the kicked rider untaps the found Forests and
  // makes them permanent 3/3 green haste creatures that are still lands.
  defineCard(
    'e9bc324e-c200-45ef-8b9b-52a61d0f7374',
    'Hunting Wilds',
    [
      'Kicker {3}{G}',
      'If this spell was kicked, untap all Forests put onto the battlefield this way. They become 3/3 green creatures with haste that are still lands.',
    ],
    {
      optionalAdditionalCost: { mechanic: 'kicker', cost: manaCost('{3}{G}') },
      spellAbility: spell({ targets: [], effects: [{ op: 'huntingWilds' }] }),
    },
  );

  defineCard('5a343a5f-3f9b-43c3-8532-8391de7a5443', 'Jacked Rabbit', ['Ravenous'], {
    ravenous: true,
    entersWithCounters: { '+1/+1': { kind: 'xValue' } },
    triggers: [
      {
        kind: 'triggered',
        trigger: {
          when: 'enters',
          subject: { kind: 'self' },
          condition: { kind: 'announcedXAtLeast', n: 5 },
        },
        targets: [],
        effects: [{ op: 'draw', count: constant(1) }],
        description: 'Ravenous — draw a card if X was 5 or greater',
      },
      {
        kind: 'triggered',
        trigger: { when: 'attacks', subject: { kind: 'self' } },
        targets: [],
        effects: [
          {
            op: 'createToken',
            spec: RABBIT_1_1_WHITE,
            count: { kind: 'powerOfSource' },
          },
        ],
        description: 'Attack — create Rabbits equal to this creature’s power',
      },
    ],
  });

  defineCard(
    'fe83087d-c6c1-40be-9295-baaa1c6b2db1',
    'Mondrak, Glory Dominus',
    [
      'If one or more tokens would be created under your control, twice that many of those tokens are created instead.',
      '{1}{W/P}{W/P}, Sacrifice two other artifacts and/or creatures: Put an indestructible counter on ~.',
    ],
    {
      ruleStatics: [{ kind: 'tokenCountMultiplier', multiplier: 2 }],
      activatedAbilities: [
        {
          costs: [
            mana('{1}{W/P}{W/P}'),
            sacOther(allOf(OTHER, anyOf(ofType('Artifact'), CREATURE)), 2),
          ],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [{ op: 'putCounters', target: 'source', counter: 'indestructible', count: 1 }],
            description: 'Put an indestructible counter on Mondrak',
          },
        },
      ],
    },
  );

  defineCard(
    '9a1fbe72-4a17-42be-8e23-d7d30a5e59c1',
    "Norn's Annex",
    [
      "Creatures can't attack you or planeswalkers you control unless their controller pays {W/P} for each of those creatures.",
    ],
    {
      ruleStatics: [
        { kind: 'attackTax', amount: 0, phyrexianColor: 'W', includePlaneswalkers: true },
      ],
    },
  );

  defineCard(
    '9bdc1e63-1cf9-4ddb-a7d5-f2a2eb91bdfd',
    'Pearl-Ear, Imperial Advisor',
    [
      'Enchantment spells you cast have affinity for Auras.',
      'Whenever you cast an Aura spell that targets a modified permanent you control, draw a card.',
    ],
    {
      ruleStatics: [
        {
          kind: 'costReduction',
          amount: { kind: 'countPermanents', selector: AURA, scope: 'you' },
          filter: ofType('Enchantment'),
        },
      ],
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'castsSpell',
            caster: 'you',
            filter: AURA,
            targetFilter: allOf(YOURS, anyOf(IS_ENCHANTED, IS_EQUIPPED, HAS_ANY_COUNTER)),
          },
          targets: [],
          effects: [{ op: 'draw', count: constant(1) }],
          description: 'Cast an Aura targeting a modified permanent you control — draw',
        },
      ],
    },
  );

  defineCard('96312b75-3110-4506-9f95-0c6c17d9da11', 'Securitron Squadron', ['Squad {3}'], {
    optionalAdditionalCost: {
      mechanic: 'squad',
      cost: manaCost('{3}'),
      repeatable: true,
    },
    triggers: [
      triggered(
        { when: 'enters', subject: { kind: 'self' } },
        {
          effects: [
            {
              op: 'createTokenCopyOf',
              ref: 'source',
              count: { kind: 'optionalCostCount', mechanic: 'squad' },
            },
          ],
          description: 'Squad — create copies for each squad cost paid',
        },
      ),
      // No "another": a squad copy sees its own entry and counters itself (CR 603.6a).
      triggered(
        {
          when: 'enters',
          subject: { kind: 'permanent', selector: allOf(CREATURE, YOURS, { kind: 'isToken' }) },
        },
        {
          effects: [{ op: 'putCounters', target: 'triggerObject', counter: '+1/+1', count: 1 }],
          description: 'A creature token you control enters — put a +1/+1 counter on it',
        },
      ),
    ],
  });

  defineCard(
    'eb735501-19e7-4910-aa6a-6667fff6f4e5',
    'Study Hall',
    [
      "{1}, {T}: Add one mana of any color. When you spend this mana to cast your commander, scry X, where X is the number of times it's been cast from the command zone this game.",
    ],
    {
      manaAbilities: [
        { units: [['C']], costs: [TAP] },
        {
          units: [[...ALL_COLORS]],
          costs: [mana('{1}'), TAP],
          spendTrigger: {
            when: {
              purposes: ['castSpell'],
              filter: { kind: 'isCommander' },
              description: 'cast your commander',
            },
            ability: {
              kind: 'triggered',
              targets: [],
              effects: [{ op: 'scry', count: { kind: 'commanderCastCount', player: 'you' } }],
              description: 'Scry for the number of times your commander has been cast',
            },
          },
        },
      ],
      activatedAbilities: [],
    },
  );

  defineCard('74868bc0-6081-4f46-a2c6-9521cd5465aa', 'Tender Wildguide', ['Offspring {2}'], {
    optionalAdditionalCost: { mechanic: 'offspring', cost: manaCost('{2}') },
    triggers: [
      {
        kind: 'triggered',
        trigger: { when: 'enters', subject: { kind: 'self' } },
        targets: [],
        effects: [
          {
            op: 'createTokenCopyOf',
            ref: 'source',
            count: { kind: 'optionalCostCount', mechanic: 'offspring' },
            powerOverride: 1,
            toughnessOverride: 1,
          },
        ],
        description: 'Offspring — create a 1/1 token copy',
      },
    ],
  });

  defineCard(
    'f8e17f4f-080d-4bba-bd05-ca27e94ccecc',
    'Terror of the Peaks',
    [
      'Spells your opponents cast that target this creature cost an additional 3 life to cast.',
      "Whenever another creature you control enters, this creature deals damage equal to that creature's power to any target.",
    ],
    {
      ruleStatics: [{ kind: 'targetLifeTax', amount: 3 }],
      triggers: [
        {
          kind: 'triggered',
          trigger: {
            when: 'enters',
            subject: { kind: 'permanent', selector: allOf(CREATURE, YOURS, OTHER) },
          },
          targets: [{ kind: 'anyTarget' }],
          effects: [
            {
              op: 'dealDamage',
              target: 0,
              amount: { kind: 'powerOfTriggerObject' },
            },
          ],
          description: 'Another creature enters — deal damage equal to its power to any target',
        },
      ],
    },
  );

  defineCard(
    'fd6e1967-237a-41f6-bbf4-2c869f9447c8',
    'Twitching Doll',
    [
      '{T}: Add one mana of any color. Put a nest counter on this creature.',
      '{T}, Sacrifice this creature: Create a 2/2 green Spider creature token with reach for each counter on this creature. Activate only as a sorcery.',
    ],
    {
      manaAbilities: [
        {
          units: [[...ALL_COLORS]],
          costs: [TAP],
          onActivate: [{ op: 'putCounters', target: 'source', counter: 'nest', count: 1 }],
        },
      ],
      activatedAbilities: [
        {
          costs: [TAP, SAC_SELF],
          timing: 'sorcery',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [
              {
                op: 'createToken',
                spec: SPIDER_2_2_REACH_GREEN,
                count: { kind: 'allCountersOnSelf' },
              },
            ],
            description: 'Sacrifice Twitching Doll — create a Spider for each counter on it',
          },
        },
      ],
    },
  );

  defineCard(
    '2fe0ebf5-52ed-4e92-9b93-81e9ae564439',
    'Ultimate Nullification',
    [
      'As an additional cost to cast this spell, sacrifice a legendary creature.',
      "Exile all creatures and graveyards. Put ~ on the bottom of its owner's library.",
    ],
    {
      spellAdditionalCosts: [sacOther(allOf(ofSupertype('Legendary'), CREATURE))],
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          { op: 'exileEach', selector: CREATURE },
          { op: 'exileAllGraveyards' },
          { op: 'resolvingSpellToLibraryBottom' },
        ],
        description: 'Exile all creatures and graveyards, then put this spell on the bottom',
      },
    },
  );

  // Coverage PR01: the Oracle search has no reveal. The kicked rider's count is 2 x the kicker
  // count, so an unkicked cast puts no counters.
  defineCard(
    '8ba2a7ad-a09b-4f52-9c76-c70510dc4feb',
    'Vastwood Surge',
    [
      'Kicker {4}',
      'Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle. If this spell was kicked, put two +1/+1 counters on each creature you control.',
    ],
    {
      optionalAdditionalCost: { mechanic: 'kicker', cost: manaCost('{4}') },
      spellAbility: spell({
        targets: [],
        effects: [
          {
            op: 'searchLibrary',
            filter: allOf(ofSupertype('Basic'), ofType('Land')),
            destinations: [{ zone: 'battlefield', tapped: true }],
            count: constant(2),
            allowFailToFind: true,
          },
          { op: 'shuffle' },
          {
            op: 'putCountersEach',
            selector: allOf(ofType('Creature'), YOURS),
            counter: '+1/+1',
            count: { kind: 'times', of: { kind: 'optionalCostCount', mechanic: 'kicker' }, n: 2 },
          },
        ],
      }),
    },
  );

  defineCard('d7315b3b-6e5d-4d28-a503-bfae1daf6c43', 'Verix Bladewing', ['Kicker {3}'], {
    optionalAdditionalCost: { mechanic: 'kicker', cost: manaCost('{3}') },
  });

  defineCard(
    'b168e4e6-f572-4d9f-b98f-95b2611354cb',
    'Zopandrel, Hunger Dominus',
    [
      'At the beginning of each combat, double the power and toughness of each creature you control until end of turn.',
      '{G/P}{G/P}, Sacrifice two other creatures: Put an indestructible counter on ~.',
    ],
    {
      triggers: [
        {
          kind: 'triggered',
          trigger: { when: 'beginningOfCombat', player: 'each' },
          targets: [],
          effects: [{ op: 'doublePowerAndToughnessEachUntilEot', selector: YOUR_CREATURES }],
          description: 'Each combat — double the power and toughness of your creatures',
        },
      ],
      activatedAbilities: [
        {
          costs: [mana('{G/P}{G/P}'), sacOther(allOf(OTHER, CREATURE), 2)],
          timing: 'any',
          ability: {
            kind: 'activated',
            targets: [],
            effects: [{ op: 'putCounters', target: 'source', counter: 'indestructible', count: 1 }],
            description: 'Put an indestructible counter on Zopandrel',
          },
        },
      ],
    },
  );
}

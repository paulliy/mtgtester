import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import type { TokenSpec } from '../../packages/engine/src/cards/ability';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import {
  activated,
  manaCost,
  mana,
  TAP,
  triggered,
  onEndStep,
  onCast,
  onEtb,
  onUpkeep,
  onBeginCombat,
  spell,
  whenAttacks,
  counterSpellTarget,
  ATTACHED,
  targetSlots,
} from '../../packages/engine/src/cards/templates';
import { constant } from '../../packages/engine/src/cards/value';
import {
  allOf,
  anyOf,
  not,
  ofColor,
  ofSubtype,
  ofType,
  ofSupertype,
  powerAtLeast,
  SELF,
  YOURS,
} from '../../packages/engine/src/cards/selector';
import { executableDefinitionShape } from './bounded-choice-spells';

/** Independently-authored, narrow executable compositions for PR09 library and casting families.
 * These are literal DSL inputs; they do not load the production override registry or Oracle pins. */
export const PR09_LIBRARY_COMPOSITION_IDS = [
  'end-step-discover-five',
  'opponent-cast-reveal',
  'dark-confidant',
  'keen-duelist',
  'cosmic-cube',
  'aetherworks-marvel',
  'herald-of-amity',
  'mystic-forge',
  'szarekh',
  'dream-pillager',
  'franklin-richards',
  'monstrous-vortex',
  'path-of-discovery',
  'trumpeting-carnosaur',
  'sunbirds-invocation',
  'minds-dilation',
  'chaos-warp',
  'adaptive-omnitool',
  'armored-skyhunter',
  'songbirds-blessing',
  'expressive-iteration',
  'genesis-ultimatum',
  'etali-primal-conqueror',
  'into-the-time-vortex',
  'rabble-rousing',
  'celebrate-mountain-king',
  'new-generations-technique',
  'tibalts-trickery',
  'grenzo-havoc-raiser',
  'power-pack',
  'improvisation-capstone',
] as const;
export type Pr09LibraryCompositionId = (typeof PR09_LIBRARY_COMPOSITION_IDS)[number];

function base(
  id: Pr09LibraryCompositionId,
  typeLine: string,
  types: string[],
  colors: CardDefinition['colors'],
  cost: string,
): CardDefinition {
  return {
    oracleId: `independent-pr09-${id}`,
    name: `Independent ${id}`,
    typeLine,
    supertypes: [],
    types,
    subtypes: [],
    colors,
    colorIdentity: colors,
    manaCost: manaCost(cost),
    hasUnsupportedCost: false,
    power: types.includes('Creature') ? 2 : null,
    toughness: types.includes('Creature') ? 2 : null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    spellAbility: null,
    triggers: [],
    staticEffects: [],
    ruleStatics: [],
    modeled: true,
    unmodeledReasons: [],
  };
}

export function boundedPr09Library(id: Pr09LibraryCompositionId): CardDefinition {
  if (id === 'end-step-discover-five') {
    const definition = base(id, 'Legendary Artifact', ['Artifact'], [], '{6}');
    definition.supertypes = ['Legendary'];
    definition.triggers = [
      triggered(onEndStep('you'), {
        effects: [{ op: 'discover', count: constant(5) }],
      }),
    ];
    definition.ruleStatics = [{ kind: 'cantBeCountered' }];
    return definition;
  }
  if (id === 'opponent-cast-reveal') {
    const definition = base(id, 'Enchantment', ['Enchantment'], ['G'], '{4}{G}{G}');
    definition.triggers = [
      triggered(onCast('opponent'), {
        effects: [{ op: 'revealCreatureOrBottom' }],
      }),
    ];
    return definition;
  }
  if (id === 'dark-confidant') {
    const definition = base(id, 'Creature — Human Wizard', ['Creature'], ['B'], '{1}{B}');
    definition.subtypes = ['Human', 'Wizard'];
    definition.power = 2;
    definition.toughness = 1;
    definition.triggers = [
      triggered(onUpkeep(), { effects: [{ op: 'drawRevealTopLoseManaValue' }] }),
    ];
    return definition;
  }
  if (id === 'keen-duelist') {
    const definition = base(id, 'Creature — Human Wizard', ['Creature'], ['B'], '{1}{B}');
    definition.subtypes = ['Human', 'Wizard'];
    definition.power = 2;
    definition.toughness = 2;
    definition.triggers = [
      triggered(onUpkeep(), {
        targets: [{ kind: 'player', controller: 'opponent' }],
        effects: [{ op: 'mutualRevealTopLoseManaValue', target: 0 }],
      }),
    ];
    return definition;
  }
  if (id === 'cosmic-cube') {
    const definition = base(id, 'Artifact', ['Artifact'], [], '{5}');
    definition.ward = { kind: 'mana', cost: manaCost('{2}') };
    definition.triggers = [
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
        },
      ),
    ];
    return definition;
  }
  if (id === 'aetherworks-marvel') {
    const definition = base(id, 'Legendary Artifact', ['Artifact'], [], '{4}');
    definition.supertypes = ['Legendary'];
    definition.triggers = [
      triggered(
        { when: 'dies', subject: { kind: 'permanent', selector: YOURS } },
        { effects: [{ op: 'gainEnergy', amount: constant(1) }] },
      ),
    ];
    definition.activatedAbilities = [
      activated({
        costs: [TAP, { kind: 'payEnergy', amount: 6 }],
        effects: [{ op: 'lookAtTopNCastOneFree', count: 6 }],
      }),
    ];
    return definition;
  }
  if (id === 'herald-of-amity') {
    const definition = base(id, 'Creature — Griffin', ['Creature'], ['W'], '{3}{W}');
    definition.subtypes = ['Griffin'];
    definition.power = 2;
    definition.toughness = 2;
    definition.keywords = ['flying'];
    definition.triggers = [
      triggered(onEtb(), {
        effects: [
          {
            op: 'lookAtTopNCastOneFree',
            count: 8,
            filter: allOf(ofType('Enchantment'), ofSubtype('Aura')),
            visibility: 'exile',
          },
        ],
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
      }),
    ];
    return definition;
  }
  if (id === 'szarekh') {
    const definition = base(
      id,
      'Legendary Artifact Creature — Necron',
      ['Artifact', 'Creature'],
      ['B'],
      '{1}{B}{B}{B}',
    );
    definition.supertypes = ['Legendary'];
    definition.subtypes = ['Necron'];
    definition.power = 3;
    definition.toughness = 4;
    definition.keywords = ['flying'];
    definition.triggers = [
      triggered(whenAttacks(SELF), { effects: [{ op: 'millAndChooseArtifact' }] }),
    ];
    return definition;
  }
  if (id === 'dream-pillager') {
    const definition = base(id, 'Creature — Dragon', ['Creature'], ['R'], '{5}{R}{R}');
    definition.subtypes = ['Dragon'];
    definition.power = 4;
    definition.toughness = 4;
    definition.keywords = ['flying'];
    definition.triggers = [
      triggered(
        { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
        {
          effects: [
            {
              op: 'exileTopNPlayableUntilEot',
              count: { kind: 'damageDealt' },
              castOnly: true,
            },
          ],
        },
      ),
    ];
    return definition;
  }
  if (id === 'franklin-richards') {
    const definition = base(id, 'Legendary Creature — Mutant Hero', ['Creature'], ['R'], '{5}{R}');
    definition.supertypes = ['Legendary'];
    definition.subtypes = ['Mutant', 'Hero'];
    definition.power = 6;
    definition.toughness = 6;
    definition.triggers = [
      triggered(onBeginCombat(), {
        condition: { kind: 'castSpellThisTurn', category: 'noncreature', cmp: '>=', n: 1 },
        effects: [{ op: 'discover', count: constant(6) }],
      }),
    ];
    return definition;
  }
  if (id === 'monstrous-vortex') {
    const definition = base(id, 'Enchantment', ['Enchantment'], ['G'], '{3}{G}');
    definition.triggers = [
      triggered(onCast('you', allOf(ofType('Creature'), powerAtLeast(5))), {
        effects: [{ op: 'discover', count: { kind: 'spellManaValue' } }],
      }),
    ];
    return definition;
  }
  if (id === 'path-of-discovery') {
    const definition = base(id, 'Enchantment', ['Enchantment'], ['G'], '{3}{G}');
    definition.triggers = [
      triggered(
        {
          when: 'enters',
          subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
        },
        { effects: [{ op: 'explore', target: 'triggerObject' }] },
      ),
    ];
    return definition;
  }
  if (id === 'trumpeting-carnosaur') {
    const definition = base(id, 'Creature — Dinosaur', ['Creature'], ['R'], '{4}{R}{R}');
    definition.subtypes = ['Dinosaur'];
    definition.power = 7;
    definition.toughness = 6;
    definition.keywords = ['trample'];
    definition.triggers = [
      triggered(onEtb(), { effects: [{ op: 'discover', count: constant(5) }] }),
    ];
    definition.activatedAbilities = [
      activated({
        zone: 'hand',
        costs: [mana('{2}{R}'), { kind: 'discardSelf' }],
        targets: [{ kind: 'permanent', filter: anyOf(ofType('Creature'), ofType('Planeswalker')) }],
        effects: [{ op: 'dealDamage', target: 0, amount: constant(3) }],
      }),
    ];
    return definition;
  }
  if (id === 'sunbirds-invocation') {
    const definition = base(id, 'Enchantment', ['Enchantment'], ['R'], '{5}{R}');
    definition.triggers = [
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
        },
      ),
    ];
    return definition;
  }
  if (id === 'minds-dilation') {
    const definition = base(id, 'Enchantment', ['Enchantment'], ['U'], '{5}{U}{U}');
    definition.triggers = [
      triggered(
        { when: 'castsSpell', caster: 'opponent', ordinal: 1 },
        { effects: [{ op: 'exileLibraryTop', player: 'eventPlayer', castFree: true }] },
      ),
    ];
    return definition;
  }
  if (id === 'chaos-warp') {
    const definition = base(id, 'Instant', ['Instant'], ['R'], '{2}{R}');
    definition.spellAbility = spell({
      targets: [{ kind: 'permanent' }],
      effects: [{ op: 'chaosWarp', target: 0 }],
    });
    return definition;
  }
  if (id === 'adaptive-omnitool') {
    const definition = base(id, 'Artifact — Equipment', ['Artifact'], [], '{2}');
    definition.subtypes = ['Equipment'];
    definition.triggers = [
      triggered(whenAttacks(ATTACHED), {
        effects: [
          {
            op: 'lookAtTopN',
            count: 6,
            mayPut: {
              filter: ofType('Artifact'),
              destination: { zone: 'hand' },
              reveal: true,
            },
            rest: 'bottomRandom',
          },
        ],
      }),
    ];
    definition.activatedAbilities = [
      activated({
        costs: [mana('{3}')],
        timing: 'sorcery',
        targets: [{ kind: 'creature', controller: 'you' }],
        effects: [{ op: 'attachSelfTo', target: 0 }],
      }),
    ];
    definition.staticEffects = [
      {
        affects: { kind: 'attachedToSource' },
        op: {
          layer: 7,
          sublayer: 'd',
          power: {
            kind: 'times',
            n: 1,
            of: {
              kind: 'countPermanents',
              selector: allOf(YOURS, ofType('Artifact')),
              scope: 'you',
            },
          },
          toughness: {
            kind: 'times',
            n: 1,
            of: {
              kind: 'countPermanents',
              selector: allOf(YOURS, ofType('Artifact')),
              scope: 'you',
            },
          },
        },
      },
    ];
    return definition;
  }
  if (id === 'armored-skyhunter') {
    const definition = base(id, 'Creature — Cat Knight', ['Creature'], ['W'], '{3}{W}');
    definition.subtypes = ['Cat', 'Knight'];
    definition.power = 3;
    definition.toughness = 3;
    definition.keywords = ['flying'];
    definition.triggers = [
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
      }),
    ];
    return definition;
  }
  if (id === 'songbirds-blessing') {
    const definition = base(id, 'Enchantment — Aura', ['Enchantment'], ['W'], '{3}{W}');
    definition.subtypes = ['Aura'];
    definition.spellAbility = spell({
      targets: [{ kind: 'creature' }],
      effects: [],
    });
    definition.triggers = [
      triggered(whenAttacks(ATTACHED), { effects: [{ op: 'revealUntilAura' }] }),
    ];
    return definition;
  }
  if (id === 'expressive-iteration') {
    const definition = base(id, 'Sorcery', ['Sorcery'], ['R', 'U'], '{U}{R}');
    definition.spellAbility = spell({
      effects: [{ op: 'partitionLibrary', count: 3, mode: 'handBottomExile' }],
    });
    return definition;
  }
  if (id === 'genesis-ultimatum') {
    const definition = base(id, 'Sorcery', ['Sorcery'], ['G', 'R', 'U'], '{G}{G}{U}{U}{U}{R}{R}');
    definition.spellAbility = spell({
      effects: [
        { op: 'partitionLibrary', count: 5, mode: 'permanentsAndHand' },
        { op: 'exileResolvingSpell' },
      ],
    });
    return definition;
  }
  if (id === 'etali-primal-conqueror') {
    const definition = base(
      id,
      'Legendary Creature — Elder Dinosaur // Legendary Creature — Phyrexian Elder Dinosaur',
      ['Creature'],
      ['R'],
      '{5}{R}{R}',
    );
    definition.supertypes = ['Legendary'];
    definition.subtypes = ['Elder', 'Dinosaur'];
    definition.colorIdentity = ['G', 'R'];
    definition.power = 7;
    definition.toughness = 7;
    definition.keywords = ['trample'];
    definition.triggers = [triggered(onEtb(), { effects: [{ op: 'exileEachUntilNonlandCast' }] })];
    definition.activatedAbilities = [
      activated({
        costs: [mana('{9}{G/P}')],
        timing: 'sorcery',
        effects: [{ op: 'transformSelf' }],
      }),
    ];
    definition.backFace = {
      name: 'Etali, Primal Sickness',
      typeLine: 'Legendary Creature — Phyrexian Elder Dinosaur',
      oracleText:
        'Trample, indestructible\nWhenever Etali deals combat damage to a player, they get that many poison counters. (A player with ten or more poison counters loses the game.)',
      manaCostText: null,
      frontOracleText:
        'Trample\nWhen Etali enters, each player exiles cards from the top of their library until they exile a nonland card. You may cast any number of spells from among the nonland cards exiled this way without paying their mana costs.\n{9}{G/P}: Transform Etali. Activate only as a sorcery.',
      frontManaCostText: '{5}{R}{R}',
      manaCost: null,
      hasUnsupportedCost: false,
      supertypes: ['Legendary'],
      types: ['Creature'],
      subtypes: ['Phyrexian', 'Elder', 'Dinosaur'],
      colors: ['G', 'R'],
      power: 11,
      toughness: 11,
      loyalty: null,
      defense: null,
      keywords: ['trample', 'indestructible'],
      manaAbilities: [],
      activatedAbilities: [],
      entersTapped: false,
      triggers: [
        triggered(
          { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
          {
            optional: false,
            effects: [
              {
                op: 'giveTargetPoisonCounters',
                target: 'eventPlayer',
                count: { kind: 'damageDealt' },
              },
            ],
          },
        ),
      ],
      staticEffects: [],
      ruleStatics: [],
    };
    return definition;
  }
  if (id === 'into-the-time-vortex') {
    const definition = base(id, 'Sorcery', ['Sorcery'], ['R'], '{4}{R}');
    definition.keywords = ['cascade', 'rebound'];
    definition.spellAbility = spell({ effects: [] });
    return definition;
  }
  if (id === 'rabble-rousing') {
    const definition = base(id, 'Enchantment', ['Enchantment'], ['W'], '{4}{W}');
    const citizen: TokenSpec = {
      name: 'Citizen',
      typeLine: 'Creature — Citizen',
      types: ['Creature'],
      subtypes: ['Citizen'],
      colors: ['G', 'W'],
      power: 1,
      toughness: 1,
    };
    definition.triggers = [
      triggered(onEtb(), { effects: [{ op: 'hideaway', count: 5 }] }),
      triggered(
        { when: 'attackDeclared', attacker: 'you' },
        {
          effects: [
            { op: 'createToken', spec: citizen, count: { kind: 'triggerCount' } },
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
        },
      ),
    ];
    return definition;
  }
  if (id === 'celebrate-mountain-king') {
    const definition = base(id, 'Enchantment', ['Enchantment'], ['W'], '{3}{W}');
    const targets = targetSlots({
      permanents: {
        kind: 'nonlandPermanent',
        controller: 'opponent',
        perPlayer: true,
        count: { min: 0, max: 1 },
      },
    });
    definition.triggers = [
      triggered(onEtb(), {
        targets: targets.targets,
        effects: [{ op: 'exileEachChosenUntilSourceLeaves', targetSlot: targets.slot.permanents }],
      }),
      triggered(onEtb(), { effects: [{ op: 'recruit' }] }),
    ];
    return definition;
  }
  if (id === 'new-generations-technique') {
    const definition = base(id, 'Sorcery', ['Sorcery'], ['G'], '{3}{G}');
    definition.alternativeCasts = [
      {
        kind: 'nonMana',
        manaCost: manaCost('{2}{G}'),
        costs: [{ kind: 'returnUnblockedAttacker' }],
        instantTiming: true,
        condition: {
          kind: 'allOf',
          of: [{ kind: 'yourTurn' }, { kind: 'duringStep', step: 'declareBlockers' }],
        },
        description: 'Sneak {2}{G} — return an unblocked attacker you control',
      },
    ];
    definition.spellAbility = spell({
      effects: [
        {
          op: 'searchLibrary',
          filter: allOf(ofSupertype('Basic'), ofType('Land')),
          destinations: [{ zone: 'battlefield', tapped: true }],
          count: constant(2),
        },
        { op: 'shuffle' },
      ],
    });
    return definition;
  }
  if (id === 'tibalts-trickery') {
    const definition = base(id, 'Instant', ['Instant'], ['R'], '{1}{R}');
    const targets = targetSlots({ spell: counterSpellTarget() });
    definition.spellAbility = spell({
      targets: targets.targets,
      effects: [{ op: 'trickery', target: targets.slot.spell }],
      description:
        'Counter target spell; randomly mill one to three, exile to a different nonland name, optionally cast it free, randomly bottom the rest',
    });
    return definition;
  }
  if (id === 'grenzo-havoc-raiser') {
    const definition = base(id, 'Legendary Creature — Goblin Rogue', ['Creature'], ['R'], '{R}{R}');
    definition.supertypes = ['Legendary'];
    definition.subtypes = ['Goblin', 'Rogue'];
    definition.power = 2;
    definition.toughness = 2;
    const targets = targetSlots({ creature: { kind: 'creature', controller: 'eventPlayer' } });
    definition.triggers = [
      triggered(
        {
          when: 'dealsCombatDamageToPlayer',
          subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
        },
        {
          targets: targets.targets,
          effects: [],
          modes: {
            minChoices: 1,
            maxChoices: 1,
            options: [
              {
                targetSlots: [targets.slot.creature],
                effects: [{ op: 'goad', target: targets.slot.creature }],
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
    ];
    return definition;
  }
  if (id === 'power-pack') {
    const definition = base(
      id,
      'Legendary Creature — Human Hero',
      ['Creature'],
      ['G', 'R', 'U', 'W'],
      '{1}{R}{G}{W}{U}',
    );
    definition.supertypes = ['Legendary'];
    definition.subtypes = ['Human', 'Hero'];
    definition.power = 4;
    definition.toughness = 4;
    definition.keywords = ['flying', 'vigilance', 'trample', 'haste'];
    const targets = targetSlots({
      card: {
        kind: 'cardInGraveyard',
        graveyardOwnerScope: 'controller',
        filter: anyOf(ofType('Instant'), ofType('Sorcery')),
        random: true,
      },
    });
    definition.triggers = [
      triggered(
        { when: 'dealsCombatDamageToPlayer', subject: { kind: 'self' } },
        {
          targets: targets.targets,
          effects: [{ op: 'exileAndCastNextUpkeep', target: targets.slot.card }],
          description:
            'Exile a random target instant or sorcery in your graveyard; at your next upkeep optionally cast it free, exiling it if it would go to your graveyard',
        },
      ),
    ];
    return definition;
  }
  if (id === 'improvisation-capstone') {
    const definition = base(id, 'Sorcery — Lesson', ['Sorcery'], ['R'], '{5}{R}{R}');
    definition.subtypes = ['Lesson'];
    definition.spellAbility = spell({
      effects: [{ op: 'capstoneParadigm', minimumManaValue: 4 }],
      description:
        'Exile to total mana value four or greater; optionally cast any number of those spells free. Paradigm: exile this spell and copy it each of your future first main phases after its first resolution',
    });
    return definition;
  }
  const definition = base(id, 'Artifact', ['Artifact'], [], '{4}');
  definition.ruleStatics = [
    { kind: 'lookTopLibrary' },
    {
      kind: 'castFromZone',
      zone: 'libraryTop',
      filter: anyOf(
        ofType('Artifact'),
        not(anyOf(ofColor('W'), ofColor('U'), ofColor('B'), ofColor('R'), ofColor('G'))),
      ),
    },
  ];
  definition.activatedAbilities = [
    activated({
      costs: [TAP, { kind: 'payLife', amount: 1 }],
      effects: [{ op: 'exileLibraryTop', player: 'you' }],
    }),
  ];
  return definition;
}

export const BOUNDED_PR09_LIBRARY = PR09_LIBRARY_COMPOSITION_IDS.map((id) => ({
  id,
  definition: boundedPr09Library(id),
}));

/** Full executable shape is fixed. Only root identifiers/names and ability descriptions vary. */
export function matchesBoundedPr09Library(
  definition: CardDefinition,
  id?: Pr09LibraryCompositionId,
): boolean {
  try {
    return (
      validateCardDefinition(definition).length === 0 &&
      BOUNDED_PR09_LIBRARY.some(
        (entry) =>
          (id === undefined || entry.id === id) &&
          JSON.stringify(executableDefinitionShape(definition, true)) ===
            JSON.stringify(executableDefinitionShape(entry.definition, true)),
      )
    );
  } catch {
    return false;
  }
}

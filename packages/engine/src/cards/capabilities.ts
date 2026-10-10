/** Exhaustive structural traversal of final executable IR. This describes dependencies; it does not certify behavior. */
import type {
  WardCost,
  AbilityCost,
  AlternativeCast,
  MdfcLandFace,
  ActivatedAbility,
  ManaRestriction,
  ManaSpendTrigger,
  ManaAbilitySpec,
  TargetSpec,
  Effect,
  TokenSpec,
  SearchDestination,
  TriggerSpec,
  TriggerSubject,
  Ability,
} from './ability';
import type { BackFace, CardDefinition } from './definition';
import type { Selector } from './selector';
import type { Value } from './value';
import type { Condition } from './condition';
import type { RuleStatic } from './rule-statics';
import type { ContinuousOp, StaticEffect } from './continuous-types';
import type { ParsedManaCost } from '../mana/cost';
import { IMPLEMENTED_KEYWORDS } from './ability';

type Models = {
  WardCost: WardCost;
  AbilityCost: AbilityCost;
  AlternativeCast: AlternativeCast;
  MdfcLandFace: MdfcLandFace;
  ActivatedAbility: ActivatedAbility;
  ManaRestriction: ManaRestriction;
  ManaSpendTrigger: ManaSpendTrigger;
  ManaAbilitySpec: ManaAbilitySpec;
  TargetSpec: TargetSpec;
  Effect: Effect;
  TokenSpec: TokenSpec;
  SearchDestination: SearchDestination;
  TriggerSubject: TriggerSubject;
  TriggerSpec: TriggerSpec;
  Ability: Ability;
  BackFace: BackFace;
  CardDefinition: CardDefinition;
  Selector: Selector;
  Value: Value;
  Condition: Condition;
  RuleStatic: RuleStatic;
  ContinuousOp: ContinuousOp;
  StaticEffect: StaticEffect;
  ParsedManaCost: ParsedManaCost;
};
type NodeName = keyof Models;
type Keys<T> = T extends unknown ? keyof T : never;
type Property<T, P extends PropertyKey> = T extends unknown
  ? P extends keyof T
    ? T[P]
    : never
  : never;
type Element<T> = T extends readonly (infer E)[] ? E : never;
type Objects<T> = T extends object ? (T extends readonly unknown[] ? never : T) : never;
type Fields<T> = { [P in Keys<T>]-?: Walk };
type Walk =
  | { leaf: true }
  | { node: NodeName }
  | { array: Walk }
  | { record: Walk }
  | { object: Readonly<Record<string, Walk>> }
  | { union: readonly Walk[] };
const leaf = { leaf: true } as const;

const shapes = {
  WardCost: {
    kind: leaf,
    cost: { node: 'ParsedManaCost' },
    amount: leaf,
  } satisfies Fields<Objects<WardCost>>,
  AbilityCost: {
    kind: leaf,
    selector: { node: 'Selector' },
    capturePowerForStation: leaf,
    count: { union: [leaf, { node: 'Value' }] },
    allowSelf: leaf,
    onlyCardId: leaf,
    minPower: leaf,
    counter: leaf,
    amount: { union: [leaf, { node: 'Value' }] },
    delta: leaf,
    cost: { node: 'ParsedManaCost' },
  } satisfies Fields<Objects<AbilityCost>>,
  AlternativeCast: {
    kind: leaf,
    from: leaf,
    manaCost: { node: 'ParsedManaCost' },
    costs: { array: { node: 'AbilityCost' } },
    condition: { node: 'Condition' },
    description: leaf,
    name: leaf,
    typeLine: leaf,
    ability: { node: 'Ability' },
    landFace: { node: 'MdfcLandFace' },
    spellFace: { node: 'CardDefinition' },
    exileOnResolution: leaf,
    escaped: leaf,
  } satisfies Fields<Objects<AlternativeCast>>,
  MdfcLandFace: {
    name: leaf,
    typeLine: leaf,
    oracleText: leaf,
    manaCost: leaf,
    frontOracleText: leaf,
    frontManaCost: leaf,
    colors: { array: leaf },
    supertypes: { array: leaf },
    types: { array: leaf },
    subtypes: { array: leaf },
    manaAbilities: { array: { node: 'ManaAbilitySpec' } },
    entersTapped: leaf,
    entersTappedUnless: { node: 'Condition' },
  } satisfies Fields<Objects<MdfcLandFace>>,
  ActivatedAbility: {
    costs: { array: { node: 'AbilityCost' } },
    ability: { node: 'Ability' },
    condition: { node: 'Condition' },
    timing: leaf,
    oncePerTurn: leaf,
    zone: leaf,
    requiresAttackedThisTurn: leaf,
    boast: leaf,
    exhaust: leaf,
  } satisfies Fields<Objects<ActivatedAbility>>,
  ManaRestriction: {
    purposes: { array: leaf },
    filter: { node: 'Selector' },
    sharesCreatureTypeWithCommander: leaf,
    description: leaf,
  } satisfies Fields<Objects<ManaRestriction>>,
  ManaSpendTrigger: {
    when: { node: 'ManaRestriction' },
    ability: { node: 'Ability' },
  } satisfies Fields<Objects<ManaSpendTrigger>>,
  ManaAbilitySpec: {
    units: { array: { array: leaf } },
    costs: { array: { node: 'AbilityCost' } },
    dynamic: leaf,
    condition: { node: 'Condition' },
    onActivate: { array: { node: 'Effect' } },
    restriction: { node: 'ManaRestriction' },
    spendTrigger: { node: 'ManaSpendTrigger' },
    uncounterableSpell: leaf,
    persistent: leaf,
    linked: leaf,
    conditionalUnits: {
      object: {
        condition: { node: 'Condition' },
        units: { array: { array: leaf } },
        linked: leaf,
      } satisfies Fields<Objects<Property<ManaAbilitySpec, 'conditionalUnits'>>>,
    },
    amount: { node: 'Value' },
    amountFromSacrificedManaValue: leaf,
  } satisfies Fields<Objects<ManaAbilitySpec>>,
  TargetSpec: {
    kind: leaf,
    controller: leaf,
    filter: { node: 'Selector' },
    count: {
      object: {
        min: leaf,
        max: leaf,
      } satisfies Fields<Objects<Property<TargetSpec, 'count'>>>,
    },
    totalManaValueAtMost: leaf,
    graveyardOwnerSlot: leaf,
    graveyardOwnerScope: leaf,
  } satisfies Fields<Objects<TargetSpec>>,
  Effect: {
    op: leaf,
    target: leaf,
    power: { union: [leaf, { node: 'Value' }] },
    toughness: { union: [leaf, { node: 'Value' }] },
    keyword: leaf,
    options: {
      array: {
        object: {
          effects: { array: { node: 'Effect' } },
          description: leaf,
        } satisfies Fields<Objects<Element<Property<Effect, 'options'>>>>,
      },
    },
    first: leaf,
    second: leaf,
    from: leaf,
    to: leaf,
    selector: { union: [{ node: 'Selector' }, leaf] },
    colors: { union: [{ array: leaf }, leaf] },
    amount: { union: [{ node: 'Value' }, leaf] },
    source: leaf,
    cantRegenerate: leaf,
    spec: { node: 'TokenSpec' },
    count: { union: [{ node: 'Value' }, leaf] },
    metric: leaf,
    action: leaf,
    maxManaValue: { union: [leaf, { node: 'Value' }] },
    filter: { union: [{ node: 'Selector' }, leaf] },
    creatureCounter: leaf,
    planeswalkerCounter: leaf,
    targetSlot: leaf,
    exileIfCountered: leaf,
    addManaAtNextMainPhase: leaf,
    then: { union: [{ array: { node: 'Effect' } }, { node: 'Ability' }] },
    cases: { array: { object: { n: leaf, effects: { array: { node: 'Effect' } } } } },
    otherwise: { array: { node: 'Effect' } },
    key: leaf,
    counter: leaf,
    minPower: leaf,
    scope: leaf,
    cost: { union: [{ node: 'ParsedManaCost' }, { node: 'WardCost' }] },
    player: leaf,
    anyOrder: leaf,
    name: leaf,
    abilities: { array: { node: 'Ability' } },
    exceptSource: leaf,
    destinations: { array: { node: 'SearchDestination' } },
    differentNames: leaf,
    bind: leaf,
    allowFailToFind: leaf,
    reveal: leaf,
    min: leaf,
    max: { union: [leaf, { node: 'Value' }] },
    relation: leaf,
    destination: { node: 'SearchDestination' },
    stackObjectId: leaf,
    powerOverride: { union: [leaf, { node: 'Value' }] },
    toughnessOverride: { union: [leaf, { node: 'Value' }] },
    tapped: leaf,
    attacking: leaf,
    ref: leaf,
    exceptNonLegendary: leaf,
    addTypes: { array: leaf },
    addKeywords: { array: leaf },
    sacrificeAt: leaf,
    untilEot: leaf,
    addSupertypes: { array: leaf },
    nameOverride: leaf,
    binding: leaf,
    condition: { node: 'Condition' },
    mayPut: {
      object: {
        filter: { node: 'Selector' },
        destination: { node: 'SearchDestination' },
      } satisfies Fields<Objects<Property<Effect, 'mayPut'>>>,
    },
    rest: leaf,
    mayShuffle: leaf,
    returnUnder: leaf,
    entersTapped: leaf,
    total: { node: 'Value' },
    else: { array: { node: 'Effect' } },
    checkTarget: leaf,
    payer: leaf,
    genericValue: { node: 'Value' },
    fixedSymbols: { array: leaf },
    restriction: { node: 'ManaRestriction' },
    persistent: leaf,
    when: leaf,
    ability: { node: 'Ability' },
    expiry: leaf,
    controller: leaf,
    affectedPlayer: leaf,
    sameObject: leaf,
    entersHaste: leaf,
    drawCount: leaf,
    millCount: leaf,
    a: leaf,
    bSlot: leaf,
    subtypes: { array: leaf },
    keywords: { array: leaf },
    replaceTypes: { array: leaf },
    greatestDiscarded: leaf,
    playerSlot: leaf,
    cardsSlot: leaf,
    templatedCost: { node: 'ParsedManaCost' },
    mv: { node: 'Value' },
    spell: {
      object: {
        stackObjectId: leaf,
        oracleId: leaf,
        name: leaf,
        targets: { array: leaf },
        oracleText: leaf,
        manaCost: leaf,
      } satisfies Fields<Objects<Property<Effect, 'spell'>>>,
    },
    zones: { array: leaf },
    fromTop: leaf,
  } satisfies Fields<Objects<Effect>>,
  TokenSpec: {
    name: leaf,
    typeLine: leaf,
    supertypes: { array: leaf },
    types: { array: leaf },
    subtypes: { array: leaf },
    colors: { array: leaf },
    power: { union: [leaf, { node: 'Value' }] },
    toughness: { union: [leaf, { node: 'Value' }] },
    keywords: { array: leaf },
    triggers: { array: { node: 'Ability' } },
    manaAbilities: { array: { node: 'ManaAbilitySpec' } },
    activatedAbilities: { array: { node: 'ActivatedAbility' } },
    legendary: leaf,
    grantHasteUntilEot: leaf,
    manaCost: { node: 'ParsedManaCost' },
    manaCostText: leaf,
  } satisfies Fields<Objects<TokenSpec>>,
  SearchDestination: {
    zone: leaf,
    tapped: leaf,
  } satisfies Fields<Objects<SearchDestination>>,
  TriggerSubject: {
    kind: leaf,
    selector: { node: 'Selector' },
  } satisfies Fields<Objects<TriggerSubject>>,
  TriggerSpec: {
    when: leaf,
    subject: { node: 'TriggerSubject' },
    aggregate: leaf,
    entersUntapped: leaf,
    entersFrom: { object: { zone: leaf, graveyardOwner: leaf } },
    entersWithoutManaSpentToCast: leaf,
    leavesTo: { array: leaf },
    defendingPlayerIsEventPlayer: leaf,
    counter: leaf,
    byYou: leaf,
    oncePerTurn: leaf,
    condition: { node: 'Condition' },
    caster: leaf,
    filter: { node: 'Selector' },
    targetFilter: { node: 'Selector' },
    ordinal: leaf,
    castFrom: leaf,
    player: leaf,
  } satisfies Fields<Objects<TriggerSpec>>,
  Ability: {
    kind: leaf,
    trigger: { node: 'TriggerSpec' },
    optional: leaf,
    targets: { array: { node: 'TargetSpec' } },
    effects: { array: { node: 'Effect' } },
    description: leaf,
    cantBeCountered: leaf,
    modes: {
      object: {
        minChoices: leaf,
        maxChoices: leaf,
        repeatable: leaf,
        maxChoicesIf: {
          object: {
            condition: { node: 'Condition' },
            maxChoices: leaf,
          } satisfies Fields<Objects<Property<Property<Ability, 'modes'>, 'maxChoicesIf'>>>,
        },
        additionalCostPerChoiceBeyondFirst: { array: { node: 'AbilityCost' } },
        options: {
          array: {
            object: {
              effects: { array: { node: 'Effect' } },
              description: leaf,
              additionalCost: { array: { node: 'AbilityCost' } },
              targetSlots: { array: leaf },
            } satisfies Fields<Objects<Element<Property<Property<Ability, 'modes'>, 'options'>>>>,
          },
        },
      } satisfies Fields<Objects<Property<Ability, 'modes'>>>,
    },
    functionsInGraveyard: leaf,
  } satisfies Fields<Objects<Ability>>,
  BackFace: {
    name: leaf,
    typeLine: leaf,
    oracleText: leaf,
    manaCostText: leaf,
    frontOracleText: leaf,
    frontManaCostText: leaf,
    manaCost: { node: 'ParsedManaCost' },
    hasUnsupportedCost: leaf,
    supertypes: { array: leaf },
    types: { array: leaf },
    subtypes: { array: leaf },
    colors: { array: leaf },
    power: leaf,
    toughness: leaf,
    loyalty: leaf,
    defense: leaf,
    backFace: { node: 'BackFace' },
    keywords: { array: leaf },
    ward: { node: 'WardCost' },
    protectionFrom: { array: leaf },
    manaAbilities: { array: { node: 'ManaAbilitySpec' } },
    activatedAbilities: { array: { node: 'ActivatedAbility' } },
    entersTapped: leaf,
    entersTappedUnless: { node: 'Condition' },
    entersWithCounters: { record: { union: [leaf, { node: 'Value' }] } },
    triggers: { array: { node: 'Ability' } },
    staticEffects: { array: { node: 'StaticEffect' } },
    ruleStatics: { array: { node: 'RuleStatic' } },
    cantBlock: leaf,
    cantBeBlocked: leaf,
  } satisfies Fields<Objects<BackFace>>,
  CardDefinition: {
    oracleId: leaf,
    scryfallId: leaf,
    name: leaf,
    typeLine: leaf,
    supertypes: { array: leaf },
    types: { array: leaf },
    subtypes: { array: leaf },
    colors: { array: leaf },
    colorIdentity: { array: leaf },
    manaCost: { node: 'ParsedManaCost' },
    hasUnsupportedCost: leaf,
    power: leaf,
    toughness: leaf,
    loyalty: leaf,
    defense: leaf,
    backFace: { node: 'BackFace' },
    keywords: { array: leaf },
    ward: { node: 'WardCost' },
    protectionFrom: { array: leaf },
    manaAbilities: { array: { node: 'ManaAbilitySpec' } },
    activatedAbilities: { array: { node: 'ActivatedAbility' } },
    entersTapped: leaf,
    entersTappedUnless: { node: 'Condition' },
    entersChoosingOption: {
      object: {
        prompt: leaf,
        options: {
          array: {
            object: {
              key: leaf,
              label: leaf,
            } satisfies Fields<
              Objects<
                Element<Property<Property<CardDefinition, 'entersChoosingOption'>, 'options'>>
              >
            >,
          },
        },
        domain: leaf,
      } satisfies Fields<Objects<Property<CardDefinition, 'entersChoosingOption'>>>,
    },
    entersWithCounters: { record: { union: [leaf, { node: 'Value' }] } },
    additionalCountersOnEntry: {
      array: {
        object: {
          affects: { node: 'Selector' },
          counter: leaf,
          count: { node: 'Value' },
        } satisfies Fields<Objects<Element<Property<CardDefinition, 'additionalCountersOnEntry'>>>>,
      },
    },
    tokenCreationReplacement: { node: 'TokenSpec' },
    copyLastExiledCreature: leaf,
    energyAlternativeCost: leaf,
    counterThresholdTriggers: {
      array: {
        object: {
          counter: leaf,
          threshold: leaf,
          ability: { node: 'Ability' },
        } satisfies Fields<Objects<Element<Property<CardDefinition, 'counterThresholdTriggers'>>>>,
      },
    },
    spellAbility: { node: 'Ability' },
    spellCantBeCountered: leaf,
    alternativeCasts: { array: { node: 'AlternativeCast' } },
    commanderFreeCast: leaf,
    spellAdditionalCosts: { array: { node: 'AbilityCost' } },
    announcesX: leaf,
    optionalAdditionalCost: {
      object: {
        mechanic: leaf,
        cost: { node: 'ParsedManaCost' },
        repeatable: leaf,
      } satisfies Fields<Objects<Property<CardDefinition, 'optionalAdditionalCost'>>>,
    },
    ravenous: leaf,
    entersAsCopy: {
      object: {
        selector: { node: 'Selector' },
        addTypes: { array: leaf },
        addKeywords: { array: leaf },
        addTriggers: { array: { node: 'Ability' } },
        removeSupertypes: { array: leaf },
        addCounterByType: {
          object: {
            creatureCounter: leaf,
            planeswalkerCounter: leaf,
            count: leaf,
          } satisfies Fields<
            Objects<Property<Property<CardDefinition, 'entersAsCopy'>, 'addCounterByType'>>
          >,
        },
      } satisfies Fields<Objects<Property<CardDefinition, 'entersAsCopy'>>>,
    },
    morphCost: { node: 'ParsedManaCost' },
    castFromGraveyard: leaf,
    cantBlock: leaf,
    cantBeBlocked: leaf,
    artifactGraveyardAbilities: leaf,
    emptyLibraryCreatureReplacement: leaf,
    triggers: { array: { node: 'Ability' } },
    staticEffects: { array: { node: 'StaticEffect' } },
    ruleStatics: { array: { node: 'RuleStatic' } },
    modeled: leaf,
    unmodeledReasons: { array: leaf },
  } satisfies Fields<Objects<CardDefinition>>,
  Selector: {
    kind: leaf,
    value: leaf,
    who: leaf,
    n: leaf,
    power: leaf,
    toughness: leaf,
    counter: leaf,
    keyword: leaf,
    role: leaf,
    of: { union: [{ array: { node: 'Selector' } }, { node: 'Selector' }] },
  } satisfies Fields<Objects<Selector>>,
  Value: {
    kind: leaf,
    n: leaf,
    of: { node: 'Value' },
    selector: { node: 'Selector' },
    scope: leaf,
    target: leaf,
    zone: leaf,
    owner: leaf,
    color: leaf,
    mechanic: leaf,
    counter: leaf,
    player: leaf,
  } satisfies Fields<Objects<Value>>,
  Condition: {
    kind: leaf,
    selector: { node: 'Selector' },
    scope: leaf,
    cmp: leaf,
    n: leaf,
    cost: { node: 'ParsedManaCost' },
    subtypes: { array: leaf },
    minDamage: leaf,
    counter: leaf,
    value: leaf,
    of: { union: [{ array: { node: 'Condition' } }, { node: 'Condition' }] },
    category: leaf,
    left: { node: 'Value' },
    right: { node: 'Value' },
  } satisfies Fields<Objects<Condition>>,
  RuleStatic: {
    kind: leaf,
    amount: { union: [{ node: 'Value' }, leaf] },
    coloredAmount: { node: 'ParsedManaCost' },
    filter: { node: 'Selector' },
    excludesSelf: leaf,
    yourTurnOnly: leaf,
    alsoFromCommandZone: leaf,
    selfOnly: leaf,
    appliesTo: leaf,
    who: leaf,
    duringCombatOnly: leaf,
    zone: leaf,
    permanentTypeBudget: leaf,
    source: { node: 'Selector' },
    add: {
      object: {
        kind: leaf,
        units: { array: { array: leaf } },
      } satisfies Fields<Objects<Property<RuleStatic, 'add'>>>,
    },
    count: { node: 'Value' },
    sourceFilter: { node: 'Selector' },
    sourceControllerOnly: leaf,
    multiplier: leaf,
    counter: leaf,
    addition: leaf,
    phyrexianColor: leaf,
    cost: { node: 'ParsedManaCost' },
    targetFilter: { node: 'Selector' },
    boastOnly: leaf,
    graveyardAbilities: leaf,
    minimumMana: leaf,
    condition: { node: 'Condition' },
    reduction: leaf,
  } satisfies Fields<Objects<RuleStatic>>,
  ContinuousOp: {
    layer: leaf,
    addTypes: { array: leaf },
    addSubtypes: { array: leaf },
    addAllCreatureTypes: leaf,
    setLandSubtype: leaf,
    setTypes: { array: leaf },
    setSubtypes: { array: leaf },
    loseAbilities: leaf,
    setColors: { array: leaf },
    addKeyword: leaf,
    setCantBeBlocked: leaf,
    setMustAttackEachCombat: leaf,
    addGoad: leaf,
    addWard: { node: 'WardCost' },
    addProtection: { array: leaf },
    addProtectionFromChosenColor: leaf,
    addTrigger: { node: 'Ability' },
    addActivatedAbility: { node: 'ActivatedAbility' },
    addManaAbility: { node: 'ManaAbilitySpec' },
    loseAllAbilities: leaf,
    sublayer: leaf,
    power: { union: [{ node: 'Value' }, leaf] },
    toughness: { union: [{ node: 'Value' }, leaf] },
  } satisfies Fields<Objects<ContinuousOp>>,
  StaticEffect: {
    affects: { node: 'Selector' },
    op: { node: 'ContinuousOp' },
    condition: { node: 'Condition' },
  } satisfies Fields<Objects<StaticEffect>>,
  ParsedManaCost: {
    generic: leaf,
    colored: {
      object: {
        W: leaf,
        U: leaf,
        B: leaf,
        R: leaf,
        G: leaf,
      } satisfies Fields<Objects<Property<ParsedManaCost, 'colored'>>>,
    },
    colorless: leaf,
    x: leaf,
    hybrid: { array: { array: leaf } },
    phyrexian: { array: leaf },
  } satisfies Fields<Objects<ParsedManaCost>>,
} satisfies { [N in NodeName]: Fields<Models[N]> };

const families = {
  WardCost: {
    prefix: 'WardCost',
    discriminator: 'kind',
    tags: { mana: true, life: true } satisfies Record<
      Extract<WardCost['kind'], string | number>,
      true
    >,
  },
  AbilityCost: {
    prefix: 'AbilityCost',
    discriminator: 'kind',
    tags: {
      tap: true,
      tapOther: true,
      tapOthers: true,
      tapXOthers: true,
      sacrificeSelf: true,
      exileSelf: true,
      sacrificeOther: true,
      discardSelf: true,
      discardCard: true,
      discardHand: true,
      tapCreaturesTotalPower: true,
      removeCounters: true,
      removeCountersFromAmong: true,
      payLife: true,
      payLifeValue: true,
      payEnergy: true,
      loyalty: true,
      mana: true,
      exileSelfFromGraveyard: true,
      exileOtherCardsFromGraveyard: true,
      exileCardFromHand: true,
      unattachSelf: true,
    } satisfies Record<Extract<AbilityCost['kind'], string | number>, true>,
  },
  AlternativeCast: {
    prefix: 'AlternativeCast',
    discriminator: 'kind',
    tags: {
      overload: true,
      adventure: true,
      omen: true,
      mdfc: true,
      nonMana: true,
    } satisfies Record<Extract<AlternativeCast['kind'], string | number>, true>,
  },
  MdfcLandFace: { prefix: 'MdfcLandFace', discriminator: undefined, tags: {} },
  ActivatedAbility: { prefix: 'ActivatedAbility', discriminator: undefined, tags: {} },
  ManaRestriction: { prefix: 'ManaRestriction', discriminator: undefined, tags: {} },
  ManaSpendTrigger: { prefix: 'ManaSpendTrigger', discriminator: undefined, tags: {} },
  ManaAbilitySpec: { prefix: 'ManaAbilitySpec', discriminator: undefined, tags: {} },
  TargetSpec: {
    prefix: 'TargetSpec',
    discriminator: 'kind',
    tags: {
      creature: true,
      artifact: true,
      enchantment: true,
      land: true,
      planeswalker: true,
      permanent: true,
      nonlandPermanent: true,
      artifactOrEnchantment: true,
      artifactEnchantmentOrPlaneswalker: true,
      player: true,
      anyTarget: true,
      playerOrPlaneswalker: true,
      spell: true,
      spellOrNonlandPermanent: true,
      stackObject: true,
      cardInGraveyard: true,
      noncreatureSpell: true,
      commanderInCommandZone: true,
    } satisfies Record<Extract<TargetSpec['kind'], string | number>, true>,
  },
  Effect: {
    prefix: 'Effect',
    discriminator: 'op',
    tags: {
      pumpUntilEot: true,
      grantKeywordUntilEot: true,
      cantBeBlockedUntilEot: true,
      creaturesCantBeBlockedThisTurn: true,
      chooseOne: true,
      fight: true,
      pumpEachUntilEot: true,
      doublePowerAndToughnessEachUntilEot: true,
      grantKeywordEachUntilEot: true,
      grantProtectionEachUntilEot: true,
      dealDamage: true,
      dealDamageUnlessSacrifice: true,
      destroy: true,
      regenerate: true,
      destroyAndCreateTokenForController: true,
      exileAndGainLifeTargetController: true,
      damageEachCreatureController: true,
      sacrificeAndDrawForPower: true,
      sacrificeGreatestEachOpponent: true,
      transferCountersFromTriggerObject: true,
      transferCountersFromSource: true,
      moveCounters: true,
      bolster: true,
      distributeCountersFromSource: true,
      mayPayLifeForTriggerPowerAndCounter: true,
      vindictiveLichModes: true,
      returnExiledAttachedCard: true,
      sacrificeOneCreatureEachPlayer: true,
      sacrificeOtherForMana: true,
      livingDeath: true,
      exileGraveyardCreateTokens: true,
      millAndCreateTokensForCreatures: true,
      returnArtifactCreaturesUpToManaValue: true,
      halfLifeDrainTargetOpponent: true,
      loseHalfLifeTarget: true,
      tombBladeHit: true,
      emptyLibraryCreatureOrLose: true,
      exileResolvingSpell: true,
      millTargetPlayer: true,
      millAndChooseArtifact: true,
      dealDamageNonbasicLands: true,
      sacrificeOneEachOpponent: true,
      sacrificeEachPlayer: true,
      putCounterByPermanentType: true,
      drawRevealTopLoseManaValue: true,
      goadEachOpponent: true,
      createTreasureForDeaths: true,
      preventCombatDamageAll: true,
      preventCombatDamageToController: true,
      copyTargetSpell: true,
      replicateCopies: true,
      copyEachTargetedSpell: true,
      angelGrace: true,
      arcbond: true,
      arcbondDamage: true,
      tapAndDamageController: true,
      drawForEachOpponent: true,
      drawTargetAndController: true,
      combatCalligrapher: true,
      inkshield: true,
      delirium: true,
      deflectingPalm: true,
      gisela: true,
      humbleDefector: true,
      shadrixModes: true,
      masterOfCeremonies: true,
      breenaAttack: true,
      drawTargetAndControllerN: true,
      schemingSymmetry: true,
      sacrificePermanentOnDamage: true,
      kambal: true,
      destroyAndCreateTokensEqualToManaValue: true,
      exile: true,
      exileCard: true,
      counter: true,
      counterAndCreateTokenForController: true,
      sacrifice: true,
      sacrificeOneThen: true,
      sacrificeSourceThenReflexive: true,
      mayPayManaThenReflexive: true,
      putCountersOnSourceThenReflexive: true,
      gainControlTarget: true,
      putCounters: true,
      putCountersEach: true,
      putCountersOnCreaturesTargetPlayerControls: true,
      doubleCountersTarget: true,
      doublePlayerCountersTarget: true,
      doubleCountersEach: true,
      giveTargetPoisonCounters: true,
      removeCounters: true,
      removeCountersEach: true,
      crewVehicle: true,
      becomeArtifactCreature: true,
      exileEach: true,
      exileEachOpponentGraveyard: true,
      exileAllGraveyards: true,
      resolvingSpellToLibraryBottom: true,
      resolvingSpellExile: true,
      shuffleSourceFromGraveyardIntoLibrary: true,
      resolvingSpellShuffleIntoLibrary: true,
      exileTargetPlayerGraveyard: true,
      returnToHandEach: true,
      graveyardToBattlefieldEach: true,
      returnOneFromYourGraveyardToBattlefield: true,
      graveyardToHandEach: true,
      unearth: true,
      grantUnearthToArtifactCreaturesInGraveyard: true,
      exileSource: true,
      draw: true,
      discard: true,
      putFromHandOnLibraryTop: true,
      discardAtRandom: true,
      mill: true,
      gainEnergy: true,
      createEmblem: true,
      gainLife: true,
      loseLife: true,
      loseLifeTarget: true,
      drawTarget: true,
      cascade: true,
      reboundCastFromExile: true,
      eachOpponentLosesLife: true,
      gainLifeEqualToLifeLostThisWay: true,
      eachOpponentDamage: true,
      damageController: true,
      damageEach: true,
      damageEachPlayer: true,
      searchLibrary: true,
      searchLibraryGroup: true,
      huntingWilds: true,
      etaliPrimalConqueror: true,
      searchLibraryCastFree: true,
      shuffle: true,
      scry: true,
      surveil: true,
      proliferate: true,
      counterUnlessPays: true,
      attachSelfTo: true,
      createToken: true,
      createTokenAttacking: true,
      createAttachedToken: true,
      createTokenForEachOpponent: true,
      createTokenForPlayer: true,
      createTokenForEachPlayerExceptTarget: true,
      createTokenCopyOf: true,
      becomeCopyOf: true,
      becomeCopyOfTarget: true,
      untapEach: true,
      untapBoundIf: true,
      gainControl: true,
      graveyardToBattlefield: true,
      reanimateAndLoseLife: true,
      graveyardToHand: true,
      graveyardToLibraryTop: true,
      graveyardToLibraryBottom: true,
      returnToHand: true,
      returnOneToHand: true,
      handToBattlefield: true,
      lookAtTopN: true,
      destroyEach: true,
      dealDamageEachChosen: true,
      returnToHandEachChosen: true,
      transformSelf: true,
      selfToLibraryTop: true,
      putCountersEachChosen: true,
      grantKeywordEachChosenUntilEot: true,
      doubleCountersEachChosen: true,
      cantBeBlockedEachChosen: true,
      untapUpTo: true,
      exileEachChosen: true,
      destroyEachChosen: true,
      blinkEachChosen: true,
      regainControlOfOwnCreatures: true,
      exileTargetGraveyardAndBuffIfCreature: true,
      pumpTargetPlayerCreaturesUntilEot: true,
      untapTargetPlayerCreatures: true,
      exileUntilSourceLeaves: true,
      exileTargetAndControllerMaySearchBasicLandTapped: true,
      removeTargetAndControllerMaySearchBasicLand: true,
      populate: true,
      untapAttackingPlayerNonlandPermanents: true,
      dealDamageDivided: true,
      conditionalEffect: true,
      byResolutionCountThisTurn: true,
      counterUnlessControllerPays: true,
      unlessPays: true,
      addMana: true,
      registerDelayedTrigger: true,
      commandZoneToBattlefield: true,
      commandZoneToHand: true,
      returnToCommandZone: true,
      grantAbilityUntilEot: true,
      grantHasteToResolvingSpell: true,
      grantHasteOnResolution: true,
      overloadBounceAllNonlandOpponents: true,
      goad: true,
      forceAttack: true,
      forceAttackEach: true,
      doublePower: true,
      doublePowerTarget: true,
      drawUpTo: true,
      drawUpToN: true,
      mayPayManaAndSacrificeSource: true,
      searchBasicsNamedLikeChosenLand: true,
      mayPayEnergyUpTo: true,
      mayPayEnergy: true,
      doublePlayerCounters: true,
      shuffleHandGraveyardIntoLibrary: true,
      chaosWarp: true,
      manifestTop: true,
      manifestTopForTargetController: true,
      opponentMayDrawOrMillThenDamage: true,
      lookAtTopNCastOneFree: true,
      castAnyFromHandFree: true,
      castForLifeFromZones: true,
      castOneFromHandFreeUpTo: true,
      setMustBlockThisTurn: true,
      extraCombatPhase: true,
      becomeMonarch: true,
      druidPurification: true,
      exileTargetWithSource: true,
      exileAndManifestTarget: true,
      blinkTarget: true,
      blinkOneCreatureYouControl: true,
      untapTarget: true,
      tapTarget: true,
      tapEach: true,
      bounceUpTo6MV: true,
      millAndReturnSpells: true,
      hideawayExileTop4: true,
      playExiledCardFree: true,
      fightUpToOneChosen: true,
      becomeCreatureUntilEot: true,
      discardHand: true,
      eachPlayerDiscardHandThenDraw: true,
      shuffleChosenGraveyardCardsIntoLibrary: true,
      mayPayXThenDealDamage: true,
      destroyEachNonlandMVFromDamagedControllers: true,
      returnSelfFromGraveyardToHand: true,
      returnDiedSourceToBattlefield: true,
      putDepartedSourceIntoLibrary: true,
      exileTargetReturnAtNextEndStep: true,
      returnExiledTriggerObject: true,
      reanimateTargetHasteExileAtYourNextEndStep: true,
      returnDiedTriggerObjectTapped: true,
      reanimateEachChosenTapped: true,
      connive: true,
      exileTopNPlayableUntilEot: true,
      noOp: true,
    } satisfies Record<Extract<Effect['op'], string | number>, true>,
  },
  TokenSpec: { prefix: 'TokenSpec', discriminator: undefined, tags: {} },
  SearchDestination: { prefix: 'SearchDestination', discriminator: undefined, tags: {} },
  TriggerSubject: {
    prefix: 'TriggerSubject',
    discriminator: 'kind',
    tags: { self: true, permanent: true } satisfies Record<
      Extract<TriggerSubject['kind'], string | number>,
      true
    >,
  },
  TriggerSpec: {
    prefix: 'TriggerSpec',
    discriminator: 'when',
    tags: {
      enters: true,
      dies: true,
      attacks: true,
      blocks: true,
      becomesBlocked: true,
      dealsCombatDamageToPlayer: true,
      becomesTapped: true,
      fights: true,
      becomesTargeted: true,
      dealtDamage: true,
      enchantedPlayerAttacked: true,
      sacrificed: true,
      tokenCreated: true,
      putIntoGraveyardFromAnywhere: true,
      leavesGraveyard: true,
      leavesBattlefield: true,
      transformsInto: true,
      countersPut: true,
      castsSpell: true,
      endStep: true,
      untapStep: true,
      drawStep: true,
      upkeep: true,
      beginningOfCombat: true,
      mainPhase: true,
      precombatMain: true,
      gainsLife: true,
      drawsCard: true,
      becomesCrewed: true,
      foretells: true,
    } satisfies Record<Extract<TriggerSpec['when'], string | number>, true>,
  },
  Ability: {
    prefix: 'Ability',
    discriminator: 'kind',
    tags: { spell: true, triggered: true, activated: true } satisfies Record<
      Extract<Ability['kind'], string | number>,
      true
    >,
  },
  BackFace: { prefix: 'BackFace', discriminator: undefined, tags: {} },
  CardDefinition: { prefix: 'CardDefinition', discriminator: undefined, tags: {} },
  Selector: {
    prefix: 'Selector',
    discriminator: 'kind',
    tags: {
      self: true,
      other: true,
      attachedToSource: true,
      type: true,
      subtype: true,
      supertype: true,
      color: true,
      chosenColor: true,
      chosenType: true,
      chosenSubtype: true,
      controller: true,
      powerAtLeast: true,
      powerAtMost: true,
      powerAtMostSource: true,
      toughnessAtLeast: true,
      basePowerToughness: true,
      manaValueAtMost: true,
      manaValueAtLeast: true,
      hasAnyCounter: true,
      hasCounter: true,
      hasKeyword: true,
      isToken: true,
      enteredThisTurn: true,
      isCommander: true,
      owner: true,
      isMonocolored: true,
      isEnchanted: true,
      isEquipped: true,
      inCombat: true,
      combatRole: true,
      attackingEventPlayer: true,
      allOf: true,
      anyOf: true,
      not: true,
    } satisfies Record<Extract<Selector['kind'], string | number>, true>,
  },
  Value: {
    prefix: 'Value',
    discriminator: 'kind',
    tags: {
      const: true,
      cardTypesInAllGraveyards: true,
      plus: true,
      negate: true,
      times: true,
      countPermanents: true,
      countTappedPermanents: true,
      countPermanentsControlledByTarget: true,
      aurasYouControlAttachedToCreatures: true,
      countCardsInZone: true,
      colorsAmongPermanents: true,
      devotionTo: true,
      countOpponents: true,
      greatestToughnessAmong: true,
      greatestPowerAmong: true,
      greatestManaValueAmong: true,
      totalPowerOfAttackers: true,
      totalPowerAmong: true,
      xValue: true,
      optionalCostCount: true,
      damageDealt: true,
      triggerCount: true,
      spellManaValue: true,
      spellColorCount: true,
      manaSpent: true,
      treasureManaSpent: true,
      energyPaid: true,
      energyAvailable: true,
      stationPower: true,
      countersOnSelf: true,
      allCountersOnSelf: true,
      countersOnTarget: true,
      manaValueOfTarget: true,
      commanderCastCount: true,
      commanderIdentityColorCount: true,
      lifeTotal: true,
      countOpponentsWithFewerCreatures: true,
      creaturesDiedThisTurn: true,
      powerOfSource: true,
      toughnessOfSource: true,
      powerOfTarget: true,
      opponentsLostLifeThisTurn: true,
      powerOfTriggerObject: true,
      cardsInTargetHand: true,
      tappedCreaturesControlledByTarget: true,
      attackingCreatures: true,
      spellsCastThisTurn: true,
      countersOnTriggerObject: true,
    } satisfies Record<Extract<Value['kind'], string | number>, true>,
  },
  Condition: {
    prefix: 'Condition',
    discriminator: 'kind',
    tags: {
      countPermanents: true,
      opponentControlsMore: true,
      controlsLandsWithSameName: true,
      opponentCount: true,
      mayPayLife: true,
      mayPayMana: true,
      mayRevealCardFromHand: true,
      excessDamageDealtTo: true,
      opponentDealtDamageThisTurn: true,
      totalCreaturePower: true,
      isUntapped: true,
      wasKicked: true,
      sourceWasCast: true,
      announcedXAtLeast: true,
      escaped: true,
      hasCounters: true,
      enteredThisTurn: true,
      createdTokenThisTurn: true,
      hadToAttackThisCombat: true,
      triggerObjectHadToAttackThisCombat: true,
      triggerObjectMatches: true,
      sourceMatches: true,
      compareValues: true,
      chosenOptionIs: true,
      controlsYourCommander: true,
      controlsACommander: true,
      opponentIsMonarch: true,
      notYourTurn: true,
      yourTurn: true,
      attackingPlayerHasMoreLife: true,
      attackingPlayerHasMoreLifeThanYou: true,
      triggerObjectAttackingOpponent: true,
      allOf: true,
      anyOf: true,
      eventPlayerDrawCount: true,
      notFirstDrawInOwnDrawStep: true,
      cardsInYourGraveyard: true,
      sourceHasCounters: true,
      castSpellThisTurn: true,
      not: true,
    } satisfies Record<Extract<Condition['kind'], string | number>, true>,
  },
  RuleStatic: {
    prefix: 'RuleStatic',
    discriminator: 'kind',
    tags: {
      costReduction: true,
      cantBeCountered: true,
      cantCastSpells: true,
      castFromZone: true,
      playFromZone: true,
      manaActivationRider: true,
      revealTopLibrary: true,
      additionalLandDrops: true,
      cantActivateAbilities: true,
      damageDoubled: true,
      damageDoubledToOpponents: true,
      damageHalvedToYou: true,
      tokenCountMultiplier: true,
      counterPlacementReplacement: true,
      attackTax: true,
      targetLifeTax: true,
      convoke: true,
      improvise: true,
      kicker: true,
      noMaximumHandSize: true,
      triggerAdditionalOnArtifactOrCreatureEntry: true,
      triggerAdditionalForShamanOrOtherWizard: true,
      artifactTokenCreatesThopter: true,
      grantForetell: true,
    } satisfies Record<Extract<RuleStatic['kind'], string | number>, true>,
  },
  ContinuousOp: {
    prefix: 'ContinuousOp',
    discriminator: 'layer',
    tags: { '4': true, '5': true, '6': true, '7': true } satisfies Record<
      Extract<ContinuousOp['layer'], string | number>,
      true
    >,
  },
  StaticEffect: { prefix: 'StaticEffect', discriminator: undefined, tags: {} },
  ParsedManaCost: { prefix: 'ParsedManaCost', discriminator: undefined, tags: {} },
} as const;
const FEATURES = new Set<NodeName>([
  'CardDefinition',
  'BackFace',
  'Ability',
  'ActivatedAbility',
  'AlternativeCast',
  'MdfcLandFace',
  'ManaAbilitySpec',
  'ManaRestriction',
  'ManaSpendTrigger',
  'TokenSpec',
  'StaticEffect',
  'ContinuousOp',
]);
const METADATA = new Set([
  'oracleId',
  'scryfallId',
  'name',
  'description',
  'typeLine',
  'oracleText',
  'manaCostText',
  'frontOracleText',
  'frontManaCostText',
  'frontManaCost',
  'supertypes',
  'types',
  'subtypes',
  'colors',
  'colorIdentity',
  'power',
  'toughness',
  'loyalty',
  'defense',
  'modeled',
  'unmodeledReasons',
  'kind',
  'layer',
  'sublayer',
]);
const KEYWORDS = new Set(['keywords', 'keyword', 'addKeyword', 'addKeywords']);
const enabled = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  (!Array.isArray(value) || value.length > 0) &&
  (typeof value !== 'object' || Object.keys(value).length > 0);
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Capability IR: expected object at ${path}`);
  }
  return value as Record<string, unknown>;
}

/** Dependencies present in final IR, including alternate faces and nested token behavior. */
function cardFieldCapabilities(definition: Partial<CardDefinition>): string[] {
  const capabilities = new Set<string>();
  const active = new Set<object>();
  let visited = 0;
  const add = (value: string): void => {
    capabilities.add(value);
  };
  function fields(value: unknown, shape: Readonly<Record<string, Walk>>, path: string): void {
    const record = object(value, path);
    if (active.has(record)) throw new Error(`Capability IR: cyclic graph at ${path}`);
    if (active.size >= 128) throw new Error(`Capability IR: depth budget exceeded at ${path}`);
    active.add(record);
    try {
      for (const [key, child] of Object.entries(record)) {
        const rule = Object.hasOwn(shape, key) ? shape[key] : undefined;
        if (rule === undefined) throw new Error(`Capability IR: unclassified field ${path}.${key}`);
        if (KEYWORDS.has(key) && child !== undefined) {
          for (const keyword of Array.isArray(child) ? child : [child]) {
            if (
              typeof keyword !== 'string' ||
              !(IMPLEMENTED_KEYWORDS as readonly string[]).includes(keyword)
            ) {
              throw new Error(`Capability IR: unknown keyword at ${path}.${key}`);
            }
            add(`Keyword.${keyword}`);
          }
        }
        walk(child, rule, `${path}.${key}`);
      }
    } finally {
      active.delete(record);
    }
  }
  function node(value: unknown, name: NodeName, path: string): void {
    const record = object(value, path);
    const family = families[name];
    if (family.discriminator !== undefined) {
      const tag = String(record[family.discriminator]);
      if (!Object.hasOwn(family.tags, tag))
        throw new Error(`Capability IR: unknown ${name} discriminator at ${path}`);
      add(`${family.prefix}.${tag}`);
    } else {
      add(family.prefix);
    }
    if (name === 'ContinuousOp' && record['layer'] === 7)
      add(`ContinuousOp.7${String(record['sublayer'])}`);
    if (FEATURES.has(name)) {
      for (const [key, child] of Object.entries(record)) {
        if (!METADATA.has(key) && enabled(child)) add(`${family.prefix}.${key}`);
      }
    }
    // An omitted activation cost executes as {T}; the dependency must not disappear.
    if (name === 'ManaAbilitySpec' && record['costs'] === undefined) add('AbilityCost.tap');
    fields(record, shapes[name], path);
  }
  function accepts(value: unknown, rule: Walk): boolean {
    if ('leaf' in rule) return typeof value !== 'object';
    if ('array' in rule) return Array.isArray(value);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if ('node' in rule) {
      const family = families[rule.node];
      return family.discriminator !== undefined
        ? Object.hasOwn(family.tags, String(record[family.discriminator]))
        : Object.keys(record).every((key) => Object.hasOwn(shapes[rule.node], key));
    }
    if ('object' in rule)
      return Object.keys(record).every((key) => Object.hasOwn(rule.object, key));
    if ('union' in rule) return rule.union.some((child) => accepts(value, child));
    return 'record' in rule;
  }
  function walk(value: unknown, rule: Walk, path: string): void {
    if (value === undefined || value === null) return;
    if (++visited > 100_000) throw new Error('Capability IR: graph budget exceeded');
    if ('leaf' in rule) {
      if (typeof value === 'object' || typeof value === 'function')
        throw new Error(`Capability IR: unclassified nested value at ${path}`);
    } else if ('node' in rule) {
      node(value, rule.node, path);
    } else if ('array' in rule) {
      if (!Array.isArray(value)) throw new Error(`Capability IR: expected array at ${path}`);
      for (const [index, child] of value.entries()) walk(child, rule.array, `${path}[${index}]`);
    } else if ('record' in rule) {
      for (const [key, child] of Object.entries(object(value, path)))
        walk(child, rule.record, `${path}.${key}`);
    } else if ('object' in rule) {
      fields(value, rule.object, path);
    } else {
      const options = rule.union.filter((child) => accepts(value, child));
      if (options.length !== 1)
        throw new Error(`Capability IR: ambiguous or unknown value at ${path}`);
      walk(value, options[0]!, path);
    }
  }
  node(definition, 'CardDefinition', 'card');
  return [...capabilities].sort();
}

/** Structural field coverage for full definitions and partial authored patches; no evidence claim. */
export function validateCardIRFields(definition: Partial<CardDefinition>): void {
  cardFieldCapabilities(definition);
}

/** Derive dependencies only from a fully typed executable definition. */
export function deriveCardCapabilities(definition: CardDefinition): string[] {
  return cardFieldCapabilities(definition);
}

export interface CapabilityConsumer {
  /** Explicit canonical Oracle identity from pinned input; never inferred from a fixture name. */
  canonicalOracleId: string;
  definition: CardDefinition;
}
export interface CardCapabilityIndex {
  cards: Record<string, string[]>;
  capabilities: Record<string, string[]>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

/** Pure, deterministic impact maps. Alias collisions with different final behavior fail closed. */
export function indexCardCapabilities(
  consumers: readonly CapabilityConsumer[],
): CardCapabilityIndex {
  const definitions = new Map<string, string>();
  const cards = new Map<string, string[]>();
  const capabilities = new Map<string, Set<string>>();
  for (const { canonicalOracleId, definition } of consumers) {
    if (canonicalOracleId.length === 0)
      throw new Error('Capability IR: missing canonical Oracle identity');
    const { oracleId: _oracleId, scryfallId: _scryfallId, ...behavior } = definition;
    const identity = JSON.stringify(canonical(behavior));
    const existing = definitions.get(canonicalOracleId);
    if (existing !== undefined && existing !== identity)
      throw new Error(`Capability IR: conflicting aliases for ${canonicalOracleId}`);
    if (existing !== undefined) continue;
    definitions.set(canonicalOracleId, identity);
    const dependencies = deriveCardCapabilities(definition);
    cards.set(canonicalOracleId, dependencies);
    for (const dependency of dependencies) {
      const readers = capabilities.get(dependency) ?? new Set<string>();
      readers.add(canonicalOracleId);
      capabilities.set(dependency, readers);
    }
  }
  return {
    cards: Object.fromEntries([...cards].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    capabilities: Object.fromEntries(
      [...capabilities]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, readers]) => [key, [...readers].sort()]),
    ),
  };
}

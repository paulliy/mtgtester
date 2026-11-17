import type { Effect } from './ability';
import type { Selector } from './selector';
import type { Value } from './value';
import type { Condition } from './condition';
import type { AuthoringIssue } from './authoring-validation';
import { validateIRGraph } from './ir-graph';

// This mapped shape makes every discriminator and every declared field a compiler obligation.
type Shapes<T extends { kind: string }> = {
  [K in T['kind']]: { [F in Exclude<keyof Extract<T, { kind: K }>, 'kind'>]-?: Check };
};
type Check = (value: unknown, path: string, issues: AuthoringIssue[]) => void;
const issue = (path: string, issues: AuthoringIssue[], message: string): void => {
  issues.push({ path, message });
};
const finite: Check = (value, path, issues) => {
  if (typeof value !== 'number' || !Number.isFinite(value))
    issue(path, issues, 'expected finite number');
};
const nonnegativeInteger: Check = (value, path, issues) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    issue(path, issues, 'expected nonnegative integer');
};
const positiveInteger: Check = (value, path, issues) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    issue(path, issues, 'expected positive integer');
};
const text: Check = (value, path, issues) => {
  if (typeof value !== 'string' || value.length === 0)
    issue(path, issues, 'expected nonempty string');
};
const oneOf =
  (...values: string[]): Check =>
  (value, path, issues) => {
    if (!values.includes(value as string)) issue(path, issues, 'expected ' + values.join(' | '));
  };
const flag: Check = (value, path, issues) => {
  if (value !== true) issue(path, issues, 'expected true');
};
const optional =
  (check: Check): Check =>
  (value, path, issues) => {
    if (value !== undefined) check(value, path, issues);
  };
const arrayOf =
  (check: Check): Check =>
  (value, path, issues) => {
    if (!Array.isArray(value)) {
      issue(path, issues, 'expected array');
      return;
    }
    value.forEach((entry, index) => check(entry, path + '[' + index + ']', issues));
  };
const color = oneOf('W', 'U', 'B', 'R', 'G');
const reference: Check = (value, path, issues) => {
  if (
    !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) &&
    !['source', 'triggerObject', 'attachedToSource', 'eventPlayer'].includes(value as string)
  )
    issue(path, issues, 'invalid expression reference');
};
const mana: Check = (value, path, issues) => {
  if (value === null || typeof value !== 'object') {
    issue(path, issues, 'invalid mana cost');
    return;
  }
  const cost = value as Record<string, unknown>;
  const nonnegative: Check = (part, at, out) => {
    if (typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0)
      issue(at, out, 'mana components must be nonnegative integers');
  };
  nonnegative(cost['generic'], path + '.generic', issues);
  nonnegative(cost['colorless'], path + '.colorless', issues);
  optional(nonnegative)(cost['x'], path + '.x', issues);
  const colored = cost['colored'];
  if (colored === null || typeof colored !== 'object')
    issue(path + '.colored', issues, 'expected colored components');
  else
    for (const symbol of ['W', 'U', 'B', 'R', 'G'])
      nonnegative(
        (colored as Record<string, unknown>)[symbol],
        path + '.colored.' + symbol,
        issues,
      );
  optional(arrayOf(color))(cost['phyrexian'], path + '.phyrexian', issues);
  optional(
    arrayOf((pair, at, out) => {
      if (!Array.isArray(pair) || pair.length !== 2)
        issue(at, out, 'hybrid symbol requires two colors');
      else arrayOf(color)(pair, at, out);
    }),
  )(cost['hybrid'], path + '.hybrid', issues);
};
const selector: Check = (value, path, issues) =>
  validateExpression('selector', value, path, issues);
const numberValue: Check = (value, path, issues) =>
  validateExpression('value', value, path, issues);
const condition: Check = (value, path, issues) =>
  validateExpression('condition', value, path, issues);
/** Gain-control duration union — 'permanent' | 'untilEndOfTurn' | 'whileSourceOnBattlefield'. */
const controlDuration: Check = (value, path, issues) => {
  if (!['permanent', 'untilEndOfTurn', 'whileSourceOnBattlefield'].includes(value as string))
    issue(path, issues, 'expected permanent | untilEndOfTurn | whileSourceOnBattlefield');
};

const selectorShapes = {
  self: {},
  other: {},
  attachedToSource: {},
  type: { value: text },
  subtype: { value: text },
  supertype: { value: text },
  name: { value: text },
  color: { value: color },
  chosenColor: {},
  chosenType: {},
  chosenSubtype: {},
  sameNameAsSource: {},
  controller: { who: oneOf('you', 'opponents', 'eventPlayer') },
  powerAtLeast: { n: finite },
  powerAtMost: { n: finite },
  powerAtMostSource: {},
  toughnessAtLeast: { n: finite },
  basePowerToughness: { power: finite, toughness: finite },
  powerGreaterThanBase: {},
  manaValueAtMost: { n: finite },
  manaValueAtLeast: { n: finite },
  manaCostIs: { manaCosts: arrayOf(text) },
  hasAnyCounter: {},
  hasCounter: { counter: text },
  hasKeyword: { keyword: text },
  isToken: {},
  tapped: {},
  enteredThisTurn: {},
  isCommander: {},
  owner: { who: oneOf('you') },
  isMonocolored: {},
  isEnchanted: {},
  isEquipped: {},
  inCombat: {},
  combatRole: { role: oneOf('attacking', 'blocking') },
  attackingEventPlayer: {},
  attackingChosenPlayer: {},
  attackedThisTurn: {},
  controlledSinceTurnStart: {},
  attackingOpponent: {},
  attackingYouOrYourPlaneswalker: {},
  enchantedByAuraYouControl: {},
  allOf: { of: arrayOf(selector) },
  anyOf: { of: arrayOf(selector) },
  not: { of: selector },
} satisfies Shapes<Selector>;

const valueShapes = {
  const: { n: finite },
  cardTypesInAllGraveyards: {},
  cardTypesInYourGraveyard: {},
  cardTypesInOpponentsGraveyards: {},
  greatestNoncreatureManaValueYouControlOrInGraveyard: {},
  plus: { of: numberValue, n: finite },
  negate: { of: numberValue },
  times: { of: numberValue, n: finite },
  countPermanents: { selector: selector, scope: oneOf('you', 'opponents', 'all') },
  countTappedPermanents: { selector: selector, scope: oneOf('you', 'opponents', 'all') },
  countPermanentsControlledByTarget: { target: reference, selector: selector },
  aurasYouControlAttachedToCreatures: {},
  aurasAttachedToSource: {},
  countCardsInZone: {
    zone: oneOf('graveyard', 'hand', 'library'),
    selector: selector,
    owner: oneOf('you', 'opponents', 'all'),
  },
  colorsAmongPermanents: {},
  colorsAmongPermanentsAndSpellsCastThisTurn: {},
  devotionTo: { color: color, and: optional(color) },
  countOpponents: {},
  greatestToughnessAmong: { selector: selector, scope: oneOf('you', 'opponents', 'all') },
  greatestPowerAmong: { selector: selector, scope: oneOf('you', 'opponents', 'all') },
  greatestManaValueAmong: { selector: selector, scope: oneOf('you', 'opponents', 'all') },
  totalPowerOfAttackers: {},
  totalPowerAmong: { selector: selector, scope: oneOf('you', 'opponents', 'all') },
  xValue: {},
  optionalCostCount: { mechanic: oneOf('kicker', 'squad', 'offspring') },
  damageDealt: {},
  triggerCount: {},
  aurasYouControlledAttachedToTriggerObject: {},
  spellManaValue: {},
  spellColorCount: {},
  manaSpent: {},
  treasureManaSpent: {},
  energyPaid: {},
  energyAvailable: {},
  stationPower: {},
  countersOnSelf: { counter: text },
  allCountersOnSelf: {},
  countersOnTarget: { target: reference, counter: text },
  manaValueOfTarget: { target: reference },
  commanderCastCount: { player: optional(oneOf('you')) },
  commanderIdentityColorCount: {},
  lifeTotal: { scope: optional(oneOf('you', 'eventPlayer')) },
  countOpponentsWithFewerCreatures: {},
  creaturesDiedThisTurn: {},
  powerOfSource: {},
  timesAttackedThisTurn: {},
  toughnessOfSource: {},
  powerOfTarget: { target: reference },
  opponentsLostLifeThisTurn: {},
  powerOfTriggerObject: {},
  cardsInTargetHand: { target: reference },
  tappedCreaturesControlledByTarget: { target: reference },
  attackingCreatures: {},
  spellsCastThisTurn: {},
  manaValueOfOtherSpellsCastThisTurn: {},
  countersOnTriggerObject: { counter: text },
} satisfies Shapes<Value>;

const conditionShapes = {
  countPermanents: {
    selector: selector,
    scope: oneOf('you', 'opponents', 'all'),
    cmp: oneOf('>=', '<='),
    n: finite,
  },
  opponentControlsMore: { selector: selector },
  controlsLandsWithSameName: { n: finite },
  opponentCount: { cmp: oneOf('>=', '<='), n: finite },
  anyPlayerLifeAtMost: { n: finite },
  mayPayLife: { n: finite },
  mayPayMana: { cost: mana },
  mayRevealCardFromHand: { subtypes: arrayOf(text) },
  excessDamageDealtTo: { scope: oneOf('opponents') },
  opponentDealtDamageThisTurn: { minDamage: finite },
  opponentDiscardedThisTurn: {},
  totalCreaturePower: {
    scope: oneOf('you', 'opponents', 'all'),
    cmp: oneOf('>=', '<='),
    n: finite,
  },
  isUntapped: {},
  wasKicked: {},
  sourceWasCast: {},
  announcedXAtLeast: { n: finite },
  escaped: {},
  castDuringYourMainPhase: {},
  hasCounters: { selector: selector, counter: text, cmp: oneOf('>=', '<='), n: finite },
  enteredThisTurn: {},
  createdTokenThisTurn: {},
  exiledWithSourceAtLeast: { n: finite, cardType: text },
  hadToAttackThisCombat: {},
  triggerObjectHadToAttackThisCombat: {},
  triggerObjectMatches: { selector: selector },
  sourceMatches: { selector: selector },
  compareValues: {
    left: (value, path, issues) => numericExpression(value, path, issues),
    cmp: oneOf('>=', '<=', '=='),
    right: (value, path, issues) => numericExpression(value, path, issues),
  },
  chosenOptionIs: { value: text },
  controlsYourCommander: {},
  controlsACommander: {},
  opponentIsMonarch: {},
  notYourTurn: {},
  duringStep: {
    step: oneOf(
      'untap',
      'upkeep',
      'draw',
      'beginCombat',
      'declareAttackers',
      'declareBlockers',
      'firstStrikeCombatDamage',
      'combatDamage',
      'endCombat',
      'end',
      'cleanup',
    ),
  },
  beforeAttackersDeclared: {},
  duringYourMainPhase: {},
  yourTurn: {},
  attackingPlayerHasMoreLife: {},
  attackingPlayerHasMoreLifeThanYou: {},
  defendingOpponentHasMoreLifeThanAnother: {},
  triggerObjectAttackingOpponent: {},
  attackGroupAttackingYou: {
    planeswalkers: (value, path, issues) => {
      if (typeof value !== 'boolean') issues.push({ path, message: 'expected a boolean' });
    },
    cmp: oneOf('>=', '<=', '=='),
    n: finite,
  },
  attackWasNotAtYou: {},
  attackedPlayerHasMoreLifeThanAnotherOpponent: {},
  eventObjectDefendingPlayerIsYou: {},
  allOf: { of: arrayOf(condition) },
  anyOf: { of: arrayOf(condition) },
  eventPlayerDrawCount: { cmp: oneOf('>=', '<=', '=='), n: finite },
  notFirstDrawInOwnDrawStep: {},
  cardsInYourGraveyard: { cmp: oneOf('>=', '<=', '=='), n: finite },
  sourceHasCounters: { counter: text, cmp: oneOf('>=', '<=', '=='), n: finite },
  giftPromised: {},
  sourceClassLevel: { cmp: oneOf('>=', '<=', '=='), n: finite },
  eventPlayerHandSize: { cmp: oneOf('>=', '<=', '=='), n: finite },
  castSpellThisTurn: { category: oneOf('any', 'noncreature'), cmp: oneOf('>=', '<='), n: finite },
  modifiedCreatureDiedUnderYourControlThisTurn: {},
  youAttackedThisTurn: {},
  not: { of: condition },
} satisfies Shapes<Condition>;

/** Validate in a declared expression position, so unknown kinds cannot evade classification. */
export function validateExpression(
  domain: 'selector' | 'value' | 'condition',
  value: unknown,
  path: string,
  issues: AuthoringIssue[],
): void {
  if (!validateIRGraph(value, path, issues)) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issue(path, issues, 'expected ' + domain + ' expression');
    return;
  }
  const record = value as Record<string, unknown>;
  const shapes: Record<string, Record<string, Check>> = domain === 'selector'
    ? selectorShapes
    : domain === 'value'
      ? valueShapes
      : conditionShapes;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(shapes, kind)) {
    issue(path, issues, 'unknown ' + domain + ' expression kind');
    return;
  }
  for (const [field, check] of Object.entries(shapes[kind]!))
    check(record[field], path + '.' + field, issues);
}

export { mana as validateParsedManaCost };

const numericExpression: Check = (value, path, issues) => {
  if (typeof value === 'number') finite(value, path, issues);
  else numberValue(value, path, issues);
};
const selectorOr =
  (...allowed: string[]): Check =>
  (value, path, issues) => {
    if (typeof value === 'string') oneOf(...allowed)(value, path, issues);
    else selector(value, path, issues);
  };

// All effect operations participate, including operations with no expression operands.
type ExpressionFields<T> = {
  [F in keyof T as Extract<T[F], Selector | Value | Condition> extends never ? never : F]-?: Check;
};
const effectExpressions = {
  amass: { count: numberValue },
  payLifeOrTopDrawnCards: { count: numberValue, life: numberValue },
  returnCardFromGraveyardToHand: { filter: selector },
  pumpUntilEot: { power: numericExpression, toughness: numericExpression },
  grantKeywordUntilEot: {},
  cantBeBlockedUntilEot: {},
  creaturesCantBeBlockedThisTurn: {},
  chooseOne: {},
  fight: {},
  pumpEachUntilEot: { selector: selector, power: numericExpression, toughness: numericExpression },
  doublePowerAndToughnessEachUntilEot: { selector: selector },
  grantKeywordEachUntilEot: { selector: selector },
  denyKeywordsEachUntilEot: { selector: selector },
  loseKeywordsEachUntilEot: { selector: selector },
  grantKeywordToAttackGroupUntilEot: {},
  putCountersOnCreatureOfChoice: { count: finite },
  returnBlockedCreatureAtEndOfCombat: {},
  damageEachOtherOpponent: { amount: numberValue },
  grantProtectionEachUntilEot: { selector: selector },
  grantChosenColorProtectionUntilEot: {},
  returnSpellToOwnerHand: {},
  exileSpellAndPlot: {},
  prohibitSpellsThisTurn: {},
  phaseOutAndProtectControllerUntilNextTurn: {},
  controllerProtectionFromEverythingUntilNextTurn: {},
  phaseOutEachChosen: {},
  controllerHexproofUntilEot: {},
  changeSingleTarget: {},
  chooseNewTargets: {},
  exileGraveyardEventCard: {},
  sacrificeTargetPlayerCreature: {},
  eachPlayerKeepsCreatureWithVow: {},
  separatePermanentsIntoPilesThenSacrifice: {},
  separateIntoPilesLimitAttackers: {},
  dealDamage: { amount: numberValue },
  dealDamageUnlessSacrifice: { amount: numberValue },
  destroy: {},
  regenerate: {},
  destroyAndCreateTokenForController: { count: numberValue },
  exileAndGainLifeTargetController: {},
  damageEachCreatureController: { amount: numberValue },
  sacrificeAndDrawForPower: {},
  sacrificeGreatestEachOpponent: { damageIfGraveyardSpellsAtLeast: optional(nonnegativeInteger) },
  transferCountersFromTriggerObject: {},
  transferCountersFromTriggerObjectToChosenCreatures: {},
  mayForgoTriggerObjectCombatDamageForRandomDiscard: {},
  gainClassLevel: { level: positiveInteger },
  drawForOpponentsWithSmallHands: { maximum: nonnegativeInteger },
  sacrificeNonlandOrDiscardOrLoseLife: { amount: numberValue },
  transferCountersFromSource: { counter: optional(text) },
  moveCounters: { counter: text, count: finite },
  moveAllCounters: {},
  bolster: { count: finite },
  distributeCountersFromSource: { selector: selector },
  mayPayLifeForTriggerPowerAndCounter: {},
  vindictiveLichModes: {},
  returnExiledAttachedCard: {},
  sacrificeOneCreatureEachPlayer: {},
  sacrificeOtherForMana: {},
  livingDeath: {},
  exileGraveyardCreateTokens: {},
  millAndCreateTokensForCreatures: {},
  returnArtifactCreaturesUpToManaValue: {},
  halfLifeDrainTargetOpponent: {},
  loseHalfLifeTarget: {},
  tombBladeHit: {},
  emptyLibraryCreatureOrLose: {},
  exileResolvingSpell: {},
  millTargetPlayer: {},
  millAndChooseArtifact: {},
  millThenReturnMilledCard: { filter: selector },
  dealDamageNonbasicLands: {},
  sacrificeOneEachOpponent: { filter: selectorOr('creature', 'nonland') },
  sacrificeEachPlayer: {},
  eventPlayerSacrificesPermanents: { count: numericExpression },
  attackingOpponentUntapsNonland: {},
  reanimateEnchantedCardAndAttach: {},
  sacrificeRememberedPermanent: {},
  putCounterByPermanentType: { count: numericExpression },
  drawRevealTopLoseManaValue: {},
  mutualRevealTopLoseManaValue: {},
  discover: { count: numberValue },
  revealUntilAura: {},
  exileEachUntilNonlandCast: {},
  revealCreatureOrBottom: {},
  explore: {},
  exileLibraryTop: {},
  partitionLibrary: {},
  recruit: {},
  trickery: {},
  exileAndCastNextUpkeep: {},
  castRememberedExile: {},
  capstoneParadigm: {},
  castParadigmCopy: {},

  goadEachOpponent: {},
  createTreasureForDeaths: {},
  preventCombatDamageAll: {},
  createDamageShield: {
    player: optional(oneOf('you')),
    target: optional(reference),
    dealtTo: optional(flag),
    dealtBy: optional(flag),
    combatOnly: optional(flag),
    chosenSource: optional(flag),
    oneShot: optional(flag),
    reflect: optional(oneOf('toSourceController', 'toSourceCreatureElseController')),
    andPlaneswalkersYouControl: optional(flag),
    sources: optional(oneOf('youDontControl')),
  },
  copyTargetSpell: { newTargets: optional(flag) },
  replicateCopies: { optional: optional(flag), oncePerTurn: optional(flag) },
  copyCastSpell: { optional: optional(flag), oncePerTurn: optional(flag) },
  nextCastThisTurn: { filter: selector },
  copyActivatedAbility: { mayPayLifeAgain: optional(flag) },
  copyStackAbility: { lifeCost: optional(nonnegativeInteger) },
  createTokenCopyOfEventGroupMember: { count: numberValue },
  mayReturnEventGroupMemberToHand: {},
  copyTargetAbility: { count: positiveInteger, newTargets: optional(flag) },
  copyEachTargetedSpell: { newTargets: optional(flag) },
  angelGrace: {},
  castAsThoughFlashThisTurn: {},
  drawForEachOpponent: {},
  drawTargetAndController: {},
  inkshield: {},
  gisela: {},
  humbleDefector: {},
  shadrixModes: {},
  masterOfCeremonies: {},
  drawTargetAndControllerN: {},
  schemingSymmetry: {},
  kambal: {},
  destroyAndCreateTokensEqualToManaValue: {},
  exile: {},
  exileCard: {},
  counter: {
    manaSpentAtNextMainPhase: optional((value, path, issues) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        issue(path, issues, 'expected object');
        return;
      }
      condition((value as { condition?: unknown }).condition, path + '.condition', issues);
    }),
  },
  counterAndCreateTokenForController: { count: numberValue },
  sacrifice: {},
  sacrificeOneThen: { selector: selector },
  sacrificeSourceThenReflexive: {},
  mayPayManaThenReflexive: {},
  mayPayEnergyThenReflexive: { min: finite, exact: optional(flag) },
  putCountersOnSourceThenReflexive: { counter: text, count: finite },
  gainControlTarget: {},
  swapCreatureControlUntilEot: {},
  putCounters: { count: numericExpression },
  putCountersEach: { selector: selector, count: numericExpression },
  putCountersOnCreaturesTargetPlayerControls: { count: numericExpression },
  doubleCountersTarget: {},
  doublePlayerCountersTarget: {},
  doubleCountersEach: { selector: selector },
  giveTargetPoisonCounters: { count: numericExpression },
  removeCounters: { count: numericExpression },
  removeCountersEach: { selector: selector, count: numericExpression },
  crewVehicle: {},
  becomeArtifactCreature: {},
  exileEach: { selector: selector },
  exileEachOpponentGraveyard: {},
  exileAllGraveyards: {},
  resolvingSpellToLibraryBottom: {},
  resolvingSpellExile: {},
  shuffleSourceFromGraveyardIntoLibrary: {},
  resolvingSpellShuffleIntoLibrary: {},
  exileTargetPlayerGraveyard: {},
  returnToHandEach: { selector: selector },
  graveyardToBattlefieldEach: { filter: selector },
  returnOneFromYourGraveyardToBattlefield: { filter: selector },
  graveyardToHandEach: { filter: selector },
  unearth: {},
  grantUnearthToArtifactCreaturesInGraveyard: {},
  exileSource: {},
  draw: { count: numberValue },
  additionalLandPlaysThisTurn: { count: numberValue },
  discard: {},
  putFromHandOnLibraryTop: { count: numberValue },
  discardAtRandom: { count: numberValue },
  discardTarget: { count: numberValue },
  discardOrLoseLife: { amount: numberValue },
  millEachPlayer: { count: numberValue },
  councilVote: {},
  takeExtraTurn: {},
  sacrificeThenOpponentsShareTypeOrPunish: { selector: selector, life: numberValue },
  searchLibraryAndOrGraveyardToBattlefield: { filter: selector, maxManaValue: numberValue },
  eachPlayerDraws: { count: numberValue },
  eachPlayerLosesLifeAndDraws: { amount: numberValue, count: numberValue },
  discardChosenPlayers: { count: numberValue },
  millAndLoseLifeChosenPlayers: { count: numberValue, amount: numberValue },
  revealHandAndDiscard: { filter: selector },
  discardEachPlayer: { count: numberValue, opponentsUnableLoseLife: optional(numberValue) },
  mill: { count: numberValue },
  gainEnergy: { amount: numberValue },
  createEmblem: {},
  targetPlayerMaySearchNamed: {},
  gainLife: { amount: numberValue },
  loseLife: { amount: numberValue },
  loseLifeTarget: { amount: numberValue },
  drawTarget: { count: numberValue },
  gainLifeTarget: { amount: numberValue },
  cascade: {},
  reboundCastFromExile: {},
  eachOpponentLosesLife: { amount: numericExpression },
  gainLifeEqualToLifeLostThisWay: {},
  eachOpponentDamage: { amount: numericExpression },
  damageController: {},
  damageEach: { selector: selector, amount: numberValue },
  damageEachPlayer: { amount: numberValue },
  searchLibrary: { filter: selector, count: optional(numberValue) },
  searchLibraryGroup: { filter: selector },
  huntingWilds: {},
  searchLibraryCastFree: { filter: selector },
  shuffle: {},
  scry: { count: numericExpression },
  surveil: {},
  proliferate: {},
  counterUnlessPays: {},
  attachSelfTo: {},
  createToken: {
    count: numberValue,
    powerOverride: optional(numericExpression),
    toughnessOverride: optional(numericExpression),
  },
  createTokenAttacking: {
    count: numberValue,
    powerOverride: optional(numericExpression),
    toughnessOverride: optional(numericExpression),
  },
  createAttachedToken: {},
  createTokenForEachOpponent: {},
  createTokenForPlayer: { count: numberValue },
  createTokenForEachPlayerExceptTarget: { count: numberValue },
  eachOpponentCreatesTokens: { count: numberValue },
  shareTokensWithChosenOpponent: { count: numberValue },
  shareCreatureLifeWithChosenOpponent: { amount: numberValue },
  createTokenCopyOf: {
    count: numberValue,
    powerOverride: optional(numericExpression),
    toughnessOverride: optional(numericExpression),
  },
  becomeCopyOf: {},
  becomeCopyOfTarget: {},
  untapEach: { selector: selector },
  untapBoundIf: { condition: condition },
  gainControl: { selector: selector },
  graveyardToBattlefield: {},
  reanimateAndLoseLife: {},
  graveyardToHand: {},
  graveyardToLibraryTop: {},
  graveyardToLibraryBottom: {},
  returnToHand: {},
  returnOneToHand: { selector: selector },
  handToBattlefield: { filter: selector, maxManaValue: optional(numberValue) },
  lookAtTopN: {},
  destroyEach: { selector: selector },
  dealDamageEachChosen: { amount: numberValue },
  returnToHandEachChosen: {},
  transformSelf: {},
  becomePrepared: {},
  mayDiscardThenDraw: { count: positiveInteger },
  eachPlayerGainsLife: { amount: numberValue },
  eachPlayerLosesLife: { amount: numberValue },
  eachPlayerLooksAtTopRevealsToHand: { count: positiveInteger },
  sourceGainsAbility: {},
  selfToLibraryTop: {},
  putCountersEachChosen: { count: numericExpression },
  grantKeywordEachChosenUntilEot: {},
  cantBlockEachChosenThisTurn: {},
  doubleCountersEachChosen: {},
  cantBeBlockedEachChosen: {},
  untapUpTo: { selector: selector },
  exileEachChosen: {},
  destroyEachChosen: {},
  tapAndGoadEachChosen: {},
  blinkEachChosen: {},
  regainControlOfOwnCreatures: {},
  exileTargetGraveyardAndBuffIfCreature: {},
  pumpTargetPlayerCreaturesUntilEot: {},
  untapTargetPlayerCreatures: {},
  exileUntilSourceLeaves: {},
  exileEachChosenUntilSourceLeaves: {},
  removeTargetAndControllerMaySearchBasicLand: {},
  destroyTargetAndControllerMaySearchBasicTypedLand: {},
  exileCreatureAndControllerSearchBasicLand: {},
  exileEachCreatureAndControllersSearchBasicLands: { selector },
  populate: {},
  untapAttackingPlayerNonlandPermanents: {},
  dealDamageDivided: { total: numberValue },
  conditionalEffect: { condition: condition },
  byResolutionCountThisTurn: { key: text },
  counterUnlessControllerPays: {},
  unlessPays: { genericValue: optional(numberValue) },
  addMana: { amount: numberValue },
  registerDelayedTrigger: {},
  commandZoneToBattlefield: {},
  commandZoneToHand: {},
  returnToCommandZone: {},
  grantAbilityUntilEot: {},
  grantHasteToResolvingSpell: {},
  grantHasteOnResolution: {},
  overloadBounceAllNonlandOpponents: {},
  goad: {},
  chooseAttackersAndBlockers: {},
  addAttackRequirement: { selector: optional(selector) },
  cantBlockEach: { selector: selector },
  limitAttacksToNearestOpponent: {},
  attackLifeTaxUntilYourNextTurn: {},
  chooseOpponentForSource: {},
  removeAttackersFromCombat: {},
  eventPlayerMayDraw: {},
  forceAttack: {},
  forceAttackEach: { selector: selector },
  doublePower: { selector: selector },
  doublePowerTarget: {},
  drawUpTo: {},
  drawUpToN: {},
  mayPayManaAndSacrificeSource: {},
  searchBasicsNamedLikeChosenLand: {},
  mayPayEnergyUpTo: { max: numberValue },
  mayPayEnergy: { amount: numberValue },
  doublePlayerCounters: {},
  shuffleHandGraveyardIntoLibrary: {},
  chaosWarp: {},
  manifestTop: {},
  manifestTopForTargetController: {},
  manifestDread: {},
  exileFaceDownPlayable: {},
  opponentMayDrawOrMillThenDamage: {},
  lookAtTopNCastOneFree: {
    count: (value, path, issues) =>
      typeof value === 'number' ? finite(value, path, issues) : numberValue(value, path, issues),
    filter: optional(selector),
    maxManaValue: optional(numberValue),
  },
  castAnyFromHandFree: {},
  castForLifeFromZones: { selector: selector },
  castOneFromHandFreeUpTo: {},
  setMustBlockThisTurn: {},
  extraCombatPhase: {},
  becomeMonarch: {},
  druidPurification: {},
  attackingCreaturesToOwnerLibraries: {},
  rotateSourceAtUpkeep: {},
  choosePermanentTypesThenSacrificeOthers: {
    types: arrayOf(oneOf('Artifact', 'Creature', 'Enchantment', 'Planeswalker')),
  },
  eachPlayerMayPutCountersAndGoad: { count: numericExpression },
  voteAndExileMost: { selector: selector },
  exileTargetWithSource: {},
  exileFromHandWithSource: {},
  exileGraveyardCardWithSource: { drawIfCardType: text },
  flipCoin: {},
  returnRandomExiledWithSourceToHand: {},
  exileAndManifestTarget: {},
  blinkTarget: { returnUnder: optional(oneOf('owner', 'you')) },
  blinkOneCreatureYouControl: {},
  untapTarget: {},
  tapTarget: {},
  tapEach: { selector: selector },
  bounceUpTo6MV: {},
  millAndReturnSpells: {},
  hideawayExileTop4: {},
  hideaway: {},
  playExiledCardFree: {},
  fightUpToOneChosen: {},
  becomeCreatureUntilEot: {},
  discardHand: {},
  eachPlayerDiscardHandThenDraw: { count: optional(numberValue) },
  putAnyFromHandOnBottomThenDraw: { extra: nonnegativeInteger },
  shuffleChosenGraveyardCardsIntoLibrary: {},
  mayPayXThenDealDamage: {},
  destroyEachNonlandMVFromDamagedControllers: { mv: numberValue },
  returnSelfFromGraveyardToHand: {},
  createTokenCopyOfSourceCard: {
    setColors: arrayOf(color),
    addSubtypes: arrayOf(text),
    basePower: optional(nonnegativeInteger),
    baseToughness: optional(nonnegativeInteger),
  },
  returnSelfFromGraveyardToBattlefield: {
    tapped: optional(flag),
    counter: optional(text),
    counterCount: optional(positiveInteger),
  },
  returnDiedSourceToBattlefield: { counter: optional(text), tapped: optional(flag) },
  putDepartedSourceIntoLibrary: { fromTop: finite },
  returnDepartedSourceToHand: {},
  exileTargetReturnAtNextEndStep: { returnUnder: oneOf('owner', 'sourceController') },
  returnExiledTriggerObject: { returnUnder: oneOf('owner', 'sourceController') },
  reanimateTargetHasteExileAtYourNextEndStep: { exileAt: optional(oneOf('yourNextUpkeep')) },
  returnDiedTriggerObjectTapped: {},
  returnDiedTriggerObjectAtNextEndStep: {},
  returnRememberedGraveyardCard: {},
  returnDepartedSourceToBattlefield: {},
  attach: {},
  reflexiveOnCreatedToken: {},
  returnChosenCardsAttachedTo: {},
  reanimateEachChosenTapped: {},
  reanimateEachChosen: { counter: optional(text), addTypes: optional(arrayOf(text)) },
  connive: {},
  exileTopNPlayableUntilEot: { count: numberValue },
  noOp: {},
} satisfies { [O in Effect['op']]: ExpressionFields<Extract<Effect, { op: O }>> };

/**
 * Ops with optional NON-expression fields (durations, rider flags) — the expression registry
 * above can only carry Selector/Value/Condition operands, so anything else is checked here.
 * Malformed payloads surface as authoring issues, never silently pass.
 */
const effectExtraFields: Partial<Record<Effect['op'], Record<string, Check>>> = {
  eachPlayerMayPutCountersAndGoad: { counter: text },
  gainControlTarget: { duration: optional(controlDuration) },
  gainControl: {
    duration: optional(controlDuration),
    untap: optional(flag),
    grantHaste: optional(flag),
  },
};

export function validateEffectExpressions(
  effect: Effect,
  path: string,
  issues: AuthoringIssue[],
): void {
  const fields: Record<string, Check> | undefined = effectExpressions[effect.op];
  const extra: Record<string, Check> | undefined = effectExtraFields[effect.op];
  if (fields === undefined && extra === undefined) return; // Unknown operations are rejected by the effect-reference registry.
  for (const [field, check] of [...Object.entries(fields ?? {}), ...Object.entries(extra ?? {})])
    check((effect as unknown as Record<string, unknown>)[field], path + '.' + field, issues);
}

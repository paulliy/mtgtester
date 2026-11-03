import type { Effect, EffectRef, TargetKind } from './ability';
import type { Selector } from './selector';
import { assertNever } from '../utils/assert-never';

export type TargetDomain =
  'permanent' | 'player' | 'spell' | 'stackAbility' | 'graveyard' | 'command';
export interface ReferenceContract {
  domains: readonly TargetDomain[];
  selection: 'ordinary' | 'counted';
  optional?: true;
  /** Specific zone-tracking referents implemented by this operation outside ref(). */
  nonTargetRefs?: readonly Exclude<EffectRef, number>[];
}
type ReferenceField =
  | 'target'
  | 'first'
  | 'second'
  | 'a'
  | 'ref'
  | 'source'
  | 'checkTarget'
  | 'targetSlot'
  | 'bSlot'
  | 'cardsSlot'
  | 'playerSlot'
  | 'controlledBy'
  | 'relativeToPlayer'
  | 'forPlayer';
type EffectContracts = {
  [Op in Effect['op']]: Record<
    Extract<keyof Extract<Effect, { op: Op }>, ReferenceField>,
    ReferenceContract
  >;
};
const permanent: ReferenceContract = {
  domains: ['permanent'],
  selection: 'ordinary',
};
const player: ReferenceContract = {
  domains: ['player'],
  selection: 'ordinary',
};
const graveyard: ReferenceContract = {
  domains: ['graveyard'],
  selection: 'ordinary',
};
const spell: ReferenceContract = { domains: ['spell'], selection: 'ordinary' };
const stack: ReferenceContract = {
  domains: ['spell', 'stackAbility'],
  selection: 'ordinary',
};
const command: ReferenceContract = {
  domains: ['command'],
  selection: 'ordinary',
};
const damage: ReferenceContract = {
  domains: ['permanent', 'player'],
  selection: 'ordinary',
};
const anyReference: ReferenceContract = {
  domains: ['permanent', 'player', 'spell', 'stackAbility', 'graveyard', 'command'],
  selection: 'ordinary',
};
const returnedPermanent: ReferenceContract = {
  domains: ['permanent', 'graveyard', 'command'],
  selection: 'ordinary',
};
const many = (contract: ReferenceContract): ReferenceContract => ({
  ...contract,
  selection: 'counted',
});
const optionalRef = (contract: ReferenceContract): ReferenceContract => ({
  ...contract,
  optional: true,
});
const spellOrPermanent: ReferenceContract = {
  domains: ['permanent', 'spell'],
  selection: 'ordinary',
};

/** Each operation and each explicit reference field must declare a contract. */
export const EFFECT_REFERENCE_CONTRACTS = {
  amass: {},
  payLifeOrTopDrawnCards: {},
  returnCardFromGraveyardToHand: {},
  pumpUntilEot: { target: permanent },
  grantKeywordUntilEot: { target: permanent },
  cantBeBlockedUntilEot: { target: permanent },
  creaturesCantBeBlockedThisTurn: {},
  chooseOne: {},
  fight: { first: permanent, second: permanent },
  pumpEachUntilEot: {},
  doublePowerAndToughnessEachUntilEot: {},
  grantKeywordEachUntilEot: {},
  denyKeywordsEachUntilEot: {},
  loseKeywordsEachUntilEot: {},
  grantKeywordToAttackGroupUntilEot: {},
  putCountersOnCreatureOfChoice: {},
  returnBlockedCreatureAtEndOfCombat: {},
  damageEachOtherOpponent: {},
  grantProtectionEachUntilEot: {},
  grantChosenColorProtectionUntilEot: { target: permanent },
  returnSpellToOwnerHand: { target: spell },
  exileSpellAndPlot: { target: spell },
  prohibitSpellsThisTurn: {},
  phaseOutAndProtectControllerUntilNextTurn: {},
  controllerProtectionFromEverythingUntilNextTurn: {},
  phaseOutEachChosen: { targetSlot: many(permanent) },
  controllerHexproofUntilEot: {},
  changeSingleTarget: { target: stack },
  chooseNewTargets: { target: stack },
  exileGraveyardEventCard: {},
  sacrificeTargetPlayerCreature: { target: player },
  eachPlayerKeepsCreatureWithVow: {},
  separatePermanentsIntoPilesThenSacrifice: { target: player },
  separateIntoPilesLimitAttackers: {},
  dealDamage: { target: damage, source: optionalRef(permanent) },
  dealDamageUnlessSacrifice: { target: player },
  destroy: { target: permanent },
  regenerate: { target: permanent },
  destroyAndCreateTokenForController: { target: permanent },
  exileAndGainLifeTargetController: { target: permanent },
  damageEachCreatureController: {},
  sacrificeAndDrawForPower: {},
  sacrificeGreatestEachOpponent: {},
  transferCountersFromTriggerObject: { target: permanent },
  transferCountersFromTriggerObjectToChosenCreatures: { targetSlot: many(permanent) },
  mayForgoTriggerObjectCombatDamageForRandomDiscard: {},
  gainClassLevel: {},
  drawForOpponentsWithSmallHands: {},
  sacrificeNonlandOrDiscardOrLoseLife: { target: player },
  transferCountersFromSource: { target: permanent },
  moveCounters: { from: permanent, to: permanent },
  moveAllCounters: { from: permanent, to: permanent },
  bolster: {},
  distributeCountersFromSource: {},
  mayPayLifeForTriggerPowerAndCounter: {},
  vindictiveLichModes: {},
  returnExiledAttachedCard: {},
  sacrificeOneCreatureEachPlayer: {},
  sacrificeOtherForMana: {},
  livingDeath: {},
  exileGraveyardCreateTokens: { target: player },
  millAndCreateTokensForCreatures: {},
  returnArtifactCreaturesUpToManaValue: {},
  halfLifeDrainTargetOpponent: {},
  loseHalfLifeTarget: { target: player },
  tombBladeHit: { target: player },
  emptyLibraryCreatureOrLose: {},
  exileResolvingSpell: {},
  millTargetPlayer: { target: player },
  millAndChooseArtifact: {},
  millThenReturnMilledCard: {},
  dealDamageNonbasicLands: { target: player },
  sacrificeOneEachOpponent: {},
  sacrificeEachPlayer: {},
  eventPlayerSacrificesPermanents: {},
  attackingOpponentUntapsNonland: {},
  reanimateEnchantedCardAndAttach: {},
  sacrificeRememberedPermanent: {},
  putCounterByPermanentType: { target: permanent },
  drawRevealTopLoseManaValue: {},
  mutualRevealTopLoseManaValue: { target: player },
  discover: {},
  revealUntilAura: {},
  exileEachUntilNonlandCast: {},
  revealCreatureOrBottom: {},
  explore: { target: permanent },
  exileLibraryTop: {},
  partitionLibrary: {},
  recruit: {},
  trickery: { target: spell },
  exileAndCastNextUpkeep: { target: graveyard },
  castRememberedExile: {},
  capstoneParadigm: {},
  castParadigmCopy: {},

  goadEachOpponent: {},
  createTreasureForDeaths: {},
  preventCombatDamageAll: {},
  createDamageShield: { target: optionalRef(permanent) },
  copyTargetSpell: { target: spell },
  replicateCopies: {},
  copyCastSpell: {},
  copyActivatedAbility: {},
  copyStackAbility: {},
  copyTargetAbility: { target: stack },
  createTokenCopyOfEventGroupMember: {},
  mayReturnEventGroupMemberToHand: {},
  nextCastThisTurn: {},
  copyEachTargetedSpell: { targetSlot: many(spell) },
  angelGrace: {},
  drawForEachOpponent: {},
  drawTargetAndController: { target: player },
  inkshield: {},
  gisela: {},
  humbleDefector: { target: player },
  shadrixModes: {},
  masterOfCeremonies: {},
  drawTargetAndControllerN: { target: player },
  schemingSymmetry: { targetSlot: many(player) },
  kambal: {},
  destroyAndCreateTokensEqualToManaValue: { target: permanent },
  exile: { target: permanent },
  exileCard: { target: graveyard },
  counter: { target: stack },
  counterAndCreateTokenForController: { target: stack },
  sacrifice: { target: permanent },
  sacrificeOneThen: {},
  sacrificeSourceThenReflexive: {},
  mayPayManaThenReflexive: {},
  mayPayEnergyThenReflexive: {},
  putCountersOnSourceThenReflexive: {},
  gainControlTarget: { target: permanent },
  swapCreatureControlUntilEot: { target: player },
  putCounters: { target: permanent },
  putCountersEach: {},
  putCountersOnCreaturesTargetPlayerControls: { target: player },
  doubleCountersTarget: { target: permanent },
  doublePlayerCountersTarget: { target: player },
  doubleCountersEach: {},
  giveTargetPoisonCounters: { target: player },
  removeCounters: { target: permanent },
  removeCountersEach: {},
  crewVehicle: {},
  becomeArtifactCreature: {},
  exileEach: {},
  exileEachOpponentGraveyard: {},
  exileAllGraveyards: {},
  resolvingSpellToLibraryBottom: {},
  resolvingSpellExile: {},
  shuffleSourceFromGraveyardIntoLibrary: {},
  resolvingSpellShuffleIntoLibrary: {},
  exileTargetPlayerGraveyard: { target: player },
  returnToHandEach: {},
  graveyardToBattlefieldEach: {},
  returnOneFromYourGraveyardToBattlefield: {},
  graveyardToHandEach: {},
  unearth: {},
  grantUnearthToArtifactCreaturesInGraveyard: {},
  exileSource: {},
  draw: {},
  additionalLandPlaysThisTurn: {},
  discard: {},
  putFromHandOnLibraryTop: {},
  discardAtRandom: {},
  discardTarget: { target: player },
  discardOrLoseLife: { target: player },
  millEachPlayer: {},
  sacrificeThenOpponentsShareTypeOrPunish: {},
  searchLibraryAndOrGraveyardToBattlefield: {},
  eachPlayerDraws: {},
  eachPlayerLosesLifeAndDraws: {},
  discardChosenPlayers: { targetSlot: many(player) },
  millAndLoseLifeChosenPlayers: { targetSlot: many(player) },
  revealHandAndDiscard: { target: player },
  discardEachPlayer: {},
  mill: {},
  gainEnergy: {},
  createEmblem: { forPlayer: optionalRef(player) },
  gainLife: {},
  loseLife: {},
  loseLifeTarget: { target: player },
  drawTarget: { target: player },
  cascade: {},
  reboundCastFromExile: {},
  eachOpponentLosesLife: {},
  gainLifeEqualToLifeLostThisWay: {},
  eachOpponentDamage: {},
  damageController: {},
  damageEach: { source: optionalRef(permanent), controlledBy: optionalRef(player) },
  damageEachPlayer: { source: optionalRef(permanent) },
  searchLibrary: {},
  searchLibraryGroup: {},
  huntingWilds: {},
  searchLibraryCastFree: {},
  shuffle: {},
  scry: {},
  surveil: {},
  proliferate: {},
  counterUnlessPays: {},
  attachSelfTo: { target: permanent },
  createToken: {},
  createTokenAttacking: {},
  createAttachedToken: { target: permanent },
  createTokenForEachOpponent: {},
  createTokenForPlayer: { target: player },
  createTokenForEachPlayerExceptTarget: { target: player },
  eachOpponentCreatesTokens: {},
  shareTokensWithChosenOpponent: {},
  shareCreatureLifeWithChosenOpponent: {},
  createTokenCopyOf: { ref: permanent },
  becomeCopyOf: { ref: permanent },
  becomeCopyOfTarget: { target: permanent, ref: permanent },
  untapEach: {},
  untapBoundIf: {},
  gainControl: {},
  graveyardToBattlefield: { target: { ...graveyard, nonTargetRefs: ['triggerObject'] } },
  reanimateAndLoseLife: { target: graveyard },
  graveyardToHand: { target: graveyard },
  graveyardToLibraryTop: { target: graveyard },
  graveyardToLibraryBottom: { target: graveyard },
  returnToHand: { target: spellOrPermanent },
  returnOneToHand: {},
  handToBattlefield: {},
  lookAtTopN: {},
  destroyEach: {},
  dealDamageEachChosen: { targetSlot: many(damage) },
  returnToHandEachChosen: { targetSlot: many(permanent) },
  transformSelf: {},
  becomePrepared: {},
  mayDiscardThenDraw: {},
  eachPlayerGainsLife: {},
  eachPlayerLosesLife: {},
  eachPlayerLooksAtTopRevealsToHand: {},
  sourceGainsAbility: {},
  selfToLibraryTop: {},
  putCountersEachChosen: { targetSlot: many(permanent) },
  grantKeywordEachChosenUntilEot: { targetSlot: many(permanent) },
  cantBlockEachChosenThisTurn: { targetSlot: many(permanent) },
  doubleCountersEachChosen: { targetSlot: many(permanent) },
  cantBeBlockedEachChosen: { targetSlot: many(permanent) },
  untapUpTo: {},
  exileEachChosen: { targetSlot: many(permanent) },
  destroyEachChosen: { targetSlot: many(permanent) },
  tapAndGoadEachChosen: { targetSlot: many(permanent) },
  blinkEachChosen: { targetSlot: many(permanent) },
  regainControlOfOwnCreatures: {},
  exileTargetGraveyardAndBuffIfCreature: { targetSlot: graveyard },
  pumpTargetPlayerCreaturesUntilEot: { targetSlot: player },
  untapTargetPlayerCreatures: { targetSlot: player },
  exileUntilSourceLeaves: { targetSlot: permanent },
  exileEachChosenUntilSourceLeaves: {
    targetSlot: { domains: ['permanent'], selection: 'counted' },
  },
  removeTargetAndControllerMaySearchBasicLand: { target: permanent },
  destroyTargetAndControllerMaySearchBasicTypedLand: { target: permanent },
  exileCreatureAndControllerSearchBasicLand: { target: permanent },
  exileEachCreatureAndControllersSearchBasicLands: {},
  populate: {},
  untapAttackingPlayerNonlandPermanents: {},
  dealDamageDivided: { targetSlot: many(damage) },
  conditionalEffect: { checkTarget: optionalRef(anyReference) },
  byResolutionCountThisTurn: {},
  counterUnlessControllerPays: { target: spell },
  unlessPays: {},
  addMana: {},
  registerDelayedTrigger: {
    target: { ...optionalRef(anyReference), nonTargetRefs: ['triggerObject'] },
  },
  commandZoneToBattlefield: { target: command },
  commandZoneToHand: {},
  returnToCommandZone: { target: permanent },
  grantAbilityUntilEot: { target: permanent },
  grantHasteToResolvingSpell: {},
  grantHasteOnResolution: { target: returnedPermanent },
  overloadBounceAllNonlandOpponents: {},
  goad: { target: permanent },
  chooseAttackersAndBlockers: {},
  addAttackRequirement: { target: optionalRef(permanent), relativeToPlayer: optionalRef(player) },
  targetPlayerMaySearchNamed: { target: player },
  cantBlockEach: {},
  limitAttacksToNearestOpponent: {},
  attackLifeTaxUntilYourNextTurn: {},
  chooseOpponentForSource: {},
  removeAttackersFromCombat: {},
  eventPlayerMayDraw: {},
  forceAttack: { target: permanent },
  forceAttackEach: {},
  doublePower: {},
  doublePowerTarget: { target: permanent },
  drawUpTo: {},
  drawUpToN: {},
  mayPayManaAndSacrificeSource: {},
  searchBasicsNamedLikeChosenLand: {},
  mayPayEnergyUpTo: {},
  mayPayEnergy: {},
  doublePlayerCounters: {},
  shuffleHandGraveyardIntoLibrary: {},
  chaosWarp: { target: permanent },
  manifestTop: {},
  manifestTopForTargetController: { target: permanent },
  opponentMayDrawOrMillThenDamage: { target: player },
  lookAtTopNCastOneFree: {},
  castAnyFromHandFree: {},
  castForLifeFromZones: {},
  castOneFromHandFreeUpTo: {},
  setMustBlockThisTurn: { target: permanent },
  extraCombatPhase: {},
  becomeMonarch: {},
  druidPurification: {},
  attackingCreaturesToOwnerLibraries: {},
  rotateSourceAtUpkeep: {},
  choosePermanentTypesThenSacrificeOthers: {},
  eachPlayerMayPutCountersAndGoad: {},
  voteAndExileMost: {},
  exileTargetWithSource: { target: permanent },
  exileFromHandWithSource: {},
  exileGraveyardCardWithSource: { target: graveyard },
  flipCoin: {},
  returnRandomExiledWithSourceToHand: {},
  exileAndManifestTarget: { target: permanent },
  blinkTarget: { target: permanent },
  blinkOneCreatureYouControl: {},
  untapTarget: { target: permanent },
  tapTarget: { target: permanent },
  tapEach: {},
  bounceUpTo6MV: {},
  millAndReturnSpells: {},
  hideawayExileTop4: {},
  hideaway: {},
  playExiledCardFree: {},
  fightUpToOneChosen: { a: permanent, bSlot: many(permanent) },
  becomeCreatureUntilEot: { target: permanent },
  discardHand: {},
  eachPlayerDiscardHandThenDraw: {},
  shuffleChosenGraveyardCardsIntoLibrary: {
    playerSlot: player,
    cardsSlot: many(graveyard),
  },
  mayPayXThenDealDamage: { target: damage },
  destroyEachNonlandMVFromDamagedControllers: {},
  returnSelfFromGraveyardToHand: {},
  returnDiedSourceToBattlefield: {},
  putAnyFromHandOnBottomThenDraw: {},
  putDepartedSourceIntoLibrary: {},
  returnDepartedSourceToHand: {},
  exileTargetReturnAtNextEndStep: { target: permanent },
  returnExiledTriggerObject: {},
  reanimateTargetHasteExileAtYourNextEndStep: { target: graveyard },
  returnDiedTriggerObjectTapped: {},
  returnDiedTriggerObjectAtNextEndStep: {},
  returnRememberedGraveyardCard: {},
  returnDepartedSourceToBattlefield: {},
  attach: {},
  reflexiveOnCreatedToken: {},
  returnChosenCardsAttachedTo: { targetSlot: many(graveyard) },
  reanimateEachChosenTapped: { targetSlot: many(graveyard) },
  reanimateEachChosen: { targetSlot: many(graveyard) },
  connive: {},
  exileTopNPlayableUntilEot: {},
  noOp: {},
} satisfies EffectContracts;

const REFERENCE_FIELDS: ReadonlySet<string> = new Set<ReferenceField>([
  'target',
  'first',
  'second',
  'a',
  'ref',
  'source',
  'checkTarget',
  'targetSlot',
  'bSlot',
  'cardsSlot',
  'playerSlot',
  'controlledBy',
  'relativeToPlayer',
  'forPlayer',
]);

/**
 * `effect` with each of its target-slot references moved up by `offset`, for the right half of a
 * fused split spell whose slots follow the left half's (CR 702.102d). Undefined, so the caller
 * fails closed, when a slot reference is nested anywhere below the operation's own fields (a
 * nested effect or a target-reading value), where this flat renumbering would miss it.
 */
export function offsetEffectSlots(effect: Effect, offset: number): Effect | undefined {
  const nestedReference = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(nestedReference);
    if (value === null || typeof value !== 'object') return false;
    return Object.entries(value).some(
      ([key, entry]) =>
        key === 'op' ||
        (REFERENCE_FIELDS.has(key) && typeof entry === 'number') ||
        nestedReference(entry),
    );
  };
  const contract = EFFECT_REFERENCE_CONTRACTS[effect.op] as Record<string, ReferenceContract>;
  const out: Record<string, unknown> = { ...effect };
  for (const [key, value] of Object.entries(effect)) {
    if (key === 'op') continue;
    if (key in contract) {
      if (typeof value === 'number') out[key] = value + offset;
      continue;
    }
    if (nestedReference(value)) return undefined;
  }
  return out as unknown as Effect;
}

/** Safe mixed-domain filter: players cannot be commanders (CR 903.3). */
export function playerFilterAlwaysTrue(selector: Selector): boolean {
  if (selector.kind === 'not') return selector.of.kind === 'isCommander';
  if (selector.kind === 'allOf') return selector.of.every(playerFilterAlwaysTrue);
  if (selector.kind === 'anyOf') return selector.of.some(playerFilterAlwaysTrue);
  return false;
}

/** Domain possibilities in the existing target representation; filters cannot change zones. */
export function targetDomains(kind: TargetKind): readonly TargetDomain[] {
  switch (kind) {
    case 'player':
      return ['player'];
    case 'spell':
    case 'noncreatureSpell':
      return ['spell'];
    case 'stackObject':
      return ['spell', 'stackAbility'];
    case 'spellOrNonlandPermanent':
      return ['spell', 'permanent'];
    case 'cardInGraveyard':
      return ['graveyard'];
    case 'commanderInCommandZone':
      return ['command'];
    case 'anyTarget':
    case 'playerOrPlaneswalker':
      return ['player', 'permanent'];
    case 'creature':
    case 'artifact':
    case 'enchantment':
    case 'land':
    case 'planeswalker':
    case 'artifactOrEnchantment':
    case 'artifactEnchantmentOrPlaneswalker':
    case 'nonlandPermanent':
    case 'permanent':
      return ['permanent'];
    default:
      return assertNever(kind, 'target contract domain');
  }
}

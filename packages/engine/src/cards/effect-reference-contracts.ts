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
  | 'playerSlot';
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
  pumpUntilEot: { target: permanent },
  grantKeywordUntilEot: { target: permanent },
  cantBeBlockedUntilEot: { target: permanent },
  creaturesCantBeBlockedThisTurn: {},
  chooseOne: {},
  fight: { first: permanent, second: permanent },
  pumpEachUntilEot: {},
  doublePowerAndToughnessEachUntilEot: {},
  grantKeywordEachUntilEot: {},
  grantProtectionEachUntilEot: {},
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
  transferCountersFromSource: { target: permanent },
  moveCounters: { from: permanent, to: permanent },
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
  dealDamageNonbasicLands: { target: player },
  sacrificeOneEachOpponent: {},
  sacrificeEachPlayer: {},
  putCounterByPermanentType: { target: permanent },
  drawRevealTopLoseManaValue: {},
  goadEachOpponent: {},
  createTreasureForDeaths: {},
  preventCombatDamageAll: {},
  preventCombatDamageToController: {},
  copyTargetSpell: { target: spell },
  replicateCopies: {},
  copyEachTargetedSpell: { targetSlot: many(spell) },
  angelGrace: {},
  arcbond: { target: permanent },
  arcbondDamage: {},
  tapAndDamageController: { target: permanent },
  drawForEachOpponent: {},
  drawTargetAndController: { target: player },
  combatCalligrapher: {},
  inkshield: {},
  delirium: {},
  deflectingPalm: { target: permanent },
  gisela: {},
  humbleDefector: { target: player },
  shadrixModes: {},
  masterOfCeremonies: {},
  breenaAttack: { target: permanent },
  drawTargetAndControllerN: { target: player },
  schemingSymmetry: {},
  sacrificePermanentOnDamage: { target: permanent },
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
  putCountersOnSourceThenReflexive: {},
  gainControlTarget: { target: permanent },
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
  discard: {},
  putFromHandOnLibraryTop: {},
  discardAtRandom: {},
  mill: {},
  gainEnergy: {},
  createEmblem: {},
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
  damageEach: { source: optionalRef(permanent) },
  damageEachPlayer: {},
  searchLibrary: {},
  searchLibraryGroup: {},
  huntingWilds: {},
  etaliPrimalConqueror: {},
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
  selfToLibraryTop: {},
  putCountersEachChosen: { targetSlot: many(permanent) },
  grantKeywordEachChosenUntilEot: { targetSlot: many(permanent) },
  doubleCountersEachChosen: { targetSlot: many(permanent) },
  cantBeBlockedEachChosen: { targetSlot: many(permanent) },
  untapUpTo: {},
  exileEachChosen: { targetSlot: many(permanent) },
  destroyEachChosen: { targetSlot: many(permanent) },
  blinkEachChosen: { targetSlot: many(permanent) },
  regainControlOfOwnCreatures: {},
  exileTargetGraveyardAndBuffIfCreature: { targetSlot: graveyard },
  pumpTargetPlayerCreaturesUntilEot: { targetSlot: player },
  untapTargetPlayerCreatures: { targetSlot: player },
  exileUntilSourceLeaves: { targetSlot: permanent },
  exileTargetAndControllerMaySearchBasicLandTapped: { targetSlot: permanent },
  removeTargetAndControllerMaySearchBasicLand: { target: permanent },
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
  exileTargetWithSource: { target: permanent },
  exileAndManifestTarget: { target: permanent },
  blinkTarget: { target: permanent },
  blinkOneCreatureYouControl: {},
  untapTarget: { target: permanent },
  tapTarget: { target: permanent },
  tapEach: {},
  bounceUpTo6MV: {},
  millAndReturnSpells: {},
  hideawayExileTop4: {},
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
  putDepartedSourceIntoLibrary: {},
  exileTargetReturnAtNextEndStep: { target: permanent },
  returnExiledTriggerObject: {},
  reanimateTargetHasteExileAtYourNextEndStep: { target: graveyard },
  returnDiedTriggerObjectTapped: {},
  reanimateEachChosenTapped: { targetSlot: many(graveyard) },
  connive: {},
  exileTopNPlayableUntilEot: {},
  noOp: {},
} satisfies EffectContracts;

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

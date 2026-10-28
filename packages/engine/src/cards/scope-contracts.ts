/**
 * Scope contracts (ADR 0034 decision 2). Some `Value` kinds read a fact the resolving ability's
 * scope carries rather than the board: the damage that fired a trigger, the spell that was cast,
 * the mana spent on this spell. The scope is filled by the ability's trigger head, cast path or
 * cost, and nothing else checked the pairing, so an enters trigger drawing `damageDealt` cards
 * validated and drew zero. Each `Value` kind declares the field it needs and each provider the
 * fields it fills; `validateCardDefinition` rejects a kind used where its field is not provided.
 */
import type { TriggerWhen } from './ability';
import type { Value } from './value';

export type ScopeField =
  | 'damageDealt'
  | 'triggerCount'
  | 'spellManaValue'
  | 'spellColorCount'
  | 'manaSpent'
  | 'treasureManaSpent'
  | 'energyPaid'
  | 'stationPower';

/** The scope field each `Value` kind reads, or null for a kind that reads only the board. */
export const VALUE_SCOPE_NEEDS: Record<Value['kind'], ScopeField | null> = {
  const: null,
  cardTypesInAllGraveyards: null,
  cardTypesInYourGraveyard: null,
  cardTypesInOpponentsGraveyards: null,
  plus: null,
  negate: null,
  times: null,
  countPermanents: null,
  countTappedPermanents: null,
  countPermanentsControlledByTarget: null,
  aurasYouControlAttachedToCreatures: null,
  aurasAttachedToSource: null,
  countCardsInZone: null,
  colorsAmongPermanents: null,
  colorsAmongPermanentsAndSpellsCastThisTurn: null,
  devotionTo: null,
  countOpponents: null,
  greatestToughnessAmong: null,
  greatestPowerAmong: null,
  greatestManaValueAmong: null,
  greatestNoncreatureManaValueYouControlOrInGraveyard: null,
  totalPowerOfAttackers: null,
  totalPowerAmong: null,
  xValue: null,
  optionalCostCount: null,
  damageDealt: 'damageDealt',
  triggerCount: 'triggerCount',
  aurasYouControlledAttachedToTriggerObject: null,
  spellManaValue: 'spellManaValue',
  spellColorCount: 'spellColorCount',
  manaValueOfOtherSpellsCastThisTurn: null,
  manaSpent: 'manaSpent',
  treasureManaSpent: 'treasureManaSpent',
  energyPaid: 'energyPaid',
  energyAvailable: null,
  stationPower: 'stationPower',
  countersOnSelf: null,
  allCountersOnSelf: null,
  countersOnTarget: null,
  manaValueOfTarget: null,
  commanderCastCount: null,
  commanderIdentityColorCount: null,
  lifeTotal: null,
  countOpponentsWithFewerCreatures: null,
  creaturesDiedThisTurn: null,
  powerOfSource: null,
  timesAttackedThisTurn: null,
  toughnessOfSource: null,
  powerOfTarget: null,
  opponentsLostLifeThisTurn: null,
  powerOfTriggerObject: null,
  cardsInTargetHand: null,
  tappedCreaturesControlledByTarget: null,
  attackingCreatures: null,
  spellsCastThisTurn: null,
  countersOnTriggerObject: null,
};

/**
 * The scope fields a trigger head fills when its ability resolves (`state/objects.ts`). An
 * aggregate head (any `aggregate` flag) also fills `triggerCount`.
 */
export const TRIGGER_SCOPE_FIELDS: Record<TriggerWhen, readonly ScopeField[]> = {
  discardsCard: [],
  attacks: [],
  enchantedPlayerAttacked: [],
  attacksUnblocked: [],
  dealsCombatDamageToPlayer: ['damageDealt'],
  becomesTargeted: [],
  dealsDamageToOpponent: ['damageDealt'],
  castsSpell: ['spellManaValue', 'spellColorCount', 'manaSpent'],
  gainsLife: ['damageDealt'],
  losesLife: ['damageDealt'],
  drawsCard: [],
  foretells: [],
  activatesAbility: [],
  damagePreventedToPlayer: ['damageDealt'],
  playerDealtDamage: ['damageDealt'],
  attackDeclared: ['triggerCount'],
  upkeep: [],
  endStep: [],
  untapStep: [],
  drawStep: [],
  beginningOfCombat: [],
  endOfCombat: [],
  mainPhase: [],
  precombatMain: [],
  secondMainPhase: [],
  enters: [],
  dies: [],
  blocks: [],
  becomesBlocked: [],
  becomesTapped: [],
  becomesCrewed: [],
  fights: [],
  dealtDamage: ['damageDealt'],
  sacrificed: [],
  tokenCreated: [],
  putIntoGraveyardFromAnywhere: [],
  leavesGraveyard: [],
  leavesBattlefield: [],
  transformsInto: [],
  countersPut: [],
};

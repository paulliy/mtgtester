import type { EnginePermanent, GameContext } from '../state/types';
import type { ValueScope } from './value';
import type { SelectorCandidate } from './selector';
import { candidateOf, computeCharacteristics } from '../effects/continuous';

/** Announcement metadata survives removal of the resolving spell from the stack. */
export interface SourceCastState {
  wasKicked: boolean;
  announcedX: number;
  escaped: boolean;
  /** Addendum: the resolving spell was cast during its caster's main phase. */
  castDuringOwnMainPhase?: boolean;
}

/** Private rules facts for one incarnation; never exposed by player/spectator projections. */
export interface ObjectFacts extends SourceCastState {
  objectId: string;
  /** Its name and definition as it last existed: a token that left has no card to ask. */
  name?: string;
  oracleId?: string;
  candidate: SelectorCandidate;
  power: number;
  toughness: number;
  manaValue: number;
  counters: Record<string, number>;
  tapped: boolean;
  loseAbilities?: boolean;
  hadToAttackThisCombat: boolean;
  enteredTurnNumber: number;
  chosenOption?: string;
  classLevel?: number;
  /** The permanent's cast record (`CastRecord`), when the spell that became it was cast. */
  castByPlayerId?: string;
  castFromZone?: string;
  manaSpentToCast?: number;
  /**
   * The controller of each Aura attached to it as it last existed (CR 603.10a), one entry per
   * Aura: "each Aura you controlled that was attached to it" (Hateful Eidolon).
   */
  attachedAuraControllerIds?: string[];
}

export function captureObjectFacts(ctx: GameContext, permanent: EnginePermanent): ObjectFacts {
  const chars = computeCharacteristics(ctx, permanent);
  const candidate = candidateOf(ctx, permanent, chars);
  const counters = { ...permanent.counters };
  const attachedAuraControllerIds = ctx.state.battlefield
    .filter(
      (other) =>
        other.attachedTo === permanent.id &&
        computeCharacteristics(ctx, other).subtypes.includes('Aura'),
    )
    .map((aura) => aura.controllerId);
  return {
    objectId: permanent.id,
    name: permanent.name,
    oracleId: permanent.oracleId,
    candidate: {
      ...candidate,
      types: [...candidate.types],
      supertypes: [...candidate.supertypes],
      subtypes: [...candidate.subtypes],
      colors: [...candidate.colors],
      keywords: [...candidate.keywords],
      counters,
    },
    power: chars.power,
    toughness: chars.toughness,
    manaValue: candidate.manaValue ?? 0,
    counters,
    tapped: permanent.tapped,
    loseAbilities: chars.loseAbilities,
    hadToAttackThisCombat: permanent.hadToAttackThisCombat === true,
    enteredTurnNumber: permanent.enteredTurnNumber,
    ...(permanent.chosenOption === undefined ? {} : { chosenOption: permanent.chosenOption }),
    ...(permanent.classLevel === undefined ? {} : { classLevel: permanent.classLevel }),
    ...(permanent.castByPlayerId === undefined
      ? {}
      : {
          castByPlayerId: permanent.castByPlayerId,
          ...(permanent.castFromZone === undefined ? {} : { castFromZone: permanent.castFromZone }),
          manaSpentToCast: permanent.manaSpentToCast ?? 0,
        }),
    wasKicked: permanent.wasKicked === true || permanent.kicked === true,
    announcedX: permanent.announcedX ?? 0,
    escaped: permanent.escaped === true,
    ...(attachedAuraControllerIds.length === 0 ? {} : { attachedAuraControllerIds }),
  };
}

export function eventObjectScope(ctx: GameContext, permanent: EnginePermanent) {
  return {
    eventObjectId: permanent.id,
    ...(permanent.firstDestinationObjectId === undefined
      ? {}
      : { eventObjectDestinationId: permanent.firstDestinationObjectId }),
    triggerObjectFacts: permanent.lastKnownFacts ?? captureObjectFacts(ctx, permanent),
  };
}

/**
 * Information reads retain departure facts (CR 608.2h), even when hidden-zone movement
 * ends object tracking. Only moves caused by this resolution may rebind an incarnation.
 */
function informationStateOf(
  ctx: GameContext,
  id: string,
  fallback?: ObjectFacts,
): EnginePermanent | ObjectFacts | undefined {
  let current: string | null = id;
  let facts = fallback?.objectId === id ? fallback : undefined;
  while (current !== null) {
    facts = ctx.resolutionObjectFacts?.get(current) ?? facts;
    if (!ctx.resolutionObjectMoves?.has(current)) break;
    current = ctx.resolutionObjectMoves.get(current) ?? null;
  }
  const permanent = ctx.state.battlefield.find((permanent) => permanent.id === current);
  return permanent ?? facts;
}

function factsOf(ctx: GameContext, state: EnginePermanent | ObjectFacts | undefined) {
  return state === undefined
    ? undefined
    : 'candidate' in state
      ? state
      : captureObjectFacts(ctx, state);
}

/** Prefer the exact original's current facts; once gone, use that original's LKI. */
export function eventObjectFacts(ctx: GameContext, scope: ValueScope): ObjectFacts | undefined {
  return factsOf(ctx, eventObjectState(ctx, scope));
}

/** Raw identity/state reads must not re-enter layers when used by static conditions. */
export function eventObjectState(ctx: GameContext, scope: ValueScope) {
  const id = scope.triggerObjectId ?? scope.eventObjectId;
  if (id !== undefined) return informationStateOf(ctx, id, scope.triggerObjectFacts);
  if (scope.triggerObjectCardId === undefined)
    throw new Error('event object information has no bound event object');
  const permanent = ctx.state.battlefield.find(
    (permanent) => permanent.cardId === scope.triggerObjectCardId,
  );
  return permanent;
}

/** An ability retains its source incarnation even when the physical card returns. */
export function sourceObjectFacts(ctx: GameContext, scope: ValueScope): ObjectFacts | undefined {
  return factsOf(ctx, sourceObjectState(ctx, scope));
}

export function sourceObjectState(ctx: GameContext, scope: ValueScope) {
  const id = scope.sourceObjectId;
  if (id !== undefined) return informationStateOf(ctx, id, scope.sourceFacts);
  const permanent = ctx.state.battlefield.find(
    (permanent) => permanent.cardId === scope.sourceCardId,
  );
  return permanent;
}

/** A slot keeps its announced identity and its initial resolution legality mask. */
export function targetObjectFacts(
  ctx: GameContext,
  scope: ValueScope,
  slot: number,
): ObjectFacts | undefined {
  const id = scope.targets?.[slot];
  return id ? factsOf(ctx, informationStateOf(ctx, id)) : undefined;
}

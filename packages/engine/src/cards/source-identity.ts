import type { EnginePermanent, GameContext } from '../state/types';
import type { ValueScope } from './value';
import type { SelectorCandidate } from './selector';
import { candidateOf, computeCharacteristics } from '../effects/continuous';

/** Private rules facts for one incarnation; never exposed by player/spectator projections. */
export interface ObjectFacts {
  objectId: string;
  candidate: SelectorCandidate;
  power: number;
  toughness: number;
  manaValue: number;
  counters: Record<string, number>;
  tapped: boolean;
  hadToAttackThisCombat: boolean;
}

export function captureObjectFacts(ctx: GameContext, permanent: EnginePermanent): ObjectFacts {
  const chars = computeCharacteristics(ctx, permanent);
  const candidate = candidateOf(ctx, permanent, chars);
  const counters = { ...permanent.counters };
  return {
    objectId: permanent.id,
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
    hadToAttackThisCombat: permanent.hadToAttackThisCombat === true,
  };
}

export function eventObjectScope(ctx: GameContext, permanent: EnginePermanent) {
  return {
    eventObjectId: permanent.id,
    triggerObjectFacts: permanent.lastKnownFacts ?? captureObjectFacts(ctx, permanent),
  };
}

/**
 * Information reads retain departure facts (CR 608.2h), even when hidden-zone movement
 * ends object tracking. Only moves caused by this resolution may rebind an incarnation.
 */
function informationOf(
  ctx: GameContext,
  id: string,
  fallback?: ObjectFacts,
): ObjectFacts | undefined {
  let current: string | null = id;
  let facts = fallback?.objectId === id ? fallback : undefined;
  while (current !== null) {
    facts = ctx.resolutionObjectFacts?.get(current) ?? facts;
    if (!ctx.resolutionObjectMoves?.has(current)) break;
    current = ctx.resolutionObjectMoves.get(current) ?? null;
  }
  const permanent = ctx.state.battlefield.find((permanent) => permanent.id === current);
  return permanent === undefined ? facts : captureObjectFacts(ctx, permanent);
}

/** Prefer the exact original's current facts; once gone, use that original's LKI. */
export function eventObjectFacts(ctx: GameContext, scope: ValueScope): ObjectFacts | undefined {
  const id = scope.triggerObjectId ?? scope.eventObjectId;
  if (id !== undefined) return informationOf(ctx, id, scope.triggerObjectFacts);
  const permanent = ctx.state.battlefield.find(
    (permanent) => permanent.cardId === scope.triggerObjectCardId,
  );
  return permanent === undefined ? undefined : captureObjectFacts(ctx, permanent);
}

/** An ability retains its source incarnation even when the physical card returns. */
export function sourceObjectFacts(ctx: GameContext, scope: ValueScope): ObjectFacts | undefined {
  const id = scope.sourceObjectId;
  if (id !== undefined) return informationOf(ctx, id, scope.sourceFacts);
  const permanent = ctx.state.battlefield.find(
    (permanent) => permanent.cardId === scope.sourceCardId,
  );
  return permanent === undefined ? undefined : captureObjectFacts(ctx, permanent);
}

/** A slot keeps its announced identity and its initial resolution legality mask. */
export function targetObjectFacts(
  ctx: GameContext,
  scope: ValueScope,
  slot: number,
): ObjectFacts | undefined {
  const id = scope.targets?.[slot];
  return id ? informationOf(ctx, id) : undefined;
}

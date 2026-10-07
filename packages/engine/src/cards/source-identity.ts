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

/** Prefer the exact original's current facts; once gone, use that original's LKI. */
export function eventObjectFacts(ctx: GameContext, scope: ValueScope): ObjectFacts | undefined {
  const id = scope.triggerObjectId ?? scope.eventObjectId;
  const permanent =
    id === undefined
      ? ctx.state.battlefield.find((permanent) => permanent.cardId === scope.triggerObjectCardId)
      : ctx.state.battlefield.find((permanent) => permanent.id === id);
  if (permanent) return captureObjectFacts(ctx, permanent);
  const facts = scope.triggerObjectFacts;
  return facts !== undefined && facts.objectId === id ? facts : undefined;
}

/** An ability retains its source incarnation even when the physical card returns. */
export function sourceObjectFacts(ctx: GameContext, scope: ValueScope): ObjectFacts | undefined {
  const id = scope.sourceObjectId;
  const permanent = ctx.state.battlefield.find((permanent) =>
    id === undefined ? permanent.cardId === scope.sourceCardId : permanent.id === id,
  );
  if (permanent) return captureObjectFacts(ctx, permanent);
  const facts = scope.sourceFacts;
  return facts !== undefined && facts.objectId === id ? facts : undefined;
}

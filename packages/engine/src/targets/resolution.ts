import type { ObjectId } from '@mtg/shared';
import type { TargetSpec } from '../cards/ability';
import type { GameContext } from '../state/types';
import type { TargetContext } from './context';
import { targetIsLegal, targetManaValue } from './legality';

/** Ephemeral resolution context, never serialized into a player view. */
export interface ResolutionTargets {
  anyChosen: boolean;
  anyLegal: boolean;
  slotLegality: ReadonlyMap<number, ReadonlyMap<ObjectId, boolean>>;
  legality: ReadonlyMap<TargetSpec, ReadonlyMap<ObjectId, boolean>>;
}

/** CR 608.2b: capture all selected targets before any instruction changes game state. */
export function captureResolutionTargets(
  ctx: GameContext,
  specs: readonly TargetSpec[],
  ordinary: readonly ObjectId[],
  counted: Readonly<Record<number, readonly ObjectId[]>>,
  context: TargetContext,
): ResolutionTargets {
  const legality = new Map<TargetSpec, Map<ObjectId, boolean>>();
  const anyChosen =
    ordinary.some((id) => id !== undefined) || Object.values(counted).some((ids) => ids.length > 0);
  const slotLegality = new Map<number, Map<ObjectId, boolean>>();
  for (const [slot, spec] of specs.entries()) {
    const chosen =
      spec.count === undefined
        ? ordinary[slot] === undefined
          ? []
          : [ordinary[slot]!]
        : (counted[slot] ?? []);
    const results = new Map<ObjectId, boolean>();
    for (const id of chosen) {
      const legal = targetIsLegal(ctx, spec, id, {
        ...context,
        chosenTargets: ordinary,
        phase: 'resolution',
      });
      results.set(id, legal);
    }
    const budget = spec.totalManaValueAtMost;
    if (budget !== undefined) {
      const total = chosen.reduce(
        (sum, id) => sum + (results.get(id) === true ? targetManaValue(ctx, id) : 0),
        0,
      );
      if (total > budget) for (const id of chosen) results.set(id, false);
    }
    slotLegality.set(slot, results);
    // Compatibility for ordinary references; counted groups use their occurrence identity.
    const merged = legality.get(spec) ?? new Map<ObjectId, boolean>();
    for (const [id, legal] of results) merged.set(id, legal);
    legality.set(spec, merged);
  }
  const anyLegal = [...slotLegality.values()].some((results) =>
    [...results.values()].some(Boolean),
  );
  return { anyChosen, anyLegal, legality, slotLegality };
}

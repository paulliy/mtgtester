import type { ObjectId } from '@mtg/shared';
import type { TargetSpec } from '../cards/ability';
import type { GameContext } from '../state/types';
import type { TargetContext } from './context';
import { targetIsLegal } from './legality';

/** Ephemeral resolution context, never serialized into a player view. */
export interface ResolutionTargets {
  anyChosen: boolean;
  anyLegal: boolean;
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
  let anyLegal = false;
  for (const [slot, spec] of specs.entries()) {
    const chosen =
      spec.count === undefined
        ? ordinary[slot] === undefined
          ? []
          : [ordinary[slot]!]
        : (counted[slot] ?? []);
    // Builders may reuse one immutable spec in several ordinary occurrences.
    const results = legality.get(spec) ?? new Map<ObjectId, boolean>();
    for (const id of chosen) {
      const legal = targetIsLegal(ctx, spec, id, {
        ...context,
        chosenTargets: ordinary,
        phase: 'resolution',
      });
      results.set(id, legal);
      anyLegal ||= legal;
    }
    legality.set(spec, results);
  }
  return { anyChosen, anyLegal, legality };
}

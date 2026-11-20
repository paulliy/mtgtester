import type { ObjectId, PlayerId } from '@mtg/shared';
import type { Ability } from '../cards/ability';
import type { GameGen } from '../decisions';
import type { GameContext } from '../state/types';
import type { TargetContext, TargetingSource } from '../targets/context';
import { targetingSourceFields } from '../targets/context';
import { targetDomainCandidates, targetIsLegal, withinTotalManaValue } from '../targets/legality';

/** Retarget identities, preserving every original targeting occurrence and its cardinality. */
export function* chooseReplicateTargets(
  ctx: GameContext,
  controllerId: PlayerId,
  name: string,
  copyIndex: number,
  copyCount: number,
  ability: Ability,
  source: TargetingSource,
  sourceCardId: string,
  originalTargets: readonly ObjectId[],
  originalCounted: Readonly<Record<number, readonly ObjectId[]>>,
  originalDivision: Readonly<Record<ObjectId, number>>,
  originalNames: Readonly<Record<string, string>> = {},
): GameGen<{
  targets: ObjectId[];
  countTargets: Record<number, ObjectId[]>;
  divisionAmounts: Record<ObjectId, number>;
}> {
  return yield* chooseNewTargets(ctx, controllerId, {
    name,
    subject: `copy ${copyIndex + 1} of ${copyCount}`,
    ability,
    source,
    sourceCardId,
    originalTargets,
    originalCounted,
    originalDivision,
    originalNames,
  });
}

/**
 * "You may choose new targets" (CR 115.7d) for a copy or for a stack object in place: each
 * targeting occurrence may keep its target or change to another one, and the final collective
 * assignment must be legal. `excluded` removes candidates that may not be chosen at all, such as
 * the retargeted object itself (CR 115.5).
 */
export function* chooseNewTargets(
  ctx: GameContext,
  controllerId: PlayerId,
  request: {
    name: string;
    subject: string;
    ability: Ability;
    /** The targeting object's source, for protection and ability restrictions. */
    source: TargetingSource;
    sourceCardId: string;
    originalTargets: readonly ObjectId[];
    originalCounted: Readonly<Record<number, readonly ObjectId[]>>;
    originalDivision: Readonly<Record<ObjectId, number>>;
    originalNames?: Readonly<Record<string, string>>;
    excluded?: ReadonlySet<ObjectId>;
    /** Legality is relative to the targeting object's controller, not the chooser. */
    objectControllerId?: PlayerId;
    eventPlayerId?: PlayerId;
    sourceFacts?: TargetContext['sourceFacts'];
  },
): GameGen<{
  targets: ObjectId[];
  countTargets: Record<number, ObjectId[]>;
  divisionAmounts: Record<ObjectId, number>;
}> {
  const {
    name,
    subject,
    ability,
    source,
    sourceCardId,
    originalTargets,
    originalCounted,
    originalDivision,
    originalNames = {},
    excluded = new Set<ObjectId>(),
    objectControllerId = controllerId,
  } = request;
  const targets = [...originalTargets];
  const countTargets = Object.fromEntries(
    Object.entries(originalCounted).map(([slot, ids]) => [slot, [...ids]]),
  );
  const positions = ability.targets.flatMap((spec, slot) =>
    spec.count === undefined
      ? originalTargets[slot] === undefined
        ? []
        : [{ slot, ordinal: 0, old: originalTargets[slot]! }]
      : (originalCounted[slot] ?? []).map((old, ordinal) => ({ slot, ordinal, old })),
  );
  const valueAt = (position: (typeof positions)[number]) =>
    ability.targets[position.slot]!.count === undefined
      ? targets[position.slot]!
      : countTargets[position.slot]![position.ordinal]!;
  const set = (position: (typeof positions)[number], id: ObjectId) => {
    if (ability.targets[position.slot]!.count === undefined) targets[position.slot] = id;
    else countTargets[position.slot]![position.ordinal] = id;
  };
  const context = (chosenTargets: readonly ObjectId[]): TargetContext => ({
    controllerId: objectControllerId,
    sourceCardId,
    ...targetingSourceFields(source),
    chosenTargets,
    ...(request.eventPlayerId === undefined ? {} : { eventPlayerId: request.eventPlayerId }),
    ...(request.sourceFacts === undefined ? {} : { sourceFacts: request.sourceFacts }),
  });
  const originallyLegal = positions.map((position) =>
    targetIsLegal(ctx, ability.targets[position.slot]!, position.old, context(originalTargets)),
  );
  const finalIsLegal = () => {
    // CR 115.7d-e: unchanged illegal targets may remain; newly chosen targets and the FINAL
    // collective assignment must be legal. A change may not invalidate another kept target.
    for (const [index, position] of positions.entries()) {
      const id = valueAt(position);
      if (
        (id !== position.old || originallyLegal[index]) &&
        !targetIsLegal(ctx, ability.targets[position.slot]!, id, context(targets))
      )
        return false;
    }
    for (const [slot, ids] of Object.entries(countTargets)) {
      if (new Set(ids).size !== ids.length) return false;
      const old = originalCounted[Number(slot)] ?? [];
      if (
        ids.some((id, index) => id !== old[index]) &&
        ids.some(
          (id, index) =>
            !withinTotalManaValue(
              ctx,
              ability.targets[Number(slot)]!,
              ids.filter((_entry, i) => i !== index),
              [id],
            ).includes(id),
        )
      )
        return false;
    }
    return true;
  };
  const domains = positions.map((position) => [
    position.old,
    ...targetDomainCandidates(ctx, ability.targets[position.slot]!.kind).filter(
      (id) => id !== position.old && !excluded.has(id),
    ),
  ]);
  // A target whose legality reads no other chosen target (no "different from", "different
  // player" or "card in that player's graveyard" link) is judged the same in every completion, so
  // `finalIsLegal` would reject it at every leaf. Rejecting it when it is set keeps the search
  // linear in the candidates: Clever Concealment's six counted targets against forty permanents
  // otherwise walked every completion behind each illegal first pick.
  const standsAlone = positions.map((position) => {
    const spec = ability.targets[position.slot]!;
    return (
      spec.differentPlayerTargetSlots === undefined &&
      spec.differentFromSlots === undefined &&
      spec.graveyardOwnerSlot === undefined
    );
  });
  const illegalAlone = (index: number, id: ObjectId): boolean => {
    const position = positions[index]!;
    return (
      standsAlone[index]! &&
      (id !== position.old || originallyLegal[index]!) &&
      !targetIsLegal(ctx, ability.targets[position.slot]!, id, context(targets))
    );
  };
  const canComplete = (index: number): boolean => {
    if (index === positions.length) return finalIsLegal();
    const position = positions[index]!;
    const previous = valueAt(position);
    for (const id of domains[index]!) {
      set(position, id);
      const group =
        ability.targets[position.slot]!.count === undefined
          ? undefined
          : countTargets[position.slot]!;
      // Only earlier fixed positions constrain this prefix; later targets may themselves change.
      if (group !== undefined && group.slice(0, position.ordinal).includes(id)) continue;
      if (illegalAlone(index, id)) continue;
      if (canComplete(index + 1)) {
        set(position, previous);
        return true;
      }
    }
    set(position, previous);
    return false;
  };
  const nameOf = (id: ObjectId) =>
    ctx.state.battlefield.find((perm) => perm.id === id)?.name ??
    ctx.state.stack.find((entry) => entry.id === id)?.description ??
    originalNames[id] ??
    String(id);
  for (const [index, position] of positions.entries()) {
    const choices = domains[index]!.filter((id) => {
      set(position, id);
      const result = !illegalAlone(index, id) && canComplete(index + 1);
      set(position, position.old);
      return result;
    });
    if (choices.length === 1 && choices[0] === position.old) continue;
    if (choices.length === 0) throw new Error('new targets have no legal completion');
    const single = positions.length === 1 && ability.targets[position.slot]!.count === undefined;
    const outcome = yield {
      decisionType: 'general' as const,
      player: controllerId,
      prompt: single
        ? `${name}: choose a target for ${subject}.`
        : `${name}: choose a target for ${subject}, slot ${position.slot}, target ${position.ordinal + 1}.`,
      options: choices.map((id) => ({
        type: 'chooseTarget',
        description:
          id === position.old ? `Keep ${nameOf(id)} as the target` : `Target ${nameOf(id)}`,
      })),
    };
    const chosen = Number.isSafeInteger(outcome.index) ? choices[outcome.index] : undefined;
    if (chosen === undefined) throw new Error('invalid new target choice');
    set(position, chosen);
  }
  const divisionAmounts = { ...originalDivision };
  for (const effect of ability.effects) {
    if (effect.op !== 'dealDamageDivided') continue;
    const old = originalCounted[effect.targetSlot] ?? [];
    for (const id of old) delete divisionAmounts[id];
    for (const [index, id] of (countTargets[effect.targetSlot] ?? []).entries()) {
      const amount = originalDivision[old[index]!];
      if (amount !== undefined) divisionAmounts[id] = amount;
    }
  }
  return { targets, countTargets, divisionAmounts };
}

import type { ObjectId, PlayerId } from '@mtg/shared';
import { queueBecomesTargetedTriggers, queueWardTriggers } from '../actions/apply';
import type { GameGen } from '../decisions';
import { emit } from '../log/log';
import { findPermanent, sourceColorsOf } from '../state/queries';
import type { EngineStackObject, GameContext } from '../state/types';
import { targetDomainCandidates, targetIsLegal, withinTotalManaValue } from '../targets/legality';
import { chooseNewTargets } from './replicate-targets';
import { spellTargetOccurrences } from './target-occurrences';

/**
 * "You may choose new targets for" a spell or ability already on the stack (Deflecting Swat), or
 * for a copy just put there (Reverberate). This changes the targets of that same object; it never
 * creates another one (CR 115.7d). Every occurrence may keep its target, so choosing nothing new
 * is always possible. Newly chosen targets become targets of that object, which triggers ward and
 * "becomes the target" abilities like an announcement does.
 */
export function* chooseNewStackTargets(
  ctx: GameContext,
  entry: EngineStackObject,
  chooserId: PlayerId,
  sourceName: string,
  /** A new copy's targets all become its targets (CR 707.10c), changed or not. */
  newCopy = false,
): GameGen<void> {
  const ability = entry.ability;
  if (ability === null || spellTargetOccurrences(entry).length === 0) return;
  const before = allStackTargets(entry);
  const selected = yield* chooseNewTargets(ctx, chooserId, {
    name: sourceName,
    subject: entry.description,
    ability,
    colors: sourceColorsOf(ctx, entry.sourceCardId, entry.sourceOracleId, entry.sourceColors),
    sourceCardId: entry.sourceCardId,
    originalTargets: entry.targets,
    originalCounted: entry.countTargets ?? {},
    originalDivision: entry.divisionAmounts ?? {},
    excluded: new Set([entry.id]),
    objectControllerId: entry.controllerId,
    ...(entry.triggerScope?.eventPlayerId === undefined
      ? {}
      : { eventPlayerId: entry.triggerScope.eventPlayerId }),
    ...(entry.sourceFacts === undefined ? {} : { sourceFacts: entry.sourceFacts }),
  });
  entry.targets = selected.targets;
  if (entry.countTargets !== undefined) entry.countTargets = selected.countTargets;
  if (entry.divisionAmounts !== undefined) entry.divisionAmounts = selected.divisionAmounts;
  const after = allStackTargets(entry);
  const changed = after.filter((id, index) => id !== before[index]);
  const announced = newCopy ? after : changed;
  queueWardTriggers(ctx, entry.controllerId, entry.id, announced);
  queueBecomesTargetedTriggers(ctx, entry.controllerId, announced);
  if (changed.length === 0) return;
  emit(
    ctx,
    'stackTargetsChanged',
    { description: entry.description, from: before, to: after },
    chooserId,
  );
}

/**
 * "Change the target of target spell or ability with a single target" (Bolt Bend, CR 115.7a):
 * the object must change to another legal target if one exists, and keeps its target otherwise.
 * Only an object with exactly one targeting occurrence qualifies (CR 115.9a); that is rechecked
 * here because its targets may have changed since this one was announced.
 */
export function* changeSingleStackTarget(
  ctx: GameContext,
  entry: EngineStackObject,
  chooserId: PlayerId,
): GameGen<void> {
  const positions = spellTargetOccurrences(entry);
  if (entry.ability === null || positions.length !== 1) return;
  const position = positions[0]!;
  const targetSpec = entry.ability.targets[position.slot]!;
  const targetContext = {
    controllerId: entry.controllerId,
    sourceCardId: entry.sourceCardId,
    sourceColors: sourceColorsOf(ctx, entry.sourceCardId, entry.sourceOracleId, entry.sourceColors),
    chosenTargets: entry.targets,
    ...(entry.triggerScope?.eventPlayerId === undefined
      ? {}
      : { eventPlayerId: entry.triggerScope.eventPlayerId }),
    ...(entry.sourceFacts === undefined ? {} : { sourceFacts: entry.sourceFacts }),
  };
  const choices = withinTotalManaValue(
    ctx,
    targetSpec,
    [],
    targetDomainCandidates(ctx, targetSpec.kind),
  ).filter(
    (id) =>
      id !== entry.id && id !== position.id && targetIsLegal(ctx, targetSpec, id, targetContext),
  );
  // CR 115.7a: if it cannot change to another legal target, retain the old target.
  if (choices.length === 0) return;
  const choice = yield {
    decisionType: 'general',
    player: chooserId,
    prompt: `Change the target of ${entry.description}.`,
    options: choices.map((id) => ({
      type: 'changeTarget',
      description: `Target ${
        findPermanent(ctx, id)?.name ??
        ctx.state.stack.find((candidate) => candidate.id === id)?.description ??
        id
      }`,
    })),
  };
  const chosen = choices[choice.index];
  if (chosen === undefined) throw new Error('engine bug: invalid new stack target');
  if (position.ordinal === undefined) entry.targets[position.slot] = chosen;
  else entry.countTargets![position.slot]![position.ordinal] = chosen;
  if (entry.divisionAmounts?.[position.id] !== undefined) {
    entry.divisionAmounts[chosen] = entry.divisionAmounts[position.id]!;
    delete entry.divisionAmounts[position.id];
  }
  queueWardTriggers(ctx, entry.controllerId, entry.id, [chosen]);
  queueBecomesTargetedTriggers(ctx, entry.controllerId, [chosen]);
  emit(
    ctx,
    'spellTargetChanged',
    { spell: entry.description, from: position.id, to: chosen },
    chooserId,
  );
}

export function allStackTargets(entry: EngineStackObject): ObjectId[] {
  return spellTargetOccurrences(entry).map((position) => position.id as ObjectId);
}

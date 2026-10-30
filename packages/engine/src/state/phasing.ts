import type { PlayerId } from '@mtg/shared';
import { emit } from '../log/log';
import { createPreparedCopy, expireSourceControlEffects, retainAttackDefender } from './objects';
import type { GameContext } from './types';

/** Player shields expire as that player's next turn begins, before its untap step. */
function untilNextTurnActive(
  ctx: GameContext,
  playerId: PlayerId,
  since: number | undefined,
): boolean {
  return (
    since !== undefined &&
    !(ctx.state.currentTurnPlayer === playerId && ctx.state.turnNumber > since)
  );
}

/** Teferi's Protection: the life total can't change until the player's next turn. */
export function playerLifeLocked(ctx: GameContext, playerId: PlayerId): boolean {
  return untilNextTurnActive(ctx, playerId, ctx.state.playerProtectionUntilNextTurn?.[playerId]);
}

/**
 * CR 702.16j: protection from everything. Teferi's Protection grants it with the life lock; The
 * One Ring grants it alone, so the life total still changes.
 */
export function playerProtectedFromEverything(ctx: GameContext, playerId: PlayerId): boolean {
  return (
    playerLifeLocked(ctx, playerId) ||
    untilNextTurnActive(
      ctx,
      playerId,
      ctx.state.playerProtectionFromEverythingUntilNextTurn?.[playerId],
    )
  );
}

/** CR 702.26: keep the same object, counters, attachments and choices; no zone-change event. */
export function phaseOutControlledPermanents(ctx: GameContext, playerId: PlayerId): void {
  phaseOutPermanents(
    ctx,
    ctx.state.battlefield.filter((perm) => perm.controllerId === playerId).map((perm) => perm.id),
    playerId,
  );
}

/**
 * Phase out `directIds` and, indirectly, everything attached to them (CR 702.26g). They phase in
 * during `playerId`'s next untap step (Clever Concealment: "until your next turn").
 */
export function phaseOutPermanents(
  ctx: GameContext,
  directIds: readonly string[],
  playerId: PlayerId,
): void {
  const ids = new Set(directIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const perm of ctx.state.battlefield) {
      if (!ids.has(perm.id) && perm.attachedTo !== null && ids.has(perm.attachedTo)) {
        ids.add(perm.id);
        changed = true;
      }
    }
  }
  const leaving = ctx.state.battlefield.filter((perm) => ids.has(perm.id));
  // zone-mutation: phasing out is not a zone change (CR 702.26d): the permanents keep their objects
  ctx.state.battlefield = ctx.state.battlefield.filter((perm) => !ids.has(perm.id));
  // CR 506.4: a planeswalker that phases out is removed from combat. Mark it now, not lazily:
  // it phases back in later with the same object id and must not re-enter the attack.
  for (const attacker of ctx.state.battlefield) {
    if (attacker.attackingPlaneswalker !== null && ids.has(attacker.attackingPlaneswalker))
      attacker.attackedPlaneswalkerRemoved = true;
  }
  for (const permanent of leaving) {
    // CR 702.26f: an effect with a "for as long as" duration tracking this permanent (Promise of
    // Loyalty's "for as long as it has a vow counter on it") ends when it phases out, because it
    // can no longer see the permanent. The vow counter stays (CR 702.26d); the effect does not.
    delete permanent.cantAttackPlayerWhileCounter;
    retainAttackDefender(permanent);
    permanent.attacking = null;
    permanent.attackingPlaneswalker = null;
    permanent.attackedPlaneswalkerRemoved = false;
    permanent.blocking = null;
    permanent.statuses = permanent.statuses.filter(
      (status) => status !== 'attacking' && status !== 'blocking',
    );
    (ctx.state.phasedOut ??= []).push({ permanent, phaseInPlayerId: playerId });
  }
  // Publish the whole phased-out set first: a tracked source and the creature it controls may
  // phase out together. Their relative battlefield order cannot preserve an expired duration.
  for (const permanent of leaving) expireSourceControlEffects(ctx, permanent.id);
  emit(ctx, 'phaseOut', {
    player: playerId,
    objects: leaving.map((perm) => ({
      id: perm.id,
      name: perm.faceDown ? 'Face-down permanent' : perm.name,
    })),
  });
}

/** Directly phased objects and their indirect attachments phase in together at the due untap. */
export function phaseInAtUntap(ctx: GameContext, playerId: PlayerId): void {
  const due = (ctx.state.phasedOut ?? []).filter((record) => record.phaseInPlayerId === playerId);
  ctx.state.phasedOut = (ctx.state.phasedOut ?? []).filter(
    (record) => record.phaseInPlayerId !== playerId,
  );
  // zone-mutation: phasing in is not a zone change (CR 702.26d): the permanents return as the same objects
  ctx.state.battlefield.push(...due.map((record) => record.permanent));
  // Its prepare-spell copy ceased while it was phased out; phasing in prepared makes a fresh one
  // (CR 722.3c).
  for (const { permanent } of due)
    if (permanent.prepared === true) createPreparedCopy(ctx, permanent);
  if (due.length > 0)
    emit(ctx, 'phaseIn', {
      player: playerId,
      objects: due.map((record) => ({
        id: record.permanent.id,
        name: record.permanent.faceDown ? 'Face-down permanent' : record.permanent.name,
      })),
    });
}

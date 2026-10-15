import type { PlayerId } from '@mtg/shared';
import { emit } from '../log/log';
import type { GameContext } from './types';

/** Player shields expire as that player's next turn begins, before its untap step. */
export function playerLifeLocked(ctx: GameContext, playerId: PlayerId): boolean {
  const since = ctx.state.playerProtectionUntilNextTurn?.[playerId];
  return (
    since !== undefined &&
    !(ctx.state.currentTurnPlayer === playerId && ctx.state.turnNumber > since)
  );
}

/** CR 702.26: keep the same object, counters, attachments and choices; no zone-change event. */
export function phaseOutControlledPermanents(ctx: GameContext, playerId: PlayerId): void {
  const ids = new Set(
    ctx.state.battlefield.filter((perm) => perm.controllerId === playerId).map((perm) => perm.id),
  );
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
  ctx.state.battlefield = ctx.state.battlefield.filter((perm) => !ids.has(perm.id));
  // CR 506.4: a planeswalker that phases out is removed from combat. Mark it now, not lazily:
  // it phases back in later with the same object id and must not re-enter the attack.
  for (const attacker of ctx.state.battlefield) {
    if (attacker.attackingPlaneswalker !== null && ids.has(attacker.attackingPlaneswalker))
      attacker.attackedPlaneswalkerRemoved = true;
  }
  for (const permanent of leaving) {
    // CR 702.26f: tracking this object with a "for as long as" duration ends here.
    delete permanent.cantAttackPlayerWhileCounter;
    permanent.attacking = null;
    permanent.attackingPlaneswalker = null;
    permanent.attackedPlaneswalkerRemoved = false;
    permanent.blocking = null;
    permanent.statuses = permanent.statuses.filter(
      (status) => status !== 'attacking' && status !== 'blocking',
    );
    (ctx.state.phasedOut ??= []).push({ permanent, phaseInPlayerId: playerId });
  }
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
  ctx.state.battlefield.push(...due.map((record) => record.permanent));
  if (due.length > 0)
    emit(ctx, 'phaseIn', {
      player: playerId,
      objects: due.map((record) => ({
        id: record.permanent.id,
        name: record.permanent.faceDown ? 'Face-down permanent' : record.permanent.name,
      })),
    });
}

/**
 * Object identity and zone movement (CR 400.7, brief §5.2). A card changing zones becomes
 * a NEW object with a new `ObjectId`; the stable `cardId` links its zone-visits together.
 *
 * `moveObject` is a generator because moving a commander into its owner's hand or library
 * asks the owner whether to put it into the command zone instead (CR 903.9b — an AI
 * decision, brief §5.7). Graveyard/exile command-zone returns are a state-based action
 * (CR 903.9a) handled by the SBA loop, not here.
 */

import type { ObjectId, PlayerId, Zone } from '@mtg/shared';
import type { GameGen } from '../decisions';
import { debug, emit } from '../log/log';
import { getDefByOracleId } from './queries';
import type {
  EngineCardObject,
  EngineObject,
  EnginePermanent,
  EnginePlayerState,
  GameContext,
} from './types';

export function newObjectId(ctx: GameContext): ObjectId {
  return `o-${ctx.state.nextObjectNum++}`;
}

export function playerById(ctx: GameContext, id: PlayerId): EnginePlayerState {
  const p = ctx.state.players.find((pl) => pl.id === id);
  if (p === undefined) throw new Error(`unknown player ${id}`);
  return p;
}

/** Where a moved object should land. */
export interface MoveDestination {
  zone: Zone;
  /** Battlefield only: the controller it enters under (defaults to its owner). */
  controllerId?: PlayerId;
  /** Library only: where to put it. Defaults to 'top'. Index 0 is the top. */
  libraryPosition?: 'top' | 'bottom';
}

/** Remove `obj` from whatever zone container currently holds it. */
export function removeFromCurrentZone(ctx: GameContext, obj: EngineObject): void {
  const s = ctx.state;
  const pull = (arr: { id: ObjectId }[]): void => {
    const i = arr.findIndex((o) => o.id === obj.id);
    if (i >= 0) arr.splice(i, 1);
  };
  switch (obj.zone) {
    case 'battlefield':
      pull(s.battlefield);
      break;
    case 'exile':
      pull(s.exile);
      break;
    case 'stack':
      // A spell's card object is embedded in its stack entry; the stack entry itself is
      // removed by the resolution/counter code.
      break;
    case 'hand':
      pull(playerById(ctx, obj.ownerId).hand);
      break;
    case 'library':
      pull(playerById(ctx, obj.ownerId).library);
      break;
    case 'graveyard':
      pull(playerById(ctx, obj.ownerId).graveyard);
      break;
    case 'command':
      pull(playerById(ctx, obj.ownerId).commandZone);
      break;
  }
}

/** Clone `obj` as a brand-new object (new `ObjectId`) in `zone` (CR 400.7). */
function reincarnate(ctx: GameContext, obj: EngineObject, zone: Zone): EngineCardObject {
  return {
    id: newObjectId(ctx),
    cardId: obj.cardId,
    oracleId: obj.oracleId,
    ownerId: obj.ownerId,
    name: obj.name,
    typeLine: obj.typeLine,
    oracleText: obj.oracleText,
    manaCost: obj.manaCost,
    isToken: obj.isToken,
    isCommander: obj.isCommander,
    zone,
  };
}

/** Build the battlefield form of an object (used by moveObject and by casting). */
export function makePermanent(
  ctx: GameContext,
  obj: EngineObject,
  controllerId: PlayerId,
): EnginePermanent {
  const def = getDefByOracleId(ctx, obj.oracleId, obj.name);
  return {
    ...reincarnate(ctx, obj, 'battlefield'),
    zone: 'battlefield',
    controllerId,
    tapped: def.entersTapped,
    power: def.power,
    toughness: def.toughness,
    damageMarked: 0,
    counters: {},
    statuses: [],
    summoningSick: true,
    attachedTo: null,
    attacking: null,
    blocking: null,
    blockedByOrdered: [],
    damagedByDeathtouch: false,
    dealtFirstStrikeDamage: false,
  };
}

/**
 * Move an object to a new zone, yielding the new object (or null when a token ceases to
 * exist). Emits the zone-change event, applies the CR 903.9b commander replacement, sets
 * the CR 903.9a bookkeeping flag, and queues ETB/dies triggers.
 */
export function* moveObject(
  ctx: GameContext,
  obj: EngineObject,
  dest: MoveDestination,
): GameGen<EngineCardObject | EnginePermanent | null> {
  const from = obj.zone;
  let target: MoveDestination = dest;

  // CR 903.9b — commander headed to hand or library: owner may redirect to command zone.
  if (obj.isCommander && (dest.zone === 'hand' || dest.zone === 'library')) {
    const outcome = yield {
      decisionType: 'commanderReplacement',
      player: obj.ownerId,
      prompt: `${obj.name} would be put into your ${dest.zone}. Put it into the command zone instead?`,
      options: [
        { type: 'commanderToCommandZone', description: `Put ${obj.name} into the command zone` },
        { type: 'keepMoving', description: `Let ${obj.name} go to your ${dest.zone}` },
      ],
    };
    if (outcome.index === 0) target = { zone: 'command' };
  }

  removeFromCurrentZone(ctx, obj);

  // Tokens cease to exist when they leave the battlefield (CR 704.5d; applied directly
  // on the move rather than at the next SBA check — indistinguishable in Phase 2).
  if (obj.isToken && from === 'battlefield' && target.zone !== 'battlefield') {
    emit(ctx, 'tokenCeased', { name: obj.name, cardId: obj.cardId });
    debug(ctx, 'zoneChange', `token ${obj.name} ceased to exist`);
    queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
    return null;
  }

  let next: EngineCardObject | EnginePermanent;
  if (target.zone === 'battlefield') {
    const perm = makePermanent(ctx, obj, target.controllerId ?? obj.ownerId);
    ctx.state.battlefield.push(perm);
    next = perm;
  } else {
    next = reincarnate(ctx, obj, target.zone);
    const owner = playerById(ctx, obj.ownerId);
    switch (target.zone) {
      case 'hand':
        owner.hand.push(next);
        break;
      case 'graveyard':
        owner.graveyard.push(next); // last element = top of graveyard
        break;
      case 'command':
        owner.commandZone.push(next);
        break;
      case 'exile':
        ctx.state.exile.push(next);
        break;
      case 'library':
        if ((target.libraryPosition ?? 'top') === 'top') owner.library.unshift(next);
        else owner.library.push(next);
        break;
      case 'stack':
        // The caller (casting code) owns placing the object into its stack entry.
        break;
    }
  }

  // CR 903.9a — commander newly in graveyard/exile: flag for the next SBA check.
  if (next.isCommander && (target.zone === 'graveyard' || target.zone === 'exile')) {
    (next as EngineCardObject).commanderSbaPending = true;
  }

  emit(ctx, 'zoneChange', {
    cardId: obj.cardId,
    name: obj.name,
    from,
    to: target.zone,
    owner: obj.ownerId,
    newObjectId: next.id,
  });
  debug(ctx, 'zoneChange', `${obj.name}: ${from} → ${target.zone}`, { cardId: obj.cardId });

  // Triggers (Phase 2 set): ETB on arriving, dies on battlefield → graveyard.
  if (target.zone === 'battlefield' && from !== 'battlefield') {
    queueTriggers(ctx, next as EnginePermanent, 'etbSelf');
  }
  if (from === 'battlefield') {
    queueLeaveBattlefieldTriggers(ctx, obj, target.zone);
  }

  return next;
}

/** Queue matching triggers from a permanent's definition (CR 603.3b). */
export function queueTriggers(
  ctx: GameContext,
  perm: EnginePermanent,
  event: 'etbSelf' | 'diesSelf',
): void {
  const def = getDefByOracleId(ctx, perm.oracleId, perm.name);
  for (const spec of def.triggers) {
    if (spec.event === event) {
      ctx.state.pendingTriggers.push({
        controllerId: perm.controllerId,
        sourceCardId: perm.cardId,
        sourceOracleId: perm.oracleId,
        sourceName: perm.name,
        spec,
      });
      debug(ctx, 'stack', `trigger queued: ${perm.name} — ${spec.description}`);
    }
  }
}

function queueLeaveBattlefieldTriggers(ctx: GameContext, obj: EngineObject, to: Zone): void {
  // "dies" means battlefield → graveyard (CR 700.4). The pre-move battlefield object
  // carries the controller.
  if (to !== 'graveyard') return;
  const perm = obj as EnginePermanent;
  if (perm.controllerId === undefined) return;
  queueTriggers(ctx, perm, 'diesSelf');
}

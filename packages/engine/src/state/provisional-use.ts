/**
 * The log line and result stamp for provisional cards (H1). A provisional card plays by a
 * machine-checked patch nobody has reviewed, so the log says so the first time one is cast or
 * activated, and a finished game's result lists every provisional card its decks held.
 */

import type { GameResult } from '@mtg/shared';
import { emit } from '../log/log';
import type { PriorityActionPayload } from '../actions/legal';
import type { EngineObject, EnginePlayerState, GameContext } from './types';

/** Names of the provisional cards in this game's decks, sorted; empty for most games. */
export function provisionalCardNames(ctx: GameContext): string[] {
  const names: string[] = [];
  for (const def of ctx.defs.values()) if (def.trust === 'provisional') names.push(def.name);
  return names.sort();
}

/** The result, stamped with the provisional cards its decks held. Unchanged when there are none. */
export function stampProvisional(ctx: GameContext, result: GameResult): GameResult {
  const names = provisionalCardNames(ctx);
  return names.length === 0 ? result : { ...result, provisionalCards: names };
}

function findObject(ctx: GameContext, id: string): EngineObject | undefined {
  const s = ctx.state;
  const zones: EngineObject[][] = [s.battlefield, s.exile];
  for (const player of s.players)
    zones.push(player.hand, player.library, player.graveyard, player.commandZone);
  for (const zone of zones) {
    const found = zone.find((o) => o.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Actions that show the card to everyone. A face-down cast and foretell keep the card hidden
 * (CR 708.2, 702.143a), so announcing its name then would leak it.
 */
function isPublicUse(
  payload: PriorityActionPayload,
): payload is Extract<PriorityActionPayload, { objectId: string }> {
  switch (payload.kind) {
    case 'castSpell':
      return payload.alternativeCast !== 'faceDown';
    case 'activateAbility':
    case 'playLand':
    case 'turnFaceUp':
    case 'unlockDoor':
      return true;
    default:
      return false;
  }
}

/**
 * Before a priority action is applied: if its source is a provisional card not yet announced in
 * this game, add one `provisionalCardUsed` line to the log.
 */
export function noteProvisionalUse(
  ctx: GameContext,
  player: EnginePlayerState,
  payload: PriorityActionPayload,
): void {
  if (!isPublicUse(payload)) return;
  const obj = findObject(ctx, payload.objectId);
  if (obj === undefined) return;
  const def = ctx.defs.get(obj.oracleId);
  if (def?.trust !== 'provisional') return;
  const announced = (ctx.state.provisionalAnnounced ??= []);
  if (announced.includes(obj.oracleId)) return;
  announced.push(obj.oracleId);
  emit(
    ctx,
    'provisionalCardUsed',
    { player: player.id, name: def.name, cardId: obj.cardId, source: def.trustSource ?? null },
    player.id,
  );
}

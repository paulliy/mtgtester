/**
 * The log line and result stamp for provisional cards (H1). A provisional card plays by a
 * machine-checked patch nobody has reviewed, so the log says so the first time one is cast or
 * activated, and a finished game's result lists every provisional card its decks held.
 */

import type { GameResult } from '@mtg/shared';
import { emit } from '../log/log';
import type { PriorityActionPayload } from '../actions/legal';
import type { EngineObject, EnginePlayerState, GameContext } from './types';

/**
 * Names of the provisional cards in this game's decks, sorted; empty for most games. Read from
 * the list fixed at creation, because tokens and copies of a provisional card keep its trust
 * marking under definitions of their own.
 */
export function provisionalCardNames(ctx: GameContext): string[] {
  return [...(ctx.state.provisionalDeckCards ?? [])];
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

/** A provisional card an action is about to use, captured before the action moves it. */
export interface ProvisionalUse {
  oracleId: string;
  name: string;
  cardId: string;
  source: string | null;
}

/**
 * Before a priority action is applied: the provisional card it uses, if the use is public and the
 * card has not been announced in this game yet. A face-down permanent stays anonymous for every
 * action but turning it face up (CR 708.2).
 */
export function provisionalUseOf(
  ctx: GameContext,
  payload: PriorityActionPayload,
): ProvisionalUse | null {
  if (!isPublicUse(payload)) return null;
  const obj = findObject(ctx, payload.objectId);
  if (obj === undefined) return null;
  if (payload.kind !== 'turnFaceUp' && 'faceDown' in obj && obj.faceDown === true) return null;
  const def = ctx.defs.get(obj.oracleId);
  if (def?.trust !== 'provisional') return null;
  if (ctx.state.provisionalAnnounced?.includes(obj.oracleId) === true) return null;
  return {
    oracleId: obj.oracleId,
    name: def.name,
    cardId: obj.cardId,
    source: def.trustSource ?? null,
  };
}

/**
 * After the action took effect: one `provisionalCardUsed` line, so the board snapshot at that
 * line already shows the card cast, played, activated or face up.
 */
export function announceProvisionalUse(
  ctx: GameContext,
  player: EnginePlayerState,
  use: ProvisionalUse,
): void {
  const announced = (ctx.state.provisionalAnnounced ??= []);
  if (announced.includes(use.oracleId)) return;
  announced.push(use.oracleId);
  emit(
    ctx,
    'provisionalCardUsed',
    { player: player.id, name: use.name, cardId: use.cardId, source: use.source },
    player.id,
  );
}

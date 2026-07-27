/**
 * Event and debug logging (brief §13 — built in Phase 2 as the engine goes).
 *
 * - `emit` appends to the replayable `GameEvent` log inside `GameState` — the record the
 *   determinism test compares byte-for-byte and Phase 5 persists to `game_events`.
 * - `debug` appends to the engine-internal debug log: SBA checks, priority passes, legal
 *   action sets, zone changes — never part of `GameState`.
 */

import type { PlayerId } from '@mtg/shared';
import type { DebugEntry, GameContext } from '../state/types';
import { buildSpectatorState } from '../view/spectator';

export function emit(
  ctx: GameContext,
  type: string,
  payload: Record<string, unknown>,
  actorSeat: PlayerId | null = null,
): void {
  const s = ctx.state;
  const seq = s.nextEventSequence++;
  s.eventLog.push({
    sequence: seq,
    turn: s.turnNumber,
    phase: s.phase,
    step: s.step,
    actorSeat,
    type,
    payload,
  });
  s.sequenceSnapshots ??= new Map();
  s.sequenceSnapshots.set(seq, buildSpectatorState(ctx));
}

export function debug(
  ctx: GameContext,
  category: DebugEntry['category'],
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry: DebugEntry = { turn: ctx.state.turnNumber, category, message };
  if (data !== undefined) entry.data = data;
  ctx.debugLog.push(entry);
}

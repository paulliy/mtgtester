/**
 * Event and debug logging (brief §13 — built in Phase 2 as the engine goes).
 *
 * - `emit` appends to the replayable `GameEvent` log inside `GameState` — the record the
 *   determinism test compares byte-for-byte and Phase 5 persists to `game_events`.
 * - `debug` appends to the engine-internal debug log: SBA checks, priority passes, legal
 *   action sets, zone changes — never part of `GameState`.
 */

import type { GameEvent, PlayerId } from '@mtg/shared';
import type { DebugEntry, GameContext } from '../state/types';
import { EngineBudgetError } from '../errors';
import { buildSpectatorState, formatSpectatorLine } from '../view/spectator';

/**
 * Settle the snapshot owed to the last loggable event: whatever the board looks like *now* is
 * what that event produced.
 *
 * This is deferred on purpose. An event is appended at the moment it is *announced*, which is
 * routinely before its effect lands — `applyPriorityAction` emits `playLand` and only then
 * moves the card, and `Engine.submit` emits `decision` before the generator applies the chosen
 * action at all. Snapshotting inside `emit` therefore stored the board as it was *before* the
 * line the user clicks on, which is exactly one action stale on every seek.
 *
 * The runner calls this whenever it regains control, so the newest line always has a board.
 */
export function settleSpectatorSnapshot(ctx: GameContext): void {
  const s = ctx.state;
  const seq = s.pendingSnapshotSequence;
  if (seq === null || seq === undefined) return;
  s.pendingSnapshotSequence = null;
  (s.sequenceSnapshots ??= new Map()).set(seq, buildSpectatorState(ctx));
}

export function emit(
  ctx: GameContext,
  type: string,
  payload: Record<string, unknown>,
  actorSeat: PlayerId | null = null,
): void {
  const budget = ctx.budget;
  if (budget?.maxStepWork !== undefined && type !== 'engineHalt') {
    budget.stepWork.count += 1;
    if (budget.stepWork.count > budget.maxStepWork)
      throw new EngineBudgetError('stepWork', budget.maxStepWork);
  }
  const s = ctx.state;
  const seq = s.nextEventSequence++;
  const event: GameEvent = {
    sequence: seq,
    turn: s.turnNumber,
    phase: s.phase,
    step: s.step,
    actorSeat,
    type,
    payload,
  };
  s.eventLog.push(event);

  // The state as it stands right now is the outcome of the previous loggable event.
  settleSpectatorSnapshot(ctx);

  // Only events the spectator log actually renders are worth a snapshot: seeking is by log
  // line, and a snapshot per raw event cost ~11 MB of retained state per 30 turns.
  if (formatSpectatorLine(event) !== null) s.pendingSnapshotSequence = seq;
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

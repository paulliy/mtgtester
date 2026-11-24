/**
 * Event and debug logging (brief §13 — built in Phase 2 as the engine goes).
 *
 * - `emit` appends to the replayable `GameEvent` log inside `GameState` — the record the
 *   determinism test compares byte-for-byte and Phase 5 persists to `game_events`.
 * - `debug` appends to the engine-internal debug log: SBA checks, priority passes, legal
 *   action sets, zone changes — never part of `GameState`.
 */

import type { GameEvent, PlayerId, SpectatorState } from '@mtg/shared';
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
  const snapshot = shareUnchanged(LAST_SNAPSHOT.get(ctx), buildSpectatorState(ctx));
  LAST_SNAPSHOT.set(ctx, snapshot);
  (s.sequenceSnapshots ??= new Map()).set(seq, snapshot);
}

/**
 * The last board each game recorded. Consecutive log lines usually change one or two objects,
 * so a new board shares every part equal to this one's (`shareUnchanged`): a retained board then
 * costs about what changed, not a copy of the whole game. Only the playback UI reads them, as
 * values, and nothing writes to a recorded board.
 */
const LAST_SNAPSHOT = new WeakMap<GameContext, SpectatorState>();

/**
 * `next`, with every part that equals the same part of `prev` replaced by `prev`'s object, and
 * `prev` itself when the two are equal. Array elements with an `id` are matched by it (a
 * permanent that left shifts the ones after it); others by position. Equal means the same keys
 * in the same order with equal values, so the result serializes exactly as `next` does. `next`
 * must be freshly built: its objects are updated in place.
 */
export function shareUnchanged<T>(prev: unknown, next: T): T {
  if (prev === (next as unknown)) return next;
  if (typeof next !== 'object' || next === null || typeof prev !== 'object' || prev === null)
    return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    let byId: Map<unknown, unknown> | undefined;
    let same = prev.length === next.length;
    for (let i = 0; i < next.length; i++) {
      const item: unknown = next[i];
      const id =
        typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined;
      let match: unknown = prev[i];
      if (typeof id === 'string' && (match as { id?: unknown } | undefined)?.id !== id) {
        if (byId === undefined) {
          byId = new Map();
          for (const old of prev as unknown[])
            if (typeof old === 'object' && old !== null)
              byId.set((old as { id?: unknown }).id, old);
        }
        match = byId.get(id);
      }
      const shared = shareUnchanged(match, item);
      next[i] = shared;
      if (shared !== prev[i]) same = false;
    }
    return (same ? prev : next) as T;
  }
  if (Array.isArray(prev)) return next;
  const before = prev as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  let same = beforeKeys.length === afterKeys.length;
  for (let i = 0; i < afterKeys.length; i++) {
    const key = afterKeys[i]!;
    const shared = shareUnchanged(before[key], after[key]);
    after[key] = shared;
    if (!same) continue;
    if (beforeKeys[i] !== key || shared !== before[key]) same = false;
  }
  return (same ? prev : next) as T;
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
  if (ctx.skipSpectatorSnapshots !== true && formatSpectatorLine(event) !== null)
    s.pendingSnapshotSequence = seq;
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

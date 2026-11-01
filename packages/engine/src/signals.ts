/**
 * Engine-internal control-flow signals, thrown through the generator stack and caught by
 * the top-level game flow. Not part of the public API.
 */

import type { PlayerId } from '@mtg/shared';

/** The game has ended: one survivor, or a draw/halt state (brief §4). */
export class GameOverSignal {
  readonly winner: PlayerId | null;
  readonly haltReason: string | null;

  constructor(winner: PlayerId | null, haltReason: string | null = null) {
    this.winner = winner;
    this.haltReason = haltReason;
  }
}

/**
 * The game ends by agreement rather than by the rules (ADR 0031 decision 10): a table's time
 * limit, or every human gone. Thrown into the game generator by `Engine.concede`, it unwinds every
 * in-progress step (a cast in progress rewinds through its checkpoint) and `playGame` turns it
 * into a draw for the players still in the game.
 */
export class GameConcededSignal {
  constructor(
    readonly players: readonly PlayerId[],
    readonly reason: 'timeLimit' | 'allAway',
    /**
     * The next event sequence before the unwind. A cast in progress rewinds the whole state,
     * its event counter included, but its events may already have left the engine (the server
     * flushes before it waits on a decision), so the concession is numbered after all of them.
     */
    readonly sequenceFloor: number,
  ) {}
}

/**
 * The active player left the game and the stack is empty — the remainder of the turn is
 * skipped (Phase 2 simplification of CR 800.4j; see ADR 0003).
 */
export class TurnAbortedSignal {}

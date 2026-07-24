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
 * The active player left the game and the stack is empty — the remainder of the turn is
 * skipped (Phase 2 simplification of CR 800.4j; see ADR 0003).
 */
export class TurnAbortedSignal {}

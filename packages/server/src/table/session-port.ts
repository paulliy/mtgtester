/**
 * The table's side of one running game (ADR 0031 decision 6, plan M3 task 3).
 *
 * `TableSessionPort` is async so the table drives a game the same way whatever runs it: the
 * worker implementation (`table-worker.ts`, always used by `serve:table`) or the in-process one
 * (tests). Everything that crosses it is structured-clonable data, because the worker
 * implementation posts it between threads.
 *
 * One port is one start attempt. Its `generation` is fixed at creation; the owner ignores any
 * output carrying another generation, so late frames from a terminated worker cannot reach a
 * player. A port reports exactly one terminal output (`gameOver`, `setupProblems` or `failed`),
 * and nothing after it.
 *
 * The port never sees a socket. It names seats; the table server maps each seat to the socket
 * currently bound to it, rewrites ids through `wire-ids.ts`, and filters every frame through the
 * outbound allowlist before sending.
 */

import type {
  GameResult,
  PlayerId,
  ServerToClientMessage,
  SubmitPlayerActionPayload,
  TableClockMode,
  TableDeckProblem,
  TableServerToClientMessage,
  YieldPlayerAbilityPayload,
} from '@mtg/shared';

/** One seat of a game as the worker receives it. Human decks are the approved plaintext. */
export type TableSessionSeat =
  | { seat: PlayerId; controller: 'human'; displayName: string; decklist: string }
  /** `bot` is the heuristic bot; `model` a model-driven seat (ADR 0055). */
  | { seat: PlayerId; controller: 'bot' | 'model' };

/**
 * Everything one start attempt needs. The table server persists this as the private start-attempt
 * manifest before it calls `start`, so a worker that never reaches game start still leaves a
 * readable record. `rngKey` is secret until the game is over; it never enters a frame.
 */
export interface TableSessionConfig {
  tableId: string;
  attemptId: string;
  gameId: string;
  /** A public label only; the game's randomness comes from `rngKey`. */
  seed: string;
  /** 32 bytes as 64 hex digits, for the `chacha20` generator. */
  rngKey: string;
  seats: TableSessionSeat[];
  /** The engine work budget (`match/engine-limits.ts`), stored with the game. */
  maxStepWork: number;
  maxObjects: number;
  turnCap?: number;
  /** The table's clock preset; `off` (dev mode only) runs untimed. */
  clock: TableClockMode;
  /** Dev mode only: every clock duration divided by this, for end-to-end tests. */
  clockScale?: number;
  /** The table database the worker's `GameStore` opens. Already migrated by the main thread. */
  dbPath: string;
  /** Use the fixture oracle (`--oracle-fixture`) instead of the full card data. */
  oracleFixture?: boolean;
  /** Tests only: 0 presents as fast as the engine computes. */
  livePaceMs?: number;
  /**
   * Present exactly when a seat is `model` (ADR 0055): the per-game cap every model seat shares.
   * The Anthropic key is not here; the worker reads it from its own environment.
   */
  ai?: { maxUsdPerGame: number };
}

/** A player's input, already authorized by the table server for `seat`. */
export type TableSessionInput =
  | { type: 'submitPlayerAction'; seat: PlayerId; payload: SubmitPlayerActionPayload }
  | { type: 'yieldPlayerAbility'; seat: PlayerId; payload: YieldPlayerAbilityPayload }
  | { type: 'resumePlayerAbility'; seat: PlayerId; key: string }
  | { type: 'cancelYield'; seat: PlayerId }
  | { type: 'setPlayerConnected'; seat: PlayerId; connected: boolean }
  | { type: 'setRawActionData'; seat: PlayerId; enabled: boolean }
  /** The seat's player takes it back from the fallback bot (M4). */
  | { type: 'resumeControl'; seat: PlayerId }
  /** The host has the seat's fallback bot answer its pending decision once (a stuck game). */
  | { type: 'hostResolve'; seat: PlayerId }
  /** Re-send the seat's board and pending request to a socket that just bound to it. */
  | { type: 'resyncPlayer'; seat: PlayerId };

/** Typed per-seat deck problems from worker preparation; each goes to its own seat only. */
export type TableSetupProblems = Partial<Record<PlayerId, TableDeckProblem[]>>;

export type TableSessionOutput =
  /** A frame for one seat. Never routed to another seat or to a lobby-only socket. */
  | { type: 'seatFrame'; generation: number; seat: PlayerId; message: ServerToClientMessage }
  /** A frame every seated player may receive, still subject to the outbound allowlist. */
  | { type: 'publicFrame'; generation: number; message: ServerToClientMessage }
  /** A table frame (`clockState`, `seatStatus`) for every seated player, through the allowlist. */
  | { type: 'tableFrame'; generation: number; message: TableServerToClientMessage }
  /** Setup succeeded and the game is running. Sent once, before any frame. */
  | { type: 'started'; generation: number }
  /** Terminal: deck problems found during preparation. No game row or result was created. */
  | { type: 'setupProblems'; generation: number; problems: TableSetupProblems }
  /** Terminal: the game ended (win, draw, halt, turn cap) and its result is committed. */
  | { type: 'gameOver'; generation: number; result: GameResult }
  /**
   * Terminal: the run stopped without a committed result. `setupFailed` means setup never reached
   * game start; the others interrupt a running game (stored as a halt with this reason).
   */
  | {
      type: 'failed';
      generation: number;
      reason: 'setupFailed' | 'workerFailure' | 'hostAbandoned';
      detail?: string;
    };

export interface TableSessionPort {
  readonly generation: number;
  /** Prepare seats and start the game. Outputs arrive through `onOutput`, `started` first. */
  start(config: TableSessionConfig): Promise<void>;
  send(input: TableSessionInput): Promise<void>;
  /** Subscribe to outputs; returns the unsubscribe. */
  onOutput(listener: (output: TableSessionOutput) => void): () => void;
  /**
   * A health probe, answered while the game waits on a human, a disconnect grace or a clock.
   * Resolves when answered; the caller owns the timeout. Never produces player traffic.
   */
  ping(): Promise<void>;
  /**
   * Stop the run and wait for it to end. With `hostAbandoned` the port reports that terminal
   * output unless one was already reported. Idempotent.
   */
  terminate(reason: 'workerFailure' | 'hostAbandoned'): Promise<void>;
}

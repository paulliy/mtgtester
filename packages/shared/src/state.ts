import type { DeckId, GameId, ObjectId, PlayerId } from './ids';
import type { LossReason, Phase, Step } from './enums';
import type { ManaPool } from './mana';
import type { GameObject, PermanentState, StackObject } from './objects';
import type { ContinuousEffect } from './effects';
import type { GameEvent } from './events';

/**
 * Per-player state (brief §5.2). Zone arrays hold identity-stable `GameObject`s.
 * `library` order is secret — it must never appear in a `PlayerView` (brief §7.1).
 */
export interface PlayerState {
  id: PlayerId;
  deckId: DeckId;
  /** Commander life total. Starts at 40 (brief §5.7). */
  life: number;
  hand: GameObject[];
  /** Order is secret to every player, including its owner. */
  library: GameObject[];
  /** Public and ordered. */
  graveyard: GameObject[];
  /** One or two commanders (Partner). Commanders start here (brief §5.7). */
  commandZone: GameObject[];
  /** Times each commander was cast from the command zone → commander tax {2} each (brief §5.7). */
  commanderCastCount: Record<ObjectId, number>;
  /** Combat damage taken keyed by the SOURCE commander's object id; 21 eliminates (brief §5.7). */
  commanderDamageTaken: Record<ObjectId, number>;
  manaPool: ManaPool;
  /** Energy counters are public player counters (CR 122.8). */
  energy: number;
  landsPlayedThisTurn: number;
  /** Poison counters; 10+ loses (brief §5.6). Added to the brief's struct to support the SBA. */
  poisonCounters: number;
  /** Named global counters such as experience or other card-defined resources. */
  counters?: Record<string, number>;
  hasLost: boolean;
  lossReason: LossReason | null;
  /** The chosen companion, still outside the game until moved to hand for {3} (brief §5.7). */
  companion: GameObject | null;
}

/**
 * The complete, authoritative game state (brief §5.2). The engine owns this; the AI never
 * sees it — only a `PlayerView` projection (brief §7.1). Fully determined by seed + the
 * ordered sequence of decisions.
 */
export interface GameState {
  seed: string;
  turnNumber: number;
  /** Index into `turnOrder` of the active player. */
  activePlayerIndex: number;
  /** Index into `turnOrder` of the player with priority, or null when no one has it. */
  priorityPlayerIndex: number | null;
  phase: Phase;
  step: Step | null;
  /** LIFO. Top of stack is the last element (brief §5.5). */
  stack: StackObject[];
  players: PlayerState[];
  /** Shared battlefield; each permanent carries its own controller (brief §5.2). */
  battlefield: PermanentState[];
  exile: GameObject[];
  /** Seating order; contains survivors only after eliminations (brief §5.2). */
  turnOrder: PlayerId[];
  eliminatedPlayers: PlayerId[];
  /** Active continuous effects, for layer application (Phase 2). */
  effects: ContinuousEffect[];
  eventLog: GameEvent[];
}

/** The outcome of a game (brief §4). `winnerSeat` is null only in a halted/draw state. */
export interface GameResult {
  gameId: GameId;
  winnerSeat: PlayerId | null;
  /** Elimination order, last-to-first; the final element is the winner when not halted. */
  finishingOrder: PlayerId[];
  turnCount: number;
  /** True if the engine stopped at a probable-bug/draw state instead of a clean win (brief §4). */
  halted: boolean;
  haltReason: string | null;
}

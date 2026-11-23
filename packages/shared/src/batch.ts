import type { PlayerId } from './ids';
import type { ProviderKind, SeatSource } from './protocol';

export const BATCH_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const BATCH_GAME_STATUSES = [
  'queued',
  'running',
  'finished',
  'halted',
  'abandoned',
  'failed',
] as const;
export type BatchGameStatus = (typeof BATCH_GAME_STATUSES)[number];

export interface BatchScenarioSpec {
  id: string;
  name: string;
  seats: SeatSource[];
  providerKind: ProviderKind;
  games: number;
  reflectionEnabled?: boolean;
}
export const MAX_BATCH_NAME_LENGTH = 80;
export interface BatchSpec {
  /** An optional label for the run, trimmed, at most `MAX_BATCH_NAME_LENGTH` characters. */
  name?: string;
  seed?: string;
  scenarios: BatchScenarioSpec[];
}
export interface BatchFailure {
  scenarioId: string;
  gameIndex: number | null;
  gameId?: string;
  reason: string;
  kind?: string;
}
export interface BatchScenarioProgress {
  id: string;
  name: string;
  providerKind: ProviderKind;
  games: number;
  completedGames: number;
  status: BatchStatus;
}
export interface BatchProgress {
  batchId: string;
  /** The run's own name, or null when none was given (the viewer derives a label). */
  name: string | null;
  seed: string;
  status: BatchStatus;
  totalGames: number;
  completedGames: number;
  finishedGames: number;
  failedGames: number;
  scenarios: BatchScenarioProgress[];
  failure: BatchFailure | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}
/** One row of `GET /api/batches`: a run's headline numbers without its games. */
export interface BatchListItem {
  batchId: string;
  name: string | null;
  seed: string;
  status: BatchStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  totalGames: number;
  completedGames: number;
  finishedGames: number;
  failedGames: number;
  scenarioCount: number;
  /** Scenario names in run order, so the viewer can label a run that has no name of its own. */
  scenarioNames: string[];
}
/** One row of `GET /api/games`: a recorded game, for the Debug page's game picker. */
export interface GameListItem {
  gameId: string;
  seed: string;
  /** `running`, `finished`, `halted`, ... as stored; null for a row that never got a status. */
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  turnCount: number | null;
  /** 1-based seat number of the winner, or null. */
  winnerSeat: number | null;
  gameMode: string;
  batchId: string | null;
  /** The batch scenario's name when the game belongs to a batch. */
  scenarioName: string | null;
  /** The build the game ran on (`games.build_commit`); null for older games. */
  buildCommit: string | null;
  /** Commander names per seat, seat 1 first. */
  seats: { seat: number; commanders: string[] }[];
}
export interface BatchSeatResult {
  seat: PlayerId;
  label: string;
  position: number | null;
  lossReason: string | null;
}
export interface BatchGameSummary {
  gameId: string;
  scenarioId: string;
  scenarioName: string;
  gameIndex: number;
  seed: string;
  status: BatchGameStatus;
  winnerSeat: PlayerId | null;
  turnCount: number | null;
  /**
   * The highest turn with a recorded event. Set for every game that recorded any event, so a
   * failed or halted game (whose `turnCount` stays null) still shows how far it got.
   */
  lastRecordedTurn: number | null;
  standings: BatchSeatResult[];
  failureReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
}
export interface BatchAggregate {
  gamesRequested: number;
  gamesFinished: number;
  gamesFailed: number;
  averageTurns: number | null;
  winsBySeat: Array<{ seat: PlayerId; wins: number }>;
  placementsBySeat: Array<{ seat: PlayerId; averagePosition: number | null }>;
  ai: { calls: number; promptTokens: number; responseTokens: number; costUsd: number };
}
export interface BatchResults {
  progress: BatchProgress;
  games: BatchGameSummary[];
  aggregate: BatchAggregate;
  scenarioAggregates: Array<BatchAggregate & { scenarioId: string; scenarioName: string }>;
}

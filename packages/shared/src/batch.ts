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
export interface BatchSpec {
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
  games: number;
  completedGames: number;
  status: BatchStatus;
}
export interface BatchProgress {
  batchId: string;
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

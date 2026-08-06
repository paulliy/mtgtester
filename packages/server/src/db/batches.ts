import type {
  BatchAggregate, BatchFailure, BatchGameStatus, BatchGameSummary, BatchProgress, BatchResults,
  BatchScenarioProgress, BatchScenarioSpec, BatchSeatResult, BatchStatus, PlayerId,
} from '@mtg/shared';
import type { SqliteLike } from './games';

type Row = Record<string, unknown>;
const n = (v: unknown): number => typeof v === 'number' ? v : typeof v === 'string' ? Number(v) || 0 : 0;
const nullable = (v: unknown): number | null => v === null || v === undefined ? null : n(v);
const str = (v: unknown): string | null => typeof v === 'string' ? v : null;
const player = (v: unknown): PlayerId | null => { const value = nullable(v); return value === null ? null : `P${value}`; };
function rows(db: SqliteLike, sql: string, ...args: unknown[]): Row[] { return db.query(sql).all(...args) as Row[]; }
function first(db: SqliteLike, sql: string, ...args: unknown[]): Row | null { return (db.query(sql).get(...args) as Row | null) ?? null; }

export interface BatchRow { id: string; seed: string; status: BatchStatus; createdAt: string; startedAt: string | null; endedAt: string | null; failure: BatchFailure | null; }

export class BatchRepository {
  constructor(private readonly db: SqliteLike) {}

  create(id: string, seed: string, scenarios: readonly BatchScenarioSpec[]): void {
    const now = new Date().toISOString();
    const write = (): void => {
      this.db.query(`INSERT INTO batches (id, seed, status, created_at) VALUES (?, ?, 'queued', ?)`).run(id, seed, now);
      const stmt = this.db.query(`INSERT INTO batch_scenarios (batch_id, scenario_id, scenario_index, name, games, spec_json) VALUES (?, ?, ?, ?, ?, ?)`);
      scenarios.forEach((scenario, index) => stmt.run(id, scenario.id, index, scenario.name, scenario.games, JSON.stringify(scenario)));
    };
    if (this.db.transaction !== undefined) this.db.transaction(write)(); else write();
  }

  markRunning(id: string): void { this.db.query(`UPDATE batches SET status = 'running', started_at = ? WHERE id = ?`).run(new Date().toISOString(), id); }
  markFinished(id: string, status: Extract<BatchStatus, 'completed' | 'failed' | 'cancelled'>, failure: BatchFailure | null = null): void {
    this.db.query(`UPDATE batches SET status = ?, ended_at = ?, failure_json = ? WHERE id = ?`).run(status, new Date().toISOString(), failure === null ? null : JSON.stringify(failure), id);
  }
  createGame(batchId: string, scenarioId: string, gameIndex: number, gameId: string, seed: string): void {
    this.db.query(`INSERT INTO batch_games (batch_id, scenario_id, game_index, game_id, seed, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`).run(batchId, scenarioId, gameIndex, gameId, seed, new Date().toISOString());
  }
  markGame(gameId: string, status: BatchGameStatus, failureReason: string | null = null): void {
    this.db.query(`UPDATE batch_games SET status = ?, failure_reason = ?, ended_at = ? WHERE game_id = ?`).run(status, failureReason, new Date().toISOString(), gameId);
  }
  activeBatchExists(): boolean { return first(this.db, `SELECT id FROM batches WHERE status IN ('queued', 'running') LIMIT 1`) !== null; }

  get(id: string): BatchRow | null {
    const row = first(this.db, `SELECT * FROM batches WHERE id = ?`, id);
    if (row === null) return null;
    let failure: BatchFailure | null = null;
    if (typeof row['failure_json'] === 'string') { try { failure = JSON.parse(row['failure_json']) as BatchFailure; } catch { failure = null; } }
    return { id, seed: String(row['seed'] ?? ''), status: String(row['status'] ?? 'failed') as BatchStatus, createdAt: String(row['created_at'] ?? ''), startedAt: str(row['started_at']), endedAt: str(row['ended_at']), failure };
  }

  progress(id: string): BatchProgress | null {
    const batch = this.get(id); if (batch === null) return null;
    const scenarioRows = rows(this.db, `SELECT scenario_id, name, games FROM batch_scenarios WHERE batch_id = ? ORDER BY scenario_index`, id);
    const gameRows = rows(this.db, `SELECT scenario_id, status FROM batch_games WHERE batch_id = ?`, id);
    const counts = new Map<string, { done: number; failed: number }>();
    for (const row of gameRows) { const key = String(row['scenario_id']); const value = counts.get(key) ?? { done: 0, failed: 0 }; value.done++; if (row['status'] !== 'finished') value.failed++; counts.set(key, value); }
    const scenarios: BatchScenarioProgress[] = scenarioRows.map((row) => {
      const count = counts.get(String(row['scenario_id'])) ?? { done: 0, failed: 0 }; const games = n(row['games']);
      const status: BatchStatus = count.failed > 0 ? 'failed' : count.done >= games ? 'completed' : count.done > 0 ? 'running' : 'queued';
      return { id: String(row['scenario_id']), name: String(row['name']), games, completedGames: count.done, status };
    });
    const finishedGames = gameRows.filter((row) => row['status'] === 'finished').length;
    return { batchId: id, seed: batch.seed, status: batch.status, totalGames: scenarioRows.reduce((sum, row) => sum + n(row['games']), 0), completedGames: gameRows.length, finishedGames, failedGames: gameRows.length - finishedGames, scenarios, failure: batch.failure, createdAt: batch.createdAt, startedAt: batch.startedAt, endedAt: batch.endedAt };
  }

  results(id: string): BatchResults | null {
    const progress = this.progress(id); if (progress === null) return null;
    const raw = rows(this.db, `SELECT bg.game_id, bg.scenario_id, bs.name AS scenario_name, bg.game_index, bg.seed, bg.status AS batch_status, bg.failure_reason, bg.started_at AS batch_started_at, bg.ended_at AS batch_ended_at, g.winner_seat, g.turn_count, g.started_at, g.ended_at, gp.seat, gp.finished_position, gp.loss_reason, COALESCE(d.name, ds.id) AS deck_name FROM batch_games bg JOIN batch_scenarios bs ON bs.batch_id = bg.batch_id AND bs.scenario_id = bg.scenario_id LEFT JOIN games g ON g.id = bg.game_id LEFT JOIN game_players gp ON gp.game_id = bg.game_id LEFT JOIN deck_snapshots ds ON ds.id = gp.deck_snapshot_id LEFT JOIN decks d ON d.id = ds.deck_id WHERE bg.batch_id = ? ORDER BY bs.scenario_index, bg.game_index, gp.seat`, id);
    const games: BatchGameSummary[] = [];
    for (const row of raw) {
      let summary = games.find((item) => item.gameId === String(row['game_id']));
      if (summary === undefined) { summary = { gameId: String(row['game_id']), scenarioId: String(row['scenario_id']), scenarioName: String(row['scenario_name']), gameIndex: n(row['game_index']), seed: String(row['seed']), status: String(row['batch_status']) as BatchGameStatus, winnerSeat: player(row['winner_seat']), turnCount: nullable(row['turn_count']), standings: [], failureReason: str(row['failure_reason']), startedAt: str(row['started_at'] ?? row['batch_started_at']), endedAt: str(row['ended_at'] ?? row['batch_ended_at']) }; games.push(summary); }
      const seatNumber = nullable(row['seat']); if (seatNumber !== null && !summary.standings.some((item) => item.seat === `P${seatNumber}`)) { const result: BatchSeatResult = { seat: `P${seatNumber}`, label: String(row['deck_name'] ?? `P${seatNumber}`), position: nullable(row['finished_position']), lossReason: str(row['loss_reason']) }; summary.standings.push(result); }
    }
    return { progress, games, aggregate: this.aggregate(id), scenarioAggregates: progress.scenarios.map((scenario) => ({ scenarioId: scenario.id, scenarioName: scenario.name, ...this.aggregate(id, scenario.id) })) };
  }

  private aggregate(batchId: string, scenarioId?: string): BatchAggregate {
    const clause = scenarioId === undefined ? 'bg.batch_id = ?' : 'bg.batch_id = ? AND bg.scenario_id = ?';
    const args = scenarioId === undefined ? [batchId] : [batchId, scenarioId];
    const finished = rows(this.db, `SELECT g.id AS game_id, g.turn_count, gp.seat, gp.finished_position FROM batch_games bg JOIN games g ON g.id = bg.game_id JOIN game_players gp ON gp.game_id = g.id WHERE ${clause} AND g.status = 'finished'`, ...args);
    const requestedRow = scenarioId === undefined ? first(this.db, `SELECT SUM(games) AS total FROM batch_scenarios WHERE batch_id = ?`, batchId) : first(this.db, `SELECT games FROM batch_scenarios WHERE batch_id = ? AND scenario_id = ?`, batchId, scenarioId);
    const requested = n(requestedRow?.['total'] ?? requestedRow?.['games']);
    const all = rows(this.db, `SELECT bg.game_id FROM batch_games bg WHERE ${clause}`, ...args);
    const turns = finished.map((row) => n(row['turn_count'])); const wins = new Map<PlayerId, number>(); const places = new Map<PlayerId, number[]>();
    for (const row of finished) { const p = player(row['seat']); if (p === null) continue; if (n(row['finished_position']) === 1) wins.set(p, (wins.get(p) ?? 0) + 1); const list = places.get(p) ?? []; if (row['finished_position'] !== null) list.push(n(row['finished_position'])); places.set(p, list); }
    const ai = first(this.db, `SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(response_tokens), 0) AS response_tokens, COALESCE(SUM(cost_usd), 0) AS cost_usd FROM ai_calls ac JOIN batch_games bg ON bg.game_id = ac.game_id WHERE ${clause}`, ...args);
    return { gamesRequested: requested, gamesFinished: new Set(finished.map((row) => String(row['game_id']))).size, gamesFailed: Math.max(0, all.length - new Set(finished.map((row) => String(row['game_id']))).size), averageTurns: turns.length === 0 ? null : turns.reduce((a, b) => a + b, 0) / turns.length, winsBySeat: [...wins.entries()].map(([seat, wins]) => ({ seat, wins })), placementsBySeat: [...places.entries()].map(([seat, values]) => ({ seat, averagePosition: values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length })), ai: { calls: n(ai?.['calls']), promptTokens: n(ai?.['prompt_tokens']), responseTokens: n(ai?.['response_tokens']), costUsd: n(ai?.['cost_usd']) } };
  }
}


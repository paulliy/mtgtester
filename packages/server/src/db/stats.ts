/** Phase 5 read models: aggregate deck statistics and one-game debug/export payloads. */

import type { AiAnnotation, AiReflection, ReflectionMoment, TableTalkLine } from '@mtg/shared';
import { lossReasonLabel } from '../match/loss-reasons';
import type { SqliteLike } from './games';

type Row = Record<string, unknown>;

export interface DeckStatistic {
  deckSnapshotId: string;
  name: string;
  /** A deck generated from the supported pool for one game; each has its own random list. */
  generated: boolean;
  commanders: string[];
  colorIdentity: string[];
  archetypeTag: string;
  gamesPlayed: number;
  wins: number;
  winRate: number;
  averageFinish: number | null;
  averageGameLength: number | null;
  averageMulligans: number;
  /** Games finished 1st, 2nd, 3rd and 4th or lower. */
  finishDistribution: [number, number, number, number];
  /** The deck's most recent finished game in this scope, for "Open last game in Debug". */
  lastGameId: string | null;
  mulliganDistribution: Array<{ mulligans: number; games: number }>;
  /** `label` is `reason` in player terms, written here so no screen translates the code. */
  eliminationCauses: Array<{ reason: string; label: string; count: number }>;
  lossesTo: Array<{
    commanders: string[];
    colorIdentity: string[];
    archetypeTag: string;
    count: number;
  }>;
  manaFloodRate: number | null;
  manaDroughtRate: number | null;
}

export type StatsScopeName = 'all' | 'batch' | 'mine';

/** Which finished games a statistics request counts. */
export type StatsScope = { kind: 'all' } | { kind: 'batch'; batchId: string } | { kind: 'mine' };

export interface StatsSummary {
  finishedGames: number;
  /** Finished games where at least one seat played a generated deck. */
  generatedGames: number;
  /** Saved and imported decks that played at least one finished game in scope. */
  decksTracked: number;
  averageTurns: number | null;
  /** The most frequent recorded way a player went out, and its share of all recorded exits. */
  mostCommonEnd: { reason: string; label: string; share: number } | null;
}

export interface StatsMatchup {
  winner: string;
  beaten: string;
  games: number;
}

export interface StatsReport {
  scope: StatsScopeName;
  batchId: string | null;
  decks: DeckStatistic[];
  summary: StatsSummary;
  matchups: StatsMatchup[];
}

function emptySummary(): StatsSummary {
  return {
    finishedGames: 0,
    generatedGames: 0,
    decksTracked: 0,
    averageTurns: null,
    mostCommonEnd: null,
  };
}

interface ScopeSql {
  /** A predicate on the games table under `alias`; its placeholders are `params`, in order. */
  sql(alias: string): string;
  params: unknown[];
}

function scopeSql(scope: StatsScope): ScopeSql {
  if (scope.kind === 'batch')
    return {
      sql: (a) => `${a}.id IN (SELECT game_id FROM batch_games WHERE batch_id = ?)`,
      params: [scope.batchId],
    };
  if (scope.kind === 'mine')
    return {
      sql: (a) =>
        `EXISTS (SELECT 1 FROM game_players h WHERE h.game_id = ${a}.id AND h.controller_kind = 'human')`,
      params: [],
    };
  return { sql: () => '1 = 1', params: [] };
}

export interface DebugGameData {
  game: Row | null;
  events: Row[];
  debugEvents: Row[];
  aiCalls: Row[];
  manaMetrics: Row[];
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) || 0 : 0;
}

function jsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function rows(db: SqliteLike, sql: string, ...args: unknown[]): Row[] {
  return db.query(sql).all(...args) as Row[];
}

/** A stored `DecisionResponse`, narrowed to the two fields annotations are built from. */
function parseResponse(
  value: unknown,
): { note?: unknown; turnStrategy?: { intent?: unknown } } | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function first(db: SqliteLike, sql: string, ...args: unknown[]): Row | null {
  return (db.query(sql).get(...args) as Row | null) ?? null;
}

/**
 * A row that may count toward "Who beats me": the victim genuinely lost, not by decking, to a
 * different seat. Older rows recorded the last damaging seat for every player — winners,
 * survivors, decked players, and players hurt by their own spells — so the filter also keeps
 * that history honest without rewriting it (see `eliminatorFor` in `match/runner.ts`).
 */
const ATTRIBUTED_LOSS = `victim.loss_reason IS NOT NULL AND victim.loss_reason <> 'emptyLibraryDraw' AND victim.eliminated_by_seat IS NOT NULL AND victim.eliminated_by_seat <> victim.seat`;

/** Read-only repository; it deliberately works with the testable narrow SQLite interface. */
export class StatsRepository {
  constructor(private readonly db: SqliteLike) {}

  /** Per-deck statistics for one scope. A plain batch id keeps the old `?batchId=` call working. */
  deckStatistics(scope: StatsScope | string = { kind: 'all' }): DeckStatistic[] {
    const resolved: StatsScope =
      typeof scope === 'string' ? { kind: 'batch', batchId: scope } : scope;
    const where = scopeSql(resolved);
    // Selected-column order is the placeholder order: the `last_game_id` subquery comes first.
    const base = rows(
      this.db,
      `SELECT ds.id AS snapshot_id, COALESCE(d.name, ds.id) AS name, d.archetype_tag, d.source_type,
              ds.commander_names, ds.color_identity, COUNT(g.id) AS games_played,
              SUM(CASE WHEN g.id IS NOT NULL AND gp.finished_position = 1 THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN g.id IS NOT NULL AND gp.finished_position = 2 THEN 1 ELSE 0 END) AS second,
              SUM(CASE WHEN g.id IS NOT NULL AND gp.finished_position = 3 THEN 1 ELSE 0 END) AS third,
              SUM(CASE WHEN g.id IS NOT NULL AND gp.finished_position >= 4 THEN 1 ELSE 0 END) AS fourth,
              AVG(CASE WHEN g.id IS NOT NULL THEN gp.finished_position END) AS average_finish,
              AVG(g.turn_count) AS average_game_length,
              AVG(CASE WHEN g.id IS NOT NULL THEN gp.mulligans_taken END) AS average_mulligans,
              (SELECT g2.id FROM game_players gp2 JOIN games g2 ON g2.id = gp2.game_id
                WHERE gp2.deck_snapshot_id = ds.id AND g2.status = 'finished' AND ${where.sql('g2')}
                ORDER BY COALESCE(g2.ended_at, g2.started_at) DESC, g2.rowid DESC LIMIT 1) AS last_game_id
         FROM deck_snapshots ds
         JOIN decks d ON d.id = ds.deck_id
         LEFT JOIN game_players gp ON gp.deck_snapshot_id = ds.id
         LEFT JOIN games g ON g.id = gp.game_id AND g.status = 'finished' AND ${where.sql('g')}
        GROUP BY ds.id ${resolved.kind === 'all' ? '' : 'HAVING COUNT(g.id) > 0'}
        ORDER BY games_played DESC, name ASC`,
      ...where.params,
      ...where.params,
    );
    return base.map((row) => this.deckStatistic(row, where));
  }

  /** The batch a `scope=batch` request with no id means: the most recently created one. */
  latestBatchId(): string | null {
    const row = first(
      this.db,
      `SELECT id FROM batches ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    );
    return row === null ? null : String(row['id']);
  }

  /** Everything the Stats page shows, for one scope. */
  statsReport(request: { scope?: StatsScopeName; batchId?: string }): StatsReport {
    const scope: StatsScopeName =
      request.scope ?? (request.batchId === undefined ? 'all' : 'batch');
    const batchId = scope === 'batch' ? (request.batchId ?? this.latestBatchId()) : null;
    const resolved: StatsScope =
      scope === 'batch'
        ? { kind: 'batch', batchId: batchId ?? '' }
        : scope === 'mine'
          ? { kind: 'mine' }
          : { kind: 'all' };
    // No batch exists yet: there are no games to count, not "every game".
    const decks = scope === 'batch' && batchId === null ? [] : this.deckStatistics(resolved);
    const empty = scope === 'batch' && batchId === null;
    return {
      scope,
      batchId,
      decks,
      summary: empty ? emptySummary() : this.summary(resolved),
      matchups: empty ? [] : this.matchups(resolved),
    };
  }

  private summary(scope: StatsScope): StatsSummary {
    const where = scopeSql(scope);
    const totals = first(
      this.db,
      `SELECT COUNT(*) AS finished, AVG(g.turn_count) AS average_turns,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM game_players gp JOIN deck_snapshots ds ON ds.id = gp.deck_snapshot_id
                  JOIN decks d ON d.id = ds.deck_id
                 WHERE gp.game_id = g.id AND d.source_type = 'generated') THEN 1 ELSE 0 END) AS generated
         FROM games g WHERE g.status = 'finished' AND ${where.sql('g')}`,
      ...where.params,
    );
    const finishedGames = number(totals?.['finished']);
    const ends = rows(
      this.db,
      `SELECT gp.loss_reason AS reason, COUNT(*) AS count
         FROM game_players gp JOIN games g ON g.id = gp.game_id
        WHERE g.status = 'finished' AND gp.loss_reason IS NOT NULL AND ${where.sql('g')}
        GROUP BY gp.loss_reason ORDER BY count DESC, gp.loss_reason ASC`,
      ...where.params,
    );
    const totalEnds = ends.reduce((sum, row) => sum + number(row['count']), 0);
    const top = ends[0];
    const tracked = first(
      this.db,
      `SELECT COUNT(DISTINCT ds.id) AS decks
         FROM game_players gp JOIN games g ON g.id = gp.game_id
         JOIN deck_snapshots ds ON ds.id = gp.deck_snapshot_id JOIN decks d ON d.id = ds.deck_id
        WHERE g.status = 'finished' AND d.source_type <> 'generated' AND ${where.sql('g')}`,
      ...where.params,
    );
    return {
      finishedGames,
      generatedGames: number(totals?.['generated']),
      decksTracked: number(tracked?.['decks']),
      averageTurns:
        finishedGames === 0 || totals?.['average_turns'] === null
          ? null
          : number(totals?.['average_turns']),
      mostCommonEnd:
        top === undefined || totalEnds === 0
          ? null
          : {
              reason: String(top['reason']),
              label: lossReasonLabel(String(top['reason'])),
              share: number(top['count']) / totalEnds,
            },
    };
  }

  /** Finished games the winner (seat finishing first) took with each other deck at the table. */
  private matchups(scope: StatsScope): StatsMatchup[] {
    const where = scopeSql(scope);
    return rows(
      this.db,
      `SELECT w.deck_snapshot_id AS winner, l.deck_snapshot_id AS beaten, COUNT(*) AS games
         FROM games g
         JOIN game_players w ON w.game_id = g.id AND w.finished_position = 1
         JOIN game_players l ON l.game_id = g.id AND l.seat <> w.seat
        WHERE g.status = 'finished' AND w.deck_snapshot_id <> l.deck_snapshot_id AND ${where.sql('g')}
        GROUP BY w.deck_snapshot_id, l.deck_snapshot_id
        ORDER BY games DESC, winner ASC, beaten ASC`,
      ...where.params,
    ).map((row) => ({
      winner: String(row['winner']),
      beaten: String(row['beaten']),
      games: number(row['games']),
    }));
  }

  private deckStatistic(row: Row, where: ScopeSql): DeckStatistic {
    const snapshotId = String(row['snapshot_id']);
    const gamesPlayed = number(row['games_played']);
    const mana = this.manaRates(snapshotId);
    return {
      deckSnapshotId: snapshotId,
      name: String(row['name'] ?? snapshotId),
      generated: row['source_type'] === 'generated',
      commanders: jsonArray(row['commander_names']),
      colorIdentity: jsonArray(row['color_identity']),
      archetypeTag: String(row['archetype_tag'] ?? ''),
      gamesPlayed,
      wins: number(row['wins']),
      winRate: gamesPlayed === 0 ? 0 : number(row['wins']) / gamesPlayed,
      finishDistribution: [
        number(row['wins']),
        number(row['second']),
        number(row['third']),
        number(row['fourth']),
      ],
      lastGameId: typeof row['last_game_id'] === 'string' ? row['last_game_id'] : null,
      averageFinish: gamesPlayed === 0 ? null : number(row['average_finish']),
      averageGameLength: gamesPlayed === 0 ? null : number(row['average_game_length']),
      averageMulligans: gamesPlayed === 0 ? 0 : number(row['average_mulligans']),
      mulliganDistribution: rows(
        this.db,
        `SELECT gp.mulligans_taken AS mulligans, COUNT(*) AS games
           FROM game_players gp JOIN games g ON g.id = gp.game_id
          WHERE gp.deck_snapshot_id = ? AND g.status = 'finished' AND ${where.sql('g')}
          GROUP BY gp.mulligans_taken ORDER BY gp.mulligans_taken`,
        snapshotId,
        ...where.params,
      ).map((item) => ({ mulligans: number(item['mulligans']), games: number(item['games']) })),
      eliminationCauses: rows(
        this.db,
        `SELECT gp.loss_reason AS reason, COUNT(*) AS count
           FROM game_players gp JOIN games g ON g.id = gp.game_id
          WHERE gp.deck_snapshot_id = ? AND g.status = 'finished' AND gp.loss_reason IS NOT NULL
            AND ${where.sql('g')}
          GROUP BY gp.loss_reason`,
        snapshotId,
        ...where.params,
      ).map((item) => ({
        reason: String(item['reason']),
        label: lossReasonLabel(String(item['reason'])),
        count: number(item['count']),
      })),
      lossesTo: rows(
        this.db,
        `SELECT killer_ds.commander_names, killer_ds.color_identity, killer_d.archetype_tag, COUNT(*) AS count
           FROM game_players victim
           JOIN games g ON g.id = victim.game_id
           JOIN game_players killer ON killer.game_id = victim.game_id AND killer.seat = victim.eliminated_by_seat
           JOIN deck_snapshots killer_ds ON killer_ds.id = killer.deck_snapshot_id
           JOIN decks killer_d ON killer_d.id = killer_ds.deck_id
          WHERE victim.deck_snapshot_id = ? AND g.status = 'finished' AND ${ATTRIBUTED_LOSS}
            AND ${where.sql('g')}
          GROUP BY killer_ds.commander_names, killer_ds.color_identity, killer_d.archetype_tag`,
        snapshotId,
        ...where.params,
      ).map((item) => ({
        commanders: jsonArray(item['commander_names']),
        colorIdentity: jsonArray(item['color_identity']),
        archetypeTag: String(item['archetype_tag'] ?? ''),
        count: number(item['count']),
      })),
      manaFloodRate: mana.floodRate,
      manaDroughtRate: mana.droughtRate,
    };
  }

  private manaRates(
    _snapshotId: string,
    _batchId?: string,
  ): { floodRate: null; droughtRate: null } {
    // Legacy observations do not record actual affordability, the last five draws,
    // battlefield land counts, or the player's end-turn land drop. They cannot support
    // the advertised heuristic. Never present invented percentages from these rows.
    return { floodRate: null, droughtRate: null };
  }

  gameDebug(gameId: string): DebugGameData {
    return {
      game: first(this.db, `SELECT * FROM games WHERE id = ?`, gameId),
      events: rows(
        this.db,
        `SELECT * FROM game_events WHERE game_id = ? ORDER BY sequence`,
        gameId,
      ),
      debugEvents: rows(
        this.db,
        `SELECT * FROM game_debug_events WHERE game_id = ? ORDER BY sequence`,
        gameId,
      ),
      aiCalls: rows(this.db, `SELECT * FROM ai_calls WHERE game_id = ? ORDER BY sequence`, gameId),
      manaMetrics: rows(
        this.db,
        `SELECT * FROM mana_metrics WHERE game_id = ? ORDER BY seat, turn`,
        gameId,
      ),
    };
  }

  /**
   * Reasoning annotations for a finished game (ADR 0022), rebuilt from the AI calls that reached
   * a submitted decision. This is what makes reasoning survive a page reload â€” the live stream
   * delivers each note once, and nothing else persists it.
   */
  gameAnnotations(gameId: string): AiAnnotation[] {
    const calls = rows(
      this.db,
      `SELECT seat, model, source, turn, anchor_sequence, response_json
         FROM ai_calls
        WHERE game_id = ? AND anchor_sequence IS NOT NULL
        ORDER BY anchor_sequence`,
      gameId,
    );

    const annotations: AiAnnotation[] = [];
    for (const call of calls) {
      const parsed = parseResponse(call['response_json']);
      if (parsed === null) continue;
      const strategy = parsed.turnStrategy;
      // A strategist row carries its reasoning as the plan's standing intent; every other row
      // carries the per-decision note.
      const text =
        typeof strategy?.intent === 'string' && strategy.intent.length > 0
          ? strategy.intent
          : typeof parsed.note === 'string'
            ? parsed.note
            : '';
      if (text.trim().length === 0) continue;
      const model = call['model'];
      annotations.push({
        sequence: number(call['anchor_sequence']),
        turn: number(call['turn']),
        seat: `P${number(call['seat'])}`,
        kind: call['source'] === 'strategist' ? 'strategy' : 'decision',
        text,
        source: typeof call['source'] === 'string' ? call['source'] : 'primary',
        ...(typeof model === 'string' ? { model } : {}),
      });
    }
    return annotations;
  }

  /**
   * Post-game reviews for a finished game (ADR 0022 Â§7), so commentary survives a page reload and
   * a historical game can be read back. Ordered by seat, not by when the model happened to answer.
   */
  /** A game's table talk (ADR 0035), in the order it was said. */
  gameTableTalk(gameId: string): TableTalkLine[] {
    return rows(
      this.db,
      `SELECT sequence, turn, message_json, text
         FROM game_table_talk WHERE game_id = ? ORDER BY position`,
      gameId,
    ).map((row) => ({
      sequence: number(row['sequence']),
      turn: number(row['turn']),
      message: JSON.parse(String(row['message_json'])) as TableTalkLine['message'],
      text: String(row['text'] ?? ''),
    }));
  }

  gameReflections(gameId: string): AiReflection[] {
    const stored = rows(
      this.db,
      `SELECT seat, model, position, summary, detail_json
         FROM game_reflections WHERE game_id = ? ORDER BY seat`,
      gameId,
    );

    return stored.map((row) => {
      const detail = parseDetail(row['detail_json']);
      const model = row['model'];
      return {
        seat: `P${number(row['seat'])}`,
        position: number(row['position']),
        summary: String(row['summary'] ?? ''),
        keyMistakes: moments(detail.keyMistakes),
        keyPlays: moments(detail.keyPlays),
        threatRead: typeof detail.threatRead === 'string' ? detail.threatRead : '',
        model: typeof model === 'string' ? model : '',
      };
    });
  }
}

/** The JSON blob behind a stored reflection. Shape is not trusted â€” the row may predate a change. */
function parseDetail(value: unknown): {
  keyMistakes?: unknown;
  keyPlays?: unknown;
  threatRead?: unknown;
} {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function moments(value: unknown): ReflectionMoment[] {
  if (!Array.isArray(value)) return [];
  const result: ReflectionMoment[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as { turn?: unknown; what?: unknown; better?: unknown };
    if (typeof item.what !== 'string' || item.what.length === 0) continue;
    result.push({
      turn: number(item.turn),
      what: item.what,
      ...(typeof item.better === 'string' && item.better.length > 0 ? { better: item.better } : {}),
    });
  }
  return result;
}

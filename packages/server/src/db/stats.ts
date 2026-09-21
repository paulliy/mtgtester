/** Phase 5 read models: aggregate deck statistics and one-game debug/export payloads. */

import type { AiAnnotation, AiReflection, ReflectionMoment } from '@mtg/shared';
import type { SqliteLike } from './games';

type Row = Record<string, unknown>;

export interface DeckStatistic {
  deckSnapshotId: string;
  name: string;
  commanders: string[];
  colorIdentity: string[];
  archetypeTag: string;
  gamesPlayed: number;
  wins: number;
  winRate: number;
  averageFinish: number | null;
  averageGameLength: number | null;
  averageMulligans: number;
  mulliganDistribution: Array<{ mulligans: number; games: number }>;
  eliminationCauses: Array<{ reason: string; count: number }>;
  lossesTo: Array<{
    commanders: string[];
    colorIdentity: string[];
    archetypeTag: string;
    count: number;
  }>;
  manaFloodRate: number | null;
  manaDroughtRate: number | null;
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

/** Read-only repository; it deliberately works with the testable narrow SQLite interface. */
export class StatsRepository {
  constructor(private readonly db: SqliteLike) {}

  deckStatistics(batchId?: string): DeckStatistic[] {
    if (batchId !== undefined) return this.batchDeckStatistics(batchId);
    const base = rows(
      this.db,
      `SELECT ds.id AS snapshot_id, COALESCE(d.name, ds.id) AS name, d.archetype_tag,
              ds.commander_names, ds.color_identity, COUNT(g.id) AS games_played,
              SUM(CASE WHEN g.id IS NOT NULL AND gp.finished_position = 1 THEN 1 ELSE 0 END) AS wins,
              AVG(CASE WHEN g.id IS NOT NULL THEN gp.finished_position END) AS average_finish,
              AVG(g.turn_count) AS average_game_length,
              AVG(CASE WHEN g.id IS NOT NULL THEN gp.mulligans_taken END) AS average_mulligans
         FROM deck_snapshots ds
         JOIN decks d ON d.id = ds.deck_id
         LEFT JOIN game_players gp ON gp.deck_snapshot_id = ds.id
         LEFT JOIN games g ON g.id = gp.game_id AND g.status = 'finished'
        GROUP BY ds.id ORDER BY games_played DESC, name ASC`,
    );
    return base.map((row) => this.deckStatistic(row));
  }

  private batchDeckStatistics(batchId: string): DeckStatistic[] {
    const base = rows(
      this.db,
      `SELECT ds.id AS snapshot_id, COALESCE(d.name, ds.id) AS name, d.archetype_tag,
              ds.commander_names, ds.color_identity, COUNT(g.id) AS games_played,
              SUM(CASE WHEN gp.finished_position = 1 THEN 1 ELSE 0 END) AS wins,
              AVG(gp.finished_position) AS average_finish, AVG(g.turn_count) AS average_game_length,
              AVG(gp.mulligans_taken) AS average_mulligans
         FROM deck_snapshots ds JOIN decks d ON d.id = ds.deck_id
         JOIN game_players gp ON gp.deck_snapshot_id = ds.id
         JOIN games g ON g.id = gp.game_id AND g.status = 'finished'
         JOIN batch_games bg ON bg.game_id = g.id AND bg.batch_id = ?
        GROUP BY ds.id ORDER BY games_played DESC, name ASC`,
      batchId,
    );
    return base.map((row) => {
      const snapshotId = String(row['snapshot_id']);
      const gamesPlayed = number(row['games_played']);
      const mana = this.manaRates(snapshotId, batchId);
      return {
        deckSnapshotId: snapshotId,
        name: String(row['name'] ?? snapshotId),
        commanders: jsonArray(row['commander_names']),
        colorIdentity: jsonArray(row['color_identity']),
        archetypeTag: String(row['archetype_tag'] ?? ''),
        gamesPlayed,
        wins: number(row['wins']),
        winRate: gamesPlayed === 0 ? 0 : number(row['wins']) / gamesPlayed,
        averageFinish: gamesPlayed === 0 ? null : number(row['average_finish']),
        averageGameLength: gamesPlayed === 0 ? null : number(row['average_game_length']),
        averageMulligans: gamesPlayed === 0 ? 0 : number(row['average_mulligans']),
        mulliganDistribution: rows(
          this.db,
          `SELECT gp.mulligans_taken AS mulligans, COUNT(*) AS games FROM game_players gp JOIN games g ON g.id = gp.game_id JOIN batch_games bg ON bg.game_id = g.id AND bg.batch_id = ? WHERE gp.deck_snapshot_id = ? AND g.status = 'finished' GROUP BY gp.mulligans_taken ORDER BY gp.mulligans_taken`,
          batchId,
          snapshotId,
        ).map((item) => ({ mulligans: number(item['mulligans']), games: number(item['games']) })),
        eliminationCauses: rows(
          this.db,
          `SELECT gp.loss_reason AS reason, COUNT(*) AS count FROM game_players gp JOIN games g ON g.id = gp.game_id JOIN batch_games bg ON bg.game_id = g.id AND bg.batch_id = ? WHERE gp.deck_snapshot_id = ? AND g.status = 'finished' AND gp.loss_reason IS NOT NULL GROUP BY gp.loss_reason`,
          batchId,
          snapshotId,
        ).map((item) => ({ reason: String(item['reason']), count: number(item['count']) })),
        lossesTo: rows(
          this.db,
          `SELECT killer_ds.commander_names, killer_ds.color_identity, killer_d.archetype_tag, COUNT(*) AS count FROM game_players victim JOIN games g ON g.id = victim.game_id JOIN batch_games bg ON bg.game_id = g.id AND bg.batch_id = ? JOIN game_players killer ON killer.game_id = victim.game_id AND killer.seat = victim.eliminated_by_seat JOIN deck_snapshots killer_ds ON killer_ds.id = killer.deck_snapshot_id JOIN decks killer_d ON killer_d.id = killer_ds.deck_id WHERE victim.deck_snapshot_id = ? AND g.status = 'finished' AND victim.eliminated_by_seat IS NOT NULL GROUP BY killer_ds.commander_names, killer_ds.color_identity, killer_d.archetype_tag`,
          batchId,
          snapshotId,
        ).map((item) => ({
          commanders: jsonArray(item['commander_names']),
          colorIdentity: jsonArray(item['color_identity']),
          archetypeTag: String(item['archetype_tag'] ?? ''),
          count: number(item['count']),
        })),
        manaFloodRate: mana.floodRate,
        manaDroughtRate: mana.droughtRate,
      };
    });
  }
  private deckStatistic(row: Row): DeckStatistic {
    const snapshotId = String(row['snapshot_id']);
    const gamesPlayed = number(row['games_played']);
    const mana = this.manaRates(snapshotId);
    return {
      deckSnapshotId: snapshotId,
      name: String(row['name'] ?? snapshotId),
      commanders: jsonArray(row['commander_names']),
      colorIdentity: jsonArray(row['color_identity']),
      archetypeTag: String(row['archetype_tag'] ?? ''),
      gamesPlayed,
      wins: number(row['wins']),
      winRate: gamesPlayed === 0 ? 0 : number(row['wins']) / gamesPlayed,
      averageFinish: gamesPlayed === 0 ? null : number(row['average_finish']),
      averageGameLength: gamesPlayed === 0 ? null : number(row['average_game_length']),
      averageMulligans: gamesPlayed === 0 ? 0 : number(row['average_mulligans']),
      mulliganDistribution: rows(
        this.db,
        `SELECT mulligans_taken AS mulligans, COUNT(*) AS games FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE gp.deck_snapshot_id = ? AND g.status = 'finished' GROUP BY mulligans_taken ORDER BY mulligans_taken`,
        snapshotId,
      ).map((item) => ({ mulligans: number(item['mulligans']), games: number(item['games']) })),
      eliminationCauses: rows(
        this.db,
        `SELECT loss_reason AS reason, COUNT(*) AS count FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE gp.deck_snapshot_id = ? AND g.status = 'finished' AND loss_reason IS NOT NULL GROUP BY loss_reason`,
        snapshotId,
      ).map((item) => ({ reason: String(item['reason']), count: number(item['count']) })),
      lossesTo: rows(
        this.db,
        `SELECT killer_ds.commander_names, killer_ds.color_identity, killer_d.archetype_tag, COUNT(*) AS count
           FROM game_players victim
           JOIN games g ON g.id = victim.game_id
           JOIN game_players killer ON killer.game_id = victim.game_id AND killer.seat = victim.eliminated_by_seat
           JOIN deck_snapshots killer_ds ON killer_ds.id = killer.deck_snapshot_id
           JOIN decks killer_d ON killer_d.id = killer_ds.deck_id
          WHERE victim.deck_snapshot_id = ? AND g.status = 'finished' AND victim.eliminated_by_seat IS NOT NULL
          GROUP BY killer_ds.commander_names, killer_ds.color_identity, killer_d.archetype_tag`,
        snapshotId,
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

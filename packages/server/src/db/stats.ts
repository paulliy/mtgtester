/** Phase 5 read models: aggregate deck statistics and one-game debug/export payloads. */

import { MANA_METRICS } from '../config/mana-metrics';
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
  lossesTo: Array<{ commanders: string[]; colorIdentity: string[]; archetypeTag: string; count: number }>;
  manaFloodRate: number;
  manaDroughtRate: number;
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

function first(db: SqliteLike, sql: string, ...args: unknown[]): Row | null {
  return (db.query(sql).get(...args) as Row | null) ?? null;
}

/** Read-only repository; it deliberately works with the testable narrow SQLite interface. */
export class StatsRepository {
  constructor(private readonly db: SqliteLike) {}

  deckStatistics(): DeckStatistic[] {
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
      mulliganDistribution: rows(this.db,
        `SELECT mulligans_taken AS mulligans, COUNT(*) AS games FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE gp.deck_snapshot_id = ? AND g.status = 'finished' GROUP BY mulligans_taken ORDER BY mulligans_taken`, snapshotId)
        .map((item) => ({ mulligans: number(item['mulligans']), games: number(item['games']) })),
      eliminationCauses: rows(this.db,
        `SELECT loss_reason AS reason, COUNT(*) AS count FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE gp.deck_snapshot_id = ? AND g.status = 'finished' AND loss_reason IS NOT NULL GROUP BY loss_reason`, snapshotId)
        .map((item) => ({ reason: String(item['reason']), count: number(item['count']) })),
      lossesTo: rows(this.db,
        `SELECT killer_ds.commander_names, killer_ds.color_identity, killer_d.archetype_tag, COUNT(*) AS count
           FROM game_players victim
           JOIN games g ON g.id = victim.game_id
           JOIN game_players killer ON killer.game_id = victim.game_id AND killer.seat = victim.eliminated_by_seat
           JOIN deck_snapshots killer_ds ON killer_ds.id = killer.deck_snapshot_id
           JOIN decks killer_d ON killer_d.id = killer_ds.deck_id
          WHERE victim.deck_snapshot_id = ? AND g.status = 'finished' AND victim.eliminated_by_seat IS NOT NULL
          GROUP BY killer_ds.commander_names, killer_ds.color_identity, killer_d.archetype_tag`, snapshotId)
        .map((item) => ({ commanders: jsonArray(item['commander_names']), colorIdentity: jsonArray(item['color_identity']),
          archetypeTag: String(item['archetype_tag'] ?? ''), count: number(item['count']) })),
      manaFloodRate: mana.floodRate,
      manaDroughtRate: mana.droughtRate,
    };
  }

  private manaRates(snapshotId: string): { floodRate: number; droughtRate: number } {
    const metrics = rows(this.db,
      `SELECT mm.game_id, mm.seat, mm.turn, mm.lands_in_hand, mm.lands_drawn_cumulative,
              mm.cards_drawn_cumulative, mm.spells_castable, mm.unspent_mana, mm.on_curve
         FROM mana_metrics mm JOIN game_players gp ON gp.game_id = mm.game_id AND gp.seat = mm.seat
         JOIN games g ON g.id = mm.game_id WHERE gp.deck_snapshot_id = ? AND g.status = 'finished'
         ORDER BY mm.game_id, mm.seat, mm.turn`, snapshotId);
    const games = new Map<string, Row[]>();
    for (const metric of metrics) {
      const key = `${metric['game_id']}:${metric['seat']}`;
      const list = games.get(key) ?? [];
      list.push(metric);
      games.set(key, list);
    }
    let flooded = 0;
    let drought = 0;
    for (const game of games.values()) {
      let floodTurns = 0;
      let droughtTurns = 0;
      for (let i = 0; i < game.length; i++) {
        const current = game[i] as Row;
        const start = Math.max(0, i - MANA_METRICS.trailingDraws + 1);
        const firstMetric = game[start] as Row;
        const landDraws = number(current['lands_drawn_cumulative']) - number(firstMetric['lands_drawn_cumulative']);
        const draws = number(current['cards_drawn_cumulative']) - number(firstMetric['cards_drawn_cumulative']);
        const floodedNow = draws >= MANA_METRICS.trailingDraws && landDraws >= MANA_METRICS.floodedLandDraws &&
          number(current['unspent_mana']) >= MANA_METRICS.floodedUnspentMana && number(current['spells_castable']) === 0;
        const missedLand = number(current['on_curve']) === 0;
        const droughtNow = missedLand && (number(current['spells_castable']) >= MANA_METRICS.droughtUncastableCards ||
          number(current['lands_in_hand']) < Math.max(0, number(current['turn']) - MANA_METRICS.expectedLandLag));
        if (floodedNow) floodTurns += 1;
        if (droughtNow) droughtTurns += 1;
      }
      if (floodTurns >= MANA_METRICS.affectedTurns) flooded += 1;
      if (droughtTurns >= MANA_METRICS.affectedTurns) drought += 1;
    }
    const total = games.size;
    return { floodRate: total === 0 ? 0 : flooded / total, droughtRate: total === 0 ? 0 : drought / total };
  }

  gameDebug(gameId: string): DebugGameData {
    return {
      game: first(this.db, `SELECT * FROM games WHERE id = ?`, gameId),
      events: rows(this.db, `SELECT * FROM game_events WHERE game_id = ? ORDER BY sequence`, gameId),
      debugEvents: rows(this.db, `SELECT * FROM game_debug_events WHERE game_id = ? ORDER BY sequence`, gameId),
      aiCalls: rows(this.db, `SELECT * FROM ai_calls WHERE game_id = ? ORDER BY sequence`, gameId),
      manaMetrics: rows(this.db, `SELECT * FROM mana_metrics WHERE game_id = ? ORDER BY seat, turn`, gameId),
    };
  }
}

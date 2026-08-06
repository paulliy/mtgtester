/**
 * SQLite access via `bun:sqlite` (brief §9). This module is the only place that touches the
 * database. It runs under the Bun runtime (the server/CLI); pure logic that unit tests exercise
 * lives elsewhere so tests need no database. The DB file lives under `data/` (gitignored).
 */

import { Database } from 'bun:sqlite';
import type { DeckCardEntry, DeckSnapshot, DeckSourceType, OracleCard } from '@mtg/shared';
import { GameRecorder, type SqliteLike } from './games';
import { BatchRepository } from './batches';
import { StatsRepository } from './stats';
import { MIGRATIONS_SQL, SCHEMA_SQL } from './schema';

/** Where a deck's archetype tag came from (ADR 0022 §6). Only `manual` is safe from a backfill. */
export type ArchetypeSource = 'manual' | 'default' | 'heuristic' | 'inferred';

export interface DeckRow {
  id: string;
  name: string | null;
  sourceUrl: string | null;
  sourceType: DeckSourceType;
  archetypeTag: string;
  archetypeSource: ArchetypeSource;
  createdAt: string;
}

export class GameStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(SCHEMA_SQL);
    for (const statement of MIGRATIONS_SQL) {
      // Already-applied migrations throw "duplicate column name"; that is the success case
      // on an up-to-date database, so it is not distinguishable from a no-op and not an error.
      try {
        this.db.exec(statement);
      } catch {
        // no-op
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Persist resolved cards into the card cache (§3). Idempotent — re-imports refresh the row. */
  cacheCards(cards: OracleCard[]): void {
    const stmt = this.db.query(
      `INSERT INTO card_cache (oracle_id, name, data_json) VALUES ($id, $name, $json)
       ON CONFLICT(oracle_id) DO UPDATE SET name = $name, data_json = $json`,
    );
    const tx = this.db.transaction((batch: OracleCard[]) => {
      for (const card of batch) {
        stmt.run({ $id: card.oracleId, $name: card.name, $json: JSON.stringify(card) });
      }
    });
    tx(cards);
  }

  getCard(oracleId: string): OracleCard | null {
    const row = this.db
      .query<{ data_json: string }, [string]>(
        `SELECT data_json FROM card_cache WHERE oracle_id = ?`,
      )
      .get(oracleId);
    return row ? (JSON.parse(row.data_json) as OracleCard) : null;
  }

  /** Insert a deck identity row and return it. `archetypeTag` is already defaulted by the caller. */
  insertDeck(deck: {
    name: string | null;
    sourceUrl: string | null;
    sourceType: DeckSourceType;
    archetypeTag: string;
    /** Defaults to `manual` — the safest assumption, since it is the one a backfill won't touch. */
    archetypeSource?: ArchetypeSource;
    /** The feature vector behind a computed tag; null for a manually-entered one. */
    archetypeFeatures?: unknown;
  }): DeckRow {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const archetypeSource = deck.archetypeSource ?? 'manual';
    this.db
      .query(
        `INSERT INTO decks
           (id, name, source_url, source_type, archetype_tag, created_at,
            archetype_source, archetype_features_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        deck.name,
        deck.sourceUrl,
        deck.sourceType,
        deck.archetypeTag,
        createdAt,
        archetypeSource,
        deck.archetypeFeatures === undefined ? null : JSON.stringify(deck.archetypeFeatures),
      );
    return {
      id,
      createdAt,
      name: deck.name,
      sourceUrl: deck.sourceUrl,
      sourceType: deck.sourceType,
      archetypeTag: deck.archetypeTag,
      archetypeSource,
    };
  }

  /**
   * Insert an immutable snapshot (§8.2). Re-importing the same deck creates a *new* snapshot row
   * rather than mutating an existing one, so historical stats never shift.
   */
  insertSnapshot(snapshot: Omit<DeckSnapshot, 'id' | 'importedAt'>): DeckSnapshot {
    const id = crypto.randomUUID();
    const importedAt = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO deck_snapshots
           (id, deck_id, commander_names, color_identity, card_list_json, imported_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        snapshot.deckId,
        JSON.stringify(snapshot.commanderNames),
        JSON.stringify(snapshot.colorIdentity),
        JSON.stringify(snapshot.cards),
        importedAt,
      );
    return { ...snapshot, id, importedAt };
  }

  /**
   * The card list of an immutable snapshot (brief §8.2). Phase 4's setup path needs it to seat
   * an imported deck: the pipeline returns names and a snapshot id, the engine needs cards.
   */
  snapshotCards(snapshotId: string): DeckCardEntry[] | null {
    const row = this.db
      .query<{ card_list_json: string }, [string]>(
        `SELECT card_list_json FROM deck_snapshots WHERE id = ?`,
      )
      .get(snapshotId);
    return row ? (JSON.parse(row.card_list_json) as DeckCardEntry[]) : null;
  }

  // --- Phase 4: game recording (brief §9, ADR 0012) -----------------------------------------

  /**
   * A recorder bound to one game id. The SQL lives in `./games` behind a narrow interface so
   * it is testable without `bun:sqlite`, which the Vitest runner cannot load.
   */
  recorderFor(gameId: string): GameRecorder {
    return new GameRecorder(this.db as unknown as SqliteLike, gameId);
  }

  /** Phase 5's read-only aggregate/debug query surface. */
  stats(): StatsRepository {
    return new StatsRepository(this.db as unknown as SqliteLike);
  }

  batches(): BatchRepository {
    return new BatchRepository(this.db as unknown as SqliteLike);
  }

  /** The raw `bun:sqlite` handle, for `AiCallLogger` (brief §9 `ai_calls`). */
  get raw(): Database {
    return this.db;
  }
}

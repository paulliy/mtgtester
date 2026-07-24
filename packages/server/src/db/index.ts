/**
 * SQLite access via `bun:sqlite` (brief §9). This module is the only place that touches the
 * database. It runs under the Bun runtime (the server/CLI); pure logic that unit tests exercise
 * lives elsewhere so tests need no database. The DB file lives under `data/` (gitignored).
 */

import { Database } from 'bun:sqlite';
import type { DeckSnapshot, DeckSourceType, OracleCard } from '@mtg/shared';
import { SCHEMA_SQL } from './schema';

export interface DeckRow {
  id: string;
  name: string | null;
  sourceUrl: string | null;
  sourceType: DeckSourceType;
  archetypeTag: string;
  createdAt: string;
}

export class GameStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(SCHEMA_SQL);
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
  }): DeckRow {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO decks (id, name, source_url, source_type, archetype_tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, deck.name, deck.sourceUrl, deck.sourceType, deck.archetypeTag, createdAt);
    return { id, createdAt, ...deck };
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
}

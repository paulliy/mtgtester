/**
 * The table server's own records (ADR 0031 decision 6, plan M3 task 3): approved decklists under
 * table-scoped ids, and one private manifest per start attempt. Both live in the table database,
 * outside the served directory, and neither is ever sent to a live player.
 *
 * A manifest is written before the worker starts, so a worker that dies before it creates its
 * `games` row still leaves a readable record of what was approved and which key was drawn. The
 * end of an attempt is one transaction: the attempt's status and, for an interruption, the game
 * row moved from `running` to `halted`. A game row that already holds a committed outcome keeps
 * it: a result that raced the worker's death wins.
 */

import type { PlayerId } from '@mtg/shared';
import type { SqliteLike } from './games';

/** How an attempt ended. `starting` until it does. */
export type TableAttemptStatus =
  'starting' | 'rejected' | 'finished' | 'setupFailed' | 'workerFailure' | 'hostAbandoned';

/** The interruptions that close a still-running game row as a halt. */
const INTERRUPTIONS: ReadonlySet<TableAttemptStatus> = new Set([
  'setupFailed',
  'workerFailure',
  'hostAbandoned',
]);

export interface TableAttemptManifest {
  tableId: string;
  attemptId: string;
  gameId: string;
  /** Kept private until the game is over. */
  rngKey: string;
  seats: Array<
    | { seat: PlayerId; controller: 'human'; displayName: string; decklist: string }
    | { seat: PlayerId; controller: 'bot' }
  >;
  limits: { maxStepWork: number; maxObjects: number; turnCap: number | null };
  /** Who played the bot seats. Absent on attempts recorded before Claude bots existed. */
  bots?: 'builtin' | 'claude';
  identity: {
    cardDataSha256: string | null;
    buildCommit: string | null;
    buildDirty: boolean | null;
  };
}

export interface TableAttemptRow {
  manifest: TableAttemptManifest;
  status: TableAttemptStatus;
  createdAt: string;
  endedAt: string | null;
}

/** One seat's deck as the post-game view lists it. */
export interface TableGameDeck {
  seat: PlayerId;
  commanderNames: string[];
  cards: Array<{ name: string; quantity: number }>;
}

type Row = Record<string, unknown>;

const seatNumber = (seat: PlayerId): number => Number(seat.slice(1));

export class TableRepository {
  constructor(private readonly db: SqliteLike) {}

  /** Store a deck the host approved; returns its table-scoped id. */
  saveApprovedDeck(input: {
    tableId: string;
    seat: PlayerId;
    displayName: string;
    decklist: string;
  }): string {
    const id = `${input.tableId}:${crypto.randomUUID()}`;
    this.db
      .query(
        `INSERT INTO table_decks (id, table_id, seat, display_name, decklist, approved_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tableId,
        seatNumber(input.seat),
        input.displayName,
        input.decklist,
        new Date().toISOString(),
      );
    return id;
  }

  /** Write the manifest before the worker starts. An attempt id is written once. */
  beginAttempt(manifest: TableAttemptManifest): void {
    this.db
      .query(
        `INSERT INTO table_attempts
           (attempt_id, table_id, game_id, manifest_json, status, created_at)
         VALUES (?, ?, ?, ?, 'starting', ?)`,
      )
      .run(
        manifest.attemptId,
        manifest.tableId,
        manifest.gameId,
        JSON.stringify(manifest),
        new Date().toISOString(),
      );
  }

  /**
   * Close an attempt, once: a second call leaves the first status in place. For an interruption
   * the game row, if the worker created one and it is still `running`, becomes a `halted` row,
   * in the same transaction.
   */
  endAttempt(attemptId: string, status: Exclude<TableAttemptStatus, 'starting'>): void {
    const write = (): void => {
      const row = this.db
        .query(`SELECT game_id, status FROM table_attempts WHERE attempt_id = ?`)
        .get(attemptId) as Row | null | undefined;
      if (row === null || row === undefined || row['status'] !== 'starting') return;
      this.db
        .query(`UPDATE table_attempts SET status = ?, ended_at = ? WHERE attempt_id = ?`)
        .run(status, new Date().toISOString(), attemptId);
      if (INTERRUPTIONS.has(status)) {
        this.db
          .query(
            `UPDATE games SET status = 'halted', ended_at = ? WHERE id = ? AND status = 'running'`,
          )
          .run(new Date().toISOString(), row['game_id']);
      }
    };
    if (this.db.transaction !== undefined) this.db.transaction(write)();
    else write();
  }

  attempt(attemptId: string): TableAttemptRow | null {
    const row = this.db
      .query(
        `SELECT manifest_json, status, created_at, ended_at FROM table_attempts WHERE attempt_id = ?`,
      )
      .get(attemptId) as Row | null | undefined;
    if (row === null || row === undefined) return null;
    return {
      manifest: JSON.parse(String(row['manifest_json'])) as TableAttemptManifest,
      status: row['status'] as TableAttemptStatus,
      createdAt: String(row['created_at']),
      endedAt: typeof row['ended_at'] === 'string' ? row['ended_at'] : null,
    };
  }

  /** Whether the worker got as far as creating the game's row. */
  gameExists(gameId: string): boolean {
    const row = this.db.query(`SELECT 1 AS present FROM games WHERE id = ?`).get(gameId);
    return row !== null && row !== undefined;
  }

  /** Every seat's deck as the game stored it (bots' generated decks included). */
  gameDecks(gameId: string): TableGameDeck[] {
    const rows = this.db
      .query(
        `SELECT p.seat AS seat, s.commander_names AS commander_names, s.card_list_json AS cards
           FROM game_players p JOIN deck_snapshots s ON s.id = p.deck_snapshot_id
          WHERE p.game_id = ? ORDER BY p.seat ASC`,
      )
      .all(gameId) as Row[];
    return rows.map((row) => ({
      seat: `P${String(row['seat'])}`,
      commanderNames: JSON.parse(String(row['commander_names'])) as string[],
      cards: (JSON.parse(String(row['cards'])) as Array<{ name: string; quantity: number }>).map(
        (card) => ({ name: card.name, quantity: card.quantity }),
      ),
    }));
  }
}

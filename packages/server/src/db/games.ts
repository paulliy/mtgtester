/**
 * Game persistence (brief §9): `games`, `game_players`, `game_events`, `game_state_snapshots`.
 *
 * These four tables were created in Phase 1 carrying `TODO(phase-2)` markers and never written
 * — Phase 2 shipped as a CLI that prints a result and exits, so nothing noticed. The timeline
 * scrubber cannot be built on top of nothing (brief §10.1 requires that every past turn state
 * and the complete action log be persisted), so Phase 4 writes them. See ADR 0012 §2.
 *
 * The logic lives here, behind a minimal `SqliteLike` interface rather than inside `GameStore`,
 * for the same reason `AiCallLogger` does: `bun:sqlite` cannot be imported under the Vitest
 * runner, and this code is worth testing.
 */

import type {
  AiReflection,
  GameEvent,
  GameMode,
  GameResult,
  PlayerId,
  SeatControllerKind,
  SpectatorState,
  TableTalkLine,
} from '@mtg/shared';
import type { DebugEntry } from '@mtg/engine';

/** The slice of `bun:sqlite`'s `Database` this module uses. */
export interface SqliteLike {
  query(sql: string): {
    run(...args: unknown[]): void;
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  transaction?<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void;
}

/** Status of a game row. `halted` is brief §4's "probable rules bug" state, not a loss. */
export type GameStatus = 'running' | 'finished' | 'halted' | 'abandoned';

export interface GameSeatRecord {
  seat: PlayerId;
  deckSnapshotId: string;
  controllerKind?: SeatControllerKind;
}

export interface GameRow {
  id: string;
  seed: string;
  startedAt: string | null;
  endedAt: string | null;
  turnCount: number | null;
  winnerSeat: string | null;
  status: GameStatus | null;
  gameMode?: GameMode | null;
}

/** Raw inputs retained so mana thresholds can be adjusted without replaying games. */
export interface ManaMetricRecord {
  seat: PlayerId;
  turn: number;
  landsInHand: number;
  landsDrawnCumulative: number;
  cardsDrawnCumulative: number;
  spellsCastable: number;
  unspentMana: number;
  onCurve: boolean;
}

/**
 * Seat index for the `game_players` / `ai_calls` integer `seat` column. Seats are `"P1"`…`"P4"`
 * everywhere else; this is the one place the string form has to become a number.
 */
export function seatIndex(seat: PlayerId): number {
  const match = /^P(\d+)$/i.exec(seat);
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : 0;
}

export class GameRecorder {
  private debugSequence = 0;
  constructor(
    private readonly db: SqliteLike,
    readonly gameId: string,
  ) {}

  /** Open a game row and its four seats. Called once, before the first turn. */
  start(seed: string, seats: readonly GameSeatRecord[], gameMode: GameMode = 'spectator'): void {
    const insert = () => {
      this.db
        .query(`INSERT INTO games (id, seed, started_at, status, game_mode) VALUES (?, ?, ?, ?, ?)`)
        .run(this.gameId, seed, new Date().toISOString(), 'running' satisfies GameStatus, gameMode);
      for (const seat of seats) {
        this.db
          .query(
            `INSERT INTO game_players (game_id, seat, deck_snapshot_id, controller_kind)
             VALUES (?, ?, ?, ?)`,
          )
          .run(this.gameId, seatIndex(seat.seat), seat.deckSnapshotId, seat.controllerKind ?? 'ai');
      }
    };
    if (this.db.transaction !== undefined) this.db.transaction(insert)();
    else insert();
  }

  /**
   * Append events. `GameEvent.sequence` is the primary key, so re-appending an already-written
   * event is a no-op rather than a constraint failure — the runner flushes on a cursor and a
   * replayed flush must not corrupt the log.
   */
  appendEvents(events: readonly GameEvent[]): void {
    if (events.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO game_events
         (game_id, sequence, turn, phase, step, actor_seat, event_type, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id, sequence) DO NOTHING`,
    );
    const write = (): void => {
      for (const event of events) {
        stmt.run(
          this.gameId,
          event.sequence,
          event.turn,
          event.phase,
          event.step,
          event.actorSeat === null ? null : seatIndex(event.actorSeat),
          event.type,
          JSON.stringify(event.payload),
        );
      }
    };
    if (this.db.transaction !== undefined) this.db.transaction(write)();
    else write();
  }

  appendDebug(entries: readonly DebugEntry[]): void {
    if (entries.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO game_debug_events (game_id, sequence, turn, category, message, data_json)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(game_id, sequence) DO NOTHING`,
    );
    const write = (): void => {
      for (const entry of entries) {
        this.debugSequence += 1;
        stmt.run(
          this.gameId,
          this.debugSequence,
          entry.turn,
          entry.category,
          entry.message,
          entry.data === undefined ? null : JSON.stringify(entry.data),
        );
      }
    };
    if (this.db.transaction !== undefined) this.db.transaction(write)();
    else write();
  }

  saveManaMetrics(records: readonly ManaMetricRecord[]): void {
    if (records.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO mana_metrics (game_id, seat, turn, lands_in_hand, lands_drawn_cumulative,
        cards_drawn_cumulative, spells_castable, unspent_mana, on_curve) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_id, seat, turn) DO UPDATE SET lands_in_hand = excluded.lands_in_hand,
        lands_drawn_cumulative = excluded.lands_drawn_cumulative, cards_drawn_cumulative = excluded.cards_drawn_cumulative,
        spells_castable = excluded.spells_castable, unspent_mana = excluded.unspent_mana, on_curve = excluded.on_curve`,
    );
    const write = (): void => {
      for (const record of records) {
        stmt.run(
          this.gameId,
          seatIndex(record.seat),
          record.turn,
          record.landsInHand,
          record.landsDrawnCumulative,
          record.cardsDrawnCumulative,
          record.spellsCastable,
          record.unspentMana,
          record.onCurve ? 1 : 0,
        );
      }
    };
    if (this.db.transaction !== undefined) this.db.transaction(write)();
    else write();
  }

  /**
   * Persist one turn's board. The value stored is the **`SpectatorState` projection**, not
   * `GameState`: this row exists to redraw a past board, never to resume a game from it, and a
   * raw state would carry four full library orderings (ADR 0012 §2).
   */
  saveTurnSnapshot(turn: number, state: SpectatorState): void {
    this.db
      .query(
        `INSERT INTO game_state_snapshots (game_id, turn, state_json) VALUES (?, ?, ?)
         ON CONFLICT(game_id, turn) DO UPDATE SET state_json = excluded.state_json`,
      )
      .run(this.gameId, turn, JSON.stringify(state));
  }

  loadTurnSnapshot(turn: number): SpectatorState | null {
    const row = this.db
      .query(`SELECT state_json FROM game_state_snapshots WHERE game_id = ? AND turn = ?`)
      .get(this.gameId, turn) as { state_json?: string } | undefined | null;
    return row?.state_json === undefined ? null : (JSON.parse(row.state_json) as SpectatorState);
  }

  /** Turns that have a snapshot, ascending — the scrubber's seekable positions. */
  snapshotTurns(): number[] {
    const rows = this.db
      .query(`SELECT turn FROM game_state_snapshots WHERE game_id = ? ORDER BY turn ASC`)
      .all(this.gameId) as Array<{ turn: number }>;
    return rows.map((r) => r.turn);
  }

  loadEvents(fromSequence = 0): GameEvent[] {
    const rows = this.db
      .query(
        `SELECT sequence, turn, phase, step, actor_seat, event_type, payload_json
           FROM game_events WHERE game_id = ? AND sequence >= ? ORDER BY sequence ASC`,
      )
      .all(this.gameId, fromSequence) as Array<{
      sequence: number;
      turn: number;
      phase: string;
      step: string | null;
      actor_seat: number | null;
      event_type: string;
      payload_json: string;
    }>;
    return rows.map((r) => ({
      sequence: r.sequence,
      turn: r.turn,
      phase: r.phase as GameEvent['phase'],
      step: r.step as GameEvent['step'],
      actorSeat: r.actor_seat === null ? null : `P${r.actor_seat}`,
      type: r.event_type,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
  }

  /**
   * Append table talk (ADR 0031) after the lines already stored for this game. Positions continue
   * from the stored count, so a resumed session appends rather than overwrites.
   */
  saveTableTalk(lines: readonly TableTalkLine[]): void {
    if (lines.length === 0) return;
    const insert = () => {
      const row = this.db
        .query(`SELECT COUNT(*) AS n FROM game_table_talk WHERE game_id = ?`)
        .get(this.gameId) as { n: number } | null;
      let position = row?.n ?? 0;
      for (const line of lines) {
        this.db
          .query(
            `INSERT INTO game_table_talk (game_id, position, sequence, turn, message_json, text)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.gameId,
            position++,
            line.sequence,
            line.turn,
            JSON.stringify(line.message),
            line.text,
          );
      }
    };
    if (this.db.transaction !== undefined) this.db.transaction(insert)();
    else insert();
  }

  /**
   * Persist one seat's post-game review (ADR 0022 §7). Upserts, so a seat that somehow reflects
   * twice leaves one row rather than a constraint failure — this runs after the game is over and
   * must never throw into a results screen.
   */
  saveReflection(reflection: AiReflection): void {
    this.db
      .query(
        `INSERT INTO game_reflections
           (game_id, seat, model, position, summary, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id, seat) DO UPDATE SET
           model = excluded.model, position = excluded.position,
           summary = excluded.summary, detail_json = excluded.detail_json,
           created_at = excluded.created_at`,
      )
      .run(
        this.gameId,
        seatIndex(reflection.seat),
        reflection.model,
        reflection.position,
        reflection.summary,
        JSON.stringify({
          keyMistakes: reflection.keyMistakes,
          keyPlays: reflection.keyPlays,
          threatRead: reflection.threatRead,
        }),
        new Date().toISOString(),
      );
  }

  /**
   * Move the game row's status without touching per-seat outcomes. Used when a match halts or
   * is abandoned before the engine produced a `GameResult` at all — the row must not be left
   * reading `running` forever.
   */
  markStatus(status: GameStatus): void {
    this.db
      .query(`UPDATE games SET status = ?, ended_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), this.gameId);
  }

  /** Close the game row and fill in per-seat outcomes. See `finishingPositions` for ranking. */
  finish(
    result: GameResult,
    status: GameStatus,
    seatOutcomes: ReadonlyArray<{
      seat: PlayerId;
      lossReason: string | null;
      eliminatedOnTurn: number | null;
      eliminatedBySeat: PlayerId | null;
      mulligansTaken: number;
      openingHandSize: number;
    }>,
  ): void {
    this.db
      .query(
        `UPDATE games SET ended_at = ?, turn_count = ?, winner_seat = ?, status = ? WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        result.turnCount,
        result.winnerSeat === null ? null : seatIndex(result.winnerSeat),
        status,
        this.gameId,
      );

    const positions = finishingPositions(result.finishingOrder, seatOutcomes.length);
    for (const outcome of seatOutcomes) {
      this.db
        .query(
          `UPDATE game_players
              SET finished_position = ?, eliminated_on_turn = ?, loss_reason = ?,
                  eliminated_by_seat = ?, mulligans_taken = ?, opening_hand_size = ?
            WHERE game_id = ? AND seat = ?`,
        )
        .run(
          positions.get(outcome.seat) ?? null,
          outcome.eliminatedOnTurn,
          outcome.lossReason,
          outcome.eliminatedBySeat === null ? null : seatIndex(outcome.eliminatedBySeat),
          outcome.mulligansTaken,
          outcome.openingHandSize,
          this.gameId,
          seatIndex(outcome.seat),
        );
    }
  }
}

/**
 * Map `GameResult.finishingOrder` to 1-based finishing positions. The engine builds that array
 * as `[...eliminatedPlayers, winner]` (`flow/game.ts`), so element 0 is the *first* player
 * knocked out and therefore finishes **last**: position `seatCount - index`.
 *
 * `seatCount` — not the array length — is what the formula divides against, because a halted
 * game has no winner appended and may have survivors. Those survivors are correctly absent
 * from the map: they did not finish, and recording them as tied for first would invent a
 * result the game never produced (brief §4 — a halt is a probable rules bug, not an outcome).
 */
export function finishingPositions(
  finishingOrder: readonly PlayerId[],
  seatCount: number,
): Map<PlayerId, number> {
  const positions = new Map<PlayerId, number>();
  finishingOrder.forEach((seat, index) => {
    positions.set(seat, seatCount - index);
  });
  return positions;
}

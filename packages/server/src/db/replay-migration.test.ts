import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/**
 * The replay columns and `game_decision_sources` (ADR 0031 decision 8) are additive: a database
 * created before them opens, keeps its games, and gains the columns as null. Run against real
 * SQLite, because the migration list swallows "duplicate column" errors and only a real database
 * can say whether each statement did what it was written to do.
 */
it('adds the replay columns and the decision-source table to an existing database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-replay-migration-'));
  try {
    // Vitest runs under Node; run the native Bun SQLite adapter against a real file.
    const result = execFileSync(
      'bun',
      [
        '-e',
        `
    import { Database } from 'bun:sqlite';
    import { GameStore } from './packages/server/src/db/index.ts';
    const path = process.argv[1];
    const columns = (db, table) => db.query('PRAGMA table_info(' + table + ')').all().map((c) => c.name);

    // A database as it was before this change: the old games table, with a finished game in it.
    const old = new Database(path);
    old.exec(\`CREATE TABLE games (
      id TEXT PRIMARY KEY, seed TEXT NOT NULL, started_at TEXT, ended_at TEXT, turn_count INTEGER,
      winner_seat INTEGER, status TEXT, game_mode TEXT NOT NULL DEFAULT 'spectator')\`);
    old.query("INSERT INTO games (id, seed, status, turn_count) VALUES ('old-game', 'old-seed', 'finished', 12)").run();
    const before = columns(old, 'games');
    old.close();

    // Opening it runs the schema and the migrations; opening it again must change nothing.
    new GameStore(path).close();
    const store = new GameStore(path);
    store.close();

    const db = new Database(path);
    const after = columns(db, 'games');
    const oldRow = db.query("SELECT * FROM games WHERE id = 'old-game'").get();
    const sourcesTable = columns(db, 'game_decision_sources');
    db.close();

    // The recorder writes and reads the new columns on that same migrated database.
    const reopened = new GameStore(path);
    const recorder = reopened.recorderFor('new-game');
    const config = {
      schemaVersion: 1, cardDataSha256: 'sha', turnCap: 500,
      seats: [{ seat: 'P1', deckSnapshotId: 'snap-1', manualMana: true }],
      rng: { kind: 'legacy', key: '' }, engineOptions: { maxDecisions: 100000 },
    };
    // game_players.deck_snapshot_id is a foreign key; a game with no seats avoids it.
    recorder.start('new-seed', [], 'singlePlayer', { config, buildCommit: 'abc123', buildDirty: true });
    recorder.saveDecisionSource('new-game:1', 'P1', 'human');
    recorder.saveDecisionSource('new-game:1', 'P1', 'auto');
    recorder.saveDecisionSource('new-game:2', 'P2', 'bot');
    const replay = recorder.loadReplayRecord();
    reopened.close();

    const check = new Database(path);
    const sources = check.query('SELECT request_id, seat, source FROM game_decision_sources ORDER BY request_id').all();
    const dirty = check.query("SELECT build_dirty FROM games WHERE id = 'new-game'").get();
    check.close();
    console.log(JSON.stringify({ before, after, oldRow, sourcesTable, replay, sources, dirty }));
  `,
        join(dir, 'old.sqlite'),
      ],
      { encoding: 'utf8' },
    );
    const out = JSON.parse(result) as {
      before: string[];
      after: string[];
      oldRow: Record<string, unknown>;
      sourcesTable: string[];
      replay: { config: { turnCap: number }; buildCommit: string; buildDirty: boolean };
      sources: Array<{ request_id: string; seat: number; source: string }>;
      dirty: { build_dirty: number };
    };

    expect(out.before).not.toContain('config_json');
    expect(out.after).toEqual([...out.before, 'config_json', 'build_commit', 'build_dirty']);
    // The old game is untouched, and its new columns read as "never stored".
    expect(out.oldRow).toMatchObject({
      id: 'old-game',
      seed: 'old-seed',
      status: 'finished',
      turn_count: 12,
      config_json: null,
      build_commit: null,
      build_dirty: null,
    });
    expect(out.sourcesTable).toEqual(['game_id', 'request_id', 'seat', 'source']);
    expect(out.replay).toMatchObject({
      config: { turnCap: 500, rng: { kind: 'legacy', key: '' } },
      buildCommit: 'abc123',
      buildDirty: true,
    });
    expect(out.dirty.build_dirty).toBe(1);
    // A request keeps the first attribution it was given.
    expect(out.sources).toEqual([
      { request_id: 'new-game:1', seat: 1, source: 'human' },
      { request_id: 'new-game:2', seat: 2, source: 'bot' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('reports how far a failed batch game got from its recorded events', () => {
  // Vitest runs under Node; run the native Bun SQLite adapter against an in-memory DB.
  const result = execFileSync(
    'bun',
    [
      '-e',
      `
    import { Database } from 'bun:sqlite';
    import { SCHEMA_SQL } from './packages/server/src/db/schema.ts';
    import { BatchRepository } from './packages/server/src/db/batches.ts';
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const repo = new BatchRepository(db);
    const scenario = [{ id: 'pod', name: 'Pod', games: 3, seats: [], providerKind: 'random' }];
    repo.create('batch', 'seed', scenario);
    repo.markRunning('batch');
    const event = db.query('INSERT INTO game_events (game_id, sequence, turn) VALUES (?, ?, ?)');
    repo.createGame('batch', 'pod', 0, 'failed', 's1');
    db.query("INSERT INTO games (id, seed, status) VALUES ('failed', 's1', 'halted')").run();
    event.run('failed', 0, 1);
    event.run('failed', 1, 28);
    repo.markGame('failed', 'failed', 'engine bug: cost became unpayable');
    repo.createGame('batch', 'pod', 1, 'finished', 's2');
    db.query("INSERT INTO games (id, seed, status, turn_count) VALUES ('finished', 's2', 'finished', 36)").run();
    event.run('finished', 0, 36);
    db.query("INSERT INTO decks (id, name, source_type, archetype_tag, created_at) VALUES ('deck', 'Deck', 'generated', 'tag', 'now')").run();
    db.query("INSERT INTO deck_snapshots (id, deck_id, commander_names, color_identity, card_list_json, imported_at) VALUES ('snapshot', 'deck', '[]', '[]', '[]', 'now')").run();
    db.query("INSERT INTO game_players (game_id, seat, deck_snapshot_id, finished_position) VALUES ('finished', 1, 'snapshot', 1)").run();
    repo.markGame('finished', 'finished');
    repo.createGame('batch', 'pod', 2, 'queued', 's3');
    const running = repo.progress('batch');
    const progress = {
      completed: running.completedGames,
      finished: running.finishedGames,
      failed: running.failedGames,
      scenario: [running.scenarios[0].completedGames, running.scenarios[0].status],
      aggregateFailed: repo.results('batch').aggregate.gamesFailed,
    };
    const games = repo.results('batch').games.map((game) => ({
      id: game.gameId,
      turnCount: game.turnCount,
      lastRecordedTurn: game.lastRecordedTurn,
      failureReason: game.failureReason,
    }));
    console.log(JSON.stringify({ games, progress }));
    db.close();
  `,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(result);
  expect(parsed.games).toEqual([
    {
      id: 'failed',
      turnCount: null,
      lastRecordedTurn: 28,
      failureReason: 'engine bug: cost became unpayable',
    },
    { id: 'finished', turnCount: 36, lastRecordedTurn: 36, failureReason: null },
    { id: 'queued', turnCount: null, lastRecordedTurn: null, failureReason: null },
  ]);
  // The third game is still running (its row exists from the moment it starts): it is neither
  // processed nor failed yet.
  expect(parsed.progress).toEqual({
    completed: 2,
    finished: 1,
    failed: 1,
    scenario: [2, 'failed'],
    aggregateFailed: 1,
  });
});

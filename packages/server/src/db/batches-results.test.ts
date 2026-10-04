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
    repo.markGame('finished', 'finished');
    repo.createGame('batch', 'pod', 2, 'queued', 's3');
    const games = repo.results('batch').games.map((game) => ({
      id: game.gameId,
      turnCount: game.turnCount,
      lastRecordedTurn: game.lastRecordedTurn,
      failureReason: game.failureReason,
    }));
    console.log(JSON.stringify(games));
    db.close();
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(JSON.parse(result)).toEqual([
    {
      id: 'failed',
      turnCount: null,
      lastRecordedTurn: 28,
      failureReason: 'engine bug: cost became unpayable',
    },
    { id: 'finished', turnCount: 36, lastRecordedTurn: 36, failureReason: null },
    { id: 'queued', turnCount: null, lastRecordedTurn: null, failureReason: null },
  ]);
});

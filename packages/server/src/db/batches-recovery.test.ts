import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('recovers interrupted batches in SQLite without changing completed history', () => {
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
    const scenario = [{ id: 'pod', name: 'Pod', games: 1, seats: [], providerKind: 'random' }];
    repo.create('interrupted', 'seed', scenario);
    repo.markRunning('interrupted');
    repo.createGame('interrupted', 'pod', 0, 'game', 'seed');
    repo.create('completed', 'seed', scenario);
    repo.markFinished('completed', 'completed');
    const count = repo.recoverInterrupted();
    console.log(JSON.stringify({ count, active: repo.activeBatchExists(), interrupted: repo.get('interrupted').status, completed: repo.get('completed').status, game: db.query('SELECT status FROM batch_games WHERE game_id = ?').get('game').status, second: repo.recoverInterrupted() }));
    db.close();
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(JSON.parse(result)).toEqual({
    count: 1,
    active: false,
    interrupted: 'failed',
    completed: 'completed',
    game: 'failed',
    second: 0,
  });
});

import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

/** Runs a Bun script against an in-memory database; Vitest itself runs under Node. */
function runBun(body: string): unknown {
  const output = execFileSync(
    'bun',
    [
      '-e',
      `
    import { Database } from 'bun:sqlite';
    import { MIGRATIONS_SQL, SCHEMA_SQL } from './packages/server/src/db/schema.ts';
    import { BatchRepository } from './packages/server/src/db/batches.ts';
    const scenario = (id, games, providerKind = 'random') => ({ id, name: id, games, seats: [], providerKind });
    ${body}
  `,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(output);
}

it('lists batches newest first with counts, names and a limit', () => {
  const result = runBun(`
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    for (const statement of MIGRATIONS_SQL) { try { db.exec(statement); } catch {} }
    const repo = new BatchRepository(db);
    repo.create('old', 'seed-old', [scenario('a', 2)]);
    repo.create('mid', 'seed-mid', [scenario('a', 2), scenario('b', 3, 'ai')], 'Mid run');
    repo.create('new', 'seed-new', [scenario('a', 1)]);
    db.query("UPDATE batches SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = 'old'").run();
    db.query("UPDATE batches SET created_at = '2026-01-02T00:00:00.000Z' WHERE id = 'mid'").run();
    db.query("UPDATE batches SET created_at = '2026-01-03T00:00:00.000Z' WHERE id = 'new'").run();
    repo.markRunning('mid');
    repo.createGame('mid', 'a', 0, 'g1', 's1');
    repo.markGame('g1', 'finished');
    repo.createGame('mid', 'a', 1, 'g2', 's2');
    repo.markGame('g2', 'failed', 'boom');
    repo.createGame('mid', 'b', 0, 'g3', 's3');
    const all = repo.list();
    console.log(JSON.stringify({
      order: all.map((item) => item.batchId),
      mid: all.find((item) => item.batchId === 'mid'),
      newest: all[0],
      limited: repo.list(2).map((item) => item.batchId),
      progressName: repo.progress('mid').name,
      providers: repo.progress('mid').scenarios.map((item) => item.providerKind),
      progressUnnamed: repo.progress('old').name,
    }));
  `) as {
    order: string[];
    mid: Record<string, unknown>;
    newest: Record<string, unknown>;
    limited: string[];
    progressName: string | null;
    providers: string[];
    progressUnnamed: string | null;
  };
  expect(result.order).toEqual(['new', 'mid', 'old']);
  expect(result.limited).toEqual(['new', 'mid']);
  // The game that is still running is not yet processed, so it counts as neither done nor failed.
  expect(result.mid).toMatchObject({
    batchId: 'mid',
    name: 'Mid run',
    seed: 'seed-mid',
    status: 'running',
    totalGames: 5,
    completedGames: 2,
    finishedGames: 1,
    failedGames: 1,
    scenarioCount: 2,
    scenarioNames: ['a', 'b'],
    endedAt: null,
  });
  expect(typeof result.mid['startedAt']).toBe('string');
  expect(result.newest).toMatchObject({
    batchId: 'new',
    name: null,
    status: 'queued',
    totalGames: 1,
    completedGames: 0,
    scenarioCount: 1,
    startedAt: null,
  });
  expect(result.progressName).toBe('Mid run');
  expect(result.providers).toEqual(['random', 'ai']);
  expect(result.progressUnnamed).toBeNull();
});

it('adds the name column to a database created before it existed', () => {
  const result = runBun(`
    const db = new Database(':memory:');
    db.exec(\`CREATE TABLE batches (
      id TEXT PRIMARY KEY, seed TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, failure_json TEXT
    )\`);
    db.query("INSERT INTO batches (id, seed, status, created_at) VALUES ('legacy', 's', 'completed', '2025-01-01T00:00:00.000Z')").run();
    db.exec(SCHEMA_SQL);
    for (const statement of MIGRATIONS_SQL) { try { db.exec(statement); } catch {} }
    // A second pass is a no-op, as on every server start.
    for (const statement of MIGRATIONS_SQL) { try { db.exec(statement); } catch {} }
    const repo = new BatchRepository(db);
    repo.create('fresh', 'seed', [scenario('a', 1)], 'Named');
    console.log(JSON.stringify(repo.list().map((item) => [item.batchId, item.name])));
  `);
  expect(result).toEqual(
    expect.arrayContaining([
      ['legacy', null],
      ['fresh', 'Named'],
    ]),
  );
});

import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

/**
 * Table talk (ADR 0031) against real SQLite: lines come back in the order they were said, appends
 * continue the positions, and the structured message survives the round trip.
 */
it('stores table talk in order and reads it back intact', () => {
  // Vitest runs under Node; run the native Bun SQLite adapter against an in-memory DB.
  const result = execFileSync(
    'bun',
    [
      '-e',
      `
    import { Database } from 'bun:sqlite';
    import { SCHEMA_SQL } from './packages/server/src/db/schema.ts';
    import { GameRecorder } from './packages/server/src/db/games.ts';
    import { StatsRepository } from './packages/server/src/db/stats.ts';
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.query("INSERT INTO games (id, seed, status) VALUES ('g1', 's', 'running')").run();
    const recorder = new GameRecorder(db, 'g1');
    const call = { kind: 'threatCall', turn: 3, from: 'P1', leader: 'P4', reasons: [] };
    const end = { kind: 'dealEnded', turn: 9, dealId: 'deal-1', outcome: 'kept' };
    recorder.saveTableTalk([{ sequence: 40, turn: 3, message: call, text: 'P1: P4 is the biggest threat.' }]);
    recorder.saveTableTalk([{ sequence: 90, turn: 9, message: end, text: 'Deal deal-1 ran its course.' }]);
    console.log(JSON.stringify(new StatsRepository(db).gameTableTalk('g1')));
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(JSON.parse(result)).toEqual([
    {
      sequence: 40,
      turn: 3,
      message: { kind: 'threatCall', turn: 3, from: 'P1', leader: 'P4', reasons: [] },
      text: 'P1: P4 is the biggest threat.',
    },
    {
      sequence: 90,
      turn: 9,
      message: { kind: 'dealEnded', turn: 9, dealId: 'deal-1', outcome: 'kept' },
      text: 'Deal deal-1 ran its course.',
    },
  ]);
});

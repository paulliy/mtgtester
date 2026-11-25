import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

/** The Debug page's game picker query against real SQLite, through Bun like the other db tests. */
it('lists recorded games newest first with batch, scenario and commanders', () => {
  const output = execFileSync(
    'bun',
    [
      '-e',
      `
    import { Database } from 'bun:sqlite';
    import { MIGRATIONS_SQL, SCHEMA_SQL } from './packages/server/src/db/schema.ts';
    import { BatchRepository } from './packages/server/src/db/batches.ts';
    import { StatsRepository } from './packages/server/src/db/stats.ts';
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    for (const statement of MIGRATIONS_SQL) { try { db.exec(statement); } catch {} }
    const stats = new StatsRepository(db);
    const empty = stats.listGames();
    for (const deck of ['a', 'b']) {
      db.query("INSERT INTO decks (id, name, source_type, archetype_tag, created_at) VALUES (?, ?, 'plaintext', 'tag', 'x')").run(deck, deck);
      db.query("INSERT INTO deck_snapshots (id, deck_id, commander_names, color_identity, card_list_json, imported_at) VALUES (?, ?, ?, '[]', '[]', 'x')").run('s' + deck, deck, JSON.stringify(['Cmdr ' + deck, 'Partner ' + deck]));
    }
    const batches = new BatchRepository(db);
    batches.create('b1', 'seed', [{ id: 'pod', name: 'Pod one', games: 1, seats: [], providerKind: 'random' }]);
    const add = (id, startedAt, status, winner, batch) => {
      db.query("INSERT INTO games (id, seed, status, started_at, turn_count, winner_seat, build_commit) VALUES (?, ?, ?, ?, 7, ?, 'abc123')").run(id, 'seed-' + id, status, startedAt, winner);
      db.query("INSERT INTO game_players (game_id, seat, deck_snapshot_id) VALUES (?, 2, 'sb'), (?, 1, 'sa')").run(id, id);
      if (batch) batches.createGame('b1', 'pod', 0, id, 'seed-' + id);
    };
    add('old', '2026-01-01T00:00:00.000Z', 'finished', 1, true);
    add('new', '2026-01-02T00:00:00.000Z', 'running', null, false);
    db.query("INSERT INTO games (id, seed) VALUES ('bare', 's')").run();
    console.log(JSON.stringify({ empty, all: stats.listGames(), limited: stats.listGames(2).map((g) => g.gameId) }));
  `,
    ],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(output) as {
    empty: unknown[];
    all: Record<string, unknown>[];
    limited: string[];
  };
  expect(result.empty).toEqual([]);
  expect(result.all.map((game) => game['gameId'])).toEqual(['new', 'old', 'bare']);
  expect(result.limited).toEqual(['new', 'old']);
  expect(result.all[1]).toEqual({
    gameId: 'old',
    seed: 'seed-old',
    status: 'finished',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: null,
    turnCount: 7,
    winnerSeat: 1,
    gameMode: 'spectator',
    batchId: 'b1',
    scenarioName: 'Pod one',
    buildCommit: 'abc123',
    seats: [
      { seat: 1, commanders: ['Cmdr a', 'Partner a'] },
      { seat: 2, commanders: ['Cmdr b', 'Partner b'] },
    ],
  });
  expect(result.all[0]).toMatchObject({ batchId: null, scenarioName: null, winnerSeat: null });
  expect(result.all[2]).toMatchObject({ status: null, turnCount: null, seats: [] });
});

import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

/**
 * "Who beats me" against real SQLite, including rows written before eliminators were recorded
 * only for genuine losses: a winner with an attribution, a self-attribution, and a decked player.
 */
it('counts only genuine losses to another seat in "Who beats me"', () => {
  // Vitest runs under Node; run the native Bun SQLite adapter against an in-memory DB.
  const result = execFileSync(
    'bun',
    [
      '-e',
      `
    import { Database } from 'bun:sqlite';
    import { SCHEMA_SQL } from './packages/server/src/db/schema.ts';
    import { BatchRepository } from './packages/server/src/db/batches.ts';
    import { StatsRepository } from './packages/server/src/db/stats.ts';
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const now = new Date().toISOString();
    for (const [deck, commander, source] of [['a', 'Alpha', 'plaintext'], ['b', 'Beta', 'plaintext'], ['c', 'Gamma', 'generated']]) {
      db.query("INSERT INTO decks (id, name, source_type, archetype_tag, created_at) VALUES (?, ?, ?, 'tag', ?)").run(deck, deck, source, now);
      db.query("INSERT INTO deck_snapshots (id, deck_id, commander_names, color_identity, card_list_json, imported_at) VALUES (?, ?, ?, '[]', '[]', ?)").run('s' + deck, deck, JSON.stringify([commander]), now);
    }
    const batches = new BatchRepository(db);
    batches.create('batch', 'seed', [{ id: 'pod', name: 'Pod', games: 4, seats: [], providerKind: 'random' }]);
    const player = db.query('INSERT INTO game_players (game_id, seat, deck_snapshot_id, finished_position, loss_reason, eliminated_by_seat) VALUES (?, ?, ?, ?, ?, ?)');
    // [game, Alpha's position, Alpha's loss reason, Alpha's recorded eliminator seat]
    const games = [
      ['won', 1, null, 2],                 // a winner credited to its last damager
      ['lost', 2, 'lifeZeroOrLess', 3],    // the one genuine loss, to Gamma
      ['self', 2, 'lifeZeroOrLess', 1],    // damage from Alpha's own spell
      ['decked', 2, 'emptyLibraryDraw', 2] // decking has no damaging killer
    ];
    games.forEach(([id, position, reason, by], index) => {
      db.query("INSERT INTO games (id, seed, status, turn_count) VALUES (?, 's', 'finished', 10)").run(id);
      batches.createGame('batch', 'pod', index, id, 's');
      player.run(id, 1, 'sa', position, reason, by);
      player.run(id, 2, 'sb', position === 1 ? 2 : 1, null, null);
      player.run(id, 3, 'sc', 3, 'lifeZeroOrLess', 1);
    });
    const stats = new StatsRepository(db);
    const lossesTo = (all) => all.find((deck) => deck.deckSnapshotId === 'sa').lossesTo
      .map((entry) => ({ commanders: entry.commanders, count: entry.count }));
    const generated = Object.fromEntries(stats.deckStatistics().map((deck) => [deck.deckSnapshotId, deck.generated]));
    console.log(JSON.stringify({ all: lossesTo(stats.deckStatistics()), batch: lossesTo(stats.deckStatistics('batch')), generated }));
    db.close();
  `,
    ],
    { encoding: 'utf8' },
  );
  const expected = [{ commanders: ['Gamma'], count: 1 }];
  expect(JSON.parse(result)).toEqual({
    all: expected,
    batch: expected,
    generated: { sa: false, sb: false, sc: true },
  });
});

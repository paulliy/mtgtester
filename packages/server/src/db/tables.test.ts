import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

/**
 * The table repository in real SQLite (Vitest runs under Node, so Bun runs the script): a
 * manifest written before the worker, an interruption that closes a still-running game row as a
 * halt, a committed outcome that survives a racing interruption, and the decks a game stored.
 */
it('records attempts, closes interrupted game rows and keeps committed outcomes', () => {
  const result = execFileSync(
    'bun',
    [
      '-e',
      `
    import { Database } from 'bun:sqlite';
    import { SCHEMA_SQL } from './packages/server/src/db/schema.ts';
    import { TableRepository } from './packages/server/src/db/tables.ts';
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const repo = new TableRepository(db);
    const manifest = (attemptId, gameId) => ({
      tableId: 't1', attemptId, gameId, rngKey: 'ab'.repeat(32),
      seats: [{ seat: 'P1', controller: 'human', displayName: 'Ann', decklist: 'x' }, { seat: 'P2', controller: 'bot' }],
      limits: { maxStepWork: 1, maxObjects: 1, turnCap: null },
      identity: { cardDataSha256: null, buildCommit: null, buildDirty: null },
    });
    // A worker that died mid-game: its row was still running.
    repo.beginAttempt(manifest('a1', 'g1'));
    db.query("INSERT INTO games (id, seed, status) VALUES ('g1', 's', 'running')").run();
    repo.endAttempt('a1', 'workerFailure');
    repo.endAttempt('a1', 'finished');
    // A result committed before the worker died: the outcome stands.
    repo.beginAttempt(manifest('a2', 'g2'));
    db.query("INSERT INTO games (id, seed, status) VALUES ('g2', 's', 'finished')").run();
    repo.endAttempt('a2', 'workerFailure');
    // A worker that never created its row.
    repo.beginAttempt(manifest('a3', 'g3'));
    repo.endAttempt('a3', 'setupFailed');
    // Decks a game stored.
    db.query("INSERT INTO decks (id, name, source_type, archetype_tag, created_at) VALUES ('d', 'n', 'generated', 'x', 'now')").run();
    db.query("INSERT INTO deck_snapshots (id, deck_id, commander_names, color_identity, card_list_json, imported_at) VALUES ('s', 'd', '[\\"Gen\\"]', '[]', '[{\\"oracleId\\":\\"o\\",\\"name\\":\\"Forest\\",\\"quantity\\":30}]', 'now')").run();
    db.query("INSERT INTO game_players (game_id, seat, deck_snapshot_id) VALUES ('g2', 2, 's')").run();
    const deckId = repo.saveApprovedDeck({ tableId: 't1', seat: 'P1', displayName: 'Ann', decklist: 'x' });
    console.log(JSON.stringify({
      a1: repo.attempt('a1').status,
      g1: db.query("SELECT status FROM games WHERE id = 'g1'").get().status,
      a2: repo.attempt('a2').status,
      g2: db.query("SELECT status FROM games WHERE id = 'g2'").get().status,
      a3: repo.attempt('a3').status,
      a3Key: repo.attempt('a3').manifest.rngKey.length,
      g3: repo.gameExists('g3'),
      decks: repo.gameDecks('g2'),
      deckScoped: deckId.startsWith('t1:'),
      missing: repo.attempt('nope'),
    }));
    db.close();
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(JSON.parse(result)).toEqual({
    a1: 'workerFailure',
    g1: 'halted',
    a2: 'workerFailure',
    g2: 'finished',
    a3: 'setupFailed',
    a3Key: 64,
    g3: false,
    decks: [{ seat: 'P2', commanderNames: ['Gen'], cards: [{ name: 'Forest', quantity: 30 }] }],
    deckScoped: true,
    missing: null,
  });
});

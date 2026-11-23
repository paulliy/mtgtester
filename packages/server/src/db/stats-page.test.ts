import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The Stats page read model against real SQLite (the same Bun adapter `stats-attribution.test.ts`
 * uses): scopes, the latest-batch default, finish distribution, matchups, the summary, last game.
 *
 * Decks: a (saved), b (saved), c (generated). Four finished games, two in the batch `b1` (created
 * first), one in the later batch `b2`, one human-seated game outside every batch, plus a running game.
 *   g1 (b1): a wins, b 2nd, c 3rd   (c lost to life 0; b lost to commander damage)
 *   g2 (b1): b wins, a 2nd, c 3rd
 *   g3 (b2): a wins, b 2nd, c 3rd
 *   g4 (human seat on b): a wins, b 2nd, c 4th
 *   g5 running: ignored
 */
const SCRIPT = `
  import { Database } from 'bun:sqlite';
  import { SCHEMA_SQL } from './packages/server/src/db/schema.ts';
  import { BatchRepository } from './packages/server/src/db/batches.ts';
  import { StatsRepository } from './packages/server/src/db/stats.ts';
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const stats = new StatsRepository(db);
  const out = { empty: stats.statsReport({}), emptyBatch: stats.statsReport({ scope: 'batch' }) };
  for (const [deck, source] of [['a', 'plaintext'], ['b', 'plaintext'], ['c', 'generated']]) {
    db.query("INSERT INTO decks (id, name, source_type, archetype_tag, created_at) VALUES (?, ?, ?, 'tag', 'x')").run(deck, deck.toUpperCase(), source);
    db.query("INSERT INTO deck_snapshots (id, deck_id, commander_names, color_identity, card_list_json, imported_at) VALUES (?, ?, ?, '[]', '[]', 'x')").run('s' + deck, deck, JSON.stringify([deck]));
  }
  const batches = new BatchRepository(db);
  const spec = [{ id: 'pod', name: 'Pod', games: 2, seats: [], providerKind: 'random' }];
  batches.create('b1', 'seed', spec);
  db.query("UPDATE batches SET created_at = '2026-01-01' WHERE id = 'b1'").run();
  batches.create('b2', 'seed', spec);
  db.query("UPDATE batches SET created_at = '2026-02-01' WHERE id = 'b2'").run();
  const player = db.query("INSERT INTO game_players (game_id, seat, deck_snapshot_id, finished_position, loss_reason, eliminated_by_seat, mulligans_taken, controller_kind) VALUES (?, ?, ?, ?, ?, ?, 0, ?)");
  function game(id, status, turns, ended, order, batch, index, humanSeatDeck) {
    db.query("INSERT INTO games (id, seed, status, turn_count, ended_at) VALUES (?, 's', ?, ?, ?)").run(id, status, turns, ended);
    if (batch) batches.createGame(batch, 'pod', index, id, 's');
    order.forEach(([deck, position, reason, by], i) =>
      player.run(id, i + 1, 's' + deck, position, reason, by, deck === humanSeatDeck ? 'human' : 'ai'));
  }
  game('g1', 'finished', 10, '2026-01-01T01', [['a', 1, null, null], ['b', 2, 'commanderDamage', 1], ['c', 3, 'lifeZeroOrLess', 1]], 'b1', 0);
  game('g2', 'finished', 14, '2026-01-01T02', [['b', 1, null, null], ['a', 2, 'lifeZeroOrLess', 1], ['c', 3, 'lifeZeroOrLess', 1]], 'b1', 1);
  game('g3', 'finished', 12, '2026-02-01T01', [['a', 1, null, null], ['b', 2, 'lifeZeroOrLess', 1], ['c', 3, 'lifeZeroOrLess', 1]], 'b2', 0);
  game('g4', 'finished', 8, '2026-03-01T01', [['a', 1, null, null], ['b', 2, 'lifeZeroOrLess', 1], ['c', 4, 'emptyLibraryDraw', null]], null, 0, 'b');
  game('g5', 'running', null, null, [['a', null, null, null], ['b', null, null, null]], null, 0);
  out.all = stats.statsReport({});
  out.latest = stats.statsReport({ scope: 'batch' });
  out.b1 = stats.statsReport({ batchId: 'b1' });
  out.mine = stats.statsReport({ scope: 'mine' });
  out.legacy = stats.deckStatistics('b1').map((deck) => deck.deckSnapshotId);
  console.log(JSON.stringify(out));
  db.close();
`;

type Report = {
  scope: string;
  batchId: string | null;
  decks: Array<{
    deckSnapshotId: string;
    gamesPlayed: number;
    wins: number;
    finishDistribution: number[];
    lastGameId: string | null;
    lossesTo: Array<{ count: number }>;
    manaFloodRate: null;
  }>;
  summary: {
    finishedGames: number;
    generatedGames: number;
    decksTracked: number;
    averageTurns: number | null;
    mostCommonEnd: { reason: string; label: string; share: number } | null;
  };
  matchups: Array<{ winner: string; beaten: string; games: number }>;
};

const run = JSON.parse(execFileSync('bun', ['-e', SCRIPT], { encoding: 'utf8' })) as Record<
  'empty' | 'emptyBatch' | 'all' | 'latest' | 'b1' | 'mine',
  Report
> & {
  legacy: string[];
};
const deck = (report: Report, id: string) => report.decks.find((d) => d.deckSnapshotId === id)!;
const pair = (report: Report, winner: string, beaten: string) =>
  report.matchups.find((m) => m.winner === winner && m.beaten === beaten)?.games ?? 0;

describe('StatsRepository.statsReport', () => {
  it('reports an empty database as zeros, never as missing', () => {
    for (const report of [run.empty, run.emptyBatch]) {
      expect(report.decks).toEqual([]);
      expect(report.matchups).toEqual([]);
      expect(report.summary).toEqual({
        finishedGames: 0,
        generatedGames: 0,
        decksTracked: 0,
        averageTurns: null,
        mostCommonEnd: null,
      });
    }
    expect(run.empty).toMatchObject({ scope: 'all', batchId: null });
    expect(run.emptyBatch).toMatchObject({ scope: 'batch', batchId: null });
  });

  it('counts every finished game for scope all and ignores unfinished ones', () => {
    expect(run.all).toMatchObject({ scope: 'all', batchId: null });
    expect(run.all.summary.finishedGames).toBe(4);
    expect(deck(run.all, 'sa').gamesPlayed).toBe(4);
    expect(deck(run.all, 'sa').wins).toBe(3);
  });

  it('resolves scope=batch without an id to the most recently created batch', () => {
    expect(run.latest).toMatchObject({ scope: 'batch', batchId: 'b2' });
    expect(run.latest.summary.finishedGames).toBe(1);
    expect(run.latest.decks.map((d) => d.deckSnapshotId).sort()).toEqual(['sa', 'sb', 'sc']);
  });

  it('keeps an explicit batchId (old links) and selects the batch scope', () => {
    expect(run.b1).toMatchObject({ scope: 'batch', batchId: 'b1' });
    expect(run.b1.summary.finishedGames).toBe(2);
    expect(run.legacy.sort()).toEqual(['sa', 'sb', 'sc']);
  });

  it('scope=mine counts only games with a human seat', () => {
    expect(run.mine.scope).toBe('mine');
    expect(run.mine.summary.finishedGames).toBe(1);
    expect(deck(run.mine, 'sa').lastGameId).toBe('g4');
    expect(run.mine.matchups).toHaveLength(2);
  });

  it('builds the finish distribution as 1st, 2nd, 3rd and 4th-or-lower', () => {
    expect(deck(run.all, 'sa').finishDistribution).toEqual([3, 1, 0, 0]);
    expect(deck(run.all, 'sb').finishDistribution).toEqual([1, 3, 0, 0]);
    expect(deck(run.all, 'sc').finishDistribution).toEqual([0, 0, 3, 1]);
  });

  it('names the most recent finished game of each deck inside the scope', () => {
    expect(deck(run.all, 'sa').lastGameId).toBe('g4');
    expect(deck(run.b1, 'sa').lastGameId).toBe('g2');
    expect(deck(run.latest, 'sb').lastGameId).toBe('g3');
  });

  it('counts wins per winner and beaten deck, within the scope', () => {
    expect(pair(run.all, 'sa', 'sb')).toBe(3);
    expect(pair(run.all, 'sa', 'sc')).toBe(3);
    expect(pair(run.all, 'sb', 'sa')).toBe(1);
    expect(pair(run.all, 'sc', 'sa')).toBe(0);
    expect(pair(run.b1, 'sa', 'sb')).toBe(1);
    expect(pair(run.b1, 'sb', 'sa')).toBe(1);
    expect(run.latest.matchups.map((m) => m.games)).toEqual([1, 1]);
  });

  it('summarises games, decks, average length and the most common end', () => {
    expect(run.all.summary).toMatchObject({
      finishedGames: 4,
      generatedGames: 4,
      decksTracked: 2,
      averageTurns: 11,
    });
    // Recorded exits: commanderDamage 1, lifeZeroOrLess 6, emptyLibraryDraw 1 -> 6 of 8.
    expect(run.all.summary.mostCommonEnd).toMatchObject({
      reason: 'lifeZeroOrLess',
      label: 'Life total reached 0',
    });
    expect(run.all.summary.mostCommonEnd!.share).toBeCloseTo(6 / 8, 5);
  });

  it('still never reports flood or drought rates', () => {
    expect(deck(run.all, 'sa').manaFloodRate).toBeNull();
  });
});

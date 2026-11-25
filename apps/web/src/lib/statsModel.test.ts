import { describe, expect, it } from 'vitest';
import {
  causeRows,
  heatStep,
  lossesToRows,
  mulliganBuckets,
  normalizeReport,
  romanNumeral,
  sortDecks,
  type DeckStatistic,
} from './statsModel';

function deck(over: Partial<DeckStatistic> & { deckSnapshotId: string }): DeckStatistic {
  return normalizeReport({ decks: [{ name: over.deckSnapshotId, ...over }] }).decks[0]!;
}

describe('statsModel', () => {
  it('fills an older { decks }-only body with safe defaults', () => {
    const report = normalizeReport({
      decks: [{ deckSnapshotId: 'a', name: 'A', gamesPlayed: 4, wins: 1, averageGameLength: 10 }],
    });
    expect(report.scope).toBe('all');
    expect(report.matchups).toEqual([]);
    expect(report.decks[0]!.finishDistribution).toEqual([0, 0, 0, 0]);
    expect(report.summary).toMatchObject({ finishedGames: 4, decksTracked: 1, averageTurns: 10 });
  });

  it('writes roman numerals for ranks', () => {
    expect([1, 2, 4, 6, 9, 10].map(romanNumeral)).toEqual(['I', 'II', 'IV', 'VI', 'IX', 'X']);
  });

  it('sorts standings by win rate, average finish, or games', () => {
    const a = deck({ deckSnapshotId: 'a', winRate: 0.5, averageFinish: 3, gamesPlayed: 2 });
    const b = deck({ deckSnapshotId: 'b', winRate: 0.2, averageFinish: 1.5, gamesPlayed: 9 });
    const c = deck({ deckSnapshotId: 'c', winRate: 0.2, averageFinish: null, gamesPlayed: 5 });
    const ids = (by: 'win' | 'finish' | 'games') =>
      sortDecks([a, b, c], by).map((item) => item.deckSnapshotId);
    expect(ids('win')).toEqual(['a', 'b', 'c']);
    expect(ids('finish')).toEqual(['b', 'a', 'c']);
    expect(ids('games')).toEqual(['b', 'c', 'a']);
  });

  it('bins heat over the actual min..max and handles a flat matrix', () => {
    expect(heatStep(2, 2, 12)).toBe(0);
    expect(heatStep(12, 2, 12)).toBe(5);
    expect(heatStep(7, 2, 12)).toBe(3);
    expect(heatStep(4, 4, 4)).toBe(0);
  });

  it('folds mulligans into four buckets', () => {
    expect(
      mulliganBuckets([
        { mulligans: 0, games: 5 },
        { mulligans: 1, games: 2 },
        { mulligans: 4, games: 1 },
        { mulligans: 3, games: 1 },
      ]).map((bucket) => bucket.count),
    ).toEqual([5, 2, 0, 2]);
  });

  it('always gives "How it lost" three rows, empty ones last', () => {
    const none = causeRows(deck({ deckSnapshotId: 'a' }));
    expect(none.rows).toHaveLength(3);
    expect(none.rows.every((row) => row.count === 0)).toBe(true);
    const some = causeRows(
      deck({
        deckSnapshotId: 'b',
        eliminationCauses: [
          { reason: 'x', label: 'X', count: 1 },
          { reason: 'y', label: 'Y', count: 4 },
        ],
      }),
    );
    expect(some.rows.map((row) => row.label)).toEqual(['Y', 'X', '—']);
    expect(some.total).toBe(5);
  });

  it('names who beats a deck by commanders, falling back to archetype', () => {
    const rows = lossesToRows(
      deck({
        deckSnapshotId: 'a',
        lossesTo: [
          { commanders: [], colorIdentity: [], archetypeTag: 'Ramp', count: 1 },
          { commanders: ['Kenrith'], colorIdentity: ['W'], archetypeTag: 'x', count: 3 },
        ],
      }),
      4,
    );
    expect(rows.map((row) => row.label)).toEqual(['Kenrith', 'Ramp', '—']);
  });
});

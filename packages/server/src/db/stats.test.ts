import { describe, expect, it } from 'vitest';
import { StatsRepository } from './stats';
import type { SqliteLike } from './games';

function fakeDb(responses: unknown[][]): SqliteLike {
  const queue = [...responses];
  return {
    query: () => ({
      run: () => undefined,
      all: () => queue.shift() ?? [],
      get: () => queue.shift()?.[0] ?? null,
    }),
  };
}

describe('StatsRepository', () => {
  it('returns a zero-safe deck aggregate when no finished games exist', () => {
    const stats = new StatsRepository(fakeDb([[{
      snapshot_id: 's1', name: 'Test Deck', archetype_tag: 'midrange', commander_names: '["A"]',
      color_identity: '["G"]', games_played: 0, wins: 0, average_finish: null,
      average_game_length: null, average_mulligans: null,
    }], [], [], [], []])).deckStatistics();

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ name: 'Test Deck', gamesPlayed: 0, winRate: 0, manaFloodRate: 0 });
  });

  it('bundles every persisted source required by the JSON game export', () => {
    const repo = new StatsRepository(fakeDb([[{ id: 'g1' }], [{ sequence: 1 }], [{ sequence: 1 }], [{ sequence: 1 }], [{ turn: 1 }]]));
    expect(repo.gameDebug('g1')).toEqual({
      game: { id: 'g1' }, events: [{ sequence: 1 }], debugEvents: [{ sequence: 1 }],
      aiCalls: [{ sequence: 1 }], manaMetrics: [{ turn: 1 }],
    });
  });
});

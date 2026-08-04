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

/**
 * ADR 0022: reasoning survives a page reload only because it can be rebuilt from `ai_calls`.
 * The live socket delivers each note exactly once and nothing else persists it.
 */
describe('StatsRepository.gameAnnotations', () => {
  it('rebuilds a tactical note and a strategist intent from stored responses', () => {
    const repo = new StatsRepository(fakeDb([[
      {
        seat: 2, model: 'test/tactician', source: 'primary', turn: 4, anchor_sequence: 17,
        response_json: JSON.stringify({ actionId: 3, note: 'trading now is better than later' }),
      },
      {
        seat: 3, model: 'test/strategist', source: 'strategist', turn: 5, anchor_sequence: 22,
        response_json: JSON.stringify({ actionId: 0, turnStrategy: { intent: 'stabilise, then race P1' } }),
      },
    ]]));

    expect(repo.gameAnnotations('g1')).toEqual([
      {
        sequence: 17, turn: 4, seat: 'P2', kind: 'decision',
        text: 'trading now is better than later', source: 'primary', model: 'test/tactician',
      },
      {
        sequence: 22, turn: 5, seat: 'P3', kind: 'strategy',
        text: 'stabilise, then race P1', source: 'strategist', model: 'test/strategist',
      },
    ]);
  });

  it('skips calls with nothing to say rather than emitting blank annotations', () => {
    const repo = new StatsRepository(fakeDb([[
      { seat: 1, source: 'primary', turn: 1, anchor_sequence: 1, response_json: JSON.stringify({ actionId: 0 }) },
      { seat: 1, source: 'primary', turn: 1, anchor_sequence: 2, response_json: JSON.stringify({ note: '   ' }) },
      { seat: 1, source: 'primary', turn: 1, anchor_sequence: 3, response_json: 'not json at all' },
    ]]));

    expect(repo.gameAnnotations('g1')).toEqual([]);
  });
});

/** ADR 0022 §7: commentary survives a reload only because `game_reflections` holds it. */
describe('StatsRepository.gameReflections', () => {
  it('rebuilds a stored review, including its moments', () => {
    const repo = new StatsRepository(fakeDb([[
      {
        seat: 2, model: 'test/model', position: 3, summary: 'Ramped well, answered nothing.',
        detail_json: JSON.stringify({
          keyMistakes: [{ turn: 6, what: 'Tapped out', better: 'Held up removal' }],
          keyPlays: [{ turn: 3, what: 'Curved out' }],
          threatRead: 'P1 was the threat from turn 5.',
        }),
      },
    ]]));

    expect(repo.gameReflections('g1')).toEqual([
      {
        seat: 'P2', position: 3, model: 'test/model', summary: 'Ramped well, answered nothing.',
        keyMistakes: [{ turn: 6, what: 'Tapped out', better: 'Held up removal' }],
        keyPlays: [{ turn: 3, what: 'Curved out' }],
        threatRead: 'P1 was the threat from turn 5.',
      },
    ]);
  });

  it('degrades to empty lists on a row whose detail JSON is unreadable', () => {
    // A stored blob may predate a shape change; the summary is still worth showing.
    const repo = new StatsRepository(fakeDb([[
      { seat: 1, model: null, position: 1, summary: 'I won.', detail_json: 'not json' },
    ]]));

    expect(repo.gameReflections('g1')).toEqual([
      {
        seat: 'P1', position: 1, model: '', summary: 'I won.',
        keyMistakes: [], keyPlays: [], threatRead: '',
      },
    ]);
  });
});

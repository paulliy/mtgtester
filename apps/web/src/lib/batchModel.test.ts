import { describe, expect, it } from 'vitest';
import type { BatchAggregate, BatchGameSummary } from '@mtg/shared';
import {
  aiDetail,
  compactCount,
  fraction,
  gameRows,
  plural,
  runLabel,
  seatLetter,
  seatRows,
  splitSegments,
  statusTag,
} from './batchModel';

const aggregate = (patch: Partial<BatchAggregate> = {}): BatchAggregate => ({
  gamesRequested: 4,
  gamesFinished: 4,
  gamesFailed: 0,
  averageTurns: 10,
  winsBySeat: [
    { seat: 'P1', wins: 3 },
    { seat: 'P3', wins: 1 },
  ],
  placementsBySeat: [{ seat: 'P1', averagePosition: 1.5 }],
  ai: { calls: 0, promptTokens: 0, responseTokens: 0, costUsd: 0 },
  ...patch,
});

const game = (patch: Partial<BatchGameSummary>): BatchGameSummary => ({
  gameId: 'g',
  scenarioId: 's',
  scenarioName: 'Scenario',
  gameIndex: 0,
  seed: 'seed',
  status: 'finished',
  winnerSeat: 'P2',
  turnCount: 12,
  lastRecordedTurn: 12,
  standings: [
    { seat: 'P3', label: 'c', position: 2, lossReason: null },
    { seat: 'P2', label: 'b', position: 1, lossReason: null },
    { seat: 'P1', label: 'a', position: null, lossReason: null },
  ],
  failureReason: null,
  startedAt: null,
  endedAt: null,
  ...patch,
});

describe('batch model', () => {
  it('prints seats as letters and counts in the right number', () => {
    expect(seatLetter('P1')).toBe('A');
    expect(seatLetter('P4')).toBe('D');
    expect(seatLetter(null)).toBe('—');
    expect(plural(1, 'win')).toBe('1 win');
    expect(plural(0, 'win')).toBe('0 wins');
    expect(plural(1, 'game')).toBe('1 game');
  });

  it('labels a run by its name, else its scenarios', () => {
    expect(runLabel('  Seat test ', ['a'])).toBe('Seat test');
    expect(runLabel(null, ['Built-in baseline', 'AI comparison'])).toBe(
      'Built-in baseline + AI comparison',
    );
    expect(runLabel('   ', [])).toBe('Untitled run');
  });

  it('maps every status to a tag', () => {
    expect(statusTag('completed')).toEqual({ label: 'Finished', tone: 'finished' });
    expect(statusTag('running').tone).toBe('running');
    expect(statusTag('queued').tone).toBe('running');
    expect(statusTag('failed').tone).toBe('failed');
    expect(statusTag('cancelled').tone).toBe('cancelled');
  });

  it('scales progress and formats token counts', () => {
    expect(fraction(1, 4)).toBe(0.25);
    expect(fraction(1, 0)).toBe(0);
    expect(fraction(9, 4)).toBe(1);
    expect(compactCount(420)).toBe('420');
    expect(compactCount(12_340)).toBe('12.3K');
    expect(compactCount(1_900_000)).toBe('1.9M');
    expect(aiDetail({ calls: 0, promptTokens: 0, responseTokens: 0, costUsd: 0 })).toBe('calls');
    expect(aiDetail({ calls: 1, promptTokens: 500, responseTokens: 500, costUsd: 0.1 })).toBe(
      '1 call · 1.0K tokens',
    );
  });

  it('gives every seat a row scaled to finished games, and splits only winners', () => {
    const rows = seatRows(aggregate());
    expect(rows.map((row) => [row.letter, row.wins, row.share])).toEqual([
      ['A', 3, 0.75],
      ['B', 0, 0],
      ['C', 1, 0.25],
      ['D', 0, 0],
    ]);
    expect(rows[0]?.averagePosition).toBe(1.5);
    expect(rows[1]?.averagePosition).toBeNull();
    expect(splitSegments(aggregate())).toEqual([
      { letter: 'A', wins: 3 },
      { letter: 'C', wins: 1 },
    ]);
    expect(
      seatRows(aggregate({ gamesFinished: 0, winsBySeat: [] })).every((r) => r.share === 0),
    ).toBe(true);
  });

  it('builds game rows with finish order, failed rows and the failed-only filter', () => {
    const games = [
      game({ gameId: 'a' }),
      game({
        gameId: 'b',
        status: 'failed',
        winnerSeat: null,
        turnCount: null,
        lastRecordedTurn: 7,
        failureReason: 'AI budget ran out',
      }),
      game({
        gameId: 'c',
        status: 'running',
        winnerSeat: null,
        turnCount: null,
        lastRecordedTurn: 3,
      }),
      game({
        gameId: 'd',
        status: 'abandoned',
        winnerSeat: null,
        turnCount: null,
        lastRecordedTurn: null,
      }),
    ];
    const all = gameRows(games, 'all');
    expect(all[0]).toMatchObject({
      index: '001',
      winner: 'B',
      turns: '12',
      order: 'B · C',
      failed: false,
    });
    expect(all[1]).toMatchObject({
      winner: '×',
      turns: '7',
      order: 'AI budget ran out',
      failed: true,
    });
    expect(all[2]).toMatchObject({
      winner: '·',
      turns: '3',
      order: 'In progress',
      running: true,
      failed: false,
    });
    expect(all[3]).toMatchObject({ failed: true, turns: '—', order: 'Stopped (abandoned)' });
    expect(gameRows(games, 'failed').map((row) => row.gameId)).toEqual(['b', 'd']);
  });
});

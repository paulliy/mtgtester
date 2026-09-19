/**
 * Game persistence (brief §9). Exercised against a fake `SqliteLike` rather than a real
 * database: `bun:sqlite` cannot be imported under the Vitest runner, which is exactly why the
 * SQL lives behind that interface.
 */

import { describe, expect, it } from 'vitest';
import type { GameEvent, GameResult, SpectatorState } from '@mtg/shared';
import { finishingPositions, GameRecorder, seatIndex, type SqliteLike } from './games';

interface Call {
  sql: string;
  args: unknown[];
}

/** Records every statement, and answers `get`/`all` from a scripted queue. */
function fakeDb(responses: { get?: unknown[]; all?: unknown[][] } = {}): {
  db: SqliteLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const gets = [...(responses.get ?? [])];
  const alls = [...(responses.all ?? [])];
  const db: SqliteLike = {
    query(sql: string) {
      return {
        run: (...args: unknown[]) => {
          calls.push({ sql, args });
        },
        all: (...args: unknown[]) => {
          calls.push({ sql, args });
          return alls.shift() ?? [];
        },
        get: (...args: unknown[]) => {
          calls.push({ sql, args });
          return gets.shift() ?? null;
        },
      };
    },
  };
  return { db, calls };
}

const state = (turn: number): SpectatorState =>
  ({
    gameId: 'g1',
    seed: 's',
    turnNumber: turn,
    activePlayer: 'P1',
    priorityPlayer: null,
    monarchSeat: null,
    phase: 'precombatMain',
    step: null,
    seats: [],
    battlefield: [],
    exile: [],
    stack: [],
    turnOrder: [],
    seating: [],
    eliminatedPlayers: [],
    commanderDamage: [],
  }) satisfies SpectatorState;

describe('seatIndex', () => {
  it('maps the "P<n>" seat ids to the integer column', () => {
    expect(seatIndex('P1')).toBe(1);
    expect(seatIndex('P4')).toBe(4);
    expect(seatIndex('nonsense')).toBe(0);
  });
});

describe('finishingPositions', () => {
  it('ranks a finished game: first eliminated is last, winner is first', () => {
    // `[...eliminatedPlayers, winner]` — the order `flow/game.ts` builds.
    const positions = finishingPositions(['P3', 'P1', 'P4', 'P2'], 4);

    expect(positions.get('P3')).toBe(4);
    expect(positions.get('P1')).toBe(3);
    expect(positions.get('P4')).toBe(2);
    expect(positions.get('P2')).toBe(1);
  });

  it('ranks against the seat count, not the array length, so a halt does not invent a winner', () => {
    // Two players were knocked out and then the game halted: nobody won.
    const positions = finishingPositions(['P3', 'P1'], 4);

    expect(positions.get('P3')).toBe(4);
    expect(positions.get('P1')).toBe(3);
    // The two survivors did not finish. Recording them as tied for first would invent a
    // result the game never produced (brief §4 — a halt is a probable rules bug, not an outcome).
    expect(positions.has('P2')).toBe(false);
    expect(positions.has('P4')).toBe(false);
  });
});

describe('GameRecorder', () => {
  it('opens the game row and a row per seat', () => {
    const { db, calls } = fakeDb();
    new GameRecorder(db, 'g1').start('seed-x', [
      { seat: 'P1', deckSnapshotId: 'snap-1' },
      { seat: 'P2', deckSnapshotId: 'snap-2' },
    ]);

    expect(calls[0]?.sql).toContain('INSERT INTO games');
    expect(calls[0]?.args).toContain('seed-x');
    expect(calls.filter((c) => c.sql.includes('INSERT INTO game_players'))).toHaveLength(2);
  });

  it('records single-player mode and each seat controller', () => {
    const { db, calls } = fakeDb();
    new GameRecorder(db, 'g1').start(
      'seed-player',
      [
        { seat: 'P1', deckSnapshotId: 'snap-1', controllerKind: 'human' },
        { seat: 'P2', deckSnapshotId: 'snap-2', controllerKind: 'ai' },
      ],
      'singlePlayer',
    );

    expect(calls[0]?.args.at(-1)).toBe('singlePlayer');
    const players = calls.filter((call) => call.sql.includes('INSERT INTO game_players'));
    expect(players[0]?.args.at(-1)).toBe('human');
    expect(players[1]?.args.at(-1)).toBe('ai');
  });

  it('appends events keyed by sequence, and ignores a replayed flush', () => {
    const { db, calls } = fakeDb();
    const events: GameEvent[] = [
      {
        sequence: 7,
        turn: 2,
        phase: 'combat',
        step: 'declareAttackers',
        actorSeat: 'P2',
        type: 'attackersDeclared',
        payload: { count: 3 },
      },
    ];

    new GameRecorder(db, 'g1').appendEvents(events);

    const insert = calls.find((c) => c.sql.includes('INSERT INTO game_events'));
    expect(insert?.sql).toContain('ON CONFLICT(game_id, sequence) DO NOTHING');
    expect(insert?.args).toEqual([
      'g1',
      7,
      2,
      'combat',
      'declareAttackers',
      2,
      'attackersDeclared',
      '{"count":3}',
    ]);
  });

  it('writes nothing for an empty event batch', () => {
    const { db, calls } = fakeDb();
    new GameRecorder(db, 'g1').appendEvents([]);
    expect(calls).toHaveLength(0);
  });

  it('persists the separate debug trace and raw mana inputs used by Phase 5', () => {
    const { db, calls } = fakeDb();
    const recorder = new GameRecorder(db, 'g1');
    recorder.appendDebug([
      { turn: 3, category: 'sba', message: 'SBA pass stable', data: { checks: 1 } },
    ]);
    recorder.saveManaMetrics([
      {
        seat: 'P1',
        turn: 3,
        landsInHand: 2,
        landsDrawnCumulative: 4,
        cardsDrawnCumulative: 8,
        spellsCastable: 1,
        unspentMana: 3,
        onCurve: true,
      },
    ]);

    expect(calls[0]?.sql).toContain('game_debug_events');
    expect(calls[0]?.args).toContain('sba');
    expect(calls[1]?.sql).toContain('mana_metrics');
    expect(calls[1]?.args).toContain(8);
  });

  it('stores the spectator projection as the turn snapshot, and reads it back', () => {
    const snapshot = state(3);
    const { db, calls } = fakeDb({ get: [{ state_json: JSON.stringify(snapshot) }] });
    const recorder = new GameRecorder(db, 'g1');

    recorder.saveTurnSnapshot(3, snapshot);
    const loaded = recorder.loadTurnSnapshot(3);

    expect(calls[0]?.sql).toContain('INSERT INTO game_state_snapshots');
    expect(loaded?.turnNumber).toBe(3);
  });

  it('returns null for a turn that has no snapshot — scrubbing forward is refused, not computed', () => {
    const { db } = fakeDb({ get: [null] });
    expect(new GameRecorder(db, 'g1').loadTurnSnapshot(99)).toBeNull();
  });

  it('closes the game row and fills in each seat outcome', () => {
    const { db, calls } = fakeDb();
    const result: GameResult = {
      gameId: 'g1',
      winnerSeat: 'P2',
      finishingOrder: ['P3', 'P1', 'P4', 'P2'],
      turnCount: 17,
      halted: false,
      haltReason: null,
    };

    new GameRecorder(db, 'g1').finish(result, 'finished', [
      {
        seat: 'P1',
        lossReason: 'lifeZeroOrLess',
        eliminatedOnTurn: 12,
        eliminatedBySeat: 'P2',
        mulligansTaken: 1,
        openingHandSize: 7,
      },
      {
        seat: 'P2',
        lossReason: null,
        eliminatedOnTurn: null,
        eliminatedBySeat: null,
        mulligansTaken: 0,
        openingHandSize: 7,
      },
      {
        seat: 'P3',
        lossReason: 'commanderDamage',
        eliminatedOnTurn: 9,
        eliminatedBySeat: 'P2',
        mulligansTaken: 0,
        openingHandSize: 7,
      },
      {
        seat: 'P4',
        lossReason: 'lifeZeroOrLess',
        eliminatedOnTurn: 15,
        eliminatedBySeat: 'P2',
        mulligansTaken: 2,
        openingHandSize: 7,
      },
    ]);

    const update = calls.find((c) => c.sql.includes('UPDATE games'));
    expect(update?.args).toContain(17);
    expect(update?.args).toContain(2); // winner_seat is the integer form of "P2"
    expect(update?.args).toContain('finished');

    const seatUpdates = calls.filter((c) => c.sql.includes('UPDATE game_players'));
    expect(seatUpdates).toHaveLength(4);
    // P3 was eliminated first, so it finished 4th.
    expect(seatUpdates[2]?.args[0]).toBe(4);
    // P2 won.
    expect(seatUpdates[1]?.args[0]).toBe(1);
  });

  it('can close a game row without a result, so a halt never leaves it reading "running"', () => {
    const { db, calls } = fakeDb();
    new GameRecorder(db, 'g1').markStatus('halted');

    expect(calls[0]?.sql).toContain('UPDATE games SET status');
    expect(calls[0]?.args[0]).toBe('halted');
  });
});

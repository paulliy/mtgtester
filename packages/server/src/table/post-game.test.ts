/**
 * The post-game reader (plan M3 task 3) over a fake store: it claims no more than was committed.
 */

import { describe, expect, it } from 'vitest';
import { PLAYER_HALT_TEXT } from '@mtg/engine';
import type { GameEvent, SpectatorState } from '@mtg/shared';
import type { TableAttemptManifest } from '../db/tables';
import { createPostGameReader, type PostGameStore } from './post-game';

const MANIFEST: TableAttemptManifest = {
  tableId: 't1',
  attemptId: 'a1',
  gameId: 'g1',
  rngKey: 'ab'.repeat(32),
  seats: [
    {
      seat: 'P1',
      controller: 'human',
      displayName: 'Ann',
      decklist: 'Commander\nGen A\n\nDeck\n30 Forest',
    },
    { seat: 'P2', controller: 'bot' },
  ],
  limits: { maxStepWork: 1, maxObjects: 1, turnCap: null },
  identity: { cardDataSha256: null, buildCommit: null, buildDirty: null },
};

const state = (turn: number) => ({ turnNumber: turn }) as unknown as SpectatorState;

const HALT: GameEvent = {
  sequence: 9,
  turn: 2,
  phase: 'precombatMain',
  step: null,
  actorSeat: null,
  type: 'engineHalt',
  payload: { reason: 'TypeError: x is undefined at resolve.ts:1693' },
};

function store(options: { game: boolean; turns: number[] }): PostGameStore {
  return {
    tables: () => ({
      attempt: (attemptId) =>
        attemptId === 'a1'
          ? { manifest: MANIFEST, status: 'workerFailure', createdAt: '', endedAt: null }
          : null,
      gameExists: () => options.game,
      gameDecks: () => [
        { seat: 'P2', commanderNames: ['Bot Gen'], cards: [{ name: 'Island', quantity: 30 }] },
      ],
    }),
    recorderFor: () => ({
      snapshotTurns: () => options.turns,
      loadTurnSnapshot: (turn: number) => (options.turns.includes(turn) ? state(turn) : null),
      loadEvents: () => [HALT],
    }),
  };
}

describe('createPostGameReader', () => {
  it('lists the committed turns, every deck and the key, and unlocks from the last snapshot', async () => {
    const reader = createPostGameReader(store({ game: true, turns: [0, 1, 2] }));
    const { results, unlock } = await reader.results({
      tableId: 't1',
      attemptId: 'a1',
      ending: 'workerFailure',
      result: null,
    });
    expect(results).toEqual({
      ending: 'workerFailure',
      result: null,
      rngKey: MANIFEST.rngKey,
      replayTurns: [0, 1, 2],
      decks: [
        {
          seat: 'P1',
          controller: 'human',
          displayName: 'Ann',
          commanderNames: ['Gen A'],
          cards: [{ name: 'Forest', quantity: 30 }],
        },
        {
          seat: 'P2',
          controller: 'bot',
          displayName: null,
          commanderNames: ['Bot Gen'],
          cards: [{ name: 'Island', quantity: 30 }],
        },
      ],
    });
    expect(unlock?.frontierTurn).toBe(2);
    expect(unlock?.state).toEqual(state(2));
    // The raw halt reason never reaches a player, after the game as during it.
    expect(unlock?.lines.map((line) => line.text)).toEqual([`ENGINE HALT — ${PLAYER_HALT_TEXT}`]);
    expect(await reader.turn({ tableId: 't1', attemptId: 'a1', turn: 1 })).toEqual(state(1));
    expect(await reader.turn({ tableId: 't1', attemptId: 'a1', turn: 7 })).toBeNull();
  });

  it('has the decklists and the key but no replay when the worker never created the game', async () => {
    const reader = createPostGameReader(store({ game: false, turns: [] }));
    const { results, unlock } = await reader.results({
      tableId: 't1',
      attemptId: 'a1',
      ending: 'setupFailed',
      result: null,
    });
    expect(unlock).toBeNull();
    expect(results.replayTurns).toEqual([]);
    expect(results.rngKey).toBe(MANIFEST.rngKey);
    expect(results.decks.map((deck) => deck.commanderNames)).toEqual([['Gen A'], []]);
    expect(await reader.turn({ tableId: 't1', attemptId: 'a1', turn: 0 })).toBeNull();
  });

  it("refuses another table's attempt", async () => {
    const reader = createPostGameReader(store({ game: true, turns: [0] }));
    const { results, unlock } = await reader.results({
      tableId: 'other',
      attemptId: 'a1',
      ending: 'gameOver',
      result: null,
    });
    expect(results.rngKey).toBeNull();
    expect(unlock).toBeNull();
    expect(await reader.turn({ tableId: 'other', attemptId: 'a1', turn: 0 })).toBeNull();
  });
});

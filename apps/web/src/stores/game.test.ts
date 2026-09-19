/**
 * The playback position logic in the spectator store.
 *
 * Every case below is a bug the Phase 4 store had. It answered "where am I in the log?" by
 * turn rather than by position, which made stepping back move *forward*, and it fell back to
 * index 0 — the first action of the game — whenever no line matched. It also carried
 * `activeSequence` across games, and sequence numbers restart at 0, so a leftover value matched
 * an unrelated action in the next game.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ClientToServerMessage, ServerToClientMessage, SpectatorLogLine } from '@mtg/shared';

/** Frames the store handed to the socket, newest last. */
const sent: ClientToServerMessage[] = [];
/** The store's own inbound handler, captured when it constructs its socket. */
let inbound: ((message: ServerToClientMessage) => void) | null = null;

vi.mock('../lib/socket', () => ({
  GameSocket: class {
    constructor(onMessage: (message: ServerToClientMessage) => void) {
      inbound = onMessage;
    }
    connect(): void {}
    send(message: ClientToServerMessage): void {
      sent.push(message);
    }
    close(): void {}
  },
}));

const { useGameStore } = await import('./game');

function line(sequence: number, turn: number, text: string): SpectatorLogLine {
  return { sequence, turn, actorSeat: 'P1', text };
}

const LOG: SpectatorLogLine[] = [
  line(10, 1, '— turn 1 — P1'),
  line(12, 1, 'plays Forest'),
  line(14, 1, 'Cast Grizzly Bears'),
  line(18, 2, '— turn 2 — P2'),
  line(21, 2, 'plays Island'),
  line(25, 3, '— turn 3 — P3'),
];

type Store = ReturnType<typeof useGameStore>;

/** Put the viewer at a position without going through the wire. */
function seed(store: Store, viewTurn: number, active: number | null): void {
  store.log = [...LOG];
  store.viewTurn = viewTurn;
  store.frontierTurn = 3;
  store.activeSequence = active;
  store.playbackMode = 'manual';
  sent.length = 0;
}

/** The `jumpToTurn` payloads the store emitted. */
function jumps(): Array<{ turn: number; sequence?: number }> {
  return sent
    .filter(
      (m): m is Extract<ClientToServerMessage, { type: 'jumpToTurn' }> => m.type === 'jumpToTurn',
    )
    .map((m) => m.payload);
}

describe('spectator store — where am I in the action log', () => {
  let store: Store;

  beforeEach(() => {
    setActivePinia(createPinia());
    sent.length = 0;
    inbound = null;
    store = useGameStore();
    store.connect();
  });

  it('steps forward to the next line and back to the previous one', () => {
    seed(store, 1, 12); // sitting on "plays Forest"
    store.stepAction(1);
    expect(jumps().at(-1)).toEqual({ turn: 1, sequence: 14 });

    seed(store, 1, 14);
    store.stepAction(-1);
    expect(jumps().at(-1)).toEqual({ turn: 1, sequence: 12 });

    // Backwards across a turn boundary lands on the previous turn's last line.
    seed(store, 2, 18);
    store.stepAction(-1);
    expect(jumps().at(-1)).toEqual({ turn: 1, sequence: 14 });
  });

  it('steps into a turn rather than past it, when sitting on a turn boundary', () => {
    // Arrived by scrubbing to turn 2, so no confirmed line: the position is the *start* of
    // turn 2, and one step forward is turn 2's first line. The old logic treated turn 2's
    // *last* line as "current" and stepped past the whole turn.
    seed(store, 2, null);
    store.stepAction(1);
    expect(jumps().at(-1)).toEqual({ turn: 2, sequence: 18 });

    // And one step back is the previous turn's last line, not the first line of the game.
    seed(store, 2, null);
    store.stepAction(-1);
    expect(jumps().at(-1)).toEqual({ turn: 1, sequence: 14 });
  });

  it('never jumps to the start of the game just because nothing matched', () => {
    // Past the end of the log: there is nowhere forward to go, so nothing is sent.
    seed(store, 3, 25);
    expect(store.canStepAction(1)).toBe(false);
    store.stepAction(1);
    expect(jumps()).toEqual([]);

    // Before the first line: back is unavailable, forward reaches line 0.
    seed(store, 0, null);
    expect(store.canStepAction(-1)).toBe(false);
    expect(store.canStepAction(1)).toBe(true);
    store.stepAction(1);
    expect(jumps().at(-1)).toEqual({ turn: 1, sequence: 10 });
  });

  it('offers action steps at the frontier and after the game is over', () => {
    seed(store, 3, 21);
    // The old control gated action steps on `viewTurn < frontierTurn || isRunning`, so both
    // buttons died at the frontier and stayed dead once the game ended.
    expect(store.viewTurn).toBe(store.frontierTurn);
    expect(store.canStepAction(1)).toBe(true);
    expect(store.canStepAction(-1)).toBe(true);
  });

  it('leaves live mode when the user seeks, instead of being overridden by it', () => {
    seed(store, 1, 12);
    store.playbackMode = 'live';
    store.stepAction(1);

    const modes = sent.filter((m) => m.type === 'setPlaybackMode');
    expect(modes.at(-1)?.payload).toMatchObject({ mode: 'manual' });
    expect(store.playbackMode).toBe('manual');
    expect(jumps().at(-1)).toEqual({ turn: 1, sequence: 14 });
  });
});

describe('spectator store — server-confirmed position', () => {
  let store: Store;

  beforeEach(() => {
    setActivePinia(createPinia());
    sent.length = 0;
    store = useGameStore();
    store.connect();
  });

  function snapshot(turn: number, sequence: number | null): ServerToClientMessage {
    return {
      type: 'stateSnapshot',
      payload: {
        turn,
        sequence,
        frontierTurn: 9,
        atFrontier: false,
        state: { turnNumber: turn, seats: [], battlefield: [] } as never,
      },
    };
  }

  it('highlights a log line only when the server served that exact board', () => {
    seed(store, 1, null);
    inbound?.(snapshot(2, 18));
    expect(store.activeSequence).toBe(18);

    // A seek the server could not serve exactly comes back with `sequence: null`; the
    // highlight must clear rather than claim a position the board is not at.
    inbound?.(snapshot(2, null));
    expect(store.activeSequence).toBeNull();
  });

  it("drops the previous game's position when a new game starts", () => {
    seed(store, 2, 18);
    expect(store.activeSequence).toBe(18);

    inbound?.({
      type: 'gameStarted',
      payload: {
        gameId: 'g2',
        seed: 'abc',
        seats: [],
        providerKind: 'random',
        startedAt: new Date().toISOString(),
      },
    });

    // Sequence numbers restart at 0 in the new game, so a stale one would match an unrelated
    // action and throw the viewer there.
    expect(store.activeSequence).toBeNull();
    expect(store.log).toEqual([]);
    expect(store.viewTurn).toBe(0);
    expect(store.canStepAction(1)).toBe(false);
  });

  it('starts a player game at the next meaningful choice without racing a second frame', () => {
    sent.length = 0;
    store.startGame(
      Array.from({ length: 4 }, (_, index) => ({ kind: 'pool' as const, seed: `seat-${index}` })),
      'random',
      'game-seed',
      'singlePlayer',
      'P1',
    );

    expect(sent.map((message) => message.type)).toEqual(['startGame']);
    expect(sent[0]?.payload).toMatchObject({ paceMs: 0 });
    inbound?.({
      type: 'gameStarted',
      payload: {
        gameId: 'g-player',
        seed: 'game-seed',
        seats: [],
        providerKind: 'random',
        gameMode: 'singlePlayer',
        humanSeat: 'P1',
        sessionToken: 'resume-token',
        controllers: [],
        startedAt: new Date().toISOString(),
      },
    });
    expect(sent.map((message) => message.type)).toEqual(['startGame']);
  });
});

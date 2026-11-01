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
import type { ClientToServerMessage, SpectatorLogLine } from '@mtg/shared';
import type { ServerToClientMessage, PlayerActionRequiredPayload } from '../lib/protocol';
import type { ConnectionState } from '../lib/socket';

/** Frames the store handed to the socket, newest last. */
const sent: ClientToServerMessage[] = [];
/** The store's own inbound handler, captured when it constructs its socket. */
let inbound: ((message: ServerToClientMessage) => void) | null = null;
/** The store's own connection-state handler, so a test can drop the connection. */
let connectionChanged: ((state: ConnectionState) => void) | null = null;

vi.mock('../lib/socket', () => ({
  GameSocket: class {
    constructor(
      onMessage: (message: ServerToClientMessage) => void,
      onStateChange: (state: ConnectionState) => void,
    ) {
      inbound = onMessage;
      connectionChanged = onStateChange;
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

/** The `Play my deck` start: a generated human deck, three pod seats, and the pod's own name. */
function startWithPod(store: Store, pod: string): void {
  store.startGame(
    Array.from({ length: 4 }, () => ({ kind: 'pool' as const })),
    'random',
    'pod-seed',
    'singlePlayer',
    'P1',
    false,
    'preview-1',
    pod,
  );
}

/** A start the server accepted, as it answers it. */
function podGameStarted(gameId: string): Extract<ServerToClientMessage, { type: 'gameStarted' }> {
  return {
    type: 'gameStarted',
    payload: {
      gameId,
      seed: 'pod-seed',
      seats: [],
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      startedAt: new Date().toISOString(),
    },
  };
}

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
    connectionChanged = null;
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

describe('spectator store — deals on the board being viewed', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sent.length = 0;
  });

  it('shows the deals in force at the start of a turn picked with the slider', () => {
    const store = useGameStore();
    store.connect();
    const deal = {
      id: 'deal-1',
      proposer: 'P1',
      parties: ['P1', 'P3'] as [string, string],
      obligations: [{ kind: 'noAttack' as const, by: 'P1', against: 'P3' }],
      proposedTurn: 1,
      rounds: 2,
      status: 'proposed' as const,
    };
    store.tableTalk = [
      {
        sequence: 12,
        turn: 1,
        text: '',
        message: { kind: 'proposal', turn: 1, from: 'P1', to: 'P3', deal },
      },
      {
        sequence: 12,
        turn: 1,
        text: '',
        message: {
          kind: 'response',
          turn: 1,
          from: 'P3',
          to: 'P1',
          dealId: 'deal-1',
          answer: 'accept',
        },
      },
      {
        sequence: 25,
        turn: 3,
        text: '',
        message: { kind: 'dealEnded', turn: 3, dealId: 'deal-1', outcome: 'kept' },
      },
    ];
    // At the latest board the deal has ended.
    seed(store, 3, null);
    expect(store.dealsNow).toEqual([]);
    // Scrubbed back to the start of turn 2: agreed on turn 1, not yet ended.
    seed(store, 2, null);
    expect(store.dealsNow.map((d) => d.deal.id)).toEqual(['deal-1']);
    // The start of turn 1 comes before the deal was proposed.
    seed(store, 1, null);
    expect(store.dealsNow).toEqual([]);
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

  it('remembers where the log stood when the player last acted, until the next game', () => {
    store.log = LOG.slice(0, 3);
    store.playerAction = {
      request: {
        requestId: 'r1',
        legalActions: [
          { id: 0, type: 'playLand', description: 'Play Forest' },
          { id: 1, type: 'pass', description: 'Pass priority' },
        ],
      },
      revision: 1,
    } as never;
    expect(store.lastPlayerActionSequence).toBeNull();

    store.submitPlayerAction(0);
    expect(store.lastPlayerActionSequence).toBe(14);

    // Passing is not acting: bot lines since the land play stay summarised.
    store.log = [...LOG];
    store.submitPlayerAction(1);
    expect(store.lastPlayerActionSequence).toBe(14);

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
    expect(store.lastPlayerActionSequence).toBeNull();
  });

  it('sends smart yield and republishes only a matching rejected request for editing', () => {
    store.playerAction = {
      request: { requestId: 'r1', legalActions: [] },
      revision: 3,
    } as unknown as PlayerActionRequiredPayload;
    store.yieldPlayerAbility(7, 'smart');
    expect(sent.at(-1)).toEqual({
      type: 'yieldPlayerAbility',
      payload: { requestId: 'r1', revision: 3, actionId: 7, mode: 'smart' },
    });
    const request = store.playerAction!.request;
    inbound?.({ type: 'error', payload: { message: 'Old error', requestId: 'old', revision: 3 } });
    expect(store.playerAction!.request).toBe(request);
    inbound?.({ type: 'error', payload: { message: 'Retry', requestId: 'r1', revision: 3 } });
    expect(store.playerAction!.request).not.toBe(request);
    expect(store.playerAction!.request.requestId).toBe('r1');
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

  it('does not adopt a table game: the tester viewer has no table UI', () => {
    store.startGame(
      Array.from({ length: 4 }, () => ({ kind: 'pool' as const })),
      'random',
      'game-seed',
      'singlePlayer',
      'P1',
    );
    inbound?.({
      type: 'gameStarted',
      payload: {
        gameId: 'g-table',
        seed: 'game-seed',
        seats: [],
        providerKind: 'random',
        gameMode: 'table',
        startedAt: new Date().toISOString(),
      },
    });

    expect(store.gameId).toBeNull();
    expect(store.gameMode).not.toBe('table');
    expect(store.errors).toEqual(['This viewer cannot join a table game.']);
  });

  it('remembers a newly imported player deck by the snapshot ID returned at start', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    try {
      store.startGame(
        [
          { kind: 'plaintext', text: 'deck' },
          ...Array.from({ length: 3 }, () => ({ kind: 'pool' as const })),
        ],
        'random',
        'seed',
        'singlePlayer',
        'P1',
      );
      inbound?.({
        type: 'gameStarted',
        payload: {
          gameId: 'imported',
          seed: 'seed',
          providerKind: 'random',
          gameMode: 'singlePlayer',
          humanSeat: 'P1',
          startedAt: new Date().toISOString(),
          seats: [
            {
              seat: 'P1',
              deckId: 'snapshot-stable',
              label: 'Deck',
              commanderNames: ['Commander'],
              colorIdentity: ['G'],
              archetypeTag: 'Test',
            },
          ],
        },
      });
      expect(JSON.parse(values.get('mtg-recent-deck-ids') ?? '[]')).toEqual(['snapshot-stable']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('remembers the chosen bot pod only once the server has confirmed the start', () => {
    const values = new Map<string, string>([['mtg-recent-pod-ids', JSON.stringify(['cascade'])]]);
    const podWrites: string[] = [];
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === 'mtg-recent-pod-ids') podWrites.push(value);
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    });
    const pods = (): string[] => JSON.parse(values.get('mtg-recent-pod-ids') ?? '[]') as string[];
    try {
      // Asking to start is not playing it: the pod stays unwritten until the server answers.
      startWithPod(store, 'orbit');
      expect(podWrites).toEqual([]);
      expect(pods()).toEqual(['cascade']);

      // A rejected start leaves the stored history exactly as it was...
      inbound?.({ type: 'error', payload: { message: 'P2 cannot be played — unmodeled.' } });
      expect(podWrites).toEqual([]);
      expect(pods()).toEqual(['cascade']);

      // ...and cannot be written later by the next game that does start.
      inbound?.(podGameStarted('g-unrelated'));
      expect(podWrites).toEqual([]);
      expect(pods()).toEqual(['cascade']);

      // A connection dropped between the request and the answer is the same story.
      startWithPod(store, 'orbit');
      connectionChanged?.('closed');
      inbound?.(podGameStarted('g-dropped'));
      expect(podWrites).toEqual([]);
      expect(pods()).toEqual(['cascade']);

      // Only a start the server confirmed puts the pod at the head of the history.
      startWithPod(store, 'orbit');
      inbound?.(podGameStarted('g-played'));
      expect(pods()).toEqual(['orbit', 'cascade']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not mistake a stale session's refused resume for a refused start", () => {
    const values = new Map<string, string>([['mtg-player-session', 'stale-token']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    try {
      // A browser left with the token of a game the server no longer has.
      store.sessionToken = 'stale-token';
      store.gameMode = 'singlePlayer';
      startWithPod(store, 'orbit');
      // The connection opens: the resume goes out first, ahead of the queued start.
      connectionChanged?.('open');
      expect(sent.map((m) => m.type)).toContain('resumeGame');

      inbound?.({
        type: 'error',
        payload: { message: 'That single-player session is unavailable.' },
      });
      // Not an answer to the start: nothing is reported, and the dead token is forgotten.
      expect(store.errors).toEqual([]);
      expect(store.sessionToken).toBeNull();
      expect(values.has('mtg-player-session')).toBe(false);

      // The start's own answer still lands, and still records what it was asked to remember.
      const started = podGameStarted('fresh-game');
      started.payload.sessionToken = 'fresh-token';
      inbound?.(started);
      expect(store.gameId).toBe('fresh-game');
      expect(store.sessionToken).toBe('fresh-token');
      expect(JSON.parse(values.get('mtg-recent-pod-ids') ?? '[]')).toEqual(['orbit']);

      // A later error is a real one again.
      inbound?.({ type: 'error', payload: { message: 'Not your decision.' } });
      expect(store.errors).toEqual(['Not your decision.']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['deck', 'pod'] as const)(
    'starts a confirmed game when recent %s storage rejects a write',
    (recent) => {
      const values = new Map<string, string>();
      const recentKey = `mtg-recent-${recent}-ids`;
      const setItem = vi.fn((key: string, value: string) => {
        if (key === recentKey) throw new Error('Recent storage unavailable');
        values.set(key, value);
      });
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem,
        removeItem: (key: string) => values.delete(key),
      });
      try {
        seed(store, 2, 18);
        if (recent === 'deck') {
          store.startGame(
            [
              { kind: 'plaintext', text: 'deck' },
              ...Array.from({ length: 3 }, () => ({ kind: 'pool' as const })),
            ],
            'random',
            'confirmed-seed',
            'singlePlayer',
            'P1',
          );
        } else {
          startWithPod(store, 'orbit');
        }

        const confirmed = podGameStarted('confirmed-game');
        confirmed.payload.seed = 'confirmed-seed';
        confirmed.payload.seats = [
          {
            seat: 'P1',
            deckId: 'snapshot-stable',
            label: 'Deck',
            commanderNames: ['Commander'],
            colorIdentity: ['G'],
            archetypeTag: 'Test',
          },
        ];
        confirmed.payload.sessionToken = 'resume-token';
        inbound?.(confirmed);

        expect(setItem).toHaveBeenCalledWith(recentKey, expect.any(String));
        expect(store.gameId).toBe('confirmed-game');
        expect(store.seed).toBe('confirmed-seed');
        expect(store.gameMode).toBe('singlePlayer');
        expect(store.sessionToken).toBe('resume-token');
        expect(values.get('mtg-player-session')).toBe('resume-token');
        expect(store.isRunning).toBe(true);
        expect(store.activeSequence).toBeNull();
        expect(store.log).toEqual([]);
        expect(store.viewTurn).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});

it('rejects late state and log frames from a replaced game', () => {
  setActivePinia(createPinia());
  const store = useGameStore();
  store.connect();
  inbound?.(podGameStarted('replacement'));
  const current = { gameId: 'replacement', turnNumber: 4, seats: [], battlefield: [] } as never;
  inbound?.({
    type: 'stateSnapshot',
    payload: { turn: 4, sequence: 10, frontierTurn: 4, atFrontier: true, state: current },
  });
  inbound?.({
    type: 'stateSnapshot',
    payload: {
      turn: 1,
      sequence: 2,
      frontierTurn: 1,
      atFrontier: true,
      state: { gameId: 'retired', turnNumber: 1, seats: [], battlefield: [] } as never,
    },
  });
  inbound?.({
    type: 'eventBatch',
    payload: {
      gameId: 'retired',
      lines: [line(3, 1, 'retired game log')],
      frontierTurn: 1,
      snapshotTurns: [1],
    },
  });
  expect(store.gameId).toBe('replacement');
  expect(store.state).toEqual(current);
  expect(store.viewTurn).toBe(4);
  expect(store.log.some((entry) => entry.text === 'retired game log')).toBe(false);
});

describe('store — deals with the human seat (ADR 0035 phase 3)', () => {
  const seatState = {
    turn: 2,
    slot: 'turnStart' as const,
    canPropose: true,
    offers: [],
    deals: [],
    trust: [],
    partners: ['P2'],
    maxRounds: 3,
    maxObligationsPerSide: 2,
    attackPlayerShare: 0.5,
  };
  let store: Store;

  beforeEach(() => {
    setActivePinia(createPinia());
    sent.length = 0;
    store = useGameStore();
    store.connect();
    inbound?.(podGameStarted('g1'));
  });

  it('holds an action that may break a deal until the player confirms it', () => {
    store.humanSeat = 'P1';
    inbound?.({
      type: 'diplomacyState',
      payload: {
        gameId: 'g1',
        state: {
          ...seatState,
          deals: [
            {
              id: 'deal-1',
              proposer: 'P2',
              parties: ['P2', 'P1'],
              obligations: [{ kind: 'noAttack', by: 'P1', against: 'P2' }],
              proposedTurn: 1,
              rounds: 1,
              status: 'active',
            },
          ],
        },
      },
    });
    store.playerAction = {
      request: {
        requestId: 'r9',
        legalActions: [
          {
            id: 4,
            type: 'attackDeclaration',
            description: 'Declare attackers',
            targets: [{ slot: 0, options: ['P2', 'P3'] }],
          },
        ],
      },
      revision: 2,
      state: { seats: [{ seat: 'P2', graveyard: [] }], battlefield: [], stack: [] },
    } as never;
    sent.length = 0;

    store.submitPlayerAction(4, [{ slot: 0, choice: 'P2' }]);
    expect(sent).toEqual([]);
    expect(store.dealWarning?.messages[0]).toContain('not to attack P2');

    store.cancelDealWarning();
    expect(store.dealWarning).toBeNull();
    expect(sent).toEqual([]);

    store.submitPlayerAction(4, [{ slot: 0, choice: 'P3' }]);
    expect(sent.map((m) => m.type)).toEqual(['submitPlayerAction']);

    sent.length = 0;
    store.submitPlayerAction(4, [{ slot: 0, choice: 'P2' }]);
    store.confirmDealWarning();
    expect(sent).toEqual([
      {
        type: 'submitPlayerAction',
        payload: {
          requestId: 'r9',
          actionId: 4,
          revision: 2,
          targets: [{ slot: 0, choice: 'P2' }],
        },
      },
    ]);
    expect(store.dealWarning).toBeNull();

    // A warning outlives its decision only until the decision is gone: then confirming sends
    // nothing for whatever comes next.
    store.submitPlayerAction(4, [{ slot: 0, choice: 'P2' }]);
    expect(store.dealWarning).not.toBeNull();
    store.playerAction = {
      ...(store.playerAction as object),
      request: { requestId: 'r10', legalActions: [] },
    } as never;
    sent.length = 0;
    store.confirmDealWarning();
    expect(sent).toEqual([]);
    expect(store.dealWarning).toBeNull();
  });

  it('ignores a draft reading nobody is waiting for', () => {
    inbound?.({ type: 'dealDraft', payload: { text: 'x', terms: null, message: 'late' } });
    expect(store.dealDraft).toBeNull();
    store.requestDealDraft('truce?');
    inbound?.({ type: 'dealDraft', payload: { text: 'truce?', terms: null, message: 'no' } });
    expect(store.dealDraft?.message).toBe('no');
  });

  it('keeps the table state and the outcome of the last answer', () => {
    inbound?.({
      type: 'diplomacyState',
      payload: { gameId: 'g1', state: seatState, outcome: { kind: 'pending' } },
    });
    expect(store.diplomacySeat).toEqual(seatState);
    expect(store.lastDealOutcome).toEqual({ kind: 'pending' });
    inbound?.({
      type: 'diplomacyState',
      payload: { gameId: 'g1', state: { ...seatState, turn: 3 } },
    });
    expect(store.diplomacySeat?.turn).toBe(3);
    expect(store.lastDealOutcome).toEqual({ kind: 'pending' });
  });

  it('ignores state for another game and clears it on a new one', () => {
    inbound?.({ type: 'diplomacyState', payload: { gameId: 'other', state: seatState } });
    expect(store.diplomacySeat).toBeNull();
    inbound?.({ type: 'diplomacyState', payload: { gameId: 'g1', state: seatState } });
    inbound?.(podGameStarted('g2'));
    expect(store.diplomacySeat).toBeNull();
    expect(store.lastDealOutcome).toBeNull();
  });

  it('sends proposals, answers and drafts', () => {
    const terms = {
      to: 'P2' as const,
      obligations: [{ kind: 'noAttack' as const, by: 'P1' as const, against: 'P2' as const }],
      rounds: 2,
    };
    store.proposeDeal(terms);
    store.answerDeal('d1', 'accept');
    store.answerDeal('d2', 'decline', { obligations: terms.obligations, rounds: 1 });
    store.requestDealDraft('leave me alone');
    expect(sent).toEqual([
      { type: 'proposeDeal', payload: terms },
      { type: 'answerDeal', payload: { dealId: 'd1', answer: 'accept' } },
      {
        type: 'answerDeal',
        payload: {
          dealId: 'd2',
          answer: 'decline',
          counter: { obligations: terms.obligations, rounds: 1 },
        },
      },
      { type: 'draftDeal', payload: { text: 'leave me alone' } },
    ]);
    expect(store.dealDraftPending).toBe(true);
    inbound?.({
      type: 'dealDraft',
      payload: { text: 'leave me alone', terms: null, message: 'no' },
    });
    expect(store.dealDraftPending).toBe(false);
    expect(store.dealDraft?.message).toBe('no');
  });

  it('asks for diplomacy at any table when chosen', () => {
    const seats = Array.from({ length: 4 }, () => ({ kind: 'pool' as const }));
    const start = (kind: 'random' | 'ai', mode: 'singlePlayer' | 'spectator'): unknown => {
      sent.length = 0;
      store.startGame(seats, kind, 's', mode, 'P1', false, undefined, undefined, {
        diplomacy: true,
      });
      return (sent.find((m) => m.type === 'startGame') as { payload: { diplomacy?: boolean } })
        .payload.diplomacy;
    };
    expect(start('random', 'singlePlayer')).toBe(true);
    expect(start('random', 'spectator')).toBe(true);
    expect(start('ai', 'singlePlayer')).toBe(true);
    sent.length = 0;
    store.startGame(seats, 'random', 's', 'spectator');
    expect(
      (sent.find((m) => m.type === 'startGame') as { payload: { diplomacy?: boolean } }).payload
        .diplomacy,
    ).toBeUndefined();
  });

  it('merges table talk from a player-mode batch', () => {
    const talk = {
      sequence: 4,
      turn: 1,
      message: { kind: 'threatCall', turn: 1, from: 'P2', leader: 'P3', reasons: [] },
      text: 'P3 is ahead',
    } as never;
    inbound?.({
      type: 'eventBatch',
      payload: { gameId: 'g1', lines: [], frontierTurn: 1, snapshotTurns: [1], tableTalk: [talk] },
    });
    expect(store.tableTalk).toHaveLength(1);
  });
});

it('keeps each batch of cues for the board to animate, and flashes life from them', async () => {
  const { useLifeFlash } = await import('../composables/useLifeFlash');
  const store = useGameStore();
  store.connect();
  inbound?.(podGameStarted('cued'));
  const cues = [
    {
      kind: 'damage' as const,
      sequence: 5,
      sourceId: 'o-3',
      target: { kind: 'player' as const, id: 'P2' },
      amount: 2,
      combat: true,
      group: 0,
    },
    { kind: 'lifeChange' as const, sequence: 5, player: 'P2', delta: -2 },
  ];
  const batch = {
    type: 'eventBatch' as const,
    payload: {
      gameId: 'cued',
      lines: [line(5, 3, 'hit')],
      frontierTurn: 3,
      snapshotTurns: [],
      cues,
    },
  };
  inbound?.(batch);
  expect(store.cueBatch?.cues).toEqual(cues);
  expect(useLifeFlash(() => 'P2').value).toBe('damage');
  // The same cues again are a new batch, so the board animates again.
  const first = store.cueBatch?.id;
  inbound?.(batch);
  expect(store.cueBatch?.id).not.toBe(first);
  // A new game starts with no cues and no flashes.
  inbound?.(podGameStarted('next'));
  expect(store.cueBatch).toBeNull();
  expect(useLifeFlash(() => 'P2').value).toBeNull();
});

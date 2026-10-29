import { describe, it, expect } from 'vitest';
import type {
  DecisionRequest,
  GameResult,
  PlayerBoardState,
  PlayerId,
  ServerToClientMessage,
  SpectatorState,
  TableCapabilities,
  TableResultsPayload,
} from '@mtg/shared';
import { PROTOCOL_VERSION } from '@mtg/shared';
import { makeResolvedDeck } from '../test-factory';
import type { DeckChecker } from './deck-check';
import { TableRegistry } from './registry';
import type {
  TableSessionConfig,
  TableSessionInput,
  TableSessionOutput,
  TableSessionPort,
  TableSetupProblems,
} from './session-port';
import {
  TableSocketHub,
  type AttemptEndStatus,
  type HealthOptions,
  type HubSocket,
  type SocketLimits,
  type PostGameReader,
} from './table-ws';
import type { StartAttempt } from './table';

// ── Harness ─────────────────────────────────────────────────────────────────────────────────

const deckChecker: DeckChecker = (decklist) =>
  decklist.startsWith('bad')
    ? { ok: false, problems: [{ code: 'cardCount', message: 'Deck has 3 cards.' }] }
    : { ok: true, deck: makeResolvedDeck({ commanders: [], cards: [] }) };

type Listener = (output: TableSessionOutput) => void;

/** A scripted port: records what the hub sends it and emits whatever the test says. */
class FakePort implements TableSessionPort {
  readonly sent: TableSessionInput[] = [];
  readonly terminations: string[] = [];
  config: TableSessionConfig | null = null;
  private readonly listeners = new Set<Listener>();
  constructor(readonly generation: number) {}

  start(config: TableSessionConfig): Promise<void> {
    this.config = config;
    return Promise.resolve();
  }
  send(input: TableSessionInput): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }
  onOutput(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Set to make probes go unanswered, as a blocked worker's would. */
  hung = false;
  pings = 0;
  ping(): Promise<void> {
    this.pings += 1;
    return this.hung ? new Promise<void>(() => undefined) : Promise.resolve();
  }
  terminate(reason: 'workerFailure' | 'hostAbandoned'): Promise<void> {
    this.terminations.push(reason);
    if (reason === 'hostAbandoned') {
      this.emit({ type: 'failed', generation: this.generation, reason: 'hostAbandoned' });
    }
    return Promise.resolve();
  }

  emit(output: TableSessionOutput): void {
    for (const listener of [...this.listeners]) listener(output);
  }
  started(): void {
    this.emit({ type: 'started', generation: this.generation });
  }
  seat(seat: PlayerId, message: ServerToClientMessage, generation = this.generation): void {
    this.emit({ type: 'seatFrame', generation, seat, message });
  }
  publicFrame(message: ServerToClientMessage, generation = this.generation): void {
    this.emit({ type: 'publicFrame', generation, message });
  }
  inputs<T extends TableSessionInput['type']>(type: T) {
    return this.sent.filter((input): input is Extract<TableSessionInput, { type: T }> => {
      return input.type === type;
    });
  }
}

class FakeSocket implements HubSocket {
  readonly frames: { type: string; payload: Record<string, unknown> }[] = [];
  closed = false;
  constructor(
    readonly id: string,
    readonly address: string,
  ) {}
  send(text: string): void {
    this.frames.push(JSON.parse(text) as { type: string; payload: Record<string, unknown> });
  }
  close(): void {
    this.closed = true;
  }
  of(type: string) {
    return this.frames.filter((frame) => frame.type === type);
  }
  last(type: string) {
    const frames = this.of(type);
    const frame = frames[frames.length - 1];
    if (frame === undefined) throw new Error(`no ${type} frame received`);
    return frame.payload;
  }
  /** Every frame that is not a lobby `tableState`. */
  nonLobby() {
    return this.frames.filter((frame) => frame.type !== 'tableState');
  }
  errors(): string[] {
    return this.of('error').map((frame) => String(frame.payload['message']));
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface RigOptions {
  buildConfig?: (attempt: StartAttempt, generation: number) => TableSessionConfig;
  postGame?: PostGameReader;
  health?: HealthOptions;
  ended?: Array<{ attemptId: string; status: AttemptEndStatus }>;
  socketLimits?: SocketLimits;
}

function makeRig(options: RigOptions = {}) {
  const clock = { t: 1_000_000 };
  const registry = new TableRegistry({
    deckChecker,
    now: () => clock.t,
    hostSecret: 'host-secret',
  });
  const ports: FakePort[] = [];
  const hub = new TableSocketHub({
    registry,
    portFactory: (generation) => {
      const port = new FakePort(generation);
      ports.push(port);
      return port;
    },
    buildConfig:
      options.buildConfig ??
      ((attempt) => ({
        tableId: attempt.tableId,
        attemptId: attempt.attemptId,
        gameId: 'game-1',
        seed: 'label',
        rngKey: '0'.repeat(64),
        seats: attempt.seats.map((seat) =>
          seat.controller === 'human'
            ? {
                seat: seat.seat,
                controller: 'human' as const,
                displayName: seat.displayName,
                decklist: seat.decklist,
              }
            : { seat: seat.seat, controller: 'bot' as const },
        ),
        maxStepWork: 1000,
        maxObjects: 1000,
        clock: 'off' as const,
        dbPath: ':memory:',
      })),
    ...(options.postGame === undefined ? {} : { postGame: options.postGame }),
    ...(options.health === undefined ? {} : { health: options.health }),
    ...(options.socketLimits === undefined ? {} : { socketLimits: options.socketLimits }),
    ...(options.ended === undefined
      ? {}
      : {
          onAttemptEnded: ({ attemptId }: { attemptId: string }, status: AttemptEndStatus) => {
            options.ended?.push({ attemptId, status });
          },
        }),
  });
  let nextSocket = 0;
  const connect = (tableId: string, address = `10.0.0.${++nextSocket}`): FakeSocket => {
    const socket = new FakeSocket(`sock-${++nextSocket}`, address);
    expect(hub.open(tableId, socket)).toBe(true);
    return socket;
  };
  const send = (socket: FakeSocket, type: string, payload: object = {}): void => {
    hub.message(socket.id, JSON.stringify({ type, payload }));
  };
  const sendRaw = (socket: FakeSocket, text: string): void => hub.message(socket.id, text);
  const newTable = () => {
    const created = registry.create();
    if (!created.ok) throw new Error('table cap');
    return created;
  };
  return { clock, registry, hub, ports, connect, send, sendRaw, newTable };
}
type Rig = ReturnType<typeof makeRig>;

const join = (
  rig: Rig,
  socket: FakeSocket,
  invite: string,
  name: string,
  caps: TableCapabilities = {},
) =>
  rig.send(socket, 'joinTable', {
    inviteCode: invite,
    displayName: name,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: caps,
  });

/** A table with a connected, authenticated host. */
function openTable(rig: Rig) {
  const created = rig.newTable();
  const host = rig.connect(created.tableId);
  rig.send(host, 'hostAuth', { hostToken: created.hostToken });
  return { ...created, host };
}
type Opened = ReturnType<typeof openTable>;

/** Join, claim and approve a seat. Returns the lobby socket and the seat token. */
function seatPlayer(rig: Rig, t: Opened, name: string, seat: PlayerId) {
  const lobby = rig.connect(t.tableId);
  join(rig, lobby, t.inviteCode, name);
  rig.send(lobby, 'requestSeat', { seat, decklist: 'good deck' });
  const claimId = String(lobby.last('claimPending')['claimId']);
  rig.send(t.host, 'hostApprove', { claimId });
  return { lobby, seatToken: String(lobby.last('seatGranted')['seatToken']) };
}

const resume = (rig: Rig, socket: FakeSocket, seatToken: string, caps: TableCapabilities = {}) =>
  rig.send(socket, 'resumeSeat', {
    seatToken,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: caps,
  });

/**
 * A started game: P1 Alice and P2 Bob humans, P3 and P4 bots, a lobby-only Carol, and a game
 * socket for each human bound with `resumeSeat`.
 */
async function startedGame(rig: Rig = makeRig(), aliceCaps: TableCapabilities = {}) {
  const t = openTable(rig);
  const alice = seatPlayer(rig, t, 'Alice', 'P1');
  const bob = seatPlayer(rig, t, 'Bob', 'P2');
  const carol = rig.connect(t.tableId);
  join(rig, carol, t.inviteCode, 'Carol');
  rig.send(t.host, 'hostSetSeat', { seat: 'P3', controller: 'bot' });
  rig.send(t.host, 'hostSetSeat', { seat: 'P4', controller: 'bot' });
  rig.send(t.host, 'hostStart');
  await flush();
  const port = rig.ports[rig.ports.length - 1]!;
  port.started();
  const aliceGame = rig.connect(t.tableId);
  resume(rig, aliceGame, alice.seatToken, aliceCaps);
  const bobGame = rig.connect(t.tableId);
  resume(rig, bobGame, bob.seatToken);
  await flush();
  return { rig, t, port, alice, bob, carol, aliceGame, bobGame };
}

const board = (turn = 1): PlayerBoardState => ({ turnNumber: turn }) as unknown as PlayerBoardState;

const decision = (requestId: string, withData = true): DecisionRequest =>
  ({
    requestId,
    gameId: 'game-1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Priority',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass', ...(withData ? { data: { hidden: 1 } } : {}) },
      { id: 1, type: 'castSpell', description: 'Cast', ...(withData ? { data: { cost: 2 } } : {}) },
    ],
  }) as unknown as DecisionRequest;

const actionRequired = (
  requestId: string,
  revision: number,
  withData = true,
): ServerToClientMessage => ({
  type: 'playerActionRequired',
  payload: {
    request: decision(requestId, withData),
    state: board(),
    revision,
    ignoredAbilities: [],
  },
});

const stateSnapshot = (revision: number, turn = 1): ServerToClientMessage => ({
  type: 'playerStateSnapshot',
  payload: {
    gameId: 'game-1',
    state: board(turn),
    revision,
    connected: true,
    ignoredAbilities: [],
  },
});

const eventBatch = (sequences: number[]): ServerToClientMessage => ({
  type: 'eventBatch',
  payload: {
    gameId: 'game-1',
    lines: sequences.map((sequence) => ({
      sequence,
      turn: 1,
      actorSeat: 'P1' as const,
      text: `line ${sequence}`,
    })),
    frontierTurn: 1,
    snapshotTurns: [],
  },
});

const RESULT: GameResult = {
  gameId: 'game-1',
  winnerSeat: 'P1',
  finishingOrder: ['P4', 'P3', 'P2', 'P1'],
  turnCount: 7,
  halted: false,
  haltReason: null,
};

// ── Message set ─────────────────────────────────────────────────────────────────────────────

describe('the table message set', () => {
  const TESTER_TYPES = [
    'startGame',
    'startCardTestScenario',
    'jumpToTurn',
    'setPlaybackMode',
    'resolveHeldDecision',
    'abandonGame',
    'setDebugFlags',
    'resumeGame',
    'proposeDeal',
    'answerDeal',
    'draftDeal',
  ];

  it('refuses every tester message type, before and during a game', async () => {
    const game = await startedGame();
    const lobby = game.carol;
    for (const socket of [lobby, game.aliceGame]) {
      for (const type of TESTER_TYPES) game.rig.send(socket, type, {});
    }
    expect(game.carol.errors()).toEqual(TESTER_TYPES.map(() => 'Unrecognised message.'));
    expect(game.aliceGame.errors()).toEqual(TESTER_TYPES.map(() => 'Unrecognised message.'));
    // Nothing reached the game but the binding handshake, and the table is still playing.
    expect(
      game.port.sent.every((i) =>
        ['setRawActionData', 'setPlayerConnected', 'resyncPlayer'].includes(i.type),
      ),
    ).toBe(true);
    expect(game.rig.ports).toHaveLength(1);
  });

  it('refuses unreadable frames with one fixed sentence', async () => {
    const rig = makeRig();
    const t = openTable(rig);
    const socket = rig.connect(t.tableId);
    rig.sendRaw(socket, 'not json');
    rig.sendRaw(socket, '{"type":"joinTable","type":"joinTable","payload":{}}');
    rig.sendRaw(socket, '[1,2]');
    rig.sendRaw(socket, JSON.stringify({ type: 'joinTable', payload: {} }));
    rig.sendRaw(socket, 'x'.repeat(300_000));
    expect(socket.errors()).toEqual([
      'Unrecognised message.',
      'Unrecognised message.',
      'Unrecognised message.',
      'Unrecognised message.',
      'Message too large.',
    ]);
  });

  it('answers a stale protocol version with protocolMismatch and nothing else', async () => {
    const rig = makeRig();
    const t = openTable(rig);
    const socket = rig.connect(t.tableId);
    rig.send(socket, 'joinTable', {
      inviteCode: t.inviteCode,
      displayName: 'Old',
      protocolVersion: PROTOCOL_VERSION + 1,
      capabilities: {},
    });
    expect(socket.frames).toHaveLength(1);
    expect(socket.last('protocolMismatch')).toEqual({
      serverVersion: PROTOCOL_VERSION,
      clientVersion: PROTOCOL_VERSION + 1,
    });
    rig.send(socket, 'resumeSeat', {
      seatToken: 'whatever',
      protocolVersion: 0,
      capabilities: {},
    });
    expect(socket.of('protocolMismatch')).toHaveLength(2);
    expect(socket.errors()).toEqual([]);
  });

  it('refuses host messages without hostAuth', async () => {
    const rig = makeRig();
    const t = openTable(rig);
    const stranger = rig.connect(t.tableId);
    join(rig, stranger, t.inviteCode, 'Mallory');
    rig.send(stranger, 'hostSetSeat', { seat: 'P1', controller: 'bot' });
    rig.send(stranger, 'hostRotateInvite');
    rig.send(stranger, 'hostStart');
    rig.send(stranger, 'hostApprove', { claimId: 'x' });
    rig.send(stranger, 'hostKick', { seat: 'P1' });
    rig.send(stranger, 'hostAbandon');
    expect(stranger.errors()).toEqual(Array(6).fill('Only the host can do that.'));
    await flush();
    expect(rig.ports).toHaveLength(0);
    // A wrong host token does not authenticate either.
    rig.send(stranger, 'hostAuth', { hostToken: 'wrong' });
    expect(stranger.errors().at(-1)).toBe('That token is not valid.');
    rig.send(stranger, 'hostStart');
    expect(stranger.errors().at(-1)).toBe('Only the host can do that.');
  });

  it('does not let an unapproved client take a seat or act in a game', async () => {
    const rig = makeRig();
    const t = openTable(rig);
    const alice = seatPlayer(rig, t, 'Alice', 'P1');
    const pending = rig.connect(t.tableId);
    join(rig, pending, t.inviteCode, 'Pending');
    rig.send(pending, 'requestSeat', { seat: 'P2', decklist: 'good deck' });
    // The claim is not an approval: its id is not a seat token.
    const claimId = String(pending.last('claimPending')['claimId']);
    resume(rig, pending, claimId);
    expect(pending.errors().at(-1)).toBe('That token is not valid.');
    rig.send(t.host, 'hostSetSeat', { seat: 'P3', controller: 'bot' });
    rig.send(t.host, 'hostSetSeat', { seat: 'P4', controller: 'bot' });
    rig.send(t.host, 'hostSetSeat', { seat: 'P2', controller: 'bot' });
    rig.send(t.host, 'hostStart');
    await flush();
    const port = rig.ports[0]!;
    port.started();
    rig.send(pending, 'submitPlayerAction', { requestId: 'q1', actionId: 0, revision: 1 });
    expect(pending.errors().at(-1)).toBe('This connection holds no seat.');
    expect(port.inputs('submitPlayerAction')).toEqual([]);
    expect(alice.seatToken.length).toBeGreaterThan(20);
  });

  it('refuses resumeSeat with the token of a kicked player', async () => {
    const rig = makeRig();
    const t = openTable(rig);
    const alice = seatPlayer(rig, t, 'Alice', 'P1');
    rig.send(t.host, 'hostKick', { seat: 'P1' });
    expect(alice.lobby.of('tableClosed')).toHaveLength(1);
    expect(alice.lobby.closed).toBe(true);
    const retry = rig.connect(t.tableId);
    resume(rig, retry, alice.seatToken);
    expect(retry.errors()).toEqual(['That token is not valid.']);
    rig.send(retry, 'submitPlayerAction', { requestId: 'q1', actionId: 0, revision: 1 });
    expect(retry.errors().at(-1)).toBe('This connection holds no seat.');
  });

  it('forwards resumeControl for the bound seat only, and refuses replayTurn before the end', async () => {
    const game = await startedGame();
    game.rig.send(game.aliceGame, 'resumeControl');
    game.rig.send(game.carol, 'resumeControl');
    game.rig.send(game.aliceGame, 'replayTurn', { turn: 1 });
    expect(game.port.inputs('resumeControl')).toEqual([{ type: 'resumeControl', seat: 'P1' }]);
    expect(game.carol.errors()).toEqual(['This connection holds no seat.']);
    expect(game.aliceGame.errors()).toEqual(['Replay unlocks when the game is over.']);
  });

  it('sends clock and seat status frames to every bound seat, never to a lobby-only socket', async () => {
    const game = await startedGame();
    game.port.emit({
      type: 'tableFrame',
      generation: game.port.generation,
      message: {
        type: 'clockState',
        payload: { seat: 'P2', remainingMs: 70_000, bankMs: 60_000, running: true },
      },
    });
    game.port.emit({
      type: 'tableFrame',
      generation: game.port.generation,
      message: { type: 'seatStatus', payload: { seat: 'P2', connected: false, fallback: true } },
    });
    for (const socket of [game.aliceGame, game.bobGame]) {
      expect(socket.of('clockState')).toHaveLength(1);
      expect(socket.of('seatStatus')).toHaveLength(1);
    }
    expect(game.carol.of('clockState')).toEqual([]);
    expect(game.carol.of('seatStatus')).toEqual([]);
  });
});

// ── Socket binding ──────────────────────────────────────────────────────────────────────────

describe('socket binding', () => {
  it('takes the seat from the binding, never from the payload', async () => {
    const game = await startedGame();
    game.port.seat('P1', actionRequired('req-77', 9));
    const frame = game.aliceGame.last('playerActionRequired');
    const requestId = String((frame['request'] as { requestId: string }).requestId);
    const revision = Number(frame['revision']);

    // A forged seat field is an unknown field: refused, nothing forwarded.
    game.rig.send(game.aliceGame, 'submitPlayerAction', {
      requestId,
      revision,
      actionId: 0,
      seat: 'P2',
    });
    game.rig.send(game.aliceGame, 'yieldPlayerAbility', {
      requestId,
      revision,
      actionId: 0,
      seat: 'P2',
    });
    game.rig.send(game.aliceGame, 'cancelYield', { seat: 'P2' });
    expect(game.aliceGame.errors()).toEqual([
      'Unrecognised message.',
      'Unrecognised message.',
      'Unrecognised message.',
    ]);
    expect(game.port.inputs('submitPlayerAction')).toEqual([]);

    game.rig.send(game.aliceGame, 'submitPlayerAction', { requestId, revision, actionId: 1 });
    // Bob holds P2; the same answer from him does not match his own (empty) pending decision.
    game.rig.send(game.bobGame, 'submitPlayerAction', { requestId, revision, actionId: 1 });
    expect(game.port.inputs('submitPlayerAction')).toEqual([
      {
        type: 'submitPlayerAction',
        seat: 'P1',
        payload: { requestId: 'req-77', revision: 9, actionId: 1 },
      },
    ]);
    expect(game.bobGame.errors()).toEqual(['That decision is stale.']);
    // Table messages with a forged seat are refused too.
    game.rig.send(game.aliceGame, 'hostKick', { seat: 'P2', extra: true });
    expect(game.aliceGame.errors().at(-1)).toBe('Unrecognised message.');
  });

  it('forwards cancelYield and resumePlayerAbility for the bound seat only', async () => {
    const game = await startedGame();
    game.rig.send(game.bobGame, 'cancelYield');
    game.rig.send(game.bobGame, 'resumePlayerAbility', { key: 'k1' });
    expect(game.port.inputs('cancelYield')).toEqual([{ type: 'cancelYield', seat: 'P2' }]);
    expect(game.port.inputs('resumePlayerAbility')).toEqual([
      { type: 'resumePlayerAbility', seat: 'P2', key: 'k1' },
    ]);
    // The seated player's lobby socket was superseded by the game socket and has no seat now.
    game.rig.send(game.alice.lobby, 'cancelYield');
    expect(game.alice.lobby.errors().at(-1)).toBe('This connection holds no seat.');
    expect(game.port.inputs('cancelYield')).toHaveLength(1);
  });

  it('notifies the first socket of a takeover and refuses its answers even with a valid id', async () => {
    const game = await startedGame();
    game.port.seat('P1', actionRequired('req-5', 3));
    const frame = game.aliceGame.last('playerActionRequired');
    const requestId = String((frame['request'] as { requestId: string }).requestId);
    const revision = Number(frame['revision']);

    const second = game.rig.connect(game.t.tableId);
    resume(game.rig, second, game.alice.seatToken);
    await flush();
    expect(game.aliceGame.of('seatTakenOver')).toEqual([
      { type: 'seatTakenOver', payload: { seat: 'P1' } },
    ]);
    expect(game.aliceGame.closed).toBe(true);

    // The superseded socket answers before its close event is delivered.
    game.rig.send(game.aliceGame, 'submitPlayerAction', { requestId, revision, actionId: 1 });
    expect(game.aliceGame.errors().at(-1)).toBe('This connection holds no seat.');
    expect(game.port.inputs('submitPlayerAction')).toEqual([]);

    // The new socket can answer the very same request: resync kept the wire id and revision.
    game.port.seat('P1', actionRequired('req-5', 3));
    const again = second.last('playerActionRequired');
    expect((again['request'] as { requestId: string }).requestId).toBe(requestId);
    expect(again['revision']).toBe(revision);
    game.rig.send(second, 'submitPlayerAction', { requestId, revision, actionId: 1 });
    expect(game.port.inputs('submitPlayerAction')).toHaveLength(1);

    // The old socket's close event neither disconnects the seat nor unbinds the new socket.
    game.rig.hub.close(game.aliceGame.id);
    const disconnects = game.port.inputs('setPlayerConnected').filter((i) => !i.connected);
    expect(disconnects).toEqual([]);
    game.port.seat('P1', eventBatch([1]));
    expect(second.of('eventBatch')).toHaveLength(1);
  });

  it('tells the game a seat is away only when its current socket closes', async () => {
    const game = await startedGame();
    game.rig.hub.close(game.bobGame.id);
    expect(game.port.inputs('setPlayerConnected').filter((i) => i.seat === 'P2')).toEqual([
      { type: 'setPlayerConnected', seat: 'P2', connected: true },
      { type: 'setPlayerConnected', seat: 'P2', connected: false },
    ]);
  });

  it('keeps a connected lobby-only socket out of every live player frame', async () => {
    const game = await startedGame();
    const before = game.carol.frames.length;
    game.port.publicFrame(eventBatch([1, 2]));
    game.port.publicFrame({
      type: 'gameStarted',
      payload: {
        gameId: 'game-1',
        seed: '',
        seats: [],
        providerKind: 'random',
        startedAt: 'now',
      },
    });
    game.port.seat('P1', actionRequired('req-1', 1));
    game.port.seat('P2', stateSnapshot(4));
    // Even a seat frame addressed to a seat nobody holds reaches no one.
    game.port.seat('P3', stateSnapshot(1));
    expect(game.carol.frames.slice(before).filter((f) => f.type !== 'tableState')).toEqual([]);
    expect(game.aliceGame.of('eventBatch')).toHaveLength(1);
    expect(game.bobGame.of('eventBatch')).toHaveLength(1);
    expect(game.aliceGame.of('playerActionRequired')).toHaveLength(1);
    expect(game.bobGame.of('playerActionRequired')).toHaveLength(0);
  });

  it('routes frames only to the socket currently bound to the seat', async () => {
    const game = await startedGame();
    game.port.seat('P2', stateSnapshot(1));
    expect(game.bobGame.of('playerStateSnapshot')).toHaveLength(1);
    expect(game.aliceGame.of('playerStateSnapshot')).toHaveLength(0);
    expect(game.alice.lobby.of('playerStateSnapshot')).toHaveLength(0);
  });

  it('keeps two tables apart', async () => {
    const rig = makeRig();
    const a = await startedGame(rig);
    const b = await startedGame(rig);
    const [portA, portB] = rig.ports;
    expect(portA).not.toBe(portB);
    portA!.seat('P1', actionRequired('req-1', 1));
    portB!.seat('P1', stateSnapshot(2, 5));
    expect(a.aliceGame.of('playerActionRequired')).toHaveLength(1);
    expect(a.aliceGame.of('playerStateSnapshot')).toHaveLength(0);
    expect(b.aliceGame.of('playerActionRequired')).toHaveLength(0);
    expect(b.aliceGame.of('playerStateSnapshot')).toHaveLength(1);
    // Alice's seat token from table A means nothing on table B.
    const stranger = rig.connect(b.t.tableId);
    resume(rig, stranger, a.alice.seatToken);
    expect(stranger.errors()).toEqual(['That token is not valid.']);
    // Input on table A reaches only table A's port.
    const frame = a.aliceGame.last('playerActionRequired');
    const id = String((frame['request'] as { requestId: string }).requestId);
    rig.send(a.aliceGame, 'submitPlayerAction', {
      requestId: id,
      revision: Number(frame['revision']),
      actionId: 0,
    });
    expect(portA!.inputs('submitPlayerAction')).toHaveLength(1);
    expect(portB!.inputs('submitPlayerAction')).toHaveLength(0);
  });
});

// ── Outbound frames ─────────────────────────────────────────────────────────────────────────

describe('outbound frames', () => {
  it('never lets a frame the table policy does not allow reach a socket', async () => {
    const game = await startedGame();
    const forbidden = [
      'stateSnapshot',
      'debugEvents',
      'apiWaiting',
      'decisionPending',
      'replayUnlocked',
      'gameReflections',
      'spectatorState',
      'replayTurnState',
      'somethingNew',
    ];
    for (const type of forbidden) {
      const message = { type, payload: {} } as unknown as ServerToClientMessage;
      game.port.seat('P1', message);
      game.port.publicFrame(message);
    }
    expect(game.aliceGame.nonLobby()).toEqual([]);
    expect(game.bobGame.nonLobby()).toEqual([]);
    expect(game.rig.hub.stats.droppedByPolicy).toBe(forbidden.length * 2);
    game.port.seat('P1', stateSnapshot(1));
    expect(game.aliceGame.of('playerStateSnapshot')).toHaveLength(1);
  });

  it('drops outputs from a generation that is not the current attempt', async () => {
    const game = await startedGame();
    game.port.seat('P1', stateSnapshot(1), game.port.generation + 1);
    game.port.publicFrame(eventBatch([1]), game.port.generation - 1);
    game.port.emit({ type: 'gameOver', generation: 99, result: RESULT });
    expect(game.aliceGame.nonLobby()).toEqual([]);
    expect(game.rig.hub.stats.droppedStale).toBe(3);
    const state = game.carol.last('tableState');
    expect(state['phase']).toBe('playing');
  });

  it('ignores a retired attempt after a corrected retry starts a fresh one', async () => {
    const rig = makeRig();
    const t = openTable(rig);
    const alice = seatPlayer(rig, t, 'Alice', 'P1');
    for (const seat of ['P2', 'P3', 'P4'] as const) {
      rig.send(t.host, 'hostSetSeat', { seat, controller: 'bot' });
    }
    rig.send(t.host, 'hostStart');
    rig.send(t.host, 'hostStart'); // a duplicate start is refused: one attempt, one port
    await flush();
    expect(rig.ports).toHaveLength(1);
    const first = rig.ports[0]!;
    expect(t.host.errors()).toEqual(['That is not possible at this stage of the table.']);
    const problems: TableSetupProblems = {
      P1: [{ code: 'cardCount', message: 'Deck has 3 cards.' }],
    };
    first.emit({ type: 'setupProblems', generation: first.generation, problems });
    await flush();
    // Only the failing seat hears its problems, the table is open again, and its seat is free.
    expect(alice.lobby.last('deckProblems')['problems']).toEqual(problems['P1']);
    expect(t.host.of('deckProblems')).toEqual([]);
    expect(t.host.last('tableState')['phase']).toBe('open');
    expect(first.terminations).toEqual(['workerFailure']);

    rig.send(alice.lobby, 'requestSeat', { seat: 'P1', decklist: 'good deck' });
    rig.send(t.host, 'hostApprove', {
      claimId: String(alice.lobby.last('claimPending')['claimId']),
    });
    const again = { seatToken: String(alice.lobby.last('seatGranted')['seatToken']) };
    rig.send(t.host, 'hostStart');
    await flush();
    expect(rig.ports).toHaveLength(2);
    const second = rig.ports[1]!;
    expect(second.generation).toBe(2);
    expect(second.config?.attemptId).not.toBe(first.config?.attemptId);
    // Late frames from the retired port cannot affect the new attempt.
    const game = rig.connect(t.tableId);
    resume(rig, game, again.seatToken);
    second.started();
    first.seat('P1', stateSnapshot(1), first.generation);
    expect(game.of('playerStateSnapshot')).toHaveLength(0);
    expect(t.host.last('tableState')['phase']).toBe('playing');
  });

  it('rewrites request ids, revisions and log sequences per seat', async () => {
    const game = await startedGame();
    // Engine counters are global: P2's decisions interleave with P1's.
    game.port.seat('P1', actionRequired('req-100', 40));
    game.port.seat('P2', actionRequired('req-101', 41));
    game.port.seat('P2', actionRequired('req-102', 55));
    game.port.seat('P1', actionRequired('req-140', 90));
    const aliceIds = game.aliceGame
      .of('playerActionRequired')
      .map((f) => (f.payload['request'] as { requestId: string }).requestId);
    const bobIds = game.bobGame
      .of('playerActionRequired')
      .map((f) => (f.payload['request'] as { requestId: string }).requestId);
    expect(aliceIds).toEqual(['q1', 'q2']);
    expect(bobIds).toEqual(['q1', 'q2']);
    const aliceRevisions = game.aliceGame
      .of('playerActionRequired')
      .map((f) => f.payload['revision']);
    expect(aliceRevisions).toEqual([1, 2]);

    // Log lines count from 0 for each viewer, whatever the engine's sequence says.
    game.port.publicFrame(eventBatch([31, 32, 90]));
    game.port.seat('P1', eventBatch([91]));
    const sequences = (socket: FakeSocket) =>
      socket
        .of('eventBatch')
        .flatMap((f) => (f.payload['lines'] as { sequence: number }[]).map((l) => l.sequence));
    expect(sequences(game.aliceGame)).toEqual([0, 1, 2, 3]);
    expect(sequences(game.bobGame)).toEqual([0, 1, 2]);

    // No engine id or counter appears anywhere in what the seats were sent.
    for (const socket of [game.aliceGame, game.bobGame]) {
      const text = JSON.stringify(socket.nonLobby());
      expect(text).not.toMatch(/req-\d+/);
    }
  });

  it("sends a board snapshot only when that seat's projection changed", async () => {
    const game = await startedGame();
    game.port.seat('P1', stateSnapshot(10, 1));
    game.port.seat('P1', stateSnapshot(11, 1)); // same board, engine revision moved
    game.port.seat('P1', stateSnapshot(12, 1));
    game.port.seat('P1', stateSnapshot(13, 2)); // changed
    const frames = game.aliceGame.of('playerStateSnapshot');
    expect(frames.map((f) => f.payload['revision'])).toEqual([1, 2]);
    // The cadence of one seat does not move with the other's.
    game.port.seat('P2', stateSnapshot(20, 1));
    expect(game.aliceGame.of('playerStateSnapshot')).toHaveLength(2);
    expect(game.bobGame.of('playerStateSnapshot').map((f) => f.payload['revision'])).toEqual([1]);
  });

  it('pins the answer to the revision sent with the decision', async () => {
    const game = await startedGame();
    game.port.seat('P1', actionRequired('req-7', 12));
    const frame = game.aliceGame.last('playerActionRequired');
    const requestId = String((frame['request'] as { requestId: string }).requestId);
    const revision = Number(frame['revision']);
    // A board snapshot after the decision moves the display revision, not the pinned one.
    game.port.seat('P1', stateSnapshot(13, 2));
    game.rig.send(game.aliceGame, 'submitPlayerAction', {
      requestId,
      revision: revision + 1,
      actionId: 0,
    });
    expect(game.aliceGame.of('error').at(-1)?.payload).toEqual({
      message: 'The board changed; choose again.',
      requestId,
      revision: revision + 1,
    });
    expect(game.port.inputs('submitPlayerAction')).toEqual([]);
    game.rig.send(game.aliceGame, 'submitPlayerAction', { requestId, revision, actionId: 0 });
    expect(game.port.inputs('submitPlayerAction')[0]?.payload).toEqual({
      requestId: 'req-7',
      revision: 12,
      actionId: 0,
    });
    // An id this seat was never shown (Bob's q1 means nothing to Alice's pending q1 mapping).
    game.rig.send(game.aliceGame, 'submitPlayerAction', { requestId: 'q9', revision, actionId: 0 });
    expect(game.aliceGame.errors().at(-1)).toBe('That decision is stale.');
  });

  it('maps an engine rejection back to the wire id the client sent', async () => {
    const game = await startedGame();
    game.port.seat('P1', actionRequired('req-7', 12));
    const frame = game.aliceGame.last('playerActionRequired');
    const requestId = String((frame['request'] as { requestId: string }).requestId);
    const revision = Number(frame['revision']);
    game.rig.send(game.aliceGame, 'submitPlayerAction', { requestId, revision, actionId: 5 });
    game.port.seat('P1', {
      type: 'error',
      payload: {
        message: 'That action is not on the current legal menu.',
        requestId: 'req-7',
        revision: 12,
      },
    });
    game.port.seat('P1', {
      type: 'error',
      payload: { message: 'Other', requestId: 'req-999', revision: 3 },
    });
    expect(game.aliceGame.of('error').map((f) => f.payload)).toEqual([
      { message: 'That action is not on the current legal menu.', requestId, revision },
      { message: 'Other' },
    ]);
  });

  it('strips raw action data unless the seat asked for it, on bind and on every resume', async () => {
    const rig = makeRig();
    const game = await startedGame(rig, { rawActionData: true });
    expect(game.port.inputs('setRawActionData')).toEqual([
      { type: 'setRawActionData', seat: 'P1', enabled: true },
      { type: 'setRawActionData', seat: 'P2', enabled: false },
    ]);
    game.port.seat('P1', actionRequired('req-1', 1, true));
    game.port.seat('P2', actionRequired('req-2', 2, true));
    const dataOf = (socket: FakeSocket) =>
      (
        socket.last('playerActionRequired')['request'] as { legalActions: { data?: unknown }[] }
      ).legalActions.map((a) => a.data);
    expect(dataOf(game.aliceGame)).toEqual([{ hidden: 1 }, { cost: 2 }]);
    expect(dataOf(game.bobGame)).toEqual([undefined, undefined]);

    // A resume declares capabilities afresh; the new socket may not have the old one's.
    const again = game.rig.connect(game.t.tableId);
    resume(game.rig, again, game.alice.seatToken, {});
    await flush();
    expect(game.port.inputs('setRawActionData').at(-1)).toEqual({
      type: 'setRawActionData',
      seat: 'P1',
      enabled: false,
    });
    game.port.seat('P1', actionRequired('req-1', 1, true));
    expect(dataOf(again)).toEqual([undefined, undefined]);
    // The resumed seat is re-sent its view and marked connected.
    expect(game.port.inputs('resyncPlayer').filter((i) => i.seat === 'P1')).toHaveLength(2);
  });

  it('removes a session token from a game start frame', async () => {
    const game = await startedGame();
    game.port.publicFrame({
      type: 'gameStarted',
      payload: {
        gameId: 'game-1',
        seed: '',
        seats: [],
        providerKind: 'random',
        startedAt: 'now',
        sessionToken: 'secret-session',
      },
    });
    expect(JSON.stringify(game.aliceGame.of('gameStarted'))).not.toContain('secret-session');
    expect(game.aliceGame.of('gameStarted')).toHaveLength(1);
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────────────────────

describe('the end of an attempt', () => {
  it('moves the table to playing on started and finished on gameOver, stopping the port', async () => {
    const game = await startedGame();
    expect(game.carol.last('tableState')['phase']).toBe('playing');
    game.port.publicFrame({
      type: 'gameOver',
      payload: { result: RESULT, summary: 'Game over', standings: [] },
    });
    game.port.emit({ type: 'gameOver', generation: game.port.generation, result: RESULT });
    // A racing failure after the result changes nothing.
    game.port.emit({
      type: 'failed',
      generation: game.port.generation,
      reason: 'workerFailure',
    });
    await flush();
    expect(game.aliceGame.of('gameOver')).toHaveLength(1);
    expect(game.carol.last('tableState')['phase']).toBe('finished');
    expect(game.port.terminations).toEqual(['workerFailure']);
    expect(game.carol.errors()).toEqual([]);
    // Nothing more reaches a seat after the terminal output.
    game.port.seat('P1', stateSnapshot(1));
    expect(game.aliceGame.of('playerStateSnapshot')).toHaveLength(0);
    // Input after the end is refused.
    game.rig.send(game.aliceGame, 'cancelYield');
    expect(game.aliceGame.errors().at(-1)).toBe('This connection holds no seat.');
  });

  it('finishes with a fixed message when the worker fails, without inventing a result', async () => {
    const game = await startedGame();
    game.port.emit({
      type: 'failed',
      generation: game.port.generation,
      reason: 'workerFailure',
      detail: 'secret stack trace',
    });
    await flush();
    expect(game.aliceGame.errors()).toEqual(['The game was interrupted by a server fault.']);
    expect(game.carol.errors()).toEqual(['The game was interrupted by a server fault.']);
    expect(JSON.stringify(game.aliceGame.frames)).not.toContain('secret stack trace');
    expect(game.aliceGame.of('gameOver')).toEqual([]);
    expect(game.carol.last('tableState')['phase']).toBe('finished');
  });

  it('finishes as setupFailed when the configuration cannot be built', async () => {
    const rig = makeRig({
      buildConfig: () => {
        throw new Error('manifest write failed');
      },
    });
    const t = openTable(rig);
    seatPlayer(rig, t, 'Alice', 'P1');
    for (const seat of ['P2', 'P3', 'P4'] as const) {
      rig.send(t.host, 'hostSetSeat', { seat, controller: 'bot' });
    }
    rig.send(t.host, 'hostStart');
    await flush();
    expect(t.host.last('tableState')['phase']).toBe('finished');
    expect(t.host.errors()).toEqual(['The game could not be started.']);
    expect(JSON.stringify(t.host.frames)).not.toContain('manifest write failed');
    expect(rig.ports[0]?.terminations).toEqual(['workerFailure']);
  });

  it('ends a game the host abandons through the port', async () => {
    const game = await startedGame();
    game.rig.send(game.t.host, 'hostAbandon');
    game.rig.send(game.t.host, 'hostAbandon');
    await flush();
    expect(game.t.host.errors()).toEqual([
      'The game is already being ended.',
      'The host ended the game.',
    ]);
    expect(game.port.terminations[0]).toBe('hostAbandoned');
    expect(game.carol.last('tableState')['phase']).toBe('finished');
    expect(game.aliceGame.errors()).toEqual(['The host ended the game.']);
  });

  it('applies the board to a seat that binds before the game has started', async () => {
    const rig = makeRig();
    const t = openTable(rig);
    const alice = seatPlayer(rig, t, 'Alice', 'P1');
    for (const seat of ['P2', 'P3', 'P4'] as const) {
      rig.send(t.host, 'hostSetSeat', { seat, controller: 'bot' });
    }
    const early = rig.connect(t.tableId);
    resume(rig, early, alice.seatToken, { rawActionData: true });
    rig.send(t.host, 'hostStart');
    await flush();
    const port = rig.ports[0]!;
    expect(port.sent).toEqual([]); // nothing is sent to a game that has not started
    port.started();
    await flush();
    expect(port.sent.map((i) => i.type)).toEqual([
      'setRawActionData',
      'setPlayerConnected',
      'resyncPlayer',
    ]);
    expect(port.inputs('setRawActionData')[0]?.enabled).toBe(true);
  });
});

// ── Post-game view ──────────────────────────────────────────────────────────────────────────

describe('the post-game view', () => {
  const STATE = { turnNumber: 3 } as unknown as SpectatorState;
  const RESULTS: TableResultsPayload = {
    ending: 'gameOver',
    result: null,
    rngKey: 'ab'.repeat(32),
    decks: [],
    replayTurns: [1, 2, 3],
  };

  /** A reader that records its calls and answers from a fixed record. */
  function reader(turns: Record<number, SpectatorState> = { 3: STATE }) {
    const calls: string[] = [];
    const postGame: PostGameReader = {
      results: (query) => {
        calls.push(`results:${query.ending}`);
        return Promise.resolve({
          results: { ...RESULTS, ending: query.ending, result: query.result },
          unlock: {
            state: STATE,
            lines: [],
            snapshotTurns: [1, 2, 3],
            frontierTurn: 3,
          },
        });
      },
      turn: (query) => {
        calls.push(`turn:${query.turn}`);
        return Promise.resolve(turns[query.turn] ?? null);
      },
    };
    return { postGame, calls };
  }

  async function finishedGame(postGame?: PostGameReader) {
    const game = await startedGame(makeRig(postGame === undefined ? {} : { postGame }));
    game.port.emit({ type: 'gameOver', generation: game.port.generation, result: RESULT });
    await flush();
    await flush();
    return game;
  }

  it('is refused while the game is running, and a full-state frame cannot slip out early', async () => {
    const { postGame, calls } = reader();
    const game = await startedGame(makeRig({ postGame }));
    game.rig.send(game.aliceGame, 'replayTurn', { turn: 3 });
    await flush();
    expect(game.aliceGame.errors()).toEqual(['Replay unlocks when the game is over.']);
    expect(calls).toEqual([]);
    game.port.seat('P1', {
      type: 'replayTurnState',
      payload: { turn: 3 },
    } as unknown as ServerToClientMessage);
    game.port.publicFrame({
      type: 'replayUnlocked',
      payload: {},
    } as unknown as ServerToClientMessage);
    expect(game.aliceGame.of('replayTurnState')).toEqual([]);
    expect(game.aliceGame.of('replayUnlocked')).toEqual([]);
  });

  it('sends each seated socket the results and the replay once the end is committed', async () => {
    const ended: Array<{ attemptId: string; status: AttemptEndStatus }> = [];
    const { postGame, calls } = reader();
    const game = await startedGame(makeRig({ postGame, ended }));
    game.port.emit({ type: 'gameOver', generation: game.port.generation, result: RESULT });
    await flush();
    await flush();
    expect(ended.map((entry) => entry.status)).toEqual(['finished']);
    expect(calls).toEqual(['results:gameOver']);
    for (const socket of [game.aliceGame, game.bobGame]) {
      expect(socket.of('tableResults')).toHaveLength(1);
      expect(socket.of('replayUnlocked')).toHaveLength(1);
      expect(socket.last('tableResults')['rngKey']).toBe(RESULTS.rngKey);
    }
    // A lobby-only socket holds no seat and gets no post-game record.
    expect(game.carol.of('tableResults')).toEqual([]);
  });

  it('sends the post-game record to a seat that resumes after the game', async () => {
    const { postGame } = reader();
    const game = await finishedGame(postGame);
    const late = game.rig.connect(game.t.tableId);
    resume(game.rig, late, game.alice.seatToken);
    expect(late.of('tableResults')).toHaveLength(1);
    expect(late.of('replayUnlocked')).toHaveLength(1);
  });

  it('answers replayTurn for a seated player once the game is finished', async () => {
    const { postGame } = reader();
    const game = await finishedGame(postGame);
    game.rig.send(game.aliceGame, 'replayTurn', { turn: 3 });
    await flush();
    expect(game.aliceGame.of('replayTurnState')).toEqual([
      { type: 'replayTurnState', payload: { turn: 3, state: STATE } },
    ]);
    game.rig.send(game.aliceGame, 'replayTurn', { turn: 9 });
    await flush();
    expect(game.aliceGame.errors()).toContain('That turn is not in the replay.');
    // A lobby-only socket has no seat to read for.
    game.rig.send(game.carol, 'replayTurn', { turn: 3 });
    await flush();
    expect(game.carol.errors()).toEqual(['This connection holds no seat.']);
  });

  it('says the turn is unavailable when no reader is installed', async () => {
    const game = await finishedGame();
    game.rig.send(game.aliceGame, 'replayTurn', { turn: 1 });
    await flush();
    expect(game.aliceGame.errors()).toEqual(['That turn is not in the replay.']);
    expect(game.aliceGame.of('tableResults')).toEqual([]);
  });

  it('records an interruption and shows it without a result', async () => {
    const ended: Array<{ attemptId: string; status: AttemptEndStatus }> = [];
    const { postGame, calls } = reader();
    const game = await startedGame(makeRig({ postGame, ended }));
    game.port.emit({ type: 'failed', generation: game.port.generation, reason: 'workerFailure' });
    await flush();
    await flush();
    expect(ended.map((entry) => entry.status)).toEqual(['workerFailure']);
    expect(calls).toEqual(['results:workerFailure']);
    expect(game.aliceGame.last('tableResults')).toMatchObject({
      ending: 'workerFailure',
      result: null,
    });
  });

  it('commits a rejected start without unlocking anything', async () => {
    const ended: Array<{ attemptId: string; status: AttemptEndStatus }> = [];
    const { postGame, calls } = reader();
    const rig = makeRig({ postGame, ended });
    const t = openTable(rig);
    seatPlayer(rig, t, 'Alice', 'P1');
    rig.send(t.host, 'hostSetSeat', { seat: 'P2', controller: 'bot' });
    rig.send(t.host, 'hostSetSeat', { seat: 'P3', controller: 'bot' });
    rig.send(t.host, 'hostSetSeat', { seat: 'P4', controller: 'bot' });
    rig.send(t.host, 'hostStart');
    await flush();
    const port = rig.ports[0]!;
    port.emit({
      type: 'setupProblems',
      generation: port.generation,
      problems: { P1: [{ code: 'parse', message: 'x' }] },
    });
    await flush();
    await flush();
    expect(ended.map((entry) => entry.status)).toEqual(['rejected']);
    expect(calls).toEqual([]);
  });
});

// ── Worker health ───────────────────────────────────────────────────────────────────────────

describe('worker health', () => {
  /** Timers the test advances by hand. */
  function manualTimers() {
    let now = 0;
    const ticks: Array<{ every: number; next: number; tick: () => void; stopped: boolean }> = [];
    return {
      timers: {
        now: () => now,
        every: (ms: number, tick: () => void) => {
          const entry = { every: ms, next: now + ms, tick, stopped: false };
          ticks.push(entry);
          return () => {
            entry.stopped = true;
          };
        },
      },
      async advance(ms: number) {
        const end = now + ms;
        for (;;) {
          const due = ticks
            .filter((entry) => !entry.stopped && entry.next <= end)
            .sort((a, b) => a.next - b.next)[0];
          if (due === undefined) break;
          now = due.next;
          due.next += due.every;
          due.tick();
          await flush();
        }
        now = end;
      },
      running: () => ticks.filter((entry) => !entry.stopped).length,
    };
  }

  it('keeps a healthy game that waits on a human well past the timeout', async () => {
    const clock = manualTimers();
    const health = { intervalMs: 5_000, timeoutMs: 30_000, timers: clock.timers };
    const game = await startedGame(makeRig({ health }));
    const before = game.aliceGame.frames.length;
    const inputsBefore = game.port.sent.length;
    await clock.advance(120_000);
    expect(game.rig.registry.get(game.t.tableId)?.currentPhase).toBe('playing');
    expect(game.port.pings).toBeGreaterThan(10);
    expect(game.port.terminations).toEqual([]);
    // Probes are never player traffic.
    expect(game.aliceGame.frames.length).toBe(before);
    expect(game.port.sent.length).toBe(inputsBefore);
  });

  it('ends a game whose worker stops answering, while another table keeps running', async () => {
    const clock = manualTimers();
    const ended: Array<{ attemptId: string; status: AttemptEndStatus }> = [];
    const health = { intervalMs: 5_000, timeoutMs: 30_000, timers: clock.timers };
    const rig = makeRig({ health, ended });
    const stuck = await startedGame(rig);
    const healthy = await startedGame(rig);
    stuck.port.hung = true;
    await clock.advance(40_000);
    expect(stuck.port.terminations).toEqual(['workerFailure']);
    expect(rig.registry.get(stuck.t.tableId)?.currentPhase).toBe('finished');
    expect(stuck.aliceGame.errors()).toContain('The game was interrupted by a server fault.');
    expect(ended.map((entry) => entry.status)).toEqual(['workerFailure']);
    expect(rig.hub.stats.unhealthy).toBe(1);
    expect(healthy.port.terminations).toEqual([]);
    expect(rig.registry.get(healthy.t.tableId)?.currentPhase).toBe('playing');
    // The stuck attempt's watchdog stopped; the healthy one's still runs.
    expect(clock.running()).toBe(1);
  });

  it('fails setup, not the game, when a worker hangs before the game starts', async () => {
    const clock = manualTimers();
    const ended: Array<{ attemptId: string; status: AttemptEndStatus }> = [];
    const health = { intervalMs: 5_000, timeoutMs: 30_000, timers: clock.timers };
    const rig = makeRig({ health, ended });
    const t = openTable(rig);
    seatPlayer(rig, t, 'Alice', 'P1');
    for (const seat of ['P2', 'P3', 'P4'] as const) {
      rig.send(t.host, 'hostSetSeat', { seat, controller: 'bot' });
    }
    rig.send(t.host, 'hostStart');
    await flush();
    rig.ports[0]!.hung = true;
    await clock.advance(40_000);
    expect(ended.map((entry) => entry.status)).toEqual(['setupFailed']);
    expect(rig.registry.get(t.tableId)?.currentPhase).toBe('finished');
  });
});

// ── Socket limits (M5) ──────────────────────────────────────────────────────────────────────

describe('socket limits', () => {
  /** Timers the test drives by hand. */
  function limitTimers() {
    let now = 0;
    const due = new Map<number, { at: number; callback: () => void }>();
    let next = 0;
    return {
      timers: {
        now: () => now,
        setTimeout: (callback: () => void, ms: number) => {
          next += 1;
          due.set(next, { at: now + ms, callback });
          return next;
        },
        clearTimeout: (handle: unknown) => {
          due.delete(handle as number);
        },
      },
      advance(ms: number) {
        now += ms;
        for (const [id, entry] of [...due]) {
          if (entry.at <= now) {
            due.delete(id);
            entry.callback();
          }
        }
      },
    };
  }

  it('closes a socket that has not joined, resumed or authenticated in time', () => {
    const clock = limitTimers();
    const rig = makeRig({
      socketLimits: { preAuthMs: 10_000, messagesPerSecond: 20, timers: clock.timers },
    });
    const t = rig.newTable();
    const idle = rig.connect(t.tableId);
    const joined = rig.connect(t.tableId);
    join(rig, joined, t.inviteCode, 'Ann');
    clock.advance(10_000);
    expect(idle.closed).toBe(true);
    expect(idle.errors()).toEqual(['Join the table first.']);
    expect(joined.closed).toBe(false);
    expect(rig.hub.stats.preAuthClosed).toBe(1);
  });

  it('closes a socket that sends frames too fast, and lets a steady one through', () => {
    const clock = limitTimers();
    const rig = makeRig({
      socketLimits: { preAuthMs: 10_000, messagesPerSecond: 5, timers: clock.timers },
    });
    const t = rig.newTable();
    const steady = rig.connect(t.tableId);
    join(rig, steady, t.inviteCode, 'Ann');
    for (let i = 0; i < 20; i++) {
      clock.advance(250);
      rig.send(steady, 'leaveSeat');
    }
    expect(steady.closed).toBe(false);
    const flood = rig.connect(t.tableId);
    join(rig, flood, t.inviteCode, 'Bo');
    for (let i = 0; i < 6; i++) rig.send(flood, 'leaveSeat');
    expect(flood.closed).toBe(true);
    expect(rig.hub.stats.rateClosed).toBe(1);
  });

  it('refuses a seat bounced between sockets faster than a person reconnects', () => {
    const rig = makeRig();
    const t = openTable(rig);
    const alice = seatPlayer(rig, t, 'Alice', 'P1');
    let last: FakeSocket | null = null;
    for (let i = 0; i < 7; i++) {
      last = rig.connect(t.tableId);
      resume(rig, last, alice.seatToken);
    }
    // The first resume takes the seat from the lobby socket; six takeovers a minute are allowed.
    expect(last!.errors()).toEqual(['Too many attempts. Wait a moment and try again.']);
    rig.clock.t += 61_000;
    const later = rig.connect(t.tableId);
    resume(rig, later, alice.seatToken);
    expect(later.errors()).toEqual([]);
  });
});

// ── Reaping ─────────────────────────────────────────────────────────────────────────────────

describe('reaping', () => {
  it("closes a finished table's sockets after the idle time and forgets the table", async () => {
    const game = await startedGame();
    game.port.emit({ type: 'gameOver', generation: game.port.generation, result: RESULT });
    await flush();
    game.rig.hub.reapIdle();
    expect(game.rig.registry.size).toBe(1);
    game.rig.clock.t += 16 * 60_000;
    game.rig.hub.reapIdle();
    expect(game.rig.registry.size).toBe(0);
    expect(game.aliceGame.closed).toBe(true);
    expect(game.aliceGame.of('tableClosed')).toEqual([
      { type: 'tableClosed', payload: { reason: 'reaped' } },
    ]);
    expect(game.rig.hub.open(game.t.tableId, new FakeSocket('late', 'x'))).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAYER_IDLE_GRACE_MS } from '@mtg/shared';
const mocks = vi.hoisted(() => ({ setup: vi.fn(), construct: vi.fn() }));
vi.mock('../match/setup', () => ({ setupSeats: mocks.setup }));
vi.mock('../match/session', () => ({
  MatchSession: class {
    constructor(...args: unknown[]) {
      mocks.construct(...args);
    }
  },
}));
import { GameServer, isAllowedLocalRequest } from './server';
import type { GameServerDeps } from './server';
import { BatchManager } from '../batch/manager';
import type { BatchManagerDeps } from '../batch/manager';

beforeEach(() => {
  mocks.setup.mockReset();
  mocks.construct.mockReset();
});
const seats = Array.from({ length: 4 }, () => ({ kind: 'pool' }));
const start = JSON.stringify({ type: 'startGame', payload: { seats, providerKind: 'random' } });

describe('local server boundary', () => {
  it.each([
    ['http://127.0.0.1:3001/ws', 'http://localhost:5173', true],
    ['http://localhost:3001/ws', 'http://localhost:3001', true],
    ['http://127.0.0.1:3001/ws', 'https://hostile.example', false],
    ['http://hostile.example:3001/ws', 'http://hostile.example:3001', false],
    ['http://127.0.0.1:3001/ws', 'null', false],
  ] as const)('validates %s from %s', (url, origin, allowed) => {
    expect(isAllowedLocalRequest(new Request(url, { headers: { origin } }), 3001)).toBe(allowed);
  });

  it('allows the configured local web port only for the card test lab', () => {
    const request = new Request('http://127.0.0.1:3102/ws', {
      headers: { origin: 'http://127.0.0.1:5174' },
    });
    expect(isAllowedLocalRequest(request, 3102, true, '5174')).toBe(true);
    expect(isAllowedLocalRequest(request, 3102, false, '5174')).toBe(false);
    expect(isAllowedLocalRequest(request, 3102, true, '70000')).toBe(false);
  });
});

describe('game startup lifecycle', () => {
  it('rejects overlapping starts and preserves the current game when setup fails', async () => {
    let finish!: (value: unknown) => void;
    mocks.setup.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const server = new GameServer({} as GameServerDeps);
    const current = { abandon: vi.fn(), getGameMode: () => 'spectator' };
    const seam = server as unknown as {
      session: typeof current;
      handleMessage(socket: unknown, raw: string): Promise<void>;
    };
    seam.session = current;
    const socket = { send: vi.fn() };
    const pending = seam.handleMessage(socket, start);
    await seam.handleMessage(socket, start);
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('already starting'));
    expect(current.abandon).not.toHaveBeenCalled();
    finish({ ok: false, problems: [] });
    await pending;
    expect(current.abandon).not.toHaveBeenCalled();
    expect(seam.session).toBe(current);
  });
  it('does not install a game cancelled during setup', async () => {
    let finish!: (value: unknown) => void;
    mocks.setup.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const server = new GameServer({} as GameServerDeps);
    const seam = server as unknown as {
      handleMessage(socket: unknown, raw: string): Promise<void>;
    };
    const socket = { send: vi.fn() };
    const pending = seam.handleMessage(socket, start);
    await seam.handleMessage(socket, JSON.stringify({ type: 'abandonGame', payload: {} }));
    finish({ ok: true, seats: [] });
    await pending;
    expect(mocks.construct).not.toHaveBeenCalled();
  });
  it('surfaces thrown setup errors and releases the startup lock', async () => {
    mocks.setup.mockRejectedValue(new Error('fixture setup failure'));
    const server = new GameServer({} as GameServerDeps);
    const seam = server as unknown as {
      handleMessage(socket: unknown, raw: string): Promise<void>;
    };
    const socket = { send: vi.fn() };
    await seam.handleMessage(socket, start);
    await seam.handleMessage(socket, start);
    expect(mocks.setup).toHaveBeenCalledTimes(2);
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('fixture setup failure'));
  });
});

describe('disconnected player session', () => {
  function playerGame() {
    const server = new GameServer({} as GameServerDeps);
    const session = {
      abandon: vi.fn(),
      getGameMode: () => 'singlePlayer',
      isOver: vi.fn(() => false),
      setPlayerConnected: vi.fn(),
      getLivePaceMs: () => 0,
    };
    const seam = server as unknown as {
      session: typeof session | null;
      sessionToken: string | null;
      playerSocket: unknown;
      playerSeat: string;
      onSocketClose(socket: unknown): void;
      handleMessage(socket: unknown, raw: string): Promise<void>;
    };
    const player = { send: vi.fn() };
    seam.session = session;
    seam.sessionToken = 'token';
    seam.playerSocket = player;
    seam.playerSeat = 'P1';
    return { seam, session, player };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('abandons a game whose player never returns, freeing the seat for a new start', async () => {
    vi.useFakeTimers();
    const { seam, session, player } = playerGame();
    mocks.setup.mockResolvedValue({ ok: false, problems: [] });
    const other = { send: vi.fn() };

    seam.onSocketClose(player);
    expect(session.setPlayerConnected).toHaveBeenCalledWith('P1', false);
    await seam.handleMessage(other, start);
    expect(other.send).toHaveBeenCalledWith(expect.stringContaining('Resume the active player'));
    expect(mocks.setup).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PLAYER_IDLE_GRACE_MS - 1);
    expect(session.abandon).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(session.abandon).toHaveBeenCalledTimes(1);
    expect(seam.session).toBeNull();
    expect(seam.sessionToken).toBeNull();

    await seam.handleMessage(other, start);
    expect(mocks.setup).toHaveBeenCalledTimes(1);
  });

  it('lets any local connection replace a single-player game once it is over', async () => {
    const { seam, session, player } = playerGame();
    mocks.setup.mockResolvedValue({ ok: false, problems: [] });
    const other = { send: vi.fn() };
    seam.onSocketClose(player);

    await seam.handleMessage(other, start);
    expect(mocks.setup).not.toHaveBeenCalled();

    session.isOver.mockReturnValue(true);
    await seam.handleMessage(other, start);
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect(other.send).not.toHaveBeenCalledWith(expect.stringContaining('already starting'));
  });

  it('keeps the game when its player resumes before the grace period ends', async () => {
    vi.useFakeTimers();
    const { seam, session, player } = playerGame();
    seam.onSocketClose(player);
    vi.advanceTimersByTime(PLAYER_IDLE_GRACE_MS / 2);

    const returning = { send: vi.fn() };
    await seam.handleMessage(
      returning,
      JSON.stringify({ type: 'resumeGame', payload: { sessionToken: 'token' } }),
    );
    expect(seam.playerSocket).toBe(returning);
    vi.advanceTimersByTime(PLAYER_IDLE_GRACE_MS);
    expect(session.abandon).not.toHaveBeenCalled();
    expect(seam.session).toBe(session);
  });

  it('does not let a later disconnect inherit an earlier timer', async () => {
    vi.useFakeTimers();
    const { seam, session, player } = playerGame();
    seam.onSocketClose(player);
    vi.advanceTimersByTime(PLAYER_IDLE_GRACE_MS - 10);
    const returning = { send: vi.fn() };
    await seam.handleMessage(
      returning,
      JSON.stringify({ type: 'resumeGame', payload: { sessionToken: 'token' } }),
    );
    seam.onSocketClose(returning);
    vi.advanceTimersByTime(PLAYER_IDLE_GRACE_MS - 1);
    expect(session.abandon).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(session.abandon).toHaveBeenCalledTimes(1);
  });
});

describe('batch failure lifecycle', () => {
  it.each(['setup', 'construction'])(
    'records thrown %s failures and becomes idle',
    async (stage) => {
      const repo = {
        activeBatchExists: () => false,
        create: vi.fn(),
        markRunning: vi.fn(),
        createGame: vi.fn(),
        markGame: vi.fn(),
        markFinished: vi.fn(),
      };
      if (stage === 'setup') mocks.setup.mockRejectedValue(new Error('setup failure'));
      else {
        mocks.setup.mockResolvedValue({ ok: true, seats: [] });
        mocks.construct.mockImplementation(() => {
          throw new Error('construction failure');
        });
      }
      const manager = new BatchManager({
        store: { batches: () => repo },
      } as unknown as BatchManagerDeps);
      const batchId = manager.start({
        scenarios: [{ id: 'test', name: 'Test', seats: [], providerKind: 'random', games: 1 }],
      });
      await manager.settled();
      expect(manager.isActive()).toBe(false);
      expect(repo.markFinished).toHaveBeenCalledWith(
        batchId,
        'failed',
        expect.objectContaining({ kind: 'exception', reason: `${stage} failure` }),
      );
      if (stage === 'construction')
        expect(repo.markGame).toHaveBeenCalledWith(
          expect.any(String),
          'failed',
          'construction failure',
        );
    },
  );
});

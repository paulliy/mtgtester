import { beforeEach, describe, expect, it, vi } from 'vitest';
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

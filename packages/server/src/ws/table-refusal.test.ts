/**
 * The tester's `GameServer` never runs a `'table'` game (ADR 0031 decision 1): tables run only in
 * `serve:table`. A start or preview request for one is refused with the fixed setup-refused
 * message, and nothing is built.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartGamePayload } from '@mtg/shared';
import { setupSeats } from '../match/setup';
import { previewMatchup } from '../match/preview';
import { MatchSession } from '../match/session';
import { GameServer, type GameServerDeps } from './server';
import { SETUP_REFUSED_MESSAGE } from './setup-privacy';

// The wire parser never admits `gameMode: 'table'`, so reaching the server's own refusal takes a
// parser that does. Only the switch below turns this on.
const parser = vi.hoisted(() => ({ permissive: false }));
vi.mock('@mtg/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mtg/shared')>();
  return {
    ...actual,
    isClientToServerMessage: (value: unknown) =>
      parser.permissive || actual.isClientToServerMessage(value),
  };
});
vi.mock('../match/setup', () => ({ setupSeats: vi.fn() }));
vi.mock('../match/preview', () => ({ previewMatchup: vi.fn() }));
vi.mock('../match/session', () => ({ MatchSession: vi.fn() }));

interface Seam {
  handleMessage(socket: unknown, raw: string): Promise<void>;
  startGame(socket: unknown, payload: StartGamePayload): Promise<void>;
  handleSetupPreview(request: Request): Promise<Response>;
  session: unknown;
}

function seam(): { server: Seam; socket: { send: ReturnType<typeof vi.fn> } } {
  return {
    server: new GameServer({} as GameServerDeps) as unknown as Seam,
    socket: { send: vi.fn() },
  };
}

const body = {
  seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
  providerKind: 'random',
  gameMode: 'table',
  seed: 'seed1',
};

function sentMessages(socket: { send: ReturnType<typeof vi.fn> }): unknown[] {
  return socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as unknown);
}

beforeEach(() => {
  parser.permissive = false;
  vi.mocked(setupSeats).mockReset();
  vi.mocked(previewMatchup).mockReset();
  vi.mocked(MatchSession).mockReset();
});

describe('GameServer refuses table games', () => {
  it('refuses a table start with the setup-refused message and builds nothing', async () => {
    const { server, socket } = seam();
    await server.startGame(socket, body as unknown as StartGamePayload);

    expect(sentMessages(socket)).toEqual([
      { type: 'error', payload: { message: SETUP_REFUSED_MESSAGE } },
    ]);
    expect(setupSeats).not.toHaveBeenCalled();
    expect(MatchSession).not.toHaveBeenCalled();
    expect(server.session).toBeNull();
  });

  it('refuses a table start frame once the parser admits it, still without building', async () => {
    parser.permissive = true;
    const { server, socket } = seam();
    await server.handleMessage(socket, JSON.stringify({ type: 'startGame', payload: body }));

    expect(sentMessages(socket)).toEqual([
      { type: 'error', payload: { message: SETUP_REFUSED_MESSAGE } },
    ]);
    expect(setupSeats).not.toHaveBeenCalled();
    expect(MatchSession).not.toHaveBeenCalled();
  });

  it('refuses a table preview with the setup-refused message and previews nothing', async () => {
    parser.permissive = true;
    const { server } = seam();
    const response = await server.handleSetupPreview(
      new Request('http://127.0.0.1/api/setup-preview', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: SETUP_REFUSED_MESSAGE });
    expect(previewMatchup).not.toHaveBeenCalled();
  });

  it('never reaches the refusal over the real wire: the parser rejects a table start', async () => {
    const { server, socket } = seam();
    await server.handleMessage(socket, JSON.stringify({ type: 'startGame', payload: body }));

    expect(sentMessages(socket)).toEqual([
      { type: 'error', payload: { message: 'Unrecognised message.' } },
    ]);
    expect(setupSeats).not.toHaveBeenCalled();
  });
});

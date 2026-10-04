import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerId, StartGamePayload } from '@mtg/shared';
import { setupSeats, type SeatProblem, type SetupResult } from '../match/setup';
import { previewMatchup } from '../match/preview';
import { MatchSession } from '../match/session';
import { GameServer, type GameServerDeps } from './server';

vi.mock('../match/setup', () => ({ setupSeats: vi.fn() }));
vi.mock('../match/preview', () => ({ previewMatchup: vi.fn() }));
vi.mock('../match/session', () => ({ MatchSession: vi.fn() }));

/**
 * A string that exists nowhere else. If it appears in a single emitted byte, opponent deck data
 * crossed the boundary — the assertion needs no knowledge of which field carried it.
 */
const SENTINEL = 'Zzyzx-Opponent-Secret-Card';

interface Seam {
  session: unknown;
  playerSocket: unknown;
  setupPreviews: Map<string, { request: unknown; createdAt: number }>;
  handleMessage(socket: unknown, raw: string): Promise<void>;
  startGame(socket: unknown, payload: StartGamePayload): Promise<void>;
}

function serverSeam(): { server: Seam; socket: { send: ReturnType<typeof vi.fn> } } {
  const socket = { send: vi.fn() };
  const server = new GameServer({} as GameServerDeps) as unknown as Seam;
  return { server, socket };
}

function poolSeats(): StartGamePayload['seats'] {
  return [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }];
}

/** A failing seat whose every free-text field carries the sentinel. */
function problem(seat: PlayerId, extra: Partial<SeatProblem> = {}): SeatProblem {
  return {
    seat,
    message: `${seat}: deck rejected because of ${SENTINEL}`,
    issues: [{ code: 'singleton', message: `two copies of ${SENTINEL}`, cardName: SENTINEL }],
    unresolvedNames: [SENTINEL],
    unmodeledCards: [SENTINEL],
    ...extra,
  };
}

function refusal(problems: SeatProblem[]): SetupResult {
  return { ok: false, problems };
}

/** Every byte this socket emitted, concatenated. */
function wire(socket: { send: ReturnType<typeof vi.fn> }): string {
  return socket.send.mock.calls.map((call) => String(call[0])).join('');
}

function errorPayload(socket: { send: ReturnType<typeof vi.fn> }): Record<string, unknown> {
  expect(socket.send).toHaveBeenCalledOnce();
  const message = JSON.parse(String(socket.send.mock.calls[0]![0])) as {
    type: string;
    payload: Record<string, unknown>;
  };
  expect(message.type).toBe('error');
  return message.payload;
}

function singlePlayerStart(humanSeat: unknown): StartGamePayload {
  return {
    seats: poolSeats(),
    providerKind: 'random',
    gameMode: 'singlePlayer',
    seed: 'seed1',
    humanSeat: humanSeat as PlayerId,
  };
}

beforeEach(() => {
  vi.mocked(setupSeats).mockReset();
  vi.mocked(previewMatchup).mockReset();
  vi.mocked(MatchSession).mockReset();
});

describe('single-player setup refusal', () => {
  it('never puts another seat deck data on the wire', async () => {
    const { server, socket } = serverSeam();
    vi.mocked(setupSeats).mockResolvedValue(refusal([problem('P1'), problem('P2'), problem('P3')]));

    await server.startGame(socket, singlePlayerStart('P1'));

    expect(wire(socket)).not.toContain(SENTINEL);
    expect(MatchSession).not.toHaveBeenCalled();
  });

  it('keeps an own-seat diagnostic as a known code with a locally generated description', async () => {
    const { server, socket } = serverSeam();
    vi.mocked(setupSeats).mockResolvedValue(refusal([problem('P1')]));

    await server.startGame(socket, singlePlayerStart('P1'));

    const payload = errorPayload(socket);
    expect(payload['unmodeledCards']).toBeUndefined();
    const deckIssues = payload['deckIssues'] as Array<{
      seat: string;
      issues: Array<Record<string, unknown>>;
    }>;
    expect(deckIssues).toHaveLength(1);
    expect(deckIssues[0]!.seat).toBe('P1');
    expect(deckIssues[0]!.issues).toHaveLength(1);
    expect(deckIssues[0]!.issues[0]!['code']).toBe('singleton');
    expect(deckIssues[0]!.issues[0]!['message']).toEqual(expect.any(String));
    expect(Object.keys(deckIssues[0]!.issues[0]!)).toEqual(['code', 'message']);
  });

  it.each(['P1', 'P2', 'P3', 'P4'] as const)(
    'authorizes only seat %s when it is the human seat',
    async (seat) => {
      const { server, socket } = serverSeam();
      vi.mocked(setupSeats).mockResolvedValue(
        refusal((['P1', 'P2', 'P3', 'P4'] as const).map((s) => problem(s))),
      );

      await server.startGame(socket, singlePlayerStart(seat));

      expect(wire(socket)).not.toContain(SENTINEL);
      const deckIssues = errorPayload(socket)['deckIssues'] as Array<{ seat: string }>;
      expect(deckIssues.map((entry) => entry.seat)).toEqual([seat]);
    },
  );

  it('drops an issue whose code it does not recognise', async () => {
    const { server, socket } = serverSeam();
    vi.mocked(setupSeats).mockResolvedValue(
      refusal([
        problem('P1', {
          issues: [
            { code: 'futureRule' as never, message: SENTINEL },
            { code: 'banned', message: SENTINEL, cardName: SENTINEL },
          ],
        }),
      ]),
    );

    await server.startGame(socket, singlePlayerStart('P1'));

    expect(wire(socket)).not.toContain(SENTINEL);
    const deckIssues = errorPayload(socket)['deckIssues'] as Array<{
      issues: Array<{ code: string }>;
    }>;
    expect(deckIssues[0]!.issues.map((issue) => issue.code)).toEqual(['banned']);
  });

  it('authorizes nothing when the seat identity is not an actual seat', async () => {
    for (const seat of [['P1'], 'p1', 1, null, undefined, { toString: () => 'P1' }]) {
      const { server, socket } = serverSeam();
      vi.mocked(setupSeats).mockResolvedValue(refusal([problem('P1')]));

      await server.startGame(socket, singlePlayerStart(seat));

      expect(wire(socket)).not.toContain(SENTINEL);
      expect(errorPayload(socket)['deckIssues']).toBeUndefined();
      expect(MatchSession).not.toHaveBeenCalled();
    }
  });

  it('reports a thrown setup exception without its message', async () => {
    const { server, socket } = serverSeam();
    vi.mocked(setupSeats).mockRejectedValue(new Error(`snapshot load failed for ${SENTINEL}`));

    await server.handleMessage(
      socket,
      JSON.stringify({ type: 'startGame', payload: singlePlayerStart('P1') }),
    );

    expect(wire(socket)).not.toContain(SENTINEL);
    expect(errorPayload(socket)).toEqual({ message: expect.any(String) });
    expect(MatchSession).not.toHaveBeenCalled();
  });

  it('reports a preview-bound refusal without its blockers', async () => {
    const { server, socket } = serverSeam();
    const payload: StartGamePayload = { ...singlePlayerStart('P1'), previewId: 'preview-1' };
    server.setupPreviews.set('preview-1', {
      request: {
        seats: payload.seats,
        seed: 'seed1',
        providerKind: 'random',
        gameMode: 'singlePlayer',
        humanSeat: 'P1',
      },
      createdAt: Date.now(),
    });
    vi.mocked(previewMatchup).mockResolvedValue({
      blockers: [`P2: ${SENTINEL} is not modeled`],
    } as unknown as Awaited<ReturnType<typeof previewMatchup>>);

    await server.startGame(socket, payload);

    expect(wire(socket)).not.toContain(SENTINEL);
    expect(errorPayload(socket)).toEqual({ message: expect.any(String) });
    expect(setupSeats).not.toHaveBeenCalled();
    expect(MatchSession).not.toHaveBeenCalled();
  });
});

describe('spectator setup refusal', () => {
  it('still reports full diagnostics, because no seat is hidden from a spectator', async () => {
    const { server, socket } = serverSeam();
    vi.mocked(setupSeats).mockResolvedValue(refusal([problem('P2')]));

    await server.startGame(socket, {
      seats: poolSeats(),
      providerKind: 'random',
      gameMode: 'spectator',
      seed: 'seed1',
    });

    const payload = errorPayload(socket);
    expect(JSON.stringify(payload)).toContain(SENTINEL);
    expect(payload['unmodeledCards']).toEqual([{ seat: 'P2', cards: [SENTINEL] }]);
  });
});

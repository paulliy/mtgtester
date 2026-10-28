/**
 * Wire transcripts (multiplayer plan M1): every frame `GameServer` sends for a fixed-seed game,
 * recorded once and compared byte for byte. The seat-controller refactor must not change a single
 * single-player or spectator frame; a later milestone that changes them on purpose re-baselines the
 * fixture in its own change, with the diff explained.
 *
 * Only values that are random per run are normalised: the game id (which also appears inside
 * request ids), the session token, and timestamps. Regenerate with
 * `UPDATE_WIRE_TRANSCRIPTS=1 bunx vitest run packages/server/src/ws/wire-transcript.test.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RandomDecisionProvider } from '@mtg/engine';
import type { OracleCard, PlayerId, ServerToClientMessage, StartGamePayload } from '@mtg/shared';
import type { SeatSetup } from '../match/setup';
import { GameServer, type GameServerDeps } from './server';

vi.mock('../match/setup', () => ({ setupSeats: vi.fn() }));
// `GameServer` passes no turn cap; a small one keeps the recorded game short.
vi.mock('../match/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../match/session')>();
  return {
    ...actual,
    MatchSession: class extends actual.MatchSession {
      constructor(opts: ConstructorParameters<typeof actual.MatchSession>[0]) {
        super({ ...opts, turnCap: 40 });
      }
    },
  };
});

import { setupSeats } from '../match/setup';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const UPDATE = process.env['UPDATE_WIRE_TRANSCRIPTS'] === '1';

function forest(n: number): OracleCard {
  return {
    oracleId: `forest-${n}`,
    scryfallId: `scry-forest-${n}`,
    name: 'Forest',
    manaCost: null,
    cmc: 0,
    colors: [],
    colorIdentity: ['G'],
    typeLine: 'Basic Land — Forest',
    supertypes: ['Basic'],
    types: ['Land'],
    subtypes: ['Forest'],
    oracleText: '',
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: true,
  };
}

function general(seat: string): OracleCard {
  return {
    ...forest(0),
    oracleId: `general-${seat}`,
    scryfallId: `scry-general-${seat}`,
    name: `Test General ${seat}`,
    manaCost: '{G}',
    cmc: 1,
    colors: ['G'],
    typeLine: 'Legendary Creature — Elf',
    supertypes: ['Legendary'],
    types: ['Creature'],
    subtypes: ['Elf'],
    power: '2',
    toughness: '2',
    isBasicLand: false,
  };
}

function seats(): SeatSetup[] {
  return [1, 2, 3, 4].map((n) => ({
    seat: `P${n}` as PlayerId,
    deckSnapshotId: null,
    config: {
      id: `P${n}` as PlayerId,
      deckId: `deck-${n}`,
      commanders: [general(`P${n}`)],
      cards: Array.from({ length: 9 }, (_, i) => forest(i)),
    },
    summary: {
      seat: `P${n}` as PlayerId,
      deckId: `deck-${n}`,
      label: `Test General P${n}`,
      commanderNames: [`Test General P${n}`],
      colorIdentity: ['G'],
      archetypeTag: 'G — test',
    },
  }));
}

interface Seam {
  onSocketOpen(socket: unknown): void;
  handleMessage(socket: unknown, raw: string): Promise<void>;
  session: { settled(): Promise<void>; abandon(): void } | null;
}

async function until(done: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Replace what differs from run to run, keeping every other byte. */
function normalise(frames: readonly string[]): string[] {
  const text = frames.join('\n');
  const gameId = /"gameId":"(g-[0-9a-f-]+)"/.exec(text)?.[1];
  const token = /"sessionToken":"([0-9a-f-]+)"/.exec(text)?.[1];
  let out = text;
  if (gameId !== undefined) out = out.split(gameId).join('GAME_ID');
  if (token !== undefined) out = out.split(token).join('SESSION_TOKEN');
  out = out.replace(/"startedAt":"[^"]*"/g, '"startedAt":"TIMESTAMP"');
  return out.split('\n');
}

function compareToFixture(name: string, frames: readonly string[]): void {
  const file = join(FIXTURES, name);
  const actual = normalise(frames).join('\n') + '\n';
  if (UPDATE || !existsSync(file)) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, actual);
    if (!UPDATE) throw new Error(`recorded ${name}; re-run to compare`);
    return;
  }
  expect(actual).toBe(readFileSync(file, 'utf8'));
}

function start(payload: Partial<StartGamePayload>): string {
  return JSON.stringify({
    type: 'startGame',
    payload: {
      seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
      providerKind: 'random',
      seed: 'wire-transcript',
      paceMs: 0,
      ...payload,
    },
  });
}

describe('wire transcripts', () => {
  it('single-player: a scripted human plays a fixed-seed game to its turn cap', async () => {
    vi.mocked(setupSeats).mockResolvedValue({ ok: true, seats: seats() });
    const frames: string[] = [];
    const socket = { send: (frame: string) => frames.push(frame) };
    const server = new GameServer({} as GameServerDeps);
    const seam = server as unknown as Seam;
    seam.onSocketOpen(socket);
    await seam.handleMessage(
      socket,
      start({ gameMode: 'singlePlayer', humanSeat: 'P1' } as Partial<StartGamePayload>),
    );

    const chooser = new RandomDecisionProvider('wire-transcript-human');
    let consumed = 0;
    const parsed = (): ServerToClientMessage[] =>
      frames.map((frame) => JSON.parse(frame) as ServerToClientMessage);
    const pendingRequests = (): Extract<
      ServerToClientMessage,
      { type: 'playerActionRequired' }
    >[] =>
      parsed().filter(
        (m): m is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
          m.type === 'playerActionRequired',
      );
    for (;;) {
      await until(
        () => parsed().some((m) => m.type === 'gameOver') || pendingRequests().length > consumed,
        'the next human request or game over',
      );
      if (parsed().some((m) => m.type === 'gameOver')) break;
      const next = pendingRequests()[consumed]!;
      consumed += 1;
      const response = chooser.decide(next.payload.request);
      await seam.handleMessage(
        socket,
        JSON.stringify({
          type: 'submitPlayerAction',
          payload: {
            requestId: response.requestId,
            actionId: response.actionId,
            revision: next.payload.revision,
            ...(response.targets !== undefined ? { targets: response.targets } : {}),
          },
        }),
      );
    }
    await seam.session?.settled();
    seam.session?.abandon();

    expect(consumed).toBeGreaterThan(0);
    compareToFixture('single-player.jsonl', frames);
  }, 30_000);

  it('spectator: a fixed-seed game streams to a watcher at pace 0', async () => {
    vi.mocked(setupSeats).mockResolvedValue({ ok: true, seats: seats() });
    const frames: string[] = [];
    const socket = { send: (frame: string) => frames.push(frame) };
    const server = new GameServer({} as GameServerDeps);
    const seam = server as unknown as Seam;
    seam.onSocketOpen(socket);
    await seam.handleMessage(socket, start({}));
    await until(() => frames.some((frame) => frame.startsWith('{"type":"gameOver"')), 'game over');
    await seam.session?.settled();
    seam.session?.abandon();

    compareToFixture('spectator.jsonl', frames);
  }, 30_000);
});

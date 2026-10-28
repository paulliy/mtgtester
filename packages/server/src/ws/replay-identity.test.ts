/**
 * What `GameServer` hands the session to record about the process (ADR 0031 decision 8): the
 * card-data hash it loaded and the build it runs from. A server told neither stores no replay
 * config, and a Card Test Lab game never does.
 */

import { describe, expect, it, vi } from 'vitest';
import type { OracleCard, PlayerId, StartGamePayload } from '@mtg/shared';
import type { GameStore } from '../db';
import { GameRecorder, type SqliteLike } from '../db/games';
import type { MatchSession } from '../match/session';
import type { SeatSetup } from '../match/setup';
import { GameServer, type GameServerDeps } from './server';

vi.mock('../match/setup', () => ({ setupSeats: vi.fn() }));

import { setupSeats } from '../match/setup';

function card(name: string, id: string): OracleCard {
  return {
    oracleId: id,
    scryfallId: `scry-${id}`,
    name,
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

function seats(): SeatSetup[] {
  return (['P1', 'P2', 'P3', 'P4'] as PlayerId[]).map((seat) => ({
    seat,
    deckSnapshotId: `snap-${seat}`,
    config: {
      id: seat,
      deckId: `deck-${seat}`,
      commanders: [{ ...card(`General ${seat}`, `general-${seat}`), isBasicLand: false }],
      cards: Array.from({ length: 20 }, (_, i) => card('Forest', `forest-${i}`)),
    },
    summary: {
      seat,
      deckId: `deck-${seat}`,
      label: `General ${seat}`,
      commanderNames: [`General ${seat}`],
      colorIdentity: ['G'],
      archetypeTag: 'G — test',
    },
  }));
}

interface Seam {
  onSocketOpen(socket: unknown): void;
  handleMessage(socket: unknown, raw: string): Promise<void>;
  session: MatchSession | null;
}

async function startGame(deps: Partial<GameServerDeps>, payload: Partial<StartGamePayload>) {
  vi.mocked(setupSeats).mockResolvedValue({ ok: true, seats: seats() });
  const frames: string[] = [];
  const socket = { send: (frame: string) => frames.push(frame) };
  const server = new GameServer(deps as GameServerDeps);
  const seam = server as unknown as Seam;
  seam.onSocketOpen(socket);
  await seam.handleMessage(
    socket,
    JSON.stringify({
      type: 'startGame',
      payload: {
        seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
        providerKind: 'random',
        seed: 'identity-seed',
        paceMs: 0,
        gameMode: 'singlePlayer',
        humanSeat: 'P1',
        ...payload,
      },
    }),
  );
  seam.session?.abandon();
  await seam.session?.settled();
  return frames.map((frame) => JSON.parse(frame) as { type: string; payload: { seed?: string } });
}

function fakeStore() {
  const updates: unknown[][] = [];
  const db: SqliteLike = {
    query: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('UPDATE games SET config_json')) updates.push(args);
      },
      all: () => [],
      get: () => null,
    }),
  };
  const store = { recorderFor: (id: string) => new GameRecorder(db, id) } as unknown as GameStore;
  return { store, updates };
}

describe('GameServer replay identity', () => {
  it('stores the card-data hash and the build it was given', async () => {
    const { store, updates } = fakeStore();
    const frames = await startGame(
      {
        store,
        build: { commit: 'abc123', branch: 'main', dirty: true },
        cardData: { source: 'oracle.json', sha256: 'oracle-sha', entries: 3 },
      },
      {},
    );

    expect(updates).toHaveLength(1);
    const config = JSON.parse(String(updates[0]?.[0])) as {
      cardDataSha256: string;
      seats: Array<{ seat: string; deckSnapshotId: string; manualMana: boolean }>;
    };
    expect(config.cardDataSha256).toBe('oracle-sha');
    expect(config.seats[0]).toEqual({ seat: 'P1', deckSnapshotId: 'snap-P1', manualMana: true });
    expect(updates[0]?.slice(1, 3)).toEqual(['abc123', 1]);
    // The tester still shows the seed it was asked for.
    expect(frames.find((f) => f.type === 'gameStarted')?.payload.seed).toBe('identity-seed');
  }, 30_000);

  it('stores a null hash when the server loaded no card file, and nothing without a build', async () => {
    const withoutFile = fakeStore();
    await startGame(
      { store: withoutFile.store, build: { commit: null, branch: null, dirty: null } },
      {},
    );
    expect(JSON.parse(String(withoutFile.updates[0]?.[0])).cardDataSha256).toBeNull();
    expect(withoutFile.updates[0]?.slice(1, 3)).toEqual([null, null]);

    const withoutBuild = fakeStore();
    await startGame({ store: withoutBuild.store }, {});
    expect(withoutBuild.updates).toEqual([]);
  }, 30_000);
});

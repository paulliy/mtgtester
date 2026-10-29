/**
 * The in-process `TableSessionPort` (multiplayer M3 task 3) driven the way the table server will
 * drive it: start with a config, read outputs, answer the humans' requests through `send`.
 * Two humans with approved plaintext decks and two bots play a short game on the fixture pool.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard, PlayerId, ServerToClientMessage } from '@mtg/shared';
import { buildOracleIndexFromCards } from '../cards/oracle-index';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';
import type { GameStore } from '../db';
import { GameRecorder, type SqliteLike } from '../db/games';
import { parseBannedList } from '../decks/banned';
import { generateCommanderDeck } from '../decks/generate';
import { TABLE_ENGINE_LIMITS } from '../match/engine-limits';
import { makeResolvedDeck } from '../test-factory';
import { createDeckChecker } from './deck-check';
import { InProcessSessionPort, toDeckProblems } from './in-process-port';
import type { TableSessionConfig, TableSessionOutput, TableSessionSeat } from './session-port';
import { buildSessionConfig } from './start-config';
import type { StartAttempt } from './table';
import { generateRngKey, hex } from './tokens';

const cards = JSON.parse(
  readFileSync(resolve('packages/server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const pool = buildSupportedPool(cards);
const index = buildOracleIndexFromCards(cards);
const banned = parseBannedList('');
const check = createDeckChecker({ index, banned });

const KNOWN_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0';
const GENERATION = 7;

/** A legal plaintext decklist built from the fixture pool, one per label. */
function decklistFor(label: string): string {
  const deck = generateCommanderDeck(pool, { seed: `in-process-port-${label}` });
  const counts = new Map<string, number>();
  for (const card of deck.cards) counts.set(card.name, (counts.get(card.name) ?? 0) + 1);
  return [
    'Commander',
    deck.commander.name,
    '',
    'Deck',
    ...[...counts].map(([name, quantity]) => `${quantity} ${name}`),
  ].join('\n');
}

const HUMAN_DECKS: Record<'P1' | 'P3', string> = {
  P1: decklistFor('p1'),
  P3: decklistFor('p3'),
};

/** The store as setup and the session use it, in memory; `calls` records every SQL statement. */
function fakeStore(): { store: GameStore; calls: string[] } {
  const calls: string[] = [];
  const db: SqliteLike = {
    query: (sql: string) => ({
      run: () => {
        calls.push(sql);
      },
      all: () => [],
      get: () => null,
    }),
  };
  const snapshots = new Map<string, Array<{ oracleId: string; name: string; quantity: number }>>();
  const store = {
    cacheCards: () => undefined,
    insertDeck: (deck: { name: string | null }) => ({ id: crypto.randomUUID(), ...deck }),
    insertSnapshot: (snapshot: {
      cards: Array<{ oracleId: string; name: string; quantity: number }>;
    }) => {
      const id = crypto.randomUUID();
      snapshots.set(id, snapshot.cards);
      return { ...snapshot, id, importedAt: new Date().toISOString() };
    },
    insertStrategyProfile: () => undefined,
    snapshotCards: (id: string) => snapshots.get(id) ?? null,
    recorderFor: (gameId: string) => new GameRecorder(db, gameId),
  } as unknown as GameStore;
  return { store, calls };
}

function seatsOf(decks: Record<string, string> = HUMAN_DECKS): TableSessionSeat[] {
  return [
    { seat: 'P1', controller: 'human', displayName: 'Ann', decklist: decks['P1'] ?? '' },
    { seat: 'P2', controller: 'bot' },
    { seat: 'P3', controller: 'human', displayName: 'Bo', decklist: decks['P3'] ?? '' },
    { seat: 'P4', controller: 'bot' },
  ];
}

function configOf(over: Partial<TableSessionConfig> = {}): TableSessionConfig {
  return {
    tableId: 'table-1',
    attemptId: 'attempt-1',
    gameId: 'game-1',
    seed: 'public-label',
    rngKey: KNOWN_KEY,
    seats: seatsOf(),
    ...TABLE_ENGINE_LIMITS,
    turnCap: 6,
    dbPath: ':memory:',
    livePaceMs: 0,
    ...over,
  };
}

interface Harness {
  port: InProcessSessionPort;
  outputs: TableSessionOutput[];
  calls: string[];
  done: Promise<void>;
}

const TERMINAL = new Set(['gameOver', 'setupProblems', 'failed']);

/**
 * A port with a listener that records outputs and answers each human request with its first legal
 * action, which is how the agent client's `first-legal` policy plays.
 */
function harness(
  options: { pool?: SupportedPool; answer?: boolean; humans?: readonly PlayerId[] } = {},
): Harness {
  const { store, calls } = fakeStore();
  const port = new InProcessSessionPort({
    generation: GENERATION,
    deps: { pool: options.pool ?? pool, index, banned, store },
  });
  const outputs: TableSessionOutput[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolveDone) => {
    finish = resolveDone;
  });
  port.onOutput((output) => {
    outputs.push(output);
    if (TERMINAL.has(output.type)) finish();
    if (options.answer === false || output.type !== 'seatFrame') return;
    const message = output.message;
    if (message.type !== 'playerActionRequired') return;
    const { request, revision } = message.payload;
    const action = request.legalActions[0];
    if (action === undefined) return;
    setTimeout(() => {
      void port.send({
        type: 'submitPlayerAction',
        seat: output.seat,
        payload: { requestId: request.requestId, revision, actionId: action.id },
      });
    }, 0);
  });
  return { port, outputs, calls, done };
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
const terminals = (outputs: readonly TableSessionOutput[]) =>
  outputs.filter((o) => TERMINAL.has(o.type));

describe('fixture decks', () => {
  it('pass the claim-time check the table runs before approval', () => {
    for (const decklist of Object.values(HUMAN_DECKS)) expect(check(decklist).ok).toBe(true);
  });
});

describe('InProcessSessionPort - a played game', () => {
  let played: Harness;

  beforeAll(async () => {
    played = harness();
    await played.port.start(configOf());
    await played.done;
    await settle();
  }, 60_000);

  it('sends started first, then ends with exactly one gameOver and nothing after', () => {
    const { outputs } = played;
    expect(outputs[0]).toEqual({ type: 'started', generation: GENERATION });
    expect(outputs.filter((o) => o.type === 'started')).toHaveLength(1);
    const over = outputs.filter((o) => o.type === 'gameOver');
    expect(over).toHaveLength(1);
    expect(terminals(outputs)).toHaveLength(1);
    expect(outputs.at(-1)).toBe(over[0]);
    expect(over[0]).toMatchObject({ type: 'gameOver', result: { gameId: 'game-1' } });
    // The table policy makes a turn-cap halt terminal; the cap of 6 is what ended this game.
    expect(outputs.some((o) => o.type === 'publicFrame' && o.message.type === 'gameOver')).toBe(
      true,
    );
  });

  it('stamps every output with the port generation', () => {
    for (const output of played.outputs) expect(output.generation).toBe(GENERATION);
  });

  it("gives each human only its own seat's frames", () => {
    const seen = new Map<string, number>();
    for (const output of played.outputs) {
      if (output.type !== 'seatFrame') continue;
      expect(['P1', 'P3']).toContain(output.seat);
      seen.set(output.seat, (seen.get(output.seat) ?? 0) + 1);
      const message: ServerToClientMessage = output.message;
      if (message.type === 'playerStateSnapshot' || message.type === 'playerActionRequired') {
        expect(message.payload.state.viewerSeat).toBe(output.seat);
      }
    }
    expect(seen.get('P1') ?? 0).toBeGreaterThan(0);
    expect(seen.get('P3') ?? 0).toBeGreaterThan(0);
  });

  it('puts no seat-scoped frame on the public stream', () => {
    for (const output of played.outputs) {
      if (output.type !== 'publicFrame') continue;
      expect(['playerStateSnapshot', 'playerActionRequired', 'eventBatch']).not.toContain(
        output.message.type,
      );
    }
  });

  it('carries the rng key in no output', () => {
    const text = JSON.stringify(played.outputs);
    expect(text).not.toContain(KNOWN_KEY);
    expect(text.toLowerCase()).not.toContain(KNOWN_KEY.toLowerCase());
    // The game really did run on that key: its replay config is where the key lives.
    expect(played.calls.some((sql) => sql.includes('INSERT INTO games'))).toBe(true);
  });
});

describe('InProcessSessionPort - setup', () => {
  it('reports a bad decklist on one human seat as one setupProblems naming that seat only', async () => {
    const h = harness();
    await h.port.start(
      configOf({ seats: seatsOf({ ...HUMAN_DECKS, P3: `${HUMAN_DECKS.P3}\n1 Not A Real Card` }) }),
    );
    await h.done;
    await settle();

    expect(h.outputs).toHaveLength(1);
    const [only] = h.outputs;
    expect(only).toMatchObject({ type: 'setupProblems', generation: GENERATION });
    if (only?.type !== 'setupProblems') throw new Error('unreachable');
    expect(Object.keys(only.problems)).toEqual(['P3']);
    expect(only.problems['P3']).toEqual([
      expect.objectContaining({ code: 'unresolved', cardName: 'Not A Real Card' }),
    ]);
    expect(h.calls.some((sql) => sql.includes('INSERT INTO games'))).toBe(false);
  });

  it('reports validation issues under their own codes, and every failing seat', async () => {
    const short = HUMAN_DECKS.P1.split('\n').slice(0, 12).join('\n');
    const h = harness();
    await h.port.start(configOf({ seats: seatsOf({ P1: short, P3: 'Commander\nNobody Here' }) }));
    await h.done;
    const [only] = h.outputs;
    if (only?.type !== 'setupProblems')
      throw new Error(`expected setupProblems, got ${only?.type}`);
    expect(Object.keys(only.problems).sort()).toEqual(['P1', 'P3']);
    expect(only.problems['P1']?.map((p) => p.code)).toContain('cardCount');
    expect(only.problems['P3']?.[0]?.code).toBe('unresolved');
  });

  it('treats a problem on a bot seat as a server fault', async () => {
    const h = harness({ pool: buildSupportedPool([]) });
    await h.port.start(configOf());
    await h.done;
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0]).toMatchObject({
      type: 'failed',
      generation: GENERATION,
      reason: 'setupFailed',
    });
    expect(JSON.stringify(h.outputs)).not.toContain(KNOWN_KEY);
  });

  it('reports a setup exception as setupFailed with a short detail', async () => {
    const h = harness();
    await h.port.start(configOf({ seats: seatsOf().filter((s) => s.seat !== 'P2') }));
    await h.done;
    expect(h.outputs).toEqual([
      {
        type: 'failed',
        generation: GENERATION,
        reason: 'setupFailed',
        detail: expect.stringContaining('P1') as string,
      },
    ]);
  });

  it('starts once', async () => {
    const h = harness({ answer: false });
    await h.port.start(configOf({ turnCap: 2 }));
    await expect(h.port.start(configOf())).rejects.toThrow(/starts once/);
    await h.port.terminate('hostAbandoned');
  });
});

describe('InProcessSessionPort - termination', () => {
  it('reports one hostAbandoned failure mid-game and nothing after', async () => {
    const h = harness({ answer: false });
    await h.port.start(configOf({ turnCap: 40 }));
    expect(h.outputs[0]).toEqual({ type: 'started', generation: GENERATION });
    // The game is waiting on the humans: no answer has been sent.
    expect(
      h.outputs.some((o) => o.type === 'seatFrame' && o.message.type === 'playerActionRequired'),
    ).toBe(true);

    await h.port.terminate('hostAbandoned');
    const after = h.outputs.length;
    expect(terminals(h.outputs)).toEqual([
      { type: 'failed', generation: GENERATION, reason: 'hostAbandoned' },
    ]);
    expect(h.outputs.at(-1)?.type).toBe('failed');

    // A second terminate, a late input, and a resync produce nothing.
    await h.port.terminate('hostAbandoned');
    await h.port.terminate('workerFailure');
    await h.port.send({ type: 'resyncPlayer', seat: 'P1' });
    await h.port.send({ type: 'setPlayerConnected', seat: 'P1', connected: true });
    await settle();
    expect(h.outputs).toHaveLength(after);
  }, 30_000);

  it('reports workerFailure when that is the reason', async () => {
    const h = harness({ answer: false });
    await h.port.start(configOf({ turnCap: 40 }));
    await h.port.terminate('workerFailure');
    expect(terminals(h.outputs)).toEqual([
      { type: 'failed', generation: GENERATION, reason: 'workerFailure' },
    ]);
  }, 30_000);

  it('does not create a game when terminated before it starts', async () => {
    const h = harness();
    await h.port.terminate('hostAbandoned');
    await h.port.start(configOf());
    await settle();
    expect(h.outputs).toEqual([
      { type: 'failed', generation: GENERATION, reason: 'hostAbandoned' },
    ]);
  });

  it('answers a ping at once, before and during a game', async () => {
    const h = harness({ answer: false });
    await expect(h.port.ping()).resolves.toBeUndefined();
    await h.port.start(configOf({ turnCap: 40 }));
    await expect(h.port.ping()).resolves.toBeUndefined();
    await h.port.terminate('hostAbandoned');
  }, 30_000);

  it('stops delivering to a listener that unsubscribed', async () => {
    const h = harness({ answer: false });
    const seen: string[] = [];
    const off = h.port.onOutput((o) => seen.push(o.type));
    off();
    await h.port.start(configOf({ turnCap: 40 }));
    await h.port.terminate('hostAbandoned');
    expect(seen).toEqual([]);
  }, 30_000);
});

describe('toDeckProblems', () => {
  const base = {
    seat: 'P1' as const,
    message: 'x',
    issues: [],
    unresolvedNames: [],
    unmodeledCards: [],
  };

  it('maps validation issues, unresolved names and unmodeled cards', () => {
    expect(
      toDeckProblems({
        ...base,
        issues: [{ code: 'singleton', message: 'two of a card', cardName: 'Sol Ring' }],
        unresolvedNames: ['Nope'],
        unmodeledCards: ['Hard Card'],
      }),
    ).toEqual([
      { code: 'singleton', message: 'two of a card', cardName: 'Sol Ring' },
      expect.objectContaining({ code: 'unresolved', cardName: 'Nope' }),
      expect.objectContaining({ code: 'unresolved', cardName: 'Hard Card' }),
    ]);
  });

  it('falls back to parse with the setup message when no detail is listed', () => {
    expect(toDeckProblems({ ...base, message: 'Import failed.' })).toEqual([
      { code: 'parse', message: 'Import failed.' },
    ]);
  });
});

describe('buildSessionConfig', () => {
  const attempt: StartAttempt = {
    attemptId: 'attempt-9',
    tableId: 'table-9',
    seats: [
      {
        seat: 'P1',
        controller: 'human',
        displayName: 'Ann',
        decklist: 'the plaintext',
        deck: makeResolvedDeck({ commanders: [], cards: [] }),
      },
      { seat: 'P2', controller: 'bot' },
    ],
  };

  it('refuses a fixed rng key outside dev mode', () => {
    expect(() => buildSessionConfig(attempt, { dbPath: 'x.db', testRngKey: KNOWN_KEY })).toThrow(
      /dev mode/,
    );
    expect(() =>
      buildSessionConfig(attempt, { dbPath: 'x.db', dev: false, testRngKey: KNOWN_KEY }),
    ).toThrow(/dev mode/);
  });

  it('accepts a well-formed fixed key in dev mode, and refuses a malformed one', () => {
    expect(
      buildSessionConfig(attempt, { dbPath: 'x.db', dev: true, testRngKey: KNOWN_KEY }).rngKey,
    ).toBe(KNOWN_KEY);
    expect(() =>
      buildSessionConfig(attempt, { dbPath: 'x.db', dev: true, testRngKey: 'short' }),
    ).toThrow(/64/);
  });

  it('draws a fresh 64-digit key per call and fills the rest from the attempt', () => {
    const a = buildSessionConfig(attempt, { dbPath: 'x.db', turnCap: 12 });
    const b = buildSessionConfig(attempt, { dbPath: 'x.db' });
    expect(a.rngKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.rngKey).not.toBe(b.rngKey);
    expect(a.gameId).not.toBe(b.gameId);
    expect(a).toMatchObject({
      tableId: 'table-9',
      attemptId: 'attempt-9',
      dbPath: 'x.db',
      turnCap: 12,
      ...TABLE_ENGINE_LIMITS,
    });
    expect(a.seed).not.toContain(a.rngKey);
    expect(b).not.toHaveProperty('turnCap');
  });

  it('gives a human seat its name and plaintext and a bot only its controller', () => {
    const config = buildSessionConfig(attempt, { dbPath: 'x.db' });
    expect(config.seats).toEqual([
      { seat: 'P1', controller: 'human', displayName: 'Ann', decklist: 'the plaintext' },
      { seat: 'P2', controller: 'bot' },
    ]);
  });
});

describe('hex and generateRngKey', () => {
  it('encodes two lowercase digits per byte', () => {
    expect(hex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
    expect(generateRngKey()).toMatch(/^[0-9a-f]{64}$/);
  });
});

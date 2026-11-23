/**
 * A `'table'` session with two human seats (multiplayer M1, ADR 0031 decisions 2 and 3), run
 * in-process: the humans are scripted, the other two seats are random bots, and the game runs to
 * a turn cap of 6. The assertions are the privacy contract the table server will rely on, and
 * they hold before any table server exists.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  DecisionRequest,
  OracleCard,
  PlayerActionRequiredPayload,
  PlayerBoardState,
  PlayerId,
  ServerToClientMessage,
} from '@mtg/shared';
import { RandomDecisionProvider } from '@mtg/engine';
import { DEFAULT_AI_CONFIG, StrategyCoordinator, type AiClient, type AiConfig } from '../ai';
import type { GameStore } from '../db';
import { GameRecorder, type SqliteLike } from '../db/games';
import type { ReplayIdentity } from './replay-config';
import { sessionAi } from './session-ai';
import { MatchSession } from './session';
import type { SeatSetup } from './setup';
import { tablePolicy, testerPolicy } from './disclosure';

const SEED = 'multi-human-secret-seed';
const HUMANS = ['P1', 'P3'] as const;
const SEATS = ['P1', 'P2', 'P3', 'P4'] as const;

function land(seat: string, n: number): OracleCard {
  return {
    oracleId: `land-${seat}-${n}`,
    scryfallId: `scry-land-${seat}-${n}`,
    name: `Marker ${seat} ${n}`,
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
  return SEATS.map((seat) => ({
    seat,
    deckSnapshotId: null,
    config: {
      id: seat,
      deckId: `deck-${seat}`,
      commanders: [
        {
          ...land(seat, 0),
          oracleId: `general-${seat}`,
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
        },
      ],
      cards: Array.from({ length: 20 }, (_, i) => land(seat, i)),
    },
    summary: {
      seat,
      deckId: `deck-${seat}`,
      label: `Test General ${seat}`,
      commanderNames: [`Test General ${seat}`],
      colorIdentity: ['G'],
      archetypeTag: 'G — test',
    },
  }));
}

interface Table {
  session: MatchSession;
  /** Frames any viewer may see. */
  pub: ServerToClientMessage[];
  /** Frames addressed to one seat. */
  bySeat: Record<PlayerId, ServerToClientMessage[]>;
  all: () => ServerToClientMessage[];
}

function table(
  options: {
    providerKind?: 'random' | 'ai';
    turnCap?: number;
    store?: GameStore;
    replay?: ReplayIdentity;
    seed?: string;
    rng?: 'legacy' | 'chacha20';
    rngKey?: string;
    engineLimits?: { maxStepWork: number; maxObjects: number };
  } = {},
): Table {
  const pub: ServerToClientMessage[] = [];
  const bySeat: Record<PlayerId, ServerToClientMessage[]> = { P1: [], P3: [] };
  const session = new MatchSession({
    disclosure: tablePolicy(),
    gameId: 'g-multi-human',
    seed: options.seed ?? SEED,
    ...(options.rng !== undefined ? { rng: options.rng } : {}),
    ...(options.rngKey !== undefined ? { rngKey: options.rngKey } : {}),
    ...(options.engineLimits !== undefined ? { engineLimits: options.engineLimits } : {}),
    seats: seats(),
    providerKind: options.providerKind ?? 'random',
    ...(options.providerKind === 'ai' && { ai: sessionAi }),
    gameMode: 'table',
    seatControllers: {
      P1: 'human',
      P2: options.providerKind ?? 'random',
      P3: 'human',
      P4: options.providerKind ?? 'random',
    },
    turnCap: options.turnCap ?? 6,
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.replay !== undefined ? { replay: options.replay } : {}),
    livePaceMs: 0,
    send: (message) => pub.push(message),
    sendToSeat: (seat, message) => {
      const stream = bySeat[seat];
      if (stream === undefined) throw new Error(`frame addressed to non-human seat ${seat}`);
      stream.push(message);
    },
  });
  return {
    session,
    pub,
    bySeat,
    all: () => [...pub, ...Object.values(bySeat).flat()],
  };
}

type ActionRequired = Extract<ServerToClientMessage, { type: 'playerActionRequired' }>;

function required(frames: readonly ServerToClientMessage[]): ActionRequired[] {
  return frames.filter((m): m is ActionRequired => m.type === 'playerActionRequired');
}

async function until(done: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const ended = (t: Table): boolean =>
  t.pub.some((m) => m.type === 'gameOver' || m.type === 'computeHalted');

/** Answer each human's requests, in order, with that seat's own seeded chooser. */
async function playScripted(t: Table): Promise<void> {
  const choosers = new Map(
    HUMANS.map((seat) => [seat, new RandomDecisionProvider(`script-${seat}`)]),
  );
  const consumed = new Map<PlayerId, number>(HUMANS.map((seat) => [seat, 0]));
  t.session.start();
  while (!ended(t)) {
    let answered = false;
    for (const seat of HUMANS) {
      const next = required(t.bySeat[seat] ?? [])[consumed.get(seat) ?? 0];
      if (next === undefined) continue;
      consumed.set(seat, (consumed.get(seat) ?? 0) + 1);
      const response = choosers.get(seat)!.decide(next.payload.request);
      t.session.submitPlayerAction(seat, {
        requestId: response.requestId,
        actionId: response.actionId,
        revision: next.payload.revision,
        ...(response.targets !== undefined ? { targets: response.targets } : {}),
      });
      answered = true;
    }
    if (!answered) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await t.session.settled();
}

function boards(frames: readonly ServerToClientMessage[]): PlayerBoardState[] {
  return frames.flatMap((m) =>
    m.type === 'playerStateSnapshot' || m.type === 'playerActionRequired' ? [m.payload.state] : [],
  );
}

describe('MatchSession - a table with two human seats', () => {
  it('runs two humans and two random bots to a turn cap of 6', async () => {
    const t = table();
    await playScripted(t);

    const halted = t.pub.find((m) => m.type === 'computeHalted');
    expect(halted?.type === 'computeHalted' && halted.payload.kind).toBe('turnCap');
    expect(t.session.engine.getState().turnNumber).toBeGreaterThanOrEqual(6);
    for (const seat of HUMANS) {
      expect(required(t.bySeat[seat] ?? []).length).toBeGreaterThan(0);
    }
    expect(t.session.getHumanSeats()).toEqual(new Set(HUMANS));
    // Bots are not human seats: there is nowhere to send them a frame.
    expect(() =>
      (
        t.session as unknown as { sendToSeat(seat: string, m: ServerToClientMessage): void }
      ).sendToSeat('P2', { type: 'error', payload: { message: 'x' } }),
    ).toThrow(/not a human seat/);
  }, 30_000);

  it("shows each seat's stream only its own hand", async () => {
    const t = table();
    await playScripted(t);

    for (const seat of HUMANS) {
      const states = boards(t.bySeat[seat] ?? []);
      expect(states.length).toBeGreaterThan(0);
      let sawOwnHand = false;
      for (const state of states) {
        expect(state.viewerSeat).toBe(seat);
        for (const entry of state.seats) {
          if (entry.seat === seat) {
            sawOwnHand ||= (entry.hand?.length ?? 0) > 0;
          } else {
            expect(entry.hand).toBeNull();
          }
        }
      }
      expect(sawOwnHand).toBe(true);
    }
    // Nothing the other human drew is named in this seat's own frames except what became public.
    const p1Text = JSON.stringify(t.bySeat['P1']);
    expect(p1Text).not.toContain('"viewerSeat":"P3"');
  }, 30_000);

  it("refuses another seat's answer and a reused revision", async () => {
    const t = table({ turnCap: 40 });
    t.session.start();
    const pendingSeat = (): PlayerId | undefined =>
      HUMANS.find((seat) => required(t.bySeat[seat] ?? []).length > 0);
    await until(() => pendingSeat() !== undefined, 'the first human request');
    const owner = pendingSeat()!;
    const other = HUMANS.find((seat) => seat !== owner)!;
    const first = required(t.bySeat[owner] ?? [])[0]!.payload;
    const answer = (payload: PlayerActionRequiredPayload) => ({
      requestId: payload.request.requestId,
      revision: payload.revision,
      actionId: payload.request.legalActions[0]!.id,
    });
    const errorsOf = (seat: PlayerId) => (t.bySeat[seat] ?? []).filter((m) => m.type === 'error');

    // The other human cannot answer the owner's request, by id or by revision.
    t.session.submitPlayerAction(other, answer(first));
    expect(errorsOf(other)).toHaveLength(1);
    expect(errorsOf(owner)).toHaveLength(0);
    // The owner's decision is still pending: the attempt did not release the engine.
    expect(required(t.bySeat[owner] ?? [])).toHaveLength(1);

    // The owner answers properly; the same revision then cannot be used again.
    t.session.submitPlayerAction(owner, answer(first));
    await until(
      () => required(t.all()).some((m) => m.payload.request.requestId !== first.request.requestId),
      'the game to move on',
    );
    const before = errorsOf(owner).length;
    t.session.submitPlayerAction(owner, answer(first));
    const errors = errorsOf(owner);
    expect(errors.length).toBe(before + 1);
    expect(errors.at(-1)).toMatchObject({
      type: 'error',
      payload: { requestId: first.request.requestId, revision: first.revision },
    });

    t.session.abandon();
    await t.session.settled();
  }, 30_000);

  it('carries no seed, spectator state, debug, cost report or raw halt text on any frame', async () => {
    const t = table();
    // A table ignores debug and reasoning flags a client sends.
    t.session.setDebugFlags({
      showAIRequests: true,
      showAIResponses: true,
      showLegalActions: true,
      showSBAChecks: true,
      showPriorityPasses: true,
      showTokenUsage: true,
      verboseEngine: true,
    });
    await playScripted(t);
    t.session.jumpToTurn(2);

    const frames = t.all();
    const allowed = new Set([
      'playerStateSnapshot',
      'playerActionRequired',
      'eventBatch',
      'computeHalted',
      'gameOver',
      'diplomacyState',
      'error',
    ]);
    for (const frame of frames) expect(allowed.has(frame.type), frame.type).toBe(true);

    const text = JSON.stringify(frames);
    expect(text).not.toContain(SEED);
    expect(text).not.toContain('probable engine');
    for (const type of ['stateSnapshot', 'replayUnlocked', 'debugEvents', 'apiWaiting']) {
      expect(
        frames.some((m) => m.type === type),
        type,
      ).toBe(false);
    }
    // The seed field of the board a table sends is blank, not the game's label.
    for (const state of boards(frames)) expect(state.seed).toBe('');

    const halted = frames.find((m) => m.type === 'computeHalted');
    expect(halted).toMatchObject({
      payload: { reason: 'The rules engine could not continue this game.' },
    });
    expect(JSON.stringify(halted)).not.toContain('cardName');
    // A table is not shown a timeline, even after the game: its replay is the table database's.
    expect(t.pub.at(-1)).toMatchObject({
      type: 'error',
      payload: { message: 'Timeline seeking unlocks after a single-player game ends.' },
    });
  }, 30_000);

  it('does not make a bot wait for a disconnected human', async () => {
    const t = table();
    t.session.setPlayerConnected('P3', false);
    await playScripted(t);

    expect(t.pub.some((m) => m.type === 'computeHalted')).toBe(true);
    const connected = (t.bySeat['P3'] ?? []).flatMap((m) =>
      m.type === 'playerStateSnapshot' ? [m.payload.connected] : [],
    );
    expect(connected).toContain(false);
  }, 30_000);

  it('plans no strategist turn for either human seat, with a mocked AI client', () => {
    const t = table({ providerKind: 'ai' });
    const requestDecision = vi.fn(() => new Promise<never>(() => undefined));
    const client = {
      activeModel: 'mock-strategist',
      requestDecision,
      setAttemptObserver: () => undefined,
    } as unknown as AiClient;
    const config: AiConfig = {
      ...DEFAULT_AI_CONFIG,
      apiKey: 'test-key',
      strategistEnabled: true,
    };
    const internals = t.session as unknown as {
      aiConfig: AiConfig;
      aiStrategistClient: AiClient;
      aiTacticianClient: AiClient;
      ensureAiCoordinator(): StrategyCoordinator;
    };
    internals.aiConfig = config;
    internals.aiStrategistClient = client;
    internals.aiTacticianClient = client;
    const coordinator = internals.ensureAiCoordinator();

    const request = (seat: PlayerId, turn: number): DecisionRequest => ({
      requestId: `r-${seat}-${turn}`,
      gameId: 'g-multi-human',
      turn,
      activePlayer: seat,
      decidingPlayer: seat,
      phase: 'precombatMain',
      step: null,
      decisionType: 'priority',
      prompt: 'Choose.',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass priority' }],
    });
    coordinator.prepare(request('P1', 1));
    coordinator.prepare(request('P3', 1));
    coordinator.prefetch('g-multi-human', 1, 'P1');
    coordinator.prefetch('g-multi-human', 1, 'P3');
    expect(requestDecision).not.toHaveBeenCalled();

    // A bot seat is planned, so the skip above is the human seats' and not a dead coordinator.
    coordinator.prepare(request('P2', 1));
    expect(requestDecision).toHaveBeenCalledTimes(1);
    coordinator.cancel();
    t.session.abandon();
  });
});

describe('MatchSession - the disclosure policy at a table', () => {
  const send = (session: MatchSession) =>
    session as unknown as {
      sendPublic(message: ServerToClientMessage): void;
      sendToSeat(seat: string, message: ServerToClientMessage): void;
    };

  it('treats a halt as the end of the game and sends only the fixed message', async () => {
    const t = table();
    await playScripted(t);

    const halted = t.pub.find((m) => m.type === 'computeHalted');
    expect(halted).toBeDefined();
    if (halted?.type !== 'computeHalted') throw new Error('unreachable');
    expect(halted.payload.reason).toBe('The rules engine could not continue this game.');
    expect(halted.payload).not.toHaveProperty('cardName');

    // The halt is terminal for the post-game unlock: the result follows, with nothing raw in it.
    const over = t.pub.find((m) => m.type === 'gameOver');
    if (over?.type !== 'gameOver') throw new Error('a halted table game announces its result');
    expect(t.pub.indexOf(over)).toBeGreaterThan(t.pub.indexOf(halted));
    expect(over.payload.result.halted).toBe(true);
    expect(over.payload.result.haltReason).toBe('The rules engine could not continue this game.');
    expect(over.payload.result).not.toHaveProperty('haltSite');
    const raw = t.session.runner.getHalt()?.reason;
    expect(raw).toBeTruthy();
    for (const frame of [...t.pub, ...Object.values(t.bySeat).flat()]) {
      if (frame.type === 'eventBatch') continue;
      expect(JSON.stringify(frame)).not.toContain(raw as string);
    }
    expect(t.pub.map((m) => m.type)).not.toContain('replayUnlocked');
  }, 30_000);

  it('sends no debug events, cost reports or seed, and ignores the debug flags', async () => {
    const t = table();
    t.session.setDebugFlags({
      showAIRequests: true,
      showAIResponses: true,
      showLegalActions: true,
      showSBAChecks: true,
      showPriorityPasses: true,
      showTokenUsage: true,
      verboseEngine: true,
    });
    await playScripted(t);

    const types = new Set(t.all().map((m) => m.type));
    expect(types.has('debugEvents')).toBe(false);
    expect(types.has('apiWaiting')).toBe(false);
    expect(types.has('decisionPending')).toBe(false);
    expect(JSON.stringify(t.all())).not.toContain(SEED);
    for (const seat of HUMANS) {
      for (const state of boards(t.bySeat[seat] ?? [])) expect(state.seed).toBe('');
    }
  }, 30_000);

  it('stops a message the policy does not allow at the last hop, in tests by throwing', () => {
    const t = table();
    const debug: ServerToClientMessage = {
      type: 'debugEvents',
      payload: { gameId: 'g-multi-human', entries: [] },
    };
    expect(() => send(t.session).sendPublic(debug)).toThrow(/debugEvents/);
    expect(() => send(t.session).sendToSeat('P1', debug)).toThrow(/debugEvents/);
    // Nothing reached either stream.
    expect(t.all()).toEqual([]);
  });

  it('holds full-state frames until the game is over, then lets them through', async () => {
    const t = table();
    const replay: ServerToClientMessage = {
      type: 'replayUnlocked',
      payload: {
        state: t.session.engine.spectatorState(),
        lines: [],
        snapshotTurns: [],
        frontierTurn: 0,
      },
    };
    const snapshot: ServerToClientMessage = {
      type: 'stateSnapshot',
      payload: {
        turn: 0,
        state: t.session.engine.spectatorState(),
        frontierTurn: 0,
        atFrontier: true,
        sequence: null,
      },
    };
    for (const message of [replay, snapshot]) {
      expect(() => send(t.session).sendPublic(message)).toThrow(new RegExp(message.type));
      expect(() => send(t.session).sendToSeat('P1', message)).toThrow(new RegExp(message.type));
    }

    await playScripted(t);
    const before = t.all().length;
    send(t.session).sendToSeat('P1', replay);
    expect(t.all().length).toBe(before + 1);
  }, 30_000);

  it('drops, rather than throws, outside a test run', () => {
    vi.stubEnv('VITEST', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t = table();
      send(t.session).sendPublic({
        type: 'debugEvents',
        payload: { gameId: 'g-multi-human', entries: [] },
      });
      expect(t.all()).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  it('stores the replay inputs, and who answered each request', async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db: SqliteLike = {
      query: (sql: string) => ({
        run: (...args: unknown[]) => {
          calls.push({ sql, args });
        },
        all: () => [],
        get: () => null,
      }),
    };
    const store = { recorderFor: (id: string) => new GameRecorder(db, id) } as unknown as GameStore;
    const t = table({
      store,
      replay: {
        cardDataSha256: 'card-data-hash',
        build: { commit: 'abc123', branch: 'main', dirty: true },
      },
    });
    await playScripted(t);

    const update = calls.find((c) => c.sql.includes('UPDATE games SET config_json'));
    expect(update).toBeDefined();
    expect(JSON.parse(String(update?.args[0]))).toEqual({
      schemaVersion: 1,
      cardDataSha256: 'card-data-hash',
      seats: [
        { seat: 'P1', deckSnapshotId: 'deck-P1', manualMana: true },
        { seat: 'P2', deckSnapshotId: 'deck-P2', manualMana: false },
        { seat: 'P3', deckSnapshotId: 'deck-P3', manualMana: true },
        { seat: 'P4', deckSnapshotId: 'deck-P4', manualMana: false },
      ],
      turnCap: 6,
      rng: { kind: 'legacy', key: '' },
      engineOptions: { maxDecisions: 100000 },
    });
    expect(update?.args.slice(1)).toEqual(['abc123', 1, 'g-multi-human']);

    const sources = calls
      .filter((c) => c.sql.includes('INSERT INTO game_decision_sources'))
      .map((c) => ({ seat: c.args[2] as number, source: c.args[3] as string }));
    expect(sources.length).toBeGreaterThan(0);
    for (const row of sources) {
      expect(row.seat === 1 || row.seat === 3 ? ['human', 'auto'] : ['bot']).toContain(row.source);
    }
    expect(sources.some((row) => row.source === 'human')).toBe(true);
    expect(sources.some((row) => row.source === 'bot')).toBe(true);
  }, 30_000);

  it('passes the engine limits to the engine and stores them with the replay inputs', async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db: SqliteLike = {
      query: (sql: string) => ({
        run: (...args: unknown[]) => {
          calls.push({ sql, args });
        },
        all: () => [],
        get: () => null,
      }),
    };
    const store = { recorderFor: (id: string) => new GameRecorder(db, id) } as unknown as GameStore;
    const t = table({
      store,
      engineLimits: { maxStepWork: 50_000, maxObjects: 20_000 },
      replay: {
        cardDataSha256: 'card-data-hash',
        build: { commit: 'abc123', branch: 'main', dirty: false },
      },
    });
    const budget = (t.session.engine as unknown as { ctx: { budget?: unknown } }).ctx.budget;
    expect(budget).toMatchObject({ maxStepWork: 50_000, maxObjects: 20_000 });
    t.session.start();
    t.session.abandon();
    await t.session.settled();

    const update = calls.find((c) => c.sql.includes('UPDATE games SET config_json'));
    expect(JSON.parse(String(update?.args[0]))).toMatchObject({
      engineOptions: { maxDecisions: 100000, maxStepWork: 50_000, maxObjects: 20_000 },
    });
  }, 30_000);

  it('stores no replay inputs when the entry point names no identity', async () => {
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
    const store = { recorderFor: (id: string) => new GameRecorder(db, id) } as unknown as GameStore;
    const t = table({ store });
    await playScripted(t);
    expect(calls.some((sql) => sql.includes('config_json'))).toBe(false);
  }, 30_000);

  it('records no decision sources for a game with no human seat', async () => {
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
    const store = { recorderFor: (id: string) => new GameRecorder(db, id) } as unknown as GameStore;
    const session = new MatchSession({
      disclosure: testerPolicy('spectator'),
      gameId: 'g-no-human',
      seed: SEED,
      seats: seats(),
      providerKind: 'random',
      turnCap: 4,
      store,
      playbackMode: 'manual',
      livePaceMs: 0,
      send: () => undefined,
    });
    session.start();
    await session.settled();
    expect(calls.some((sql) => sql.includes('INSERT INTO game_events'))).toBe(true);
    expect(calls.some((sql) => sql.includes('game_decision_sources'))).toBe(false);
  }, 30_000);
});

describe('MatchSession - a chacha20 table (ADR 0031 decision 4)', () => {
  const KEY = '5d0e8a47c1f3926b7e04d8a5319cb6f2a87d40e1935b6c28f4a0d7e3918c5b6a';
  const OTHER_KEY = 'b81f3c6a09d47e52c8a1f40d6e37b92a5c0e8d14f7a369b2e508c1d4a7f3e690';
  const chacha = (rngKey: string, seed?: string) =>
    table({ rng: 'chacha20', rngKey, ...(seed !== undefined ? { seed } : {}) });

  async function eventLog(t: Table): Promise<string> {
    await playScripted(t);
    return JSON.stringify(t.session.engine.eventsSince(0));
  }

  it('is deterministic given its key, whatever the public label says', async () => {
    const first = await eventLog(chacha(KEY));
    const again = await eventLog(chacha(KEY));
    // The `gameStart` event names the public label; nothing else in the log may depend on it.
    const relabelled = (await eventLog(chacha(KEY, 'a-different-public-label'))).replaceAll(
      'a-different-public-label',
      SEED,
    );
    expect(first.length).toBeGreaterThan(1000);
    expect(again).toBe(first);
    expect(relabelled).toBe(first);
  }, 60_000);

  it('plays differently under another key, and differently from the legacy generator', async () => {
    const keyed = await eventLog(chacha(KEY));
    expect(await eventLog(chacha(OTHER_KEY))).not.toBe(keyed);
    expect(await eventLog(table())).not.toBe(keyed);
  }, 60_000);

  it('refuses a chacha20 table with no key, or a key on a legacy one', () => {
    expect(() => table({ rng: 'chacha20' })).toThrow(/needs an rngKey/);
    expect(() => table({ rng: 'chacha20', rngKey: 'abcd' })).toThrow(/64 hex digits/);
    expect(() => table({ rngKey: KEY })).toThrow(/legacy/);
  });

  it('puts the key in no frame, event, snapshot or board, and the seed in none either', async () => {
    const t = chacha(KEY, 'public-label-xyz');
    await playScripted(t);
    const engine = t.session.engine;

    const needles = [
      KEY,
      KEY.toUpperCase(),
      // The first half also catches a truncated or re-wrapped copy.
      KEY.slice(0, 32),
      Buffer.from(KEY, 'hex').toString('base64'),
      JSON.stringify([...Buffer.from(KEY, 'hex')]),
    ];
    const surfaces: Record<string, string> = {
      frames: JSON.stringify(t.all()),
      events: JSON.stringify(engine.eventsSince(0)),
      state: JSON.stringify(engine.getState()),
      spectator: JSON.stringify(engine.spectatorState()),
      boards: JSON.stringify(SEATS.map((seat) => engine.playerState(seat))),
      views: JSON.stringify(SEATS.map((seat) => engine.view(seat))),
      debug: JSON.stringify(engine.getDebugLog()),
    };
    for (const [surface, text] of Object.entries(surfaces)) {
      expect(text.length, surface).toBeGreaterThan(2);
      for (const needle of needles) expect(text, `${surface} holds the key`).not.toContain(needle);
    }
    expect(surfaces['frames']).not.toContain('public-label-xyz');
    // The frames the humans saw are real: they carry the game.
    expect(required(t.bySeat['P1'] ?? []).length).toBeGreaterThan(0);
  }, 60_000);

  it('stores the key only in the replay config, as the stored config is where it lives', async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db: SqliteLike = {
      query: (sql: string) => ({
        run: (...args: unknown[]) => {
          calls.push({ sql, args });
        },
        all: () => [],
        get: () => null,
      }),
    };
    const store = { recorderFor: (id: string) => new GameRecorder(db, id) } as unknown as GameStore;
    const t = table({
      store,
      rng: 'chacha20',
      rngKey: KEY,
      replay: {
        cardDataSha256: 'card-data-hash',
        build: { commit: 'abc123', branch: 'main', dirty: false },
      },
    });
    await playScripted(t);

    const holders = calls.filter((c) => JSON.stringify(c.args).includes(KEY));
    expect(holders.map((c) => c.sql.includes('UPDATE games SET config_json'))).toEqual([true]);
    const update = holders[0]!;
    expect(JSON.parse(String(update.args[0])).rng).toEqual({ kind: 'chacha20', key: KEY });
  }, 30_000);
});

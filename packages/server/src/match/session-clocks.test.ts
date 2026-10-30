/**
 * A timed table (plan M4): clocks, timeouts, the fallback bot, disconnect grace, resumeControl
 * and the game cap, on a `'table'` session with two human seats and two random bots. Time is
 * injected, so each expiry happens exactly when the test says.
 */

import { describe, expect, it } from 'vitest';
import type {
  OracleCard,
  PlayerId,
  ServerToClientMessage,
  TableServerToClientMessage,
} from '@mtg/shared';
import type { GameStore } from '../db';
import { GameRecorder, type SqliteLike } from '../db/games';
import type { ClockSettings, ClockTimers } from './decision-clock';
import { tablePolicy } from './disclosure';
import { MatchSession } from './session';
import type { SeatSetup } from './setup';
import { fallbackMenu, TableClocks, withoutNote } from './table-clocks';

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

/** Clock timers the test advances by hand. */
function manualTimers() {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: ClockTimers = {
    now: () => now,
    setTimeout: (callback, ms) => {
      nextId += 1;
      pending.set(nextId, { at: now + ms, callback });
      return nextId;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = end;
  };
  return { timers, advance };
}

const SETTINGS: ClockSettings = {
  allowanceMs: 1_000,
  bankMs: 0,
  graceMs: 5_000,
  disconnectBudgetMs: 20_000,
  gameCapMs: 10_000_000,
};

describe('all-away termination', () => {
  it('keeps a returned player in the game, and ends it if that player leaves again', () => {
    const time = manualTimers();
    const connected = new Set<PlayerId>(['P1', 'P3']);
    const endings: string[] = [];
    const clocks = new TableClocks(
      SETTINGS,
      {
        humanSeats: new Set(['P1', 'P3']),
        takeOver: () => null,
        fallbackDecide: () => {
          throw new Error('no decision is pending');
        },
        tagSource: () => undefined,
        concede: (reason) => endings.push(reason),
        isEliminated: () => false,
        isConnected: (seat) => connected.has(seat),
        publish: () => undefined,
      },
      time.timers,
    );
    const connection = (seat: PlayerId, present: boolean) => {
      if (present) connected.add(seat);
      else connected.delete(seat);
      clocks.connection(seat, present);
    };
    connection('P1', false);
    time.advance(SETTINGS.disconnectBudgetMs);
    connection('P1', true);
    connection('P3', false);
    time.advance(SETTINGS.disconnectBudgetMs);
    expect(endings).toEqual([]);
    connection('P1', false);
    expect(endings).toEqual(['allAway']);
    clocks.stop();
  });
});

/** A recorder over a fake database: decision sources and game-row updates are captured. */
function fakeStore() {
  const sources = new Map<string, string>();
  const statuses: string[] = [];
  const db: SqliteLike = {
    query: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT INTO game_decision_sources')) {
          sources.set(String(args[1]), String(args[3]));
        }
        if (sql.startsWith('UPDATE games SET ended_at')) statuses.push(String(args[3]));
      },
      all: () => [],
      get: () => null,
    }),
  };
  const store = { recorderFor: (gameId: string) => new GameRecorder(db, gameId) };
  return { store: store as unknown as GameStore, sources, statuses };
}

type Required = Extract<ServerToClientMessage, { type: 'playerActionRequired' }>;

function timedTable(settings: ClockSettings = SETTINGS, turnCap = 40) {
  const time = manualTimers();
  const { store, sources, statuses } = fakeStore();
  const pub: ServerToClientMessage[] = [];
  const tableFrames: TableServerToClientMessage[] = [];
  const bySeat: Record<string, ServerToClientMessage[]> = { P1: [], P3: [] };
  const session = new MatchSession({
    disclosure: tablePolicy(),
    gameId: 'g-clocks',
    seed: 'clock-seed',
    rng: 'chacha20',
    rngKey: '7e'.repeat(32),
    seats: seats(),
    providerKind: 'random',
    gameMode: 'table',
    seatControllers: { P1: 'human', P2: 'random', P3: 'human', P4: 'random' },
    turnCap,
    livePaceMs: 0,
    store,
    clock: { settings, timers: time.timers },
    send: (message) => pub.push(message),
    sendToSeat: (seat, message) => bySeat[seat]!.push(message),
    sendTable: (message) => tableFrames.push(message),
  });
  const required = (seat: PlayerId): Required[] =>
    (bySeat[seat] ?? []).filter((m): m is Required => m.type === 'playerActionRequired');
  return { session, time, sources, statuses, pub, tableFrames, bySeat, required };
}

type Timed = ReturnType<typeof timedTable>;

async function until(done: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Answer every P3 request with its first legal action, as a player who is always there. */
function keepAnswering(t: Timed, seat: PlayerId): () => void {
  let consumed = 0;
  let stop = false;
  const loop = async (): Promise<void> => {
    while (!stop) {
      const next = t.required(seat)[consumed];
      if (next !== undefined) {
        consumed += 1;
        t.session.submitPlayerAction(seat, {
          requestId: next.payload.request.requestId,
          revision: next.payload.revision,
          actionId: next.payload.request.legalActions[0]!.id,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  void loop();
  return () => {
    stop = true;
  };
}

const over = (t: Timed) => t.pub.some((m) => m.type === 'gameOver' || m.type === 'computeHalted');

const status = (t: Timed, seat: PlayerId) =>
  t.tableFrames.filter(
    (m): m is Extract<TableServerToClientMessage, { type: 'seatStatus' }> =>
      m.type === 'seatStatus' && m.payload.seat === seat,
  );

describe('fallback menus', () => {
  it('drop manual mana activations, keep ids, and drop the note', () => {
    const menu = fallbackMenu({
      legalActions: [
        { id: 0, type: 'pass', description: 'Pass' },
        { id: 1, type: 'activateManaAbility', description: 'Forest: add {G}' },
        { id: 2, type: 'playLand', description: 'Play Forest' },
      ],
    } as never);
    expect(menu.legalActions.map((a) => a.id)).toEqual([0, 2]);
    expect(withoutNote({ requestId: 'r', actionId: 0, note: 'thinking' })).toEqual({
      requestId: 'r',
      actionId: 0,
    });
  });
});

describe('a timed table', () => {
  it('answers a timed-out decision with the fallback bot, and a late answer is stale', async () => {
    const t = timedTable();
    const stopP3 = keepAnswering(t, 'P3');
    t.session.start();
    await until(() => t.required('P1').length > 0, 'a P1 decision');
    const first = t.required('P1')[0]!;
    expect(t.tableFrames.at(-1)).toMatchObject({
      type: 'clockState',
      payload: { seat: 'P1', running: true, remainingMs: 1_000 },
    });
    t.time.advance(1_000);
    await until(() => t.sources.has(first.payload.request.requestId), 'the timeout answer');
    expect(t.sources.get(first.payload.request.requestId)).toBe('timeout');
    const errors: string[] = [];
    const late = t.bySeat['P1']!.length;
    t.session.submitPlayerAction('P1', {
      requestId: first.payload.request.requestId,
      revision: first.payload.revision,
      actionId: 0,
    });
    for (const frame of t.bySeat['P1']!.slice(late)) {
      if (frame.type === 'error') errors.push(frame.payload.message);
    }
    expect(errors.length).toBe(1);
    stopP3();
    t.session.abandon();
  }, 30_000);

  it('hands the seat to the fallback bot after three timeouts in a row, until resumeControl', async () => {
    const t = timedTable();
    const stopP3 = keepAnswering(t, 'P3');
    t.session.start();
    for (let i = 1; i <= 3; i++) {
      await until(() => t.required('P1').length >= i, `P1 decision ${i}`);
      t.time.advance(1_000);
    }
    await until(() => status(t, 'P1').some((s) => s.payload.fallback), 'the takeover');
    const shownAtTakeover = t.required('P1').length;
    // The fallback bot plays on: P1 is shown nothing while turns pass.
    const turnAtTakeover = t.session.engine.getState().turnNumber;
    await until(
      () => t.session.engine.getState().turnNumber >= turnAtTakeover + 4 || over(t),
      'turns under the fallback bot',
    );
    expect(t.required('P1').length).toBe(shownAtTakeover);
    expect([...t.sources.values()]).toContain('fallback');
    // No manual mana from the fallback bot: none of its P1 decisions tapped a land by hand.
    const botAnswers = new Set(
      [...t.sources].filter(([, s]) => s === 'fallback' || s === 'timeout').map(([id]) => id),
    );
    for (const event of t.session.engine.eventsSince(0)) {
      if (event.type !== 'decision' || !botAnswers.has(String(event.payload['requestId'])))
        continue;
      expect(String(event.payload['description'])).not.toMatch(/: add \{/);
    }
    // Taking the seat back: the next decision is shown to the player again.
    t.session.resumeControl('P1');
    expect(status(t, 'P1').at(-1)?.payload).toEqual({
      seat: 'P1',
      connected: true,
      fallback: false,
    });
    await until(() => t.required('P1').length > shownAtTakeover || over(t), 'the next P1 decision');
    expect(t.required('P1').length).toBeGreaterThan(shownAtTakeover);
    stopP3();
    t.session.abandon();
  }, 30_000);

  it('hands a seat over when its disconnect grace runs out, while the other seat plays on', async () => {
    const t = timedTable();
    const stopP3 = keepAnswering(t, 'P3');
    t.session.start();
    await until(() => t.required('P1').length > 0, 'a P1 decision');
    t.session.setPlayerConnected('P1', false);
    expect(status(t, 'P1').at(-1)?.payload).toEqual({
      seat: 'P1',
      connected: false,
      fallback: false,
    });
    // The decision clock is paused while P1 is away: its allowance does not run out.
    t.time.advance(4_999);
    expect(status(t, 'P1').some((s) => s.payload.fallback)).toBe(false);
    t.time.advance(1);
    await until(() => status(t, 'P1').some((s) => s.payload.fallback), 'the takeover');
    const p3Before = t.required('P3').length;
    await until(() => t.required('P3').length > p3Before + 2 || over(t), 'P3 playing on');
    // P1 comes back and takes control; the next decision is theirs.
    t.session.setPlayerConnected('P1', true);
    const shown = t.required('P1').length;
    t.session.resumeControl('P1');
    await until(() => t.required('P1').length > shown || over(t), 'the next P1 decision');
    expect(t.required('P1').length).toBeGreaterThan(shown);
    stopP3();
    t.session.abandon();
  }, 30_000);

  it('resyncs other seats clocks and fallback badges without renewing their deadlines', async () => {
    const t = timedTable({ ...SETTINGS, allowanceMs: 1_000_000 });
    const stopP3 = keepAnswering(t, 'P3');
    try {
      t.session.start();
      await until(() => t.required('P1').length > 0, 'a P1 decision');
      t.time.advance(123);
      const before = t.tableFrames.length;
      t.session.resyncPlayer('P3');
      const frames = t.tableFrames.slice(before);
      expect(frames).toContainEqual({
        type: 'clockState',
        payload: { seat: 'P1', remainingMs: 999_877, bankMs: 0, running: true },
      });
      expect(frames).toContainEqual({
        type: 'seatStatus',
        payload: { seat: 'P1', connected: true, fallback: false },
      });
      t.time.advance(999_876);
      expect([...t.sources.values()]).not.toContain('timeout');
      t.time.advance(1);
      await until(() => [...t.sources.values()].includes('timeout'), 'the original deadline');
    } finally {
      stopP3();
      t.session.abandon();
      await t.session.settled();
    }
  }, 30_000);

  it('ends at the game cap as a draw stored as an outcome, not a halt', async () => {
    const t = timedTable({ ...SETTINGS, allowanceMs: 1_000_000, gameCapMs: 50_000 });
    t.session.start();
    // Nobody answers, so the game waits on whichever human it asks first.
    await until(() => t.required('P1').length + t.required('P3').length > 0, 'a human decision');
    t.time.advance(50_000);
    await until(() => over(t), 'the end of the game');
    expect(t.pub.some((m) => m.type === 'computeHalted')).toBe(false);
    const gameOver = t.pub.find((m) => m.type === 'gameOver');
    expect(gameOver?.type === 'gameOver' && gameOver.payload.result).toMatchObject({
      winnerSeat: null,
      halted: false,
      endReason: 'timeLimit',
    });
    expect(t.statuses).toEqual(['finished']);
    expect(t.session.engine.eventsSince(0).some((event) => event.type === 'conceded')).toBe(true);
    await t.session.settled();
  }, 30_000);

  it('starts a clock only for a decision actually shown', async () => {
    const t = timedTable({ ...SETTINGS, allowanceMs: 1_000_000 });
    const stopP1 = keepAnswering(t, 'P1');
    const stopP3 = keepAnswering(t, 'P3');
    t.session.start();
    await until(() => t.session.engine.getState().turnNumber >= 6 || over(t), 'six turns');
    stopP1();
    stopP3();
    t.session.abandon();
    for (const seat of ['P1', 'P3'] as const) {
      const shown = new Set(t.required(seat).map((m) => m.payload.request.requestId));
      const started = t.tableFrames.filter(
        (m) => m.type === 'clockState' && m.payload.seat === seat && m.payload.running,
      );
      expect(started.length).toBe(shown.size);
    }
  }, 30_000);

  it('refuses clocks outside a table, and an untimed table has none', () => {
    expect(
      () =>
        new MatchSession({
          disclosure: tablePolicy(),
          gameId: 'g',
          seed: 's',
          seats: seats(),
          providerKind: 'random',
          gameMode: 'spectator',
          clock: { settings: SETTINGS },
          send: () => undefined,
        }),
    ).toThrow(/table games only/);
    const frames: TableServerToClientMessage[] = [];
    const untimed = new MatchSession({
      disclosure: tablePolicy(),
      gameId: 'g',
      seed: 's',
      seats: seats(),
      providerKind: 'random',
      gameMode: 'table',
      seatControllers: { P1: 'human', P2: 'random', P3: 'random', P4: 'random' },
      send: () => undefined,
      sendToSeat: () => undefined,
      sendTable: (message) => frames.push(message),
    });
    untimed.setPlayerConnected('P1', false);
    expect(frames).toEqual([]);
    untimed.abandon();
  });
});

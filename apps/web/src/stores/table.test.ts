/**
 * The table store (plan M6 task 2) over a fake socket: table frames stay here, game frames reach
 * the game store, the game store's answers go out on the table socket, the seat token is kept
 * per table and resumed on every reconnect, and a takeover, a version mismatch or a closed table
 * stops reconnecting.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { PROTOCOL_VERSION } from '@mtg/shared';
import { useGameStore } from './game';
import { useTableStore, type TableSocketLike } from './table';

class FakeSocket implements TableSocketLike {
  readonly sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  closed = false;
  private openListener: () => void = () => undefined;
  private messageListener: (text: string) => void = () => undefined;
  private closeListener: () => void = () => undefined;
  constructor(readonly url: string) {}
  send(text: string): void {
    this.sent.push(JSON.parse(text) as { type: string; payload: Record<string, unknown> });
  }
  close(): void {
    this.closed = true;
    this.closeListener();
  }
  onOpen(listener: () => void): void {
    this.openListener = listener;
  }
  onMessage(listener: (text: string) => void): void {
    this.messageListener = listener;
  }
  onClose(listener: () => void): void {
    this.closeListener = listener;
  }
  open(): void {
    this.openListener();
  }
  deliver(message: object): void {
    this.messageListener(JSON.stringify(message));
  }
  drop(): void {
    this.closeListener();
  }
}

const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key),
});
vi.stubGlobal('window', { location: { protocol: 'https:', host: 'tables.example.com' } });

let sockets: FakeSocket[] = [];
let now = 1_000;

function setup() {
  setActivePinia(createPinia());
  sockets = [];
  const table = useTableStore();
  table.configure({
    factory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => now,
  });
  return { table, game: useGameStore() };
}

const tableState = (you: Record<string, unknown>, phase = 'open') => ({
  type: 'tableState',
  payload: {
    tableId: 't1',
    phase,
    seats: [
      { seat: 'P1', controller: 'human', displayName: 'Ann', connected: true },
      { seat: 'P2', controller: 'bot', displayName: null, connected: false },
    ],
    canStart: false,
    startBlockers: [],
    insecureLan: true,
    clock: 'relaxed',
    you: { displayName: 'Ann', seat: null, claim: null, isHost: false, ...you },
  },
});

beforeEach(() => {
  memory.clear();
  vi.useRealTimers();
});

describe('table store', () => {
  it("opens the table's socket on the page's origin and joins with the invite", () => {
    const { table } = setup();
    table.open('t1');
    expect(sockets[0]?.url).toBe('wss://tables.example.com/tables/t1/ws');
    sockets[0]!.open();
    table.join('inv-1', 'Ann');
    expect(sockets[0]!.sent.at(-1)).toEqual({
      type: 'joinTable',
      payload: {
        inviteCode: 'inv-1',
        displayName: 'Ann',
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
      },
    });
  });

  it('keeps the seat token per table and resumes it, on this socket and the next', () => {
    const { table } = setup();
    table.open('t1');
    const first = sockets[0]!;
    first.open();
    first.deliver({ type: 'seatGranted', payload: { seat: 'P1', seatToken: 'tok-1' } });
    expect(memory.get('mtg-table-seat:t1')).toBe('tok-1');
    expect(first.sent.at(-1)).toMatchObject({
      type: 'resumeSeat',
      payload: { seatToken: 'tok-1', protocolVersion: PROTOCOL_VERSION },
    });
    // A new store (a reloaded page) finds the token and resumes on connect.
    const reloaded = setup().table;
    reloaded.open('t1');
    sockets[0]!.open();
    expect(sockets[0]!.sent[0]).toMatchObject({
      type: 'resumeSeat',
      payload: { seatToken: 'tok-1' },
    });
  });

  it('reconnects with backoff after a drop, and resumes the seat', () => {
    vi.useFakeTimers();
    const { table } = setup();
    memory.set('mtg-table-seat:t1', 'tok-9');
    table.open('t1');
    sockets[0]!.open();
    sockets[0]!.drop();
    expect(table.connection).toBe('closed');
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent[0]).toMatchObject({
      type: 'resumeSeat',
      payload: { seatToken: 'tok-9' },
    });
  });

  it('never reconnects after a takeover or a version mismatch', () => {
    vi.useFakeTimers();
    for (const frame of [
      { type: 'seatTakenOver', payload: { seat: 'P1' } },
      { type: 'protocolMismatch', payload: { serverVersion: 9, clientVersion: 1 } },
    ]) {
      const { table } = setup();
      table.open('t1');
      sockets[0]!.open();
      sockets[0]!.deliver(frame);
      vi.advanceTimersByTime(60_000);
      expect(sockets, frame.type).toHaveLength(1);
      expect(table.stopped).not.toBeNull();
    }
  });

  it('forgets the tokens when the table closes', () => {
    const { table } = setup();
    memory.set('mtg-table-seat:t1', 'tok');
    memory.set('mtg-table-host:t1', 'host');
    table.open('t1');
    sockets[0]!.open();
    sockets[0]!.deliver({ type: 'tableClosed', payload: { reason: 'kicked' } });
    expect(memory.has('mtg-table-seat:t1')).toBe(false);
    expect(memory.has('mtg-table-host:t1')).toBe(false);
    expect(table.stopped).toBe('kicked');
  });

  it('authenticates a stored host token on connect', () => {
    const { table } = setup();
    memory.set('mtg-table-host:t1', 'host-token');
    table.open('t1');
    sockets[0]!.open();
    expect(sockets[0]!.sent[0]).toEqual({ type: 'hostAuth', payload: { hostToken: 'host-token' } });
  });

  it('keeps table frames, and hands game frames to the game store and its answers back', () => {
    const { table, game } = setup();
    table.open('t1');
    sockets[0]!.open();
    sockets[0]!.deliver(tableState({ seat: 'P1' }));
    expect(table.mySeat).toBe('P1');
    expect(table.insecureLan).toBe(true);
    expect(table.displayNames).toEqual({ P1: 'Ann' });
    sockets[0]!.deliver({
      type: 'gameStarted',
      payload: {
        gameId: 'g1',
        seed: '',
        seats: [],
        providerKind: 'random',
        gameMode: 'table',
        humanSeat: 'P1',
        startedAt: 'now',
      },
    });
    expect(game.gameId).toBe('g1');
    expect(game.gameMode).toBe('table');
    game.cancelYield();
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'cancelYield', payload: {} });
  });

  it('counts a running clock down from its report, and holds a stopped one', () => {
    const { table } = setup();
    table.open('t1');
    sockets[0]!.open();
    now = 10_000;
    sockets[0]!.deliver({
      type: 'clockState',
      payload: { seat: 'P2', remainingMs: 30_000, bankMs: 20_000, running: true },
    });
    expect(table.remainingMs('P2', 14_000)).toBe(26_000);
    expect(table.remainingMs('P2', 100_000)).toBe(0);
    sockets[0]!.deliver({
      type: 'clockState',
      payload: { seat: 'P2', remainingMs: 25_000, bankMs: 15_000, running: false },
    });
    expect(table.remainingMs('P2', 50_000)).toBe(25_000);
    sockets[0]!.deliver({
      type: 'seatStatus',
      payload: { seat: 'P1', connected: true, fallback: true },
    });
    expect(table.seatStatus['P1']?.fallback).toBe(true);
    table.resumeControl();
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'resumeControl', payload: {} });
  });

  it('keeps the post-game record and asks for replay turns', () => {
    const { table } = setup();
    table.open('t1');
    sockets[0]!.open();
    sockets[0]!.deliver({
      type: 'tableResults',
      payload: { ending: 'gameOver', result: null, rngKey: 'ab', decks: [], replayTurns: [0, 1] },
    });
    expect(table.results?.replayTurns).toEqual([0, 1]);
    table.requestReplayTurn(1);
    expect(sockets[0]!.sent.at(-1)).toEqual({ type: 'replayTurn', payload: { turn: 1 } });
    sockets[0]!.deliver({ type: 'replayTurnState', payload: { turn: 1, state: { seats: [] } } });
    expect(table.replayTurn?.turn).toBe(1);
  });
});

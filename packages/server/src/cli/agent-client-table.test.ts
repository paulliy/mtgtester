/**
 * Table mode of the JSON agent client (plan M3 task 13), driven without a socket: the lobby
 * handshake, the capability declaration on join and on resume, the seat token kept off stdout,
 * adoption of the table's game for the granted seat, and the `first-legal` policy.
 */

import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type ClientToServerMessage,
  type DecisionRequest,
  type PlayerBoardState,
  type ServerToClientMessage,
  type TableClientToServerMessage,
  type TableServerToClientMessage,
} from '@mtg/shared';
import type { AgentEvent } from './agent-client-core';
import { parseTableAgentArgs, TableAgentSession, tableSocketTarget } from './agent-client-table';

const TOKEN = 'seat-token-secret-0123456789';

function makeSession(policy: 'stdin' | 'first-legal' = 'first-legal') {
  const sent: Array<ClientToServerMessage | TableClientToServerMessage> = [];
  const events: AgentEvent[] = [];
  const diagnostics: string[] = [];
  const done: number[] = [];
  let closed = false;
  const session = new TableAgentSession({
    io: { event: (event) => events.push(event), diagnostic: (text) => diagnostics.push(text) },
    transport: {
      send: (message) => sent.push(message),
      close: () => {
        closed = true;
      },
    },
    join: { inviteCode: 'inv', displayName: 'Ann', seat: 'P2', decklist: 'deck text' },
    policy,
    onDone: (code) => done.push(code),
  });
  return { session, sent, events, diagnostics, done, isClosed: () => closed };
}

const tableState = (you: { seat: string | null; claim: object | null }, phase = 'open') =>
  ({
    type: 'tableState',
    payload: {
      tableId: 't',
      phase,
      seats: [],
      canStart: false,
      startBlockers: [],
      insecureLan: false,
      clock: null,
      you: { displayName: 'Ann', isHost: false, ...you },
    },
  }) as unknown as TableServerToClientMessage;

const started = (seat: string, gameId = 'g1'): ServerToClientMessage => ({
  type: 'gameStarted',
  payload: {
    gameId,
    seed: '',
    seats: [],
    providerKind: 'random',
    gameMode: 'table',
    humanSeat: seat,
    startedAt: 'now',
  },
});

const request = (): DecisionRequest => ({
  requestId: 'q1',
  gameId: 'g1',
  turn: 1,
  activePlayer: 'P2',
  decidingPlayer: 'P2',
  phase: 'precombatMain',
  step: null,
  decisionType: 'priority',
  prompt: 'Choose.',
  legalActions: [
    { id: 4, type: 'castSpell', description: 'Cast', targets: [{ slot: 0, options: ['o9'] }] },
    { id: 0, type: 'pass', description: 'Pass' },
  ],
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('TableAgentSession', () => {
  it('joins with its capabilities, asks for its seat once, and resumes it with the token', () => {
    const { session, sent, events } = makeSession();
    session.begin();
    expect(sent[0]).toEqual({
      type: 'joinTable',
      payload: {
        inviteCode: 'inv',
        displayName: 'Ann',
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { rawActionData: true },
      },
    });
    session.receive(tableState({ seat: null, claim: null }));
    session.receive(tableState({ seat: null, claim: null }));
    expect(sent.filter((m) => m.type === 'requestSeat')).toEqual([
      { type: 'requestSeat', payload: { seat: 'P2', decklist: 'deck text' } },
    ]);
    session.receive({ type: 'seatGranted', payload: { seat: 'P2', seatToken: TOKEN } });
    expect(sent.at(-1)).toEqual({
      type: 'resumeSeat',
      payload: {
        seatToken: TOKEN,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { rawActionData: true },
      },
    });
    // The takeover credential never reaches stdout.
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("adopts the table's game for its seat only, and answers with the first legal action", async () => {
    const { session, sent, events } = makeSession();
    session.receive(started('P1', 'other'));
    session.receive(started('P2'));
    session.receive(started('P2')); // re-sent on resume: the same game
    expect(events.filter((e) => e.type === 'game-started')).toHaveLength(1);
    session.receive({
      type: 'playerActionRequired',
      payload: {
        request: request(),
        state: {} as PlayerBoardState,
        revision: 3,
        ignoredAbilities: [],
      },
    } as ServerToClientMessage);
    await flush();
    expect(sent.at(-1)).toEqual({
      type: 'submitPlayerAction',
      payload: { requestId: 'q1', revision: 3, actionId: 4, targets: [{ slot: 0, choice: 'o9' }] },
    });
  });

  it('ignores a single-player game and never abandons the table game', () => {
    const { session, sent, done } = makeSession();
    session.receive({
      ...started('P2'),
      payload: { ...started('P2').payload, gameMode: 'singlePlayer' },
    } as ServerToClientMessage);
    session.receive(started('P2'));
    session.receive({
      type: 'gameOver',
      payload: {
        result: {
          gameId: 'g1',
          winnerSeat: 'P2',
          finishingOrder: [],
          turnCount: 5,
          halted: false,
          haltReason: null,
        },
        summary: 'Game over',
        standings: [],
      },
    } as unknown as ServerToClientMessage);
    expect(done).toEqual([0]);
    expect(sent.some((m) => m.type === 'abandonGame')).toBe(false);
  });

  it('ends on deck problems, a takeover or a closed table', () => {
    for (const frame of [
      {
        type: 'deckProblems',
        payload: { seat: 'P2', problems: [{ code: 'parse', message: 'x' }] },
      },
      { type: 'seatTakenOver', payload: { seat: 'P2' } },
      { type: 'tableClosed', payload: { reason: 'kicked' } },
    ] as TableServerToClientMessage[]) {
      const { session, done, isClosed, events } = makeSession();
      session.receive(frame);
      expect(done, frame.type).toEqual([1]);
      expect(isClosed()).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'error', fatal: true });
    }
  });

  it('reads replies from stdin only under the stdin policy', async () => {
    const { session, sent } = makeSession('stdin');
    session.receive(started('P2'));
    session.receive({
      type: 'playerActionRequired',
      payload: {
        request: request(),
        state: {} as PlayerBoardState,
        revision: 1,
        ignoredAbilities: [],
      },
    } as ServerToClientMessage);
    await flush();
    expect(sent.some((m) => m.type === 'submitPlayerAction')).toBe(false);
    session.reply(JSON.stringify({ requestId: 'q1', revision: 1, actionId: 0 }));
    expect(sent.at(-1)).toMatchObject({ type: 'submitPlayerAction' });
  });
});

describe('tableSocketTarget', () => {
  it('reads an invite link or a socket url, on loopback only', () => {
    expect(tableSocketTarget('http://127.0.0.1:3002/t/abc#inv1', undefined)).toEqual({
      ok: true,
      url: 'ws://127.0.0.1:3002/tables/abc/ws',
      inviteCode: 'inv1',
    });
    expect(tableSocketTarget('ws://localhost:3002/tables/abc/ws', 'inv2')).toEqual({
      ok: true,
      url: 'ws://localhost:3002/tables/abc/ws',
      inviteCode: 'inv2',
    });
    expect(tableSocketTarget('http://127.0.0.1:3002/t/abc', undefined).ok).toBe(false);
    expect(tableSocketTarget('http://example.com/t/abc#inv', undefined).ok).toBe(false);
    expect(tableSocketTarget('http://127.0.0.1/elsewhere#inv', undefined).ok).toBe(false);
  });
});

describe('parseTableAgentArgs', () => {
  it('needs a table, a name and a deck, and reads the policy and seat', () => {
    expect(
      parseTableAgentArgs([
        '--table',
        'http://127.0.0.1:3002/t/abc#inv',
        '--name',
        'Ann',
        '--deck',
        'd.txt',
        '--seat',
        'P3',
        '--policy',
        'first-legal',
      ]),
    ).toEqual({
      kind: 'run',
      url: 'ws://127.0.0.1:3002/tables/abc/ws',
      inviteCode: 'inv',
      displayName: 'Ann',
      seat: 'P3',
      deckPath: 'd.txt',
      policy: 'first-legal',
    });
    expect(parseTableAgentArgs(['--table', 'http://127.0.0.1/t/a#i', '--name', 'A'])).toEqual({
      kind: 'error',
      message: '--deck is required.',
    });
    expect(parseTableAgentArgs(['--policy', 'smart']).kind).toBe('error');
  });
});

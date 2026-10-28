import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { LOSS_REASONS } from '@mtg/shared';
import type {
  DecisionRequest,
  GameOverPayload,
  GameStartedPayload,
  PlayerActionRequiredPayload,
  PlayerBoardState,
  PlayerId,
  PlayerStateSnapshotPayload,
  SeatSummary,
  ServerToClientMessage,
  SpectatorState,
} from '@mtg/shared';
import {
  AgentClientSession,
  createAgentIo,
  LineBuffer,
  parseAgentClientArgs,
  type AgentClientTransport,
  type AgentEvent,
} from './agent-client-core';

function boardState(): PlayerBoardState {
  return {
    gameId: 'g1',
    seed: 'seed1',
    turnNumber: 3,
    activePlayer: 'P1',
    monarchSeat: null,
    priorityPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    viewerSeat: 'P1',
    viewerMana: { units: 0, colors: [] },
    seats: [],
    battlefield: [],
    exile: [],
    stack: [],
    turnOrder: ['P1', 'P2', 'P3', 'P4'],
    seating: ['P1', 'P2', 'P3', 'P4'],
    eliminatedPlayers: [],
    commanderDamage: [],
  };
}

function decisionRequest(): DecisionRequest {
  return {
    requestId: 'r1',
    gameId: 'g1',
    turn: 3,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType: 'priority',
    prompt: 'Choose an action.',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass', interaction: { kind: 'immediate' } },
      {
        id: 1,
        type: 'castSpell',
        description: 'Cast Lightning Bolt',
        targets: [{ slot: 0, options: ['obj-a', 'obj-b'] }],
      },
    ],
  };
}

function seatSummary(seat: string): SeatSummary {
  return {
    seat,
    deckId: `deck-${seat}`,
    label: `Seat ${seat}`,
    commanderNames: ['Commander'],
    colorIdentity: ['R'],
    archetypeTag: 'midrange',
  };
}

function gameStarted(): GameStartedPayload {
  return {
    gameId: 'g1',
    seed: 'seed1',
    seats: ['P1', 'P2', 'P3', 'P4'].map(seatSummary),
    providerKind: 'random',
    gameMode: 'singlePlayer',
    humanSeat: 'P1',
    sessionToken: 'secret-token',
    paceMs: 0,
    startedAt: '2026-09-27T00:00:00.000Z',
  };
}

function actionRequired(
  overrides: Partial<PlayerActionRequiredPayload> = {},
): PlayerActionRequiredPayload {
  return {
    request: decisionRequest(),
    state: boardState(),
    revision: 4,
    ignoredAbilities: [],
    ...overrides,
  };
}

function stateSnapshot(): PlayerStateSnapshotPayload {
  return {
    gameId: 'g1',
    state: boardState(),
    revision: 5,
    connected: true,
    ignoredAbilities: [{ key: 'card-1:0', label: 'Sacrifice a creature' }],
  };
}

function gameOver(): GameOverPayload {
  return {
    result: {
      gameId: 'g1',
      winnerSeat: 'P1',
      finishingOrder: ['P4', 'P3', 'P2', 'P1'],
      turnCount: 12,
      halted: false,
      haltReason: null,
    },
    standings: [
      { seat: 'P1', position: 1, lossReason: null },
      { seat: 'P2', position: 2, lossReason: 'lifeZeroOrLess' },
      { seat: 'P3', position: 3, lossReason: 'lifeZeroOrLess' },
      { seat: 'P4', position: 4, lossReason: 'lifeZeroOrLess' },
    ],
  };
}

/** A full-information spectator board — the shape that must never reach stdout. */
function spectatorState(): SpectatorState {
  return {
    gameId: 'g1',
    seed: 'seed1',
    turnNumber: 12,
    activePlayer: 'P1',
    monarchSeat: null,
    priorityPlayer: null,
    phase: 'precombatMain',
    step: null,
    seats: [],
    battlefield: [],
    exile: [],
    stack: [],
    turnOrder: ['P1'],
    seating: ['P1', 'P2', 'P3', 'P4'],
    eliminatedPlayers: ['P2', 'P3', 'P4'],
    commanderDamage: [],
  };
}

interface Harness {
  session: AgentClientSession;
  events: AgentEvent[];
  diagnostics: string[];
  sent: Parameters<AgentClientTransport['send']>[0][];
  closed: () => boolean;
  done: () => number | null;
}

function harness(): Harness {
  const events: AgentEvent[] = [];
  const diagnostics: string[] = [];
  const sent: Parameters<AgentClientTransport['send']>[0][] = [];
  let closed = false;
  let done: number | null = null;
  const session = new AgentClientSession({
    io: {
      event: (event) => events.push(event),
      diagnostic: (message) => diagnostics.push(message),
    },
    transport: {
      send: (message) => sent.push(message),
      close: () => {
        closed = true;
      },
    },
    game: {
      seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
      providerKind: 'random',
      humanSeat: 'P1',
      seed: 'seed1',
      paceMs: 0,
    },
    onDone: (code) => {
      done = code;
    },
  });
  return { session, events, diagnostics, sent, closed: () => closed, done: () => done };
}

/** Drive a harness up to an outstanding decision, discarding the setup traffic. */
function atDecision(overrides: Partial<PlayerActionRequiredPayload> = {}): Harness {
  const h = harness();
  h.session.begin();
  h.session.receive({ type: 'gameStarted', payload: gameStarted() });
  h.session.receive({ type: 'playerActionRequired', payload: actionRequired(overrides) });
  h.sent.length = 0;
  h.events.length = 0;
  return h;
}

function errorMessage(event: AgentEvent | undefined): string {
  return event?.type === 'error' ? event.message : '';
}

describe('agent client startup', () => {
  it('opens exactly one single-player startGame with the configured seat, seed and provider', () => {
    const h = harness();
    h.session.begin();
    expect(h.sent).toEqual([
      {
        type: 'startGame',
        payload: {
          seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
          providerKind: 'random',
          gameMode: 'singlePlayer',
          humanSeat: 'P1',
          seed: 'seed1',
          paceMs: 0,
        },
      },
    ]);
    expect(h.events).toEqual([]);
  });

  it('reports gameStarted without republishing the reconnect credential', () => {
    const h = harness();
    h.session.begin();
    h.session.receive({ type: 'gameStarted', payload: gameStarted() });
    expect(h.events).toEqual([
      {
        type: 'game-started',
        gameId: 'g1',
        seed: 'seed1',
        providerKind: 'random',
        humanSeat: 'P1',
        seats: ['P1', 'P2', 'P3', 'P4'].map(seatSummary),
        startedAt: '2026-09-27T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(h.events)).not.toContain('secret-token');
  });

  it.each(['table', 'spectator'] as const)(
    'ignores a gameStarted frame for a %s game and still adopts its own',
    (gameMode) => {
      const h = harness();
      h.session.begin();
      h.session.receive({
        type: 'gameStarted',
        payload: { ...gameStarted(), gameId: 'other', gameMode, humanSeat: 'P1' },
      });
      expect(h.events).toEqual([]);
      expect(h.diagnostics).toEqual([`ignored a gameStarted frame for a ${gameMode} game.`]);
      h.session.receive({ type: 'gameStarted', payload: gameStarted() });
      expect(h.events.map((event) => event.type)).toEqual(['game-started']);
    },
  );

  it('treats a setup error before gameStarted as fatal without republishing its text', () => {
    const h = harness();
    h.session.begin();
    h.session.receive({
      type: 'error',
      payload: {
        message: 'P2: deck is illegal',
        deckIssues: [{ seat: 'P2', issues: [{ code: 'cardCount', message: '99 cards' }] }],
        unmodeledCards: [{ seat: 'P2', cards: ['Unmodeled Card'] }],
      },
    });
    // A setup refusal names three opponent decks this seat may not see, so the event is rebuilt
    // rather than forwarded: fatal, with no seat diagnostics this agent is authorized to read.
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'error', source: 'server', fatal: true });
    expect(h.events[0]).not.toHaveProperty('unmodeledCards');
    expect(h.events[0]).not.toHaveProperty('deckIssues');
    expect(JSON.stringify(h.events)).not.toContain('Unmodeled Card');
    expect(JSON.stringify(h.events)).not.toContain('99 cards');
    expect(h.done()).toBe(1);
    expect(h.closed()).toBe(true);
  });
});

describe('agent client setup refusal privacy', () => {
  /** A string that exists nowhere else: one occurrence in any emitted byte is the leak. */
  const SENTINEL = 'Zzyzx-Opponent-Secret-Card';

  interface Stdio {
    session: AgentClientSession;
    out: string[];
    err: string[];
    sent: Parameters<AgentClientTransport['send']>[0][];
    closes: () => number;
    done: () => number | null;
  }

  /** A session wired to real byte sinks, so stdout and stderr can be asserted as text. */
  function stdio(humanSeat: PlayerId): Stdio {
    const out: string[] = [];
    const err: string[] = [];
    const sent: Parameters<AgentClientTransport['send']>[0][] = [];
    let closes = 0;
    let done: number | null = null;
    const session = new AgentClientSession({
      io: createAgentIo({
        writeOut: (chunk) => out.push(chunk),
        writeErr: (chunk) => err.push(chunk),
      }),
      transport: {
        send: (message) => sent.push(message),
        close: () => {
          closes++;
        },
      },
      game: {
        seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
        providerKind: 'random',
        humanSeat,
        seed: 'seed1',
        paceMs: 0,
      },
      onDone: (code) => {
        done = code;
      },
    });
    session.begin();
    sent.length = 0;
    return { session, out, err, sent, closes: () => closes, done: () => done };
  }

  /** A refusal with the sentinel in every free-text field a `SeatProblem` can reach. */
  function refusal(seats: readonly PlayerId[]): ServerToClientMessage {
    return {
      type: 'error',
      payload: {
        message: seats.map((seat) => `${seat}: rejected because of ${SENTINEL}`).join('\n'),
        deckIssues: seats.map((seat) => ({
          seat,
          issues: [
            { code: 'singleton', message: `two copies of ${SENTINEL}`, cardName: SENTINEL },
            { code: 'banned', message: SENTINEL },
          ],
        })),
        unmodeledCards: seats.map((seat) => ({ seat, cards: [SENTINEL] })),
        ...({ diagnostics: SENTINEL } as unknown as Record<string, never>),
      },
    };
  }

  function soleEvent(s: Stdio): Record<string, unknown> {
    expect(s.out).toHaveLength(1);
    return JSON.parse(s.out[0]!) as Record<string, unknown>;
  }

  it('keeps an opponent sentinel out of every stdout and stderr byte', () => {
    const s = stdio('P1');
    s.session.receive(refusal(['P1', 'P2', 'P3', 'P4']));
    expect(s.out.join('')).not.toContain(SENTINEL);
    expect(s.err.join('')).not.toContain(SENTINEL);
  });

  it('never carries an unmodeled-name list or an unknown extra field', () => {
    const s = stdio('P1');
    s.session.receive(refusal(['P1', 'P2']));
    const event = soleEvent(s);
    expect(event['unmodeledCards']).toBeUndefined();
    expect(event['diagnostics']).toBeUndefined();
    expect(Object.keys(event).sort()).toEqual(
      ['deckIssues', 'fatal', 'message', 'source', 'type'].sort(),
    );
  });

  it('retains its own seat diagnostics as known codes with generated descriptions', () => {
    const s = stdio('P1');
    s.session.receive(refusal(['P1', 'P2', 'P3']));
    const event = soleEvent(s);
    const deckIssues = event['deckIssues'] as Array<{
      seat: string;
      issues: Array<Record<string, unknown>>;
    }>;
    expect(deckIssues.map((entry) => entry.seat)).toEqual(['P1']);
    expect(deckIssues[0]!.issues.map((issue) => issue['code'])).toEqual(['singleton', 'banned']);
    for (const issue of deckIssues[0]!.issues) {
      expect(Object.keys(issue)).toEqual(['code', 'message']);
      expect(issue['message']).toEqual(expect.any(String));
      expect(String(issue['message'])).not.toContain(SENTINEL);
    }
  });

  it.each(['P1', 'P2', 'P3', 'P4'] as const)('authorizes only its configured seat %s', (seat) => {
    const s = stdio(seat);
    s.session.receive(refusal(['P1', 'P2', 'P3', 'P4']));
    expect(s.out.join('')).not.toContain(SENTINEL);
    const deckIssues = soleEvent(s)['deckIssues'] as Array<{ seat: string }>;
    expect(deckIssues.map((entry) => entry.seat)).toEqual([seat]);
  });

  it('drops an issue whose code it does not recognise', () => {
    const s = stdio('P1');
    s.session.receive({
      type: 'error',
      payload: {
        message: SENTINEL,
        deckIssues: [
          {
            seat: 'P1',
            issues: [
              { code: 'futureRule' as never, message: SENTINEL },
              { code: 'colorIdentity', message: SENTINEL, cardName: SENTINEL },
            ],
          },
        ],
      },
    });
    expect(s.out.join('')).not.toContain(SENTINEL);
    const deckIssues = soleEvent(s)['deckIssues'] as Array<{ issues: Array<{ code: string }> }>;
    expect(deckIssues[0]!.issues.map((issue) => issue.code)).toEqual(['colorIdentity']);
  });

  it('authorizes nothing when a diagnostic seat is not an actual seat', () => {
    const s = stdio('P1');
    s.session.receive({
      type: 'error',
      payload: {
        message: SENTINEL,
        deckIssues: [
          { seat: ['P1'] as unknown as PlayerId, issues: [{ code: 'banned', message: SENTINEL }] },
          { seat: 'p1' as unknown as PlayerId, issues: [{ code: 'banned', message: SENTINEL }] },
          { seat: undefined as unknown as PlayerId, issues: [{ code: 'banned', message: '' }] },
        ],
      },
    });
    expect(s.out.join('')).not.toContain(SENTINEL);
    expect(soleEvent(s)['deckIssues']).toBeUndefined();
  });

  it('keeps the fatal exit, closes once, and abandons nothing it never started', () => {
    const s = stdio('P1');
    s.session.receive(refusal(['P2']));
    expect(soleEvent(s)['fatal']).toBe(true);
    expect(s.done()).toBe(1);
    expect(s.closes()).toBe(1);
    expect(s.sent).toEqual([]);
    // Anything after the refusal is ignored rather than closing a second time.
    s.session.receive(refusal(['P3']));
    s.session.socketClosed();
    expect(s.closes()).toBe(1);
    expect(s.out).toHaveLength(1);
  });

  it('does not attach setup diagnostics to an error raised after the game started', () => {
    const s = stdio('P1');
    s.session.receive({ type: 'gameStarted', payload: gameStarted() });
    s.out.length = 0;
    s.session.receive({
      type: 'error',
      payload: {
        message: 'The board changed; choose again.',
        deckIssues: [{ seat: 'P1', issues: [{ code: 'banned', message: SENTINEL }] }],
        unmodeledCards: [{ seat: 'P2', cards: [SENTINEL] }],
      },
    });
    const event = soleEvent(s);
    expect(event).toMatchObject({ type: 'error', source: 'server', fatal: false });
    expect(event['deckIssues']).toBeUndefined();
    expect(event['unmodeledCards']).toBeUndefined();
    expect(s.out.join('')).not.toContain(SENTINEL);
    expect(s.err.join('')).not.toContain(SENTINEL);
    expect(s.done()).toBe(null);
  });
});

describe('agent client decision surface', () => {
  it('halts on a split decision whose required response cannot cross the submission wire', () => {
    for (const split of [
      { manaSplit: { amount: 2, colors: ['R', 'G'] } },
      { combatDamageSplit: { amount: 2, targets: ['obj-a', 'obj-b'] } },
    ]) {
      const request = { ...decisionRequest(), ...split };
      const h = harness();
      h.session.begin();
      h.session.receive({ type: 'gameStarted', payload: gameStarted() });
      h.sent.length = 0;
      h.events.length = 0;
      h.session.receive({ type: 'playerActionRequired', payload: actionRequired({ request }) });
      h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
      expect(h.sent).toEqual([{ type: 'abandonGame', payload: {} }]);
      expect(h.events.at(-1)).toMatchObject({ type: 'error', source: 'agent', fatal: true });
      expect(h.done()).toBe(1);
    }
  });
  it('publishes the request id, revision, player-safe state and legal menu as received', () => {
    const h = harness();
    h.session.begin();
    h.session.receive({ type: 'gameStarted', payload: gameStarted() });
    h.events.length = 0;
    const payload = actionRequired({
      ignoredAbilities: [{ key: 'card-1:0', label: 'Sacrifice a creature' }],
    });
    h.session.receive({ type: 'playerActionRequired', payload });
    expect(h.events).toEqual([
      {
        type: 'decision-required',
        requestId: 'r1',
        revision: 4,
        request: payload.request,
        state: payload.state,
        ignoredAbilities: [{ key: 'card-1:0', label: 'Sacrifice a creature' }],
      },
    ]);
  });

  it('preserves a legal menu the server filtered rather than restoring hidden abilities', () => {
    const filtered = decisionRequest();
    filtered.legalActions = [filtered.legalActions[0]!];
    const h = atDecision({ request: filtered });
    h.session.receive({
      type: 'playerActionRequired',
      payload: actionRequired({ request: filtered }),
    });
    const published = h.events[0];
    expect(published?.type).toBe('decision-required');
    expect(published?.type === 'decision-required' && published.request.legalActions).toEqual([
      { id: 0, type: 'pass', description: 'Pass', interaction: { kind: 'immediate' } },
    ]);
  });

  it('publishes a player state snapshot as a state update', () => {
    const h = harness();
    h.session.begin();
    h.session.receive({ type: 'gameStarted', payload: gameStarted() });
    h.events.length = 0;
    const payload = stateSnapshot();
    h.session.receive({ type: 'playerStateSnapshot', payload });
    expect(h.events).toEqual([
      {
        type: 'state-update',
        gameId: 'g1',
        revision: 5,
        connected: true,
        state: payload.state,
        ignoredAbilities: payload.ignoredAbilities,
      },
    ]);
  });

  it('never forwards spectator or replay full-information frames to stdout', () => {
    const h = harness();
    h.session.begin();
    h.session.receive({ type: 'gameStarted', payload: gameStarted() });
    h.events.length = 0;
    const hidden: ServerToClientMessage[] = [
      {
        type: 'stateSnapshot',
        payload: { turn: 12, state: spectatorState(), frontierTurn: 12, atFrontier: true },
      },
      {
        type: 'replayUnlocked',
        payload: { state: spectatorState(), lines: [], snapshotTurns: [], frontierTurn: 12 },
      },
      {
        type: 'eventBatch',
        payload: { gameId: 'g1', lines: [], frontierTurn: 12, snapshotTurns: [] },
      },
      {
        type: 'decisionPending',
        payload: { request: decisionRequest(), invalidResponse: 'nope', timeoutMs: 1000 },
      },
      {
        type: 'apiWaiting',
        payload: {
          queueDepth: 1,
          waitingMs: 10,
          reason: 'inFlight',
          calls: 1,
          skippedCalls: 0,
          promptTokens: 2,
          responseTokens: 3,
        },
      },
      { type: 'debugEvents', payload: { gameId: 'g1', entries: [] } },
      { type: 'gameReflections', payload: { gameId: 'g1', reflections: [], complete: true } },
      { type: 'sessionPaused', payload: { gameId: 'g1', reason: 'waitingForPlayer' } },
    ];
    for (const message of hidden) h.session.receive(message);
    expect(h.events).toEqual([]);
    // Diagnostics name the dropped frame type and nothing from inside it.
    expect(h.diagnostics).toHaveLength(hidden.length);
    expect(h.diagnostics.join('|')).not.toContain('eliminatedPlayers');
  });

  it('reports each dropped frame type once instead of narrating every frame', () => {
    const h = harness();
    h.session.begin();
    h.session.receive({ type: 'gameStarted', payload: gameStarted() });
    for (let i = 0; i < 20; i++) {
      h.session.receive({
        type: 'eventBatch',
        payload: { gameId: 'g1', lines: [], frontierTurn: i, snapshotTurns: [] },
      });
    }
    expect(h.diagnostics).toHaveLength(1);
    expect(h.diagnostics[0]).toContain('eventBatch');
  });
});

describe('agent client replies', () => {
  it('submits only the fields SubmitPlayerActionPayload supports', () => {
    const h = atDecision();
    h.session.reply(
      '{"requestId":"r1","revision":4,"actionId":1,"targets":[{"slot":0,"choice":"obj-a"}]}',
    );
    expect(h.sent).toEqual([
      {
        type: 'submitPlayerAction',
        payload: {
          requestId: 'r1',
          revision: 4,
          actionId: 1,
          targets: [{ slot: 0, choice: 'obj-a' }],
        },
      },
    ]);
    expect(h.events).toEqual([]);
  });

  it('omits targets entirely when the reply has none', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
    expect(h.sent).toEqual([
      { type: 'submitPlayerAction', payload: { requestId: 'r1', revision: 4, actionId: 0 } },
    ]);
  });

  it('ignores blank input lines', () => {
    const h = atDecision();
    h.session.reply('');
    h.session.reply('   ');
    expect(h.sent).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('rejects malformed JSON without touching the socket', () => {
    const h = atDecision();
    h.session.reply('{not json');
    expect(h.sent).toEqual([]);
    expect(h.events[0]).toMatchObject({ type: 'error', source: 'agent', fatal: false });
    expect(errorMessage(h.events[0])).toContain('JSON');
  });

  it('rejects a v1-unsupported split field instead of silently dropping it', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0,"manaSplit":{"amount":2}}');
    expect(h.sent).toEqual([]);
    expect(errorMessage(h.events[0])).toContain('manaSplit');
  });

  it('rejects a stale request id or revision', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"other","revision":4,"actionId":0}');
    h.session.reply('{"requestId":"r1","revision":3,"actionId":0}');
    expect(h.sent).toEqual([]);
    expect(h.events).toHaveLength(2);
    expect(errorMessage(h.events[0])).toContain('r1');
    expect(errorMessage(h.events[1])).toContain('revision');
  });

  it('rejects an action id that is not on the menu it published', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":9}');
    expect(h.sent).toEqual([]);
    expect(errorMessage(h.events[0])).toContain('9');
  });

  it('rejects malformed targets', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":1,"targets":"obj-a"}');
    h.session.reply(
      '{"requestId":"r1","revision":4,"actionId":1,"targets":[{"slot":-1,"choice":"x"}]}',
    );
    expect(h.sent).toEqual([]);
    expect(h.events).toHaveLength(2);
  });

  it('rejects duplicate target choices locally without submitting an ambiguous action', () => {
    const h = atDecision();
    h.session.reply(
      '{"requestId":"r1","revision":4,"actionId":1,"targets":[{"slot":0,"choice":"obj-a"},{"slot":0,"choice":"obj-b"}]}',
    );
    expect(h.sent).toEqual([]);
    expect(errorMessage(h.events[0])).toContain('unique slots');
  });

  it('fails closed when a target choice carries unsupported fields', () => {
    const h = atDecision();
    h.session.reply(
      '{"requestId":"r1","revision":4,"actionId":1,"targets":[{"slot":0,"choice":"obj-a","amount":2}]}',
    );
    expect(h.sent).toEqual([]);
    expect(errorMessage(h.events[0])).toContain('targets');
  });

  it('rejects a reply when no decision is outstanding', () => {
    const h = harness();
    h.session.begin();
    h.session.receive({ type: 'gameStarted', payload: gameStarted() });
    h.sent.length = 0;
    h.events.length = 0;
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
    expect(h.sent).toEqual([]);
    expect(errorMessage(h.events[0])).toContain('no decision');
  });

  it('submits one reply per decision and rejects a second before the server answers', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
    h.session.reply('{"requestId":"r1","revision":4,"actionId":1}');
    expect(h.sent).toHaveLength(1);
    expect(errorMessage(h.events[0])).toContain('already submitted');
  });

  it('does not submit a second action when the server repeats an in-flight decision', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
    h.session.receive({ type: 'playerActionRequired', payload: actionRequired() });
    h.session.reply('{"requestId":"r1","revision":4,"actionId":1}');
    expect(h.sent).toHaveLength(1);
    expect(errorMessage(h.events.at(-1))).toContain('already submitted');
  });

  it('keeps waiting after EOF when an in-flight decision is repeated', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
    h.session.inputClosed();
    h.events.length = 0;
    h.session.receive({ type: 'playerActionRequired', payload: actionRequired() });
    expect(h.done()).toBe(null);
    expect(h.sent).toHaveLength(1);
    expect(h.events.every((event) => event.type !== 'error')).toBe(true);
  });

  it('lets the agent retry the same decision after the server rejects a submission', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":1}');
    // The rejection names the submission it refused, which is what makes the decision retryable.
    h.session.receive({
      type: 'error',
      payload: { message: 'Target 1 still needs a choice.', requestId: 'r1', revision: 4 },
    });
    expect(h.events[0]).toMatchObject({
      type: 'error',
      source: 'server',
      fatal: false,
      requestId: 'r1',
      revision: 4,
    });
    h.session.reply(
      '{"requestId":"r1","revision":4,"actionId":1,"targets":[{"slot":0,"choice":"obj-b"}]}',
    );
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual({
      type: 'submitPlayerAction',
      payload: {
        requestId: 'r1',
        revision: 4,
        actionId: 1,
        targets: [{ slot: 0, choice: 'obj-b' }],
      },
    });
  });

  it('keeps a submission in flight when an error is not correlated to it', () => {
    // An uncorrelated error, and one naming a different submission, say nothing about the action
    // the server is holding. Treating either as a rejection would submit this decision twice.
    for (const payload of [
      { message: 'That yielded ability is no longer available.' },
      { message: 'The board changed; choose again.', requestId: 'r0', revision: 4 },
      { message: 'The board changed; choose again.', requestId: 'r1', revision: 3 },
    ]) {
      const h = atDecision();
      h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
      h.events.length = 0;
      h.session.receive({ type: 'error', payload });
      expect(h.events[0]).toMatchObject({ type: 'error', source: 'server', fatal: false });
      expect(h.done()).toBe(null);

      h.session.reply('{"requestId":"r1","revision":4,"actionId":1}');
      expect(h.sent).toHaveLength(1);
      expect(errorMessage(h.events[1])).toContain('already submitted');
    }
  });

  it('fails when a correlated rejection arrives after agent input has closed', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":1}');
    // EOF with a reply in flight is legitimate: the server may still accept it.
    h.session.inputClosed();
    expect(h.done()).toBe(null);

    h.session.receive({
      type: 'error',
      payload: { message: 'Target 1 still needs a choice.', requestId: 'r1', revision: 4 },
    });
    // The retry the rejection invites can never arrive, so the run ends instead of waiting.
    expect(h.events[0]).toMatchObject({ type: 'error', source: 'server', fatal: false });
    expect(h.events[1]).toMatchObject({ type: 'error', source: 'agent', fatal: true });
    expect(errorMessage(h.events[1])).toContain('r1');
    expect(h.done()).toBe(1);
  });

  it('keeps waiting when an unrelated error arrives after agent input has closed', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
    h.session.inputClosed();
    h.events.length = 0;
    h.session.receive({ type: 'error', payload: { message: 'No game is running.' } });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'error', source: 'server', fatal: false });
    expect(h.done()).toBe(null);
  });
});

describe('agent client strict reply parsing', () => {
  it('refuses a reply that repeats actionId instead of taking the last value', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":9,"actionId":0}');
    expect(h.sent).toEqual([]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'error', source: 'agent', fatal: false });
    expect(errorMessage(h.events[0])).toContain('JSON');
  });

  it('refuses a repeated key even when both values are identical', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0,"actionId":0}');
    expect(h.sent).toEqual([]);
    expect(h.events).toHaveLength(1);
  });

  it('refuses an escaped alias of a key it already saw', () => {
    const h = atDecision();
    h.session.reply(String.raw`{"requestId":"r1","revision":4,"actionId":9,"action\u0049d":0}`);
    expect(h.sent).toEqual([]);
    expect(h.events).toHaveLength(1);
  });

  it('refuses a duplicate key nested inside a target entry', () => {
    const h = atDecision();
    h.session.reply(
      '{"requestId":"r1","revision":4,"actionId":1,"targets":[{"slot":0,"slot":1,"choice":"obj-a"}]}',
    );
    expect(h.sent).toEqual([]);
    expect(h.events).toHaveLength(1);
  });

  it('leaves the decision answerable, so the next legal reply dispatches exactly once', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":9,"actionId":0}');
    expect(h.sent).toEqual([]);
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
    expect(h.sent).toEqual([
      { type: 'submitPlayerAction', payload: { requestId: 'r1', revision: 4, actionId: 0 } },
    ]);
  });

  it('still accepts distinct keys reused by separate target objects', () => {
    const h = atDecision();
    h.session.reply(
      '{"requestId":"r1","revision":4,"actionId":1,"targets":[{"slot":0,"choice":"obj-a"},{"slot":1,"choice":"obj-b"}]}',
    );
    expect(h.sent).toEqual([
      {
        type: 'submitPlayerAction',
        payload: {
          requestId: 'r1',
          revision: 4,
          actionId: 1,
          targets: [
            { slot: 0, choice: 'obj-a' },
            { slot: 1, choice: 'obj-b' },
          ],
        },
      },
    ]);
    expect(h.events).toEqual([]);
  });
});

describe('agent client termination', () => {
  it('publishes game over, closes the socket and finishes successfully', () => {
    const h = atDecision();
    h.session.receive({ type: 'gameOver', payload: gameOver() });
    expect(h.events).toEqual([
      { type: 'game-over', result: gameOver().result, standings: gameOver().standings },
    ]);
    expect(h.closed()).toBe(true);
    expect(h.done()).toBe(0);
  });

  it('releases the finished session so the next run can start a game', () => {
    const h = atDecision();
    h.session.receive({ type: 'gameOver', payload: gameOver() });
    // The server holds a single-player session past its socket, and refuses a fresh `startGame`
    // while it does. `abandon()` is a no-op on a finished runner, so the recorded game is intact.
    expect(h.sent).toEqual([{ type: 'abandonGame', payload: {} }]);
  });

  it('releases the session when a halt or a closed input ends the run', () => {
    const halted = atDecision();
    halted.session.receive({
      type: 'computeHalted',
      payload: { gameId: 'g1', kind: 'engineError', reason: 'stuck', turn: 4 },
    });
    expect(halted.sent).toEqual([{ type: 'abandonGame', payload: {} }]);

    const starved = atDecision();
    starved.session.inputClosed();
    expect(starved.sent).toEqual([{ type: 'abandonGame', payload: {} }]);
  });

  it('never abandons a game it did not start, or one whose socket is already gone', () => {
    const unstarted = harness();
    unstarted.session.begin();
    unstarted.sent.length = 0;
    unstarted.session.receive({ type: 'error', payload: { message: 'deck setup failed' } });
    expect(unstarted.sent).toEqual([]);

    const dropped = atDecision();
    dropped.session.socketClosed();
    expect(dropped.sent).toEqual([]);
  });

  it('ignores anything the server sends after game over', () => {
    const h = atDecision();
    h.session.receive({ type: 'gameOver', payload: gameOver() });
    h.events.length = 0;
    h.session.receive({ type: 'playerStateSnapshot', payload: stateSnapshot() });
    expect(h.events).toEqual([]);
    expect(h.done()).toBe(0);
  });

  it('treats a compute halt as a fatal error because no game over will follow', () => {
    const h = atDecision();
    h.session.receive({
      type: 'computeHalted',
      payload: {
        gameId: 'g1',
        kind: 'unmodeledCard',
        reason: 'The rules engine could not continue this game.',
        turn: 4,
      },
    });
    expect(h.events[0]).toMatchObject({ type: 'error', source: 'server', fatal: true });
    expect(h.done()).toBe(1);
  });

  it('fails when the socket closes before the game ends', () => {
    const h = atDecision();
    h.session.socketClosed();
    expect(h.events[0]).toMatchObject({ type: 'error', source: 'agent', fatal: true });
    expect(h.done()).toBe(1);
  });

  it('does not fail when the socket closes after game over', () => {
    const h = atDecision();
    h.session.receive({ type: 'gameOver', payload: gameOver() });
    h.events.length = 0;
    h.session.socketClosed();
    expect(h.events).toEqual([]);
    expect(h.done()).toBe(0);
  });

  it('fails a decision it can never answer once agent input has closed', () => {
    const h = atDecision();
    h.session.inputClosed();
    expect(h.events[0]).toMatchObject({ type: 'error', source: 'agent', fatal: true });
    expect(h.done()).toBe(1);
  });

  it('accepts input closing while nothing is outstanding, then fails the next decision', () => {
    const h = atDecision();
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
    h.session.receive({ type: 'playerStateSnapshot', payload: stateSnapshot() });
    h.session.inputClosed();
    expect(h.done()).toBe(null);
    h.session.receive({
      type: 'playerActionRequired',
      payload: actionRequired({ request: { ...decisionRequest(), requestId: 'r2' }, revision: 5 }),
    });
    expect(h.done()).toBe(1);
  });
});

describe('parseAgentClientArgs', () => {
  it('defaults to a loopback socket, pool seats, the random provider and seat P1', () => {
    expect(parseAgentClientArgs([])).toEqual({
      kind: 'run',
      url: 'ws://127.0.0.1:3001/ws',
      game: {
        seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
        providerKind: 'random',
        humanSeat: 'P1',
        paceMs: 0,
      },
    });
  });

  it('accepts the port, seat, seed and provider flags', () => {
    expect(
      parseAgentClientArgs(['--port', '4000', '--seat', 'P3', '--seed', 'abc', '--provider', 'ai']),
    ).toEqual({
      kind: 'run',
      url: 'ws://127.0.0.1:4000/ws',
      game: {
        seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
        providerKind: 'ai',
        humanSeat: 'P3',
        seed: 'abc',
        paceMs: 0,
      },
    });
  });

  it('reports --help', () => {
    expect(parseAgentClientArgs(['--help'])).toEqual({ kind: 'help' });
  });

  it('rejects an unknown flag, seat, provider or port', () => {
    for (const argv of [
      ['--nope'],
      ['--seat', 'P5'],
      ['--provider', 'heuristic'],
      ['--port', 'abc'],
      ['--port', '0'],
      ['--seed'],
    ]) {
      expect(parseAgentClientArgs(argv).kind).toBe('error');
    }
  });

  it('refuses a non-loopback url so the agent cannot drive a remote server', () => {
    expect(parseAgentClientArgs(['--url', 'ws://192.168.1.5:3001/ws']).kind).toBe('error');
    expect(parseAgentClientArgs(['--url', 'wss://example.com/ws']).kind).toBe('error');
    expect(parseAgentClientArgs(['--url', 'ws://localhost:3001/ws'])).toMatchObject({
      kind: 'run',
      url: 'ws://localhost:3001/ws',
    });
  });
});

describe('agent stdio framing', () => {
  function streams() {
    const out: string[] = [];
    const err: string[] = [];
    const io = createAgentIo({
      writeOut: (chunk) => out.push(chunk),
      writeErr: (chunk) => err.push(chunk),
    });
    return { io, out, err };
  }

  it('writes one newline-terminated JSON object per event and nothing else to stdout', () => {
    const s = streams();
    s.io.event({
      type: 'state-update',
      gameId: 'g1',
      revision: 5,
      connected: true,
      state: boardState(),
      ignoredAbilities: [],
    });
    s.io.event({ type: 'error', source: 'agent', fatal: false, message: 'line\nbreak' });
    expect(s.out).toHaveLength(2);
    for (const chunk of s.out) {
      expect(chunk.endsWith('\n')).toBe(true);
      expect(chunk.slice(0, -1)).not.toContain('\n');
      expect(() => JSON.parse(chunk) as unknown).not.toThrow();
    }
    expect(s.err).toEqual([]);
  });

  it('keeps diagnostics off stdout', () => {
    const s = streams();
    s.io.diagnostic('dropped a stateSnapshot frame.');
    expect(s.out).toEqual([]);
    expect(s.err).toEqual(['agent-client: dropped a stateSnapshot frame.\n']);
  });
});

describe('LineBuffer', () => {
  it('rejects incomplete JSON at EOF without submitting an action', () => {
    const h = atDecision();
    const buffer = new LineBuffer();
    expect(buffer.take('{"requestId":"r1","revision":4,"actionId":1')).toEqual([]);
    for (const line of buffer.flush()) h.session.reply(line);
    h.session.inputClosed();
    expect(h.sent).toEqual([{ type: 'abandonGame', payload: {} }]);
    expect(h.events[0]).toMatchObject({ type: 'error', source: 'agent', fatal: false });
    expect(h.events.at(-1)).toMatchObject({ type: 'error', source: 'agent', fatal: true });
    expect(h.done()).toBe(1);
  });

  it('splits complete lines and holds a partial one until it is terminated', () => {
    const buffer = new LineBuffer();
    expect(buffer.take('{"a":1}\n{"b":2}\n{"c":')).toEqual(['{"a":1}', '{"b":2}']);
    expect(buffer.take('3}\n')).toEqual(['{"c":3}']);
    expect(buffer.take('')).toEqual([]);
  });

  it('tolerates carriage returns and yields a final unterminated line on flush', () => {
    const buffer = new LineBuffer();
    expect(buffer.take('{"a":1}\r\n')).toEqual(['{"a":1}']);
    expect(buffer.take('{"b":2}')).toEqual([]);
    expect(buffer.flush()).toEqual(['{"b":2}']);
    expect(buffer.flush()).toEqual([]);
  });
});

/**
 * Terminal frames are broadcast to every socket, so a spectator session's halt reaches this client
 * too. Before it is read, a terminal must be shown to belong to *this* agent's game: the identity
 * is `computeHalted.payload.gameId` but `gameOver.payload.result.gameId`, and `agent-client.ts`
 * casts `JSON.parse` output without validating it, so the types offer no runtime protection.
 * A frame that fails the check changes no lifecycle state and emits no upstream text.
 */
describe('agent client terminal scoping', () => {
  const SENTINEL = 'Zzyzx-Spectator-Halt-Secret';

  /** A halt frame the way a spectator session broadcasts one: reasons there stay raw. */
  const spectatorHalt = (gameId: unknown): ServerToClientMessage =>
    ({
      type: 'computeHalted',
      payload: { gameId, kind: 'unmodeledCard', reason: SENTINEL, turn: 7, cardName: SENTINEL },
    }) as unknown as ServerToClientMessage;

  const spectatorOver = (gameId: unknown): ServerToClientMessage =>
    ({
      type: 'gameOver',
      payload: {
        result: { ...gameOver().result, gameId, haltReason: SENTINEL },
        standings: gameOver().standings,
      },
    }) as unknown as ServerToClientMessage;

  /** A started session whose own game is `g1`, with the startup traffic discarded. */
  function started(): Harness {
    const h = harness();
    h.session.begin();
    h.session.receive({ type: 'gameStarted', payload: gameStarted() });
    h.sent.length = 0;
    h.events.length = 0;
    return h;
  }

  function untouched(h: Harness): void {
    expect(h.events).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.closed()).toBe(false);
    expect(h.done()).toBe(null);
    expect(JSON.stringify([h.events, h.diagnostics])).not.toContain(SENTINEL);
  }

  it('records the game id only for a nonempty id on the seat it asked to play', () => {
    for (const payload of [
      { ...gameStarted(), gameId: '' },
      { ...gameStarted(), humanSeat: 'P3' },
      { ...gameStarted(), humanSeat: undefined },
      { ...gameStarted(), gameId: 17 },
    ]) {
      const h = harness();
      h.session.begin();
      h.sent.length = 0;
      h.session.receive({ type: 'gameStarted', payload } as unknown as ServerToClientMessage);
      expect(h.events).toEqual([]);
      expect(h.diagnostics).toHaveLength(1);
      // Nothing was adopted, so a terminal for that game is not this client's either.
      h.session.receive(spectatorHalt((payload as { gameId: unknown }).gameId));
      expect(h.events).toEqual([]);
      expect(h.done()).toBe(null);
    }
  });

  it('keeps the adopted game id when a later start frame names another game', () => {
    const h = started();
    h.session.receive({
      type: 'gameStarted',
      payload: { ...gameStarted(), gameId: 'other-game' },
    });
    expect(h.events).toEqual([]);
    // The replacement was refused, so the other game's terminal is still out of scope …
    h.session.receive(spectatorHalt('other-game'));
    untouched(h);
    // … while the original game's terminal still ends the run.
    h.session.receive({ type: 'gameOver', payload: gameOver() });
    expect(h.events).toHaveLength(1);
    expect(h.done()).toBe(0);
  });

  it('ignores a spectator halt that arrives before its own game starts', () => {
    const h = harness();
    h.session.begin();
    h.sent.length = 0;
    h.session.receive({
      type: 'gameStarted',
      payload: { ...gameStarted(), gameId: 'spectator-game', gameMode: 'spectator' },
    });
    h.session.receive(spectatorHalt('spectator-game'));
    h.session.receive(spectatorOver('spectator-game'));
    untouched(h);
    // The client is still free to adopt its own game afterwards.
    h.session.receive({ type: 'gameStarted', payload: gameStarted() });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'game-started', gameId: 'g1' });
  });

  it('ignores a halt for another game, and one whose id is missing or malformed', () => {
    for (const gameId of [undefined, null, '', 42, { gameId: 'g1' }, ['g1'], 'g2']) {
      const h = started();
      h.session.receive(spectatorHalt(gameId));
      untouched(h);
    }
    const noPayload = started();
    noPayload.session.receive({ type: 'computeHalted' } as unknown as ServerToClientMessage);
    untouched(noPayload);
  });

  it('ignores a game over for another game, and one with no readable result', () => {
    for (const gameId of [undefined, null, '', 42, 'g2']) {
      const h = started();
      h.session.receive(spectatorOver(gameId));
      untouched(h);
    }
    for (const payload of [{}, { result: null }, { result: 'g1' }, { result: ['g1'] }]) {
      const h = started();
      h.session.receive({ type: 'gameOver', payload } as unknown as ServerToClientMessage);
      untouched(h);
    }
  });

  it('builds the halt message from a fixed allowlist, never from the frame', () => {
    const kinds = [
      'unmodeledCard',
      'invalidAiResponse',
      'engineError',
      'draw',
      'aiBudgetExhausted',
      'turnCap',
    ];
    const messages = new Set<string>();
    for (const kind of kinds) {
      const h = started();
      h.session.receive({
        type: 'computeHalted',
        payload: { gameId: 'g1', kind, reason: SENTINEL, turn: 7, cardName: SENTINEL },
      } as unknown as ServerToClientMessage);
      expect(h.events).toHaveLength(1);
      expect(h.events[0]).toMatchObject({ type: 'error', source: 'server', fatal: true });
      const text = errorMessage(h.events[0]);
      expect(text).not.toContain(SENTINEL);
      // The kind is never interpolated. Only the camelCase kinds can be checked that way -- the
      // fixed sentence for 'draw' contains that English word by design -- and an arbitrary kind
      // string reaching the message is covered by the unknown-kind case below.
      if (/[A-Z]/.test(kind)) expect(text).not.toContain(kind);
      expect(h.done()).toBe(1);
      messages.add(text);
    }
    // One fixed sentence per kind, so the message says something without quoting the frame.
    expect(messages.size).toBe(kinds.length);
  });

  it('falls back to one fixed sentence for a halt kind it does not know', () => {
    for (const kind of [undefined, null, 17, `leak-${SENTINEL}`, {}]) {
      const h = started();
      h.session.receive({
        type: 'computeHalted',
        payload: { gameId: 'g1', kind, reason: SENTINEL, turn: 7 },
      } as unknown as ServerToClientMessage);
      expect(h.events).toHaveLength(1);
      expect(errorMessage(h.events[0])).not.toContain(SENTINEL);
      expect(errorMessage(h.events[0])).not.toContain('leak-');
      expect(h.done()).toBe(1);
      expect(h.sent).toEqual([{ type: 'abandonGame', payload: {} }]);
    }
  });

  it('accepts a matching terminal exactly once', () => {
    const over = started();
    over.session.receive({ type: 'gameOver', payload: gameOver() });
    over.session.receive({ type: 'gameOver', payload: gameOver() });
    expect(over.events).toHaveLength(1);
    expect(over.done()).toBe(0);

    const halted = started();
    const halt = {
      type: 'computeHalted',
      payload: { gameId: 'g1', kind: 'engineError', reason: 'stuck', turn: 4 },
    } as unknown as ServerToClientMessage;
    halted.session.receive(halt);
    halted.session.receive(halt);
    expect(halted.events).toHaveLength(1);
    expect(halted.done()).toBe(1);
  });

  it('leaves an outstanding decision answerable after an out-of-scope terminal', () => {
    const h = atDecision();
    h.session.receive(spectatorHalt('g2'));
    h.session.receive(spectatorOver('g2'));
    expect(h.events).toEqual([]);
    h.session.reply('{"requestId":"r1","revision":4,"actionId":0}');
    expect(h.sent).toEqual([
      { type: 'submitPlayerAction', payload: { requestId: 'r1', revision: 4, actionId: 0 } },
    ]);
  });
});

/**
 * The same scoping, proved on real process bytes. `createAgentIo` is wired to the actual
 * `process.stdout`/`process.stderr` of a Bun child process and the exit code is the one the
 * session reported, so stdout, stderr and the status are evidence rather than array contents.
 * (The transport is still a stub: this checks what the client emits for a given frame sequence,
 * not the socket.) Vitest runs under Node, so the child is Bun, as elsewhere in this suite.
 */
const REAL_PROCESS_TERMINAL_SCENARIO = `
  import { AgentClientSession, createAgentIo } from './packages/server/src/cli/agent-client-core.ts';

  const SENTINEL = 'Zzyzx-Spectator-Halt-Secret';
  const seats = [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }];
  const session = new AgentClientSession({
    io: createAgentIo({
      writeOut: (chunk) => process.stdout.write(chunk),
      writeErr: (chunk) => process.stderr.write(chunk),
    }),
    transport: { send: () => {}, close: () => {} },
    game: { seats, providerKind: 'random', humanSeat: 'P1', seed: 'seed1', paceMs: 0 },
    onDone: (code) => { process.exitCode = code; },
  });

  const seatSummary = (seat) => ({
    seat, deckId: 'deck-' + seat, label: 'Seat ' + seat,
    commanderNames: ['Commander'], colorIdentity: ['R'], archetypeTag: 'midrange',
  });
  const start = (over) => ({
    type: 'gameStarted',
    payload: {
      gameId: 'agent-game', seed: 'seed1', seats: ['P1', 'P2', 'P3', 'P4'].map(seatSummary),
      providerKind: 'random', gameMode: 'singlePlayer', humanSeat: 'P1',
      sessionToken: 'secret-token', paceMs: 0, startedAt: '2026-09-27T00:00:00.000Z', ...over,
    },
  });

  session.begin();

  // Someone else's spectator game starts and halts, unsanitized, on the same socket.
  session.receive(start({ gameId: 'spectator-game', gameMode: 'spectator', humanSeat: undefined }));
  session.receive({
    type: 'computeHalted',
    payload: { gameId: 'spectator-game', kind: 'unmodeledCard', reason: SENTINEL, turn: 7,
               cardName: SENTINEL },
  });
  session.receive({
    type: 'gameOver',
    payload: {
      result: { gameId: 'spectator-game', winnerSeat: 'P2', finishingOrder: ['P1'], turnCount: 7,
                halted: true, haltReason: SENTINEL },
      standings: [{ seat: 'P2', position: 1, lossReason: null }],
    },
  });
  // A start frame for a seat this client never asked for, then one for another game.
  session.receive(start({ gameId: 'someone-elses', humanSeat: 'P3' }));

  // This client's own game, and then its own terminal.
  session.receive(start({}));
  session.receive(start({ gameId: 'later-game' }));
  session.receive({
    type: 'computeHalted',
    payload: { gameId: 'later-game', kind: 'engineError', reason: SENTINEL, turn: 9 },
  });

  if (process.env['AGENT_TERMINAL_MODE'] === 'halt') {
    session.receive({
      type: 'computeHalted',
      payload: { gameId: 'agent-game', kind: 'unmodeledCard', reason: SENTINEL, turn: 9,
                 cardName: SENTINEL },
    });
  } else {
    session.receive({
      type: 'gameOver',
      payload: {
        result: { gameId: 'agent-game', winnerSeat: 'P1', finishingOrder: ['P4', 'P3', 'P2', 'P1'],
                  turnCount: 12, halted: false, haltReason: null },
        standings: [{ seat: 'P1', position: 1, lossReason: null }],
      },
    });
  }
`;

describe('agent client terminal scoping in a real process', () => {
  const SENTINEL = 'Zzyzx-Spectator-Halt-Secret';

  function run(mode: 'over' | 'halt'): { out: string; err: string; status: number | null } {
    const result = spawnSync('bun', ['-e', REAL_PROCESS_TERMINAL_SCENARIO], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_TERMINAL_MODE: mode },
    });
    expect(result.error).toBeUndefined();
    return { out: result.stdout, err: result.stderr, status: result.status };
  }

  it('exits 0 on its own game over, with no spectator halt text on any stream', () => {
    const { out, err, status } = run('over');
    expect(status).toBe(0);
    expect(out).not.toContain(SENTINEL);
    expect(err).not.toContain(SENTINEL);
    expect(out).not.toContain('secret-token');
    const events = out
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; gameId?: string });
    // Exactly one adopted start and one terminal: no duplicates from the frames it ignored.
    expect(events.map((event) => event.type)).toEqual(['game-started', 'game-over']);
    expect(events[0]?.gameId).toBe('agent-game');
    expect(JSON.stringify(events)).not.toContain('spectator-game');
    expect(JSON.stringify(events)).not.toContain('later-game');
  });

  it('exits 1 on its own halt, reporting the fixed message and nothing from the frame', () => {
    const { out, err, status } = run('halt');
    expect(status).toBe(1);
    expect(out).not.toContain(SENTINEL);
    expect(err).not.toContain(SENTINEL);
    const events = out
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; message?: string; fatal?: boolean });
    expect(events.map((event) => event.type)).toEqual(['game-started', 'error']);
    expect(events[1]).toMatchObject({ type: 'error', source: 'server', fatal: true });
    expect(events[1]?.message).not.toContain('unmodeledCard');
  });
});

describe('agent game-over output projection', () => {
  const MARKER = 'Zzyzx-Matched-Terminal-Private';
  const reply = '{"requestId":"r1","revision":4,"actionId":0}';

  function receive(h: Harness, payload: unknown): void {
    h.session.receive({ type: 'gameOver', payload } as unknown as ServerToClientMessage);
  }

  it('rebuilds matched result and standings, dropping private extras and halt text', () => {
    const h = atDecision();
    const original = gameOver();
    const payload = {
      result: { ...original.result, halted: true, haltReason: MARKER, privateState: MARKER },
      standings: original.standings.map((row) => ({ ...row, privateHand: MARKER })),
      reflections: MARKER,
    };
    receive(h, payload);
    expect(h.events).toEqual([
      {
        type: 'game-over',
        result: { ...original.result, halted: true, haltReason: null },
        standings: original.standings,
      },
    ]);
    const event = h.events[0];
    if (event?.type !== 'game-over') throw new Error('expected terminal event');
    expect(event.result).not.toBe(payload.result);
    expect(event.result.finishingOrder).not.toBe(payload.result.finishingOrder);
    expect(event.standings).not.toBe(payload.standings);
    for (let i = 0; i < event.standings.length; i++) {
      expect(event.standings[i]).not.toBe(payload.standings[i]);
    }
    expect(JSON.stringify(h.events)).not.toContain(MARKER);
    expect(h.diagnostics.join('\n')).not.toContain(MARKER);
    expect(h.done()).toBe(0);
    expect(h.closed()).toBe(true);
    expect(h.sent).toEqual([{ type: 'abandonGame', payload: {} }]);
  });

  it.each(['P1', 'P2', 'P3', 'P4', null])(
    'accepts winner %s without extra consistency rules',
    (winnerSeat) => {
      for (const halted of [false, true]) {
        for (const finishingOrder of [[], ['P3'], ['P4', 'P1'], ['P4', 'P3', 'P2', 'P1']]) {
          const h = atDecision();
          receive(h, {
            result: {
              ...gameOver().result,
              winnerSeat,
              finishingOrder,
              halted,
              turnCount: 0,
              haltReason: '',
            },
            standings: [],
          });
          expect(h.events).toEqual([
            {
              type: 'game-over',
              result: {
                ...gameOver().result,
                winnerSeat,
                finishingOrder,
                halted,
                turnCount: 0,
                haltReason: null,
              },
              standings: [],
            },
          ]);
          expect(h.done()).toBe(0);
        }
      }
    },
  );

  it('accepts every allowed loss reason and position including unfinished zero', () => {
    for (const lossReason of [...LOSS_REASONS, null]) {
      for (const position of [0, 1, 2, 3, 4]) {
        const h = atDecision();
        const payload = {
          ...gameOver(),
          standings: ['P1', 'P2', 'P3', 'P4'].map((seat) => ({ seat, position, lossReason })),
        };
        receive(h, payload);
        expect(h.events).toEqual([{ type: 'game-over', ...payload }]);
        expect(h.done()).toBe(0);
      }
    }
  });

  const malformed: Array<[string, unknown]> = [];
  for (const [field, values] of Object.entries({
    winnerSeat: [undefined, 'P5', '', 1, {}, []],
    finishingOrder: [undefined, null, {}, 'P1', ['P1', 'P1'], ['P5'], [null], [1]],
    turnCount: [undefined, null, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1],
    halted: [undefined, null, 0, 'false', {}, []],
    haltReason: [undefined, 0, false, {}, []],
  })) {
    for (const [index, value] of values.entries()) {
      malformed.push([
        `${field}/${index}`,
        { ...gameOver(), result: { ...gameOver().result, [field]: value } },
      ]);
    }
  }
  for (const [index, value] of [undefined, null, {}, 'rows', [null], [[]], ['row']].entries()) {
    malformed.push([`standings/${index}`, { ...gameOver(), standings: value }]);
  }
  for (const [field, values] of Object.entries({
    seat: [undefined, null, 'P5', 1, {}],
    position: [undefined, null, '0', -1, 5, 1.5, NaN, Infinity],
    lossReason: [undefined, MARKER, 1, {}, []],
  })) {
    for (const [index, value] of values.entries()) {
      malformed.push([
        `row.${field}/${index}`,
        {
          ...gameOver(),
          standings: [{ seat: 'P1', position: 0, lossReason: null, [field]: value }],
        },
      ]);
    }
  }

  it.each(malformed)(
    'ignores malformed %s without touching decision or submitted guards',
    (_label, payload) => {
      for (const submitted of [false, true]) {
        const h = atDecision();
        if (submitted) h.session.reply(reply);
        const sent = [...h.sent];
        receive(h, payload);
        expect(h.events).toEqual([]);
        expect(h.sent).toEqual(sent);
        expect(h.closed()).toBe(false);
        expect(h.done()).toBeNull();
        expect(h.diagnostics.at(-1)).toBe('ignored a malformed gameOver frame.');
        h.session.reply(reply);
        expect(h.sent).toEqual([
          { type: 'submitPlayerAction', payload: { requestId: 'r1', revision: 4, actionId: 0 } },
        ]);
        if (submitted) expect(errorMessage(h.events[0])).toContain('already submitted');
        else expect(h.events).toEqual([]);
        h.session.inputClosed();
        expect(h.done()).toBeNull();
        receive(h, gameOver());
        expect(h.done()).toBe(0);
      }
    },
  );

  it('projects terminal bytes through the actual CLI on a listening loopback WebSocket', () => {
    const payload = {
      result: { ...gameOver().result, haltReason: MARKER, privateState: MARKER },
      standings: gameOver().standings.map((row) => ({ ...row, privateHand: MARKER })),
      reflections: MARKER,
    };
    const scenario = `
      const server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch(req, server) {
          if (new URL(req.url).pathname === '/ws' && server.upgrade(req)) return;
          return new Response('not found', { status: 404 });
        },
        websocket: {
          message(ws, raw) {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'startGame') {
              ws.send(JSON.stringify({ type: 'gameStarted', payload: ${JSON.stringify(gameStarted())} }));
              ws.send(JSON.stringify({ type: 'gameOver', payload: ${JSON.stringify(payload)} }));
            }
          },
        },
      });
      const child = Bun.spawn(['bun', 'run', 'packages/server/src/cli/agent-client.ts', '--port', String(server.port)], {
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      const timer = setTimeout(() => child.kill(), 8000);
      try {
        const [out, err, status] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        console.log(JSON.stringify({ out, err, status }));
      } finally {
        clearTimeout(timer);
        child.stdin.end();
        server.stop(true);
      }
    `;
    const processResult = spawnSync('bun', ['-e', scenario], { encoding: 'utf8', timeout: 12000 });
    expect(processResult.error).toBeUndefined();
    expect(processResult.status).toBe(0);
    expect(processResult.stderr).not.toContain(MARKER);
    const { out, err, status } = JSON.parse(processResult.stdout) as {
      out: string;
      err: string;
      status: number;
    };
    expect(status).toBe(0);
    expect(out).not.toContain(MARKER);
    expect(err).not.toContain(MARKER);
    const events = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentEvent);
    expect(events).toEqual([
      {
        type: 'game-started',
        gameId: 'g1',
        seed: 'seed1',
        providerKind: 'random',
        humanSeat: 'P1',
        seats: gameStarted().seats,
        startedAt: gameStarted().startedAt,
      },
      { type: 'game-over', result: gameOver().result, standings: gameOver().standings },
    ]);
  }, 15000);
});

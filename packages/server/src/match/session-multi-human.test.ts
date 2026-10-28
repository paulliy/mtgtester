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
import { MatchSession } from './session';
import type { SeatSetup } from './setup';

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

function table(options: { providerKind?: 'random' | 'ai'; turnCap?: number } = {}): Table {
  const pub: ServerToClientMessage[] = [];
  const bySeat: Record<PlayerId, ServerToClientMessage[]> = { P1: [], P3: [] };
  const session = new MatchSession({
    gameId: 'g-multi-human',
    seed: SEED,
    seats: seats(),
    providerKind: options.providerKind ?? 'random',
    gameMode: 'table',
    seatControllers: {
      P1: 'human',
      P2: options.providerKind ?? 'random',
      P3: 'human',
      P4: options.providerKind ?? 'random',
    },
    turnCap: options.turnCap ?? 6,
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

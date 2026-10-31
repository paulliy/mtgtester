/**
 * `MatchSession` — the playback layer between the runner and the socket (brief §10.1).
 *
 * Phase 4 shipped this untested, and two defects lived here: the session set the runner's view
 * turn from its own snapshot callback (which made the compute-ahead cap unreachable and left
 * nothing to watch), and it served a seek without telling the client which action the board it
 * sent actually belongs to.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  DecisionRequest,
  GameId,
  OracleCard,
  ServerToClientMessage,
  SpectatorLogLine,
  StateSnapshotPayload,
} from '@mtg/shared';

async function waitFor(
  fn: () => void | Promise<void>,
  options?: { timeout?: number } | number,
): Promise<void> {
  const timeoutMs = typeof options === 'number' ? options : (options?.timeout ?? 5000);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fn();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  await fn();
}
import { LOOKAHEAD_TURNS } from '@mtg/shared';
import { RandomDecisionProvider, type AsyncDecisionProvider } from '@mtg/engine';
import {
  DEFAULT_AI_CONFIG,
  RequestCancelledError,
  RequestQueue,
  StrategyCoordinator,
  type AiClient,
} from '../ai';
import { MatchSession } from './session';
import { strictCardTestScenario } from '../cards/card-test-scenarios';
import type { SeatSetup } from './setup';
import { testerPolicy } from './disclosure';

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
    seat: `P${n}`,
    deckSnapshotId: null,
    config: {
      id: `P${n}`,
      deckId: `deck-${n}`,
      commanders: [general(`P${n}`)],
      cards: Array.from({ length: 20 }, (_, i) => forest(i)),
    },
    summary: {
      seat: `P${n}`,
      deckId: `deck-${n}`,
      label: `Test General P${n}`,
      commanderNames: [`Test General P${n}`],
      colorIdentity: ['G'],
      archetypeTag: 'G — test',
    },
  }));
}

interface Harness {
  session: MatchSession;
  sent: ServerToClientMessage[];
  snapshots: () => StateSnapshotPayload[];
}

function harness(options: { livePaceMs?: number; playbackMode?: 'live' | 'manual' } = {}): Harness {
  const sent: ServerToClientMessage[] = [];
  const session = new MatchSession({
    disclosure: testerPolicy('spectator'),
    gameId: 'g-session-test',
    seed: 'session-test',
    seats: seats(),
    providerKind: 'random',
    turnCap: 40,
    playbackMode: options.playbackMode ?? 'live',
    livePaceMs: options.livePaceMs ?? 0,
    send: (message) => sent.push(message),
  });
  return {
    session,
    sent,
    snapshots: () =>
      sent
        .filter(
          (m): m is Extract<ServerToClientMessage, { type: 'stateSnapshot' }> =>
            m.type === 'stateSnapshot',
        )
        .map((m) => m.payload),
  };
}

describe('MatchSession — live pacing and the compute-ahead cap (brief §10.1)', () => {
  it('aborts the pending turn-boundary strategist inside an early eventBatch abandonment', async () => {
    const sent: ServerToClientMessage[] = [];
    const order: string[] = [];
    const transport: { request?: DecisionRequest; signal?: AbortSignal; aborted?: AbortSignal } =
      {};
    let surfaced: DecisionRequest | undefined;
    let abandonedInSend = false;
    const session = new MatchSession({
      disclosure: testerPolicy('spectator'),
      gameId: 'g-strategist-event-abandon',
      seed: 'strategist-event-abandon',
      seats: seats(),
      providerKind: 'ai',
      gameMode: 'spectator',
      livePaceMs: 0,
      reflectionEnabled: false,
      send: (message) => {
        sent.push(message);
        if (message.type !== 'eventBatch' || transport.signal === undefined) return;
        order.push('eventBatch');
        expect(abandonedInSend).toBe(false);
        expect(transport.signal.aborted).toBe(false);
        expect(message.payload.frontierTurn).toBe(transport.request!.turn);
        expect(message.payload.snapshotTurns).toContain(transport.request!.turn);
        expect(session.runner.stateAt(transport.request!.turn)?.state).toEqual(
          session.engine.spectatorState(),
        );
        session.abandon();
        // Observe the transport's actual signal before this synchronous socket hook returns.
        expect(transport.signal.aborted).toBe(true);
        expect(transport.aborted).toBe(transport.signal);
        abandonedInSend = true;
        order.push('send-return');
      },
    });
    // Keep all four opening hands through the ordinary engine path, stopping at turn zero.
    // The runner's first advance (not this setup) must surface turn one's genuine decision and
    // trigger its new-turn bookkeeping. Monitor submissions only after these pre-game choices.
    for (let seat = 0; seat < 4; seat++) {
      const opening = session.engine.advance();
      if (opening.kind !== 'decision' || opening.request.decisionType !== 'mulligan') {
        throw new Error('expected an ordinary turn-zero opening-hand choice');
      }
      expect(opening.request.turn).toBe(0);
      const keep = opening.request.legalActions.find((action) => action.type === 'keep');
      if (keep === undefined) throw new Error('opening hand has no keep choice');
      session.engine.submit({ requestId: opening.request.requestId, actionId: keep.id });
    }
    const requestDecision = vi.fn<AiClient['requestDecision']>((_prompt, request, signal) => {
      transport.request = request;
      order.push('transport-start');
      if (signal === undefined) throw new Error('strategist transport must receive a real signal');
      transport.signal = signal;
      expect(signal.aborted).toBe(false);
      expect(surfaced?.turn).toBe(request.turn);
      expect(surfaced?.activePlayer).toBe(request.activePlayer);
      expect(session.runner.getFrontierTurn()).toBe(request.turn);
      expect(session.runner.getSnapshotTurns()).toContain(request.turn);
      expect(session.runner.stateAt(request.turn)?.state).toEqual(session.engine.spectatorState());
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            transport.aborted = signal;
            order.push('transport-abort');
            reject(new RequestCancelledError());
          },
          { once: true },
        );
      });
    });
    const coordinator = new StrategyCoordinator(
      { activeModel: 'fake-strategist', requestDecision },
      new RequestQueue({ concurrency: 1, rpmLimit: 10000 }),
      session.engine,
      { ...DEFAULT_AI_CONFIG, strategistEnabled: true },
    );
    const onStrategy = vi.fn();
    coordinator.onStrategy = onStrategy;
    // Replace only private factory/lookup boundaries. Even a failing ordering regression cannot
    // load environment configuration, construct configured clients/Jev, or reach a live provider.
    const internals = session as unknown as {
      aiCoordinator: StrategyCoordinator | null;
      ensureAiCoordinator(): StrategyCoordinator;
      buildAiProvider(): AsyncDecisionProvider;
      providerFor(playerId: string): AsyncDecisionProvider;
    };
    internals.aiCoordinator = coordinator;
    const ensureCoordinator = vi
      .spyOn(internals, 'ensureAiCoordinator')
      .mockReturnValue(coordinator);
    const buildProvider = vi.spyOn(internals, 'buildAiProvider').mockImplementation(() => {
      throw new Error('real AI provider factory forbidden');
    });
    const decide = vi.fn<AsyncDecisionProvider['decide']>(() => {
      throw new Error('provider decision forbidden after early abandonment');
    });
    const providerFor = vi.spyOn(internals, 'providerFor').mockReturnValue({ decide });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network transport forbidden');
    });
    const advance = session.engine.advance.bind(session.engine);
    const advanceSpy = vi.spyOn(session.engine, 'advance').mockImplementation(() => {
      const step = advance();
      if (step.kind === 'decision') {
        surfaced = step.request;
        order.push('decision-surfaced');
      }
      return step;
    });
    const submit = vi.spyOn(session.engine, 'submit');
    try {
      expect(session.engine.getState().turnNumber).toBe(0);
      session.start();
      await session.settled();
      await coordinator.settled();
      expect(sent.filter((message) => message.type === 'error')).toEqual([]);
      expect(abandonedInSend).toBe(true);
      expect(order).toEqual([
        'decision-surfaced',
        'transport-start',
        'eventBatch',
        'transport-abort',
        'send-return',
      ]);
      expect(transport.signal).toBeDefined();
      expect(transport.signal!.aborted).toBe(true);
      expect(transport.aborted).toBe(transport.signal);
      expect(transport.request!.turn).toBe(1);
      expect(transport.request!.decidingPlayer).toBe(surfaced!.activePlayer);
      expect(ensureCoordinator).toHaveBeenCalledTimes(1);
      expect(requestDecision).toHaveBeenCalledTimes(1);
      expect(session.runner.getStatus()).toBe('abandoned');
      expect(providerFor).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(buildProvider).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(
        sent.some((message) => message.type === 'error' || message.type === 'computeHalted'),
      ).toBe(false);
      expect(onStrategy).not.toHaveBeenCalled();
      expect(coordinator.guidanceFor(transport.request!.activePlayer).strategy).toBeNull();
      coordinator.prepare(surfaced!);
      coordinator.prefetch(transport.request!.gameId, transport.request!.turn + 1, 'P2');
      await coordinator.settled();
      expect(requestDecision).toHaveBeenCalledTimes(1);
      expect(onStrategy).not.toHaveBeenCalled();
      expect(
        session.engine
          .getDebugLog()
          .some((entry) => /strategist call (failed|completed)/.test(entry.message)),
      ).toBe(false);
    } finally {
      session.abandon();
      await session.settled();
      await coordinator.settled();
      for (const spy of [
        submit,
        advanceSpy,
        fetch,
        providerFor,
        buildProvider,
        ensureCoordinator,
      ]) {
        spy.mockRestore();
      }
    }
  });

  it('rejects Card Test Lab provider overrides on an ordinary match engine', () => {
    expect(
      () =>
        new MatchSession({
          disclosure: testerPolicy('spectator'),
          gameId: 'ordinary-match-provider-override',
          seed: 'ordinary-match-provider-override',
          seats: seats(),
          providerKind: 'random',
          turnCap: 2,
          decisionProviderOverrides: {
            P4: new RandomDecisionProvider('lab-only-provider'),
          },
          send: () => undefined,
        }),
    ).toThrow(/prepared Card Test Lab engine/i);
  });

  it('keeps compute within the lookahead of the *presented* turn, not the frontier', async () => {
    // A pace means the viewer walks forward on a clock, so the frontier can legitimately be
    // ahead of them — which is the only configuration in which the cap can bind at all.
    const { session } = harness({ livePaceMs: 10_000 });
    session.start();

    await waitFor(
      () => {
        expect(session.runner.getStatus()).toBe('waitingForView');
      },
      { timeout: 5_000 },
    );

    expect(session.runner.getViewTurn()).toBe(0);
    // The turn that trips the cap is computed, then nothing further.
    expect(session.runner.getFrontierTurn()).toBeLessThanOrEqual(LOOKAHEAD_TURNS + 1);

    session.abandon();
    await session.settled();
  });

  it('presents every turn once, in order, ending on the corrected final board', async () => {
    const { session, snapshots } = harness({ livePaceMs: 0 });
    session.start();
    await session.settled();

    const turns = snapshots().map((s) => s.turn);
    expect(turns[0]).toBe(0);
    for (let i = 1; i < turns.length; i++) {
      // The very last snapshot may repeat the previous turn number: a turn boundary is never
      // reached mid-turn, so `publishFinalState` re-presents the terminal turn once more with
      // the corrected post-elimination board once the game actually ends.
      const isTerminalCorrection = i === turns.length - 1 && turns[i] === turns[i - 1];
      expect(turns[i]).toBe(isTerminalCorrection ? turns[i - 1] : turns[i - 1]! + 1);
    }
    expect(turns.at(-1)).toBe(session.runner.getFrontierTurn());
  });

  it('holds log lines back until the board reaches them', async () => {
    const { session, sent } = harness({ livePaceMs: 10_000 });
    session.start();

    await waitFor(
      () => {
        expect(session.runner.getFrontierTurn()).toBeGreaterThan(1);
      },
      { timeout: 5_000 },
    );

    const released = sent
      .filter((m) => m.type === 'eventBatch')
      .flatMap((m) => (m.type === 'eventBatch' ? m.payload.lines : []));
    // Nothing from a turn the viewer has not been shown yet.
    for (const line of released) {
      expect(line.turn).toBeLessThanOrEqual(0);
    }

    session.abandon();
    await session.settled();
  });
});

describe('MatchSession - Phase 6 single-player control', () => {
  it('echoes the rejected submission request and revision to the player', async () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId: 'g-player-rejection',
      seed: 'player-rejection',
      seats: seats(),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      turnCap: 20,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    session.start();
    await waitFor(() => {
      expect(sent.some((message) => message.type === 'playerActionRequired')).toBe(true);
    });
    const request = sent.find((message) => message.type === 'playerActionRequired');
    if (request?.type !== 'playerActionRequired') throw new Error('player decision missing');
    const rejected = {
      requestId: request.payload.request.requestId,
      revision: request.payload.revision,
      actionId: 999_999,
    };
    session.submitPlayerAction('P1', rejected);
    expect(sent.at(-1)).toEqual({
      type: 'error',
      payload: {
        message: 'That action is not on the current legal menu.',
        requestId: rejected.requestId,
        revision: rejected.revision,
      },
    });
    session.abandon();
    await session.settled();
  });

  it('waits without a timeout for the human and advances only after submission', async () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId: 'g-player-test',
      seed: 'player-test',
      seats: seats(),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      turnCap: 20,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    session.start();

    await waitFor(() => {
      expect(sent.some((message) => message.type === 'playerActionRequired')).toBe(true);
    });
    const first = sent.find(
      (message): message is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
        message.type === 'playerActionRequired',
    );
    expect(first).toBeDefined();
    const countBefore = sent.filter((message) => message.type === 'playerActionRequired').length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent.filter((message) => message.type === 'playerActionRequired')).toHaveLength(
      countBefore,
    );

    session.submitPlayerAction('P1', {
      requestId: first!.payload.request.requestId,
      actionId: first!.payload.request.legalActions[0]!.id,
      revision: first!.payload.revision,
    });
    await waitFor(() => {
      expect(
        sent.filter((message) => message.type === 'playerStateSnapshot').length,
      ).toBeGreaterThan(1);
    });

    session.abandon();
    await session.settled();
    expect(sent.some((message) => message.type === 'stateSnapshot')).toBe(false);
    expect(sent.some((message) => message.type === 'replayUnlocked')).toBe(false);
  });

  it('offers the human its mana abilities, and never stops for them alone (ADR 0030)', async () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId: 'g-player-mana',
      seed: 'player-mana',
      seats: seats(),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      turnCap: 40,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    const chooser = new RandomDecisionProvider('browser-mana');
    const quiet = ['pass', 'passAndYieldTurn', 'yieldToAbility', 'activateManaAbility'];
    let consumed = 0;
    let offered = false;
    session.start();

    const deadline = Date.now() + 10_000;
    // Forty human decisions is plenty to see the offer, and to see no stop made for it alone.
    while (
      !sent.some((message) => message.type === 'gameOver') &&
      !(offered && consumed >= 40) &&
      Date.now() < deadline
    ) {
      const required = sent.filter(
        (message): message is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
          message.type === 'playerActionRequired',
      );
      const next = required[consumed];
      if (next === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      consumed += 1;
      const { request } = next.payload;
      if (request.decisionType === 'priority') {
        const types = request.legalActions.map((action) => action.type);
        if (types.includes('activateManaAbility')) offered = true;
        expect(types.every((type) => quiet.includes(type))).toBe(false);
      }
      const response = chooser.decide(request);
      session.submitPlayerAction('P1', {
        requestId: response.requestId,
        actionId: response.actionId,
        revision: next.payload.revision,
        ...(response.targets !== undefined ? { targets: response.targets } : {}),
      });
    }
    session.abandon();
    await session.settled();
    expect(offered).toBe(true);
  }, 15_000);

  it('presents every action it sends, and none it removed with a smart yield (ADR 0032)', async () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId: 'g-player-presentation',
      seed: 'player-presentation',
      seats: seats(),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      turnCap: 40,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    type Required = Extract<ServerToClientMessage, { type: 'playerActionRequired' }>;
    const requests = (): Required[] =>
      sent.filter((message): message is Required => message.type === 'playerActionRequired');
    const chooser = new RandomDecisionProvider('browser-presentation');
    // Land first, then pass: the next time the seat has priority it has a land drop and a cast.
    let consumed = 0;
    let checked = false;
    session.start();

    const deadline = Date.now() + 10_000;
    while (!checked && Date.now() < deadline) {
      const next = requests()[consumed];
      if (next === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      consumed += 1;
      const { request, revision } = next.payload;
      // Every frame's menu is presented in full, with the engine's prompt in player terms.
      expect(request.presentation?.playerPrompt).toBeDefined();
      expect(request.presentation?.playerPrompt).not.toMatch(
        /\((precombatMain|postcombatMain|beginning|combat|ending)/,
      );
      if (request.decisionType === 'priority') {
        expect(request.presentation?.layout).toBe('priority');
        for (const action of request.legalActions) {
          expect(request.presentation?.actions?.[action.id]?.verb, action.description).toBeTruthy();
        }
      }
      const cast = request.legalActions.find((action) => action.type === 'castSpell');
      const another = request.legalActions.some(
        (action) => action.id !== cast?.id && action.type === 'playLand',
      );
      if (request.decisionType === 'priority' && cast !== undefined && another) {
        expect(request.presentation?.actions?.[cast.id]?.label).toBe('Cast');
        session.yieldPlayerAbility('P1', {
          requestId: request.requestId,
          revision,
          actionId: cast.id,
          mode: 'smart',
        });
        // The same request goes out again without the yielded cast, and without its entry.
        const resent = requests().filter(
          (message) => message.payload.request.requestId === request.requestId,
        );
        const again = resent.at(-1)!.payload.request;
        expect(resent.length).toBeGreaterThan(1);
        expect(again.legalActions.map((action) => action.id)).not.toContain(cast.id);
        expect(
          Object.keys(again.presentation?.actions ?? {})
            .map(Number)
            .sort(),
        ).toEqual(again.legalActions.map((action) => action.id).sort());
        checked = true;
        break;
      }
      const response = chooser.decide(request);
      const land = request.legalActions.find((action) => action.type === 'playLand');
      const pass = request.legalActions.find((action) => action.type === 'pass');
      const actionId =
        request.decisionType === 'priority'
          ? (land ?? pass ?? request.legalActions[0]!).id
          : response.actionId;
      session.submitPlayerAction('P1', {
        requestId: response.requestId,
        actionId,
        revision,
        ...(request.decisionType !== 'priority' && response.targets !== undefined
          ? { targets: response.targets }
          : {}),
      });
    }
    session.abandon();
    await session.settled();
    expect(checked).toBe(true);
  }, 15_000);

  it('refuses timeline seeking before a player game has ended', () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId: 'g-player-seek',
      seed: 'player-seek',
      seats: seats(),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      send: (message) => sent.push(message),
    });
    session.jumpToTurn(3);
    expect(
      sent.some(
        (message) => message.type === 'error' && message.payload.message.includes('unlocks after'),
      ),
    ).toBe(true);
  });

  it('plays through with a human provider and restores the unlocked replay on resync', async () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId: 'g-player-complete',
      seed: 'player-complete',
      seats: seats(),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      turnCap: 200,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    const chooser = new RandomDecisionProvider('browser-player');
    let consumedRequests = 0;
    session.start();

    const deadline = Date.now() + 10_000;
    while (!sent.some((message) => message.type === 'gameOver') && Date.now() < deadline) {
      const required = sent.filter(
        (message): message is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
          message.type === 'playerActionRequired',
      );
      const next = required[consumedRequests];
      if (next === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      consumedRequests += 1;
      const response = chooser.decide(next.payload.request);
      session.submitPlayerAction('P1', {
        requestId: response.requestId,
        actionId: response.actionId,
        revision: next.payload.revision,
        ...(response.targets !== undefined ? { targets: response.targets } : {}),
      });
    }

    await session.settled();
    const gameOverIndex = sent.findIndex((message) => message.type === 'gameOver');
    const replayIndex = sent.findIndex((message) => message.type === 'replayUnlocked');
    expect(gameOverIndex).toBeGreaterThan(-1);
    expect(replayIndex).toBeGreaterThan(-1);
    expect(replayIndex).toBeLessThan(gameOverIndex);
    expect(sent.slice(0, gameOverIndex).some((message) => message.type === 'stateSnapshot')).toBe(
      false,
    );

    const replayCount = sent.filter((message) => message.type === 'replayUnlocked').length;
    const gameOverCount = sent.filter((message) => message.type === 'gameOver').length;
    session.resyncPlayer('P1');
    expect(sent.filter((message) => message.type === 'replayUnlocked')).toHaveLength(
      replayCount + 1,
    );
    expect(sent.filter((message) => message.type === 'gameOver')).toHaveLength(gameOverCount + 1);
  }, 15_000);
});

// Each plays a whole game, like the file's other full-game tests.
describe('MatchSession — seeking (brief §10.1)', { timeout: 15_000 }, () => {
  it('reports which action the board it sent belongs to', async () => {
    const { session, sent, snapshots } = harness({ livePaceMs: 0 });
    session.start();
    await session.settled();

    const lines = sent
      .filter((m) => m.type === 'eventBatch')
      .flatMap((m) => (m.type === 'eventBatch' ? m.payload.lines : []));
    const line = lines.find((l) => l.turn > 1);
    expect(line).toBeDefined();

    const before = snapshots().length;
    session.setPlaybackMode('manual');
    session.jumpToTurn(line!.turn, line!.sequence);

    const reply = snapshots().slice(before).at(-1);
    expect(reply).toBeDefined();
    // The exact per-action board was served, and says so — the client keys its log highlight
    // off this rather than assuming its own request succeeded.
    expect(reply!.sequence).toBe(line!.sequence);
    expect(reply!.turn).toBe(line!.turn);
  });

  it('reports null when it fell back to the turn snapshot', async () => {
    const { session, snapshots } = harness({ livePaceMs: 0 });
    session.start();
    await session.settled();

    const before = snapshots().length;
    session.setPlaybackMode('manual');
    // A sequence that was never recorded (no such event).
    session.jumpToTurn(2, 9_999_999);

    const reply = snapshots().slice(before).at(-1);
    expect(reply).toBeDefined();
    expect(reply!.sequence).toBeNull();
    expect(reply!.turn).toBe(2);
  });

  it('ends on the board the game actually finished with', async () => {
    const { session, snapshots } = harness({ livePaceMs: 0 });
    session.start();
    await session.settled();

    const final = snapshots().at(-1);
    expect(final).toBeDefined();
    // Turn snapshots are taken at a turn's start, so without a terminal re-capture the last
    // board a viewer can reach predates the eliminations that ended the game.
    const result = session.runner.getResult();
    if (result !== null && !result.halted && result.winnerSeat !== null) {
      expect(final!.state.eliminatedPlayers.length).toBe(3);
    }
  });
});

/**
 * Post-game commentary (ADR 0022 §7, §9). The default game must cost exactly what it costs today,
 * so the off path is what most users will actually run — and `gameOver` must be identical to
 * before whether commentary is coming or not.
 */
describe('MatchSession — post-game reflection stays out of the way when off', () => {
  /** `turnCap` high enough that the game genuinely ends rather than halting on the cap. */
  function finishedGame(options: { reflectionEnabled?: boolean } = {}): {
    session: MatchSession;
    sent: ServerToClientMessage[];
  } {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('spectator'),
      gameId: 'g-reflection-off',
      seed: 'reflection-off',
      seats: seats(),
      providerKind: 'random',
      ...(options.reflectionEnabled !== undefined
        ? { reflectionEnabled: options.reflectionEnabled }
        : {}),
      turnCap: 200,
      // Pace 0 presents synchronously. This fixture's 20-card test decks (`seats()` above) run
      // out well before turn 200, and a player decking out on an uneventful draw step aborts
      // their turn without ever surfacing a decision — which used to leave a gap in the turn
      // numbering the presentation clock couldn't step over (`nextPresentableTurn` in session.ts
      // is the fix; see the regression test below).
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    return { session, sent };
  }

  function gameOverPayload(sent: ServerToClientMessage[]) {
    const message = sent.find(
      (candidate): candidate is Extract<ServerToClientMessage, { type: 'gameOver' }> =>
        candidate.type === 'gameOver',
    );
    return message?.payload;
  }

  // `finishedGame()` plays a full random-fuzzed 4-player game (`providerKind: 'random'`, brief
  // §5.9's fuzzer, not the live bot/AI opponent). Batched combat declarations (ADR 0023 items
  // 13/14) occasionally add an extra decision — a rejected proposal's one informed retry — which
  // random attack proposals hit often enough to push these over vitest's 5s default under
  // full-suite parallel load. Not a hang — see determinism.test.ts's note on the same pattern.

  it('promises no commentary and sends none for a random-provider game', async () => {
    const { session, sent } = finishedGame();
    session.start();
    await session.settled();
    await session.reflectionsSettled();

    const payload = gameOverPayload(sent);
    expect(payload).toBeDefined();
    // Absent, not empty: a payload that grew would defeat the point of defaulting to off.
    expect(payload?.reflectingSeats).toBeUndefined();
    expect(sent.some((message) => message.type === 'gameReflections')).toBe(false);
  }, 30_000);

  it('leaves the rest of the gameOver payload untouched', async () => {
    const { session, sent } = finishedGame();
    session.start();
    await session.settled();

    const payload = gameOverPayload(sent);
    expect(payload?.standings).toHaveLength(4);
    expect(payload?.result).toBeDefined();
  }, 30_000);

  it('never reviews a seat with no AI behind it, even when asked to', async () => {
    // `reflectionEnabled` is a per-game opt-in, but a random bot has no reasoning to review — the
    // provider kind is the real gate.
    const { session, sent } = finishedGame({ reflectionEnabled: true });
    session.start();
    await session.settled();
    await session.reflectionsSettled();

    expect(gameOverPayload(sent)?.reflectingSeats).toBeUndefined();
    expect(sent.some((message) => message.type === 'gameReflections')).toBe(false);
  }, 30_000);
});

/**
 * Regression coverage for the turn-numbering gap discovered while building 11.3: a turn that
 * aborts with zero surfaced decisions (a player decking out on an uneventful draw step) never
 * gets a snapshot of its own, and the live presentation clock used to assume `presentedTurn + 1`
 * always exists — hanging forever, either as a tight synchronous loop (`livePaceMs: 0`) or a
 * `setInterval` that never clears (any other pace), well after the game had actually finished
 * computing.
 */
describe('MatchSession — presentation survives a gap in turn numbering', () => {
  it('presents through to the final turn at pace 0 without hanging, even with a deck-out gap', async () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('spectator'),
      gameId: 'g-presentation-gap',
      seed: 'reflection-off', // same fixture as above — its 20-card decks run out well before turn 200
      seats: seats(),
      providerKind: 'random',
      turnCap: 200,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    session.start();
    await session.settled();

    const gameOver = sent.find(
      (candidate): candidate is Extract<ServerToClientMessage, { type: 'gameOver' }> =>
        candidate.type === 'gameOver',
    );
    expect(gameOver).toBeDefined();

    const snapshots = sent.filter(
      (candidate): candidate is Extract<ServerToClientMessage, { type: 'stateSnapshot' }> =>
        candidate.type === 'stateSnapshot',
    );
    const lastPresented = snapshots[snapshots.length - 1]?.payload;
    // Presentation must have actually reached the end of the game, not stalled behind a turn
    // that was never snapshotted.
    expect(lastPresented?.turn).toBe(gameOver?.payload.result.turnCount);
    expect(lastPresented?.atFrontier).toBe(true);
  });
});

/**
 * Regression for the flush-ordering defect the Card Test Lab's War Room trace exposed.
 *
 * `MatchRunner.loop` used to await the human provider *before* flushing what `advance()` had
 * already produced. `advance()` runs a decision's whole forced tail — payment, forced passes,
 * the ability resolving, the draw — and only then surfaces the next genuine request, so those
 * outcome events sat behind the runner's event cursor while the provider waited. A human
 * provider waits indefinitely, which turned "until the next decision is answered" into "never":
 * the player was asked to act on a board holding a card the log never said they drew.
 *
 * Driven through the real `MatchSession` on the prepared scenario, submitting by the normal
 * human path, with the request that follows deliberately left unanswered.
 */
describe('MatchSession — a prepared scenario flushes its own outcome before the next request', () => {
  const ACTIVATION =
    "War Room: Pay life equal to your commanders' color identity colors: draw a card";

  function labSession(gameId: GameId) {
    const scenario = strictCardTestScenario('war-room-viewer-dynamic-life-activation', gameId);
    if (scenario === null) throw new Error('missing War Room lab scenario');
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
      disclosure: testerPolicy('singlePlayer'),
      gameId,
      seed: scenario.seed,
      seats: scenario.seats,
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      livePaceMs: 0,
      engine: scenario.engine,
      // Deliberately no store, exactly as the real lab session is built.
      send: (message) => sent.push(message),
    });
    const requests = () =>
      sent.filter(
        (m): m is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
          m.type === 'playerActionRequired',
      );
    /** Every log line the client had received by the time message `index` was sent. */
    const linesBefore = (index: number): SpectatorLogLine[] =>
      sent
        .slice(0, index)
        .flatMap((m) => (m.type === 'eventBatch' ? m.payload.lines : ([] as SpectatorLogLine[])));
    return { session, sent, requests, linesBefore };
  }

  it('delivers its own draw and resolution before the next playerActionRequired', async () => {
    const { session, sent, requests, linesBefore } = labSession('g-war-room-flush' as GameId);
    session.start();

    await waitFor(() => {
      expect(requests().length).toBeGreaterThanOrEqual(1);
    });
    const opening = requests()[0]!.payload;
    const openingSeat = opening.state.seats.find((seat) => seat.seat === 'P1');
    expect(openingSeat?.life).toBe(40);
    expect(openingSeat?.handSize).toBe(2);

    const activation = opening.request.legalActions.find(
      (action) => action.type === 'activateAbility' && action.description === ACTIVATION,
    );
    expect(activation).toBeDefined();
    session.submitPlayerAction('P1', {
      requestId: opening.request.requestId,
      actionId: activation!.id,
      revision: opening.revision,
    });

    // The next request is a genuine P1 priority decision and is never answered — the exact
    // state the defect left the player in.
    await waitFor(() => {
      expect(requests().length).toBeGreaterThanOrEqual(2);
    });
    const secondIndex = sent.findIndex(
      (m, index) =>
        m.type === 'playerActionRequired' &&
        sent.slice(0, index).filter((earlier) => earlier.type === 'playerActionRequired').length ===
          1,
    );
    expect(secondIndex).toBeGreaterThan(-1);

    const delivered = linesBefore(secondIndex);
    expect(delivered.filter((line) => line.text === 'draws Three Color Commander')).toHaveLength(1);
    expect(
      delivered.filter((line) => /Pay life.*resolves/.test(line.text)).map((line) => line.text),
    ).toEqual([
      "War Room — Pay life equal to your commanders' color identity colors: draw a card resolves",
    ]);

    const settled = requests()[1]!.payload.state;
    const p1 = settled.seats.find((seat) => seat.seat === 'P1');
    expect(p1?.life).toBe(37);
    expect(p1?.handSize).toBe(3);
    expect(p1?.hand?.map((card) => card.name).sort()).toEqual([
      'Three Color Commander',
      'War Room Action Witness',
      'War Room Mana Sink',
    ]);
    expect(settled.battlefield.filter((permanent) => permanent.tapped)).toHaveLength(4);
    expect(settled.stack).toEqual([]);

    // Flushing earlier must not widen the projection: an opponent's draw is filtered out of the
    // player log entirely, and no opponent hand is ever materialised.
    expect(
      delivered.filter((line) => line.actorSeat !== 'P1' && /^draws /.test(line.text)),
    ).toEqual([]);
    for (const seat of settled.seats.filter((candidate) => candidate.seat !== 'P1')) {
      expect(seat.hand).toBeNull();
    }

    session.abandon();
    await session.settled();
  });
});

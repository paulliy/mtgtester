/**
 * `MatchSession` — the playback layer between the runner and the socket (brief §10.1).
 *
 * Phase 4 shipped this untested, and two defects lived here: the session set the runner's view
 * turn from its own snapshot callback (which made the compute-ahead cap unreachable and left
 * nothing to watch), and it served a seek without telling the client which action the board it
 * sent actually belongs to.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard, ServerToClientMessage, StateSnapshotPayload } from '@mtg/shared';

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
import { RandomDecisionProvider } from '@mtg/engine';
import { MatchSession } from './session';
import type { SeatSetup } from './setup';

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
  it('waits without a timeout for the human and advances only after submission', async () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
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

    session.submitPlayerAction({
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

  it('refuses timeline seeking before a player game has ended', () => {
    const sent: ServerToClientMessage[] = [];
    const session = new MatchSession({
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
      session.submitPlayerAction({
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
    session.resyncPlayer();
    expect(sent.filter((message) => message.type === 'replayUnlocked')).toHaveLength(
      replayCount + 1,
    );
    expect(sent.filter((message) => message.type === 'gameOver')).toHaveLength(gameOverCount + 1);
  }, 15_000);
});

describe('MatchSession — seeking (brief §10.1)', () => {
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

  function stateSnapshots(sent: ServerToClientMessage[]) {
    return sent.filter(
      (candidate): candidate is Extract<ServerToClientMessage, { type: 'stateSnapshot' }> =>
        candidate.type === 'stateSnapshot',
    );
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

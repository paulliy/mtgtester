/**
 * `MatchSession` — the playback layer between the runner and the socket (brief §10.1).
 *
 * Phase 4 shipped this untested, and two defects lived here: the session set the runner's view
 * turn from its own snapshot callback (which made the compute-ahead cap unreachable and left
 * nothing to watch), and it served a seek without telling the client which action the board it
 * sent actually belongs to.
 */

import { describe, expect, it, vi } from 'vitest';
import type { OracleCard, ServerToClientMessage, StateSnapshotPayload } from '@mtg/shared';
import { LOOKAHEAD_TURNS } from '@mtg/shared';
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
        .filter((m): m is Extract<ServerToClientMessage, { type: 'stateSnapshot' }> =>
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

    await vi.waitFor(
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

  it('presents every turn once, in order, starting from the opening board', async () => {
    const { session, snapshots } = harness({ livePaceMs: 0 });
    session.start();
    await session.settled();

    const turns = snapshots().map((s) => s.turn);
    expect(turns[0]).toBe(0);
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i]).toBe(turns[i - 1]! + 1);
    }
    expect(turns.at(-1)).toBe(session.runner.getFrontierTurn());
  });

  it('holds log lines back until the board reaches them', async () => {
    const { session, sent } = harness({ livePaceMs: 10_000 });
    session.start();

    await vi.waitFor(
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

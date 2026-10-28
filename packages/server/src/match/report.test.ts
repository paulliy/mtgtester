/**
 * "Copy game report" (`MatchSession.gameReport`): enough to file and recreate a game, without
 * leaking an opponent's deck while the game can still change.
 */

import { describe, expect, it } from 'vitest';
import { RandomDecisionProvider } from '@mtg/engine';
import type { OracleCard, ServerToClientMessage } from '@mtg/shared';
import {
  describeSubmittedSplit,
  orderedDecklist,
  publicNames,
  REPORT_LOG_LINES,
  reportDeckSource,
  type ReportSeatSource,
} from './report';
import { MatchSession } from './session';
import type { SeatSetup } from './setup';
import { testerPolicy } from './disclosure';

function card(name: string, n = 0): OracleCard {
  return {
    oracleId: `${name}-${n}`,
    scryfallId: `scry-${name}-${n}`,
    name,
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
    ...card(`Test General ${seat}`),
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
    deckSnapshotId: n === 2 ? 'snap-p2' : null,
    config: {
      id: `P${n}`,
      deckId: `deck-${n}`,
      commanders: [general(`P${n}`)],
      cards: Array.from({ length: 20 }, (_, i) => card('Forest', i)),
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

const SOURCES: ReportSeatSource[] = [
  { kind: 'pool' },
  { kind: 'snapshot', snapshotId: 'snap-p2' },
  { kind: 'url', url: 'https://example.test/decks/p3' },
  { kind: 'plaintext', text: '1 Secret Card' },
];

const CONTEXT = {
  build: { commit: 'abc123', branch: 'feature', dirty: false },
  cardData: { source: 'fixture.json', sha256: 'beef', entries: 2 },
  startedAt: '2026-10-05T00:00:00.000Z',
  sources: SOURCES,
  cardTestScenarioId: null,
};

function session(sent: ServerToClientMessage[], turnCap = 200): MatchSession {
  return new MatchSession({
    disclosure: testerPolicy('singlePlayer'),
    gameId: 'g-report',
    seed: 'report-seed',
    seats: seats(),
    providerKind: 'random',
    gameMode: 'singlePlayer',
    humanSeat: 'P1',
    turnCap,
    livePaceMs: 0,
    send: (message) => sent.push(message),
  });
}

async function waitFor(fn: () => void, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      fn();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

type ActionRequired = Extract<ServerToClientMessage, { type: 'playerActionRequired' }>;

describe('report helpers', () => {
  it('keeps the configured deck order, collapses only consecutive copies, and keeps roles', () => {
    const list = orderedDecklist({
      id: 'P1',
      deckId: 'd',
      commanders: [general('P1')],
      companion: card('Lurrus'),
      cards: [card('Forest'), card('Forest'), card('Sol Ring'), card('Forest')],
    });
    // The seeded shuffle starts from this order, so a sorted list could not reproduce a game; the
    // companion stays labeled so a re-import cannot fold it into the main deck.
    expect(list).toEqual({
      commanders: ['Test General P1'],
      companion: 'Lurrus',
      library: ['2 Forest', '1 Sol Ring', '1 Forest'],
    });
  });

  it('describes a submitted combat-damage split rather than the preset option', () => {
    const names: Record<string, string> = { a: 'Wall of Omens', b: 'Goblin' };
    expect(describeSubmittedSplit(3, { a: 2, b: 1 }, (id) => names[id] ?? id)).toBe(
      'Divide 3 damage: 2 to Wall of Omens, 1 to Goblin',
    );
    expect(describeSubmittedSplit(undefined, { a: 0, b: 2 }, (id) => names[id] ?? id)).toBe(
      'Divide 2 damage: 2 to Goblin',
    );
  });

  it('names decision targets from public zones only, falling back to the id', () => {
    const zones = {
      battlefield: [{ id: 'o-1', name: 'Wall of Omens' }],
      stack: [
        { id: 'o-2', description: 'Cast Lightning Bolt', card: { name: 'Lightning Bolt' } },
        { id: 'o-3', description: 'Adaptive Sporesinger — ETB', card: null },
      ],
      players: [{ graveyard: [{ id: 'o-4', name: 'Goblin' }] }],
    };
    expect(publicNames(zones, ['o-1', 'o-2', 'o-3', 'o-4', 'P2', 'o-hidden'])).toEqual({
      'o-1': 'Wall of Omens',
      'o-2': 'Lightning Bolt',
      'o-3': 'Adaptive Sporesinger — ETB',
      'o-4': 'Goblin',
      P2: 'P2',
      // Nothing outside public zones is consulted, so a hidden card is never named.
      'o-hidden': 'o-hidden',
    });
  });

  it('names the seed a pool seat actually used, and withholds an unrevealed URL', () => {
    expect(reportDeckSource({ kind: 'pool' }, 2, 'game', false)).toEqual({
      kind: 'pool',
      seed: 'game-seat3',
    });
    expect(reportDeckSource({ kind: 'url', url: 'https://x.test' }, 0, 'g', false)).toEqual({
      kind: 'url',
      url: null,
    });
    expect(reportDeckSource({ kind: 'url', url: 'https://x.test' }, 0, 'g', true)).toEqual({
      kind: 'url',
      url: 'https://x.test',
    });
    expect(reportDeckSource({ kind: 'plaintext', text: '1 Secret Card' }, 0, 'g', true)).toEqual({
      kind: 'plaintext',
    });
  });
});

describe('MatchSession.gameReport', () => {
  it('mid-game: own deck and choice only, opponents reduced to what setup already showed', async () => {
    const sent: ServerToClientMessage[] = [];
    const match = session(sent, 20);
    match.start();
    await waitFor(() => expect(sent.some((m) => m.type === 'playerActionRequired')).toBe(true));
    const required = sent.find((m): m is ActionRequired => m.type === 'playerActionRequired')!;

    const before = match.gameReport(CONTEXT);
    expect(before.build).toEqual(CONTEXT.build);
    expect(before.game).toMatchObject({ id: 'g-report', seed: 'report-seed', humanSeat: 'P1' });
    expect(before.status.over).toBe(false);
    expect(before.pendingChoice?.requestId).toBe(required.payload.request.requestId);
    expect(before.pendingChoice?.options).toEqual(
      required.payload.request.legalActions.map((action) => action.description),
    );

    const [own, p2, p3, p4] = before.seats;
    expect(own?.decklist?.commanders).toEqual(['Test General P1']);
    expect(before.cardData).toEqual(CONTEXT.cardData);
    expect(own?.source).toEqual({ kind: 'pool', seed: 'report-seed-seat1' });
    for (const opponent of [p2, p3, p4]) expect(opponent?.decklist).toBeNull();
    expect(p2?.source).toEqual({ kind: 'snapshot', snapshotId: 'snap-p2' });
    expect(p3?.source).toEqual({ kind: 'url', url: null });
    expect(p4?.source).toEqual({ kind: 'plaintext' });
    expect(JSON.stringify(before)).not.toContain('example.test');
    expect(JSON.stringify(before)).not.toContain('Secret Card');

    const chosen = required.payload.request.legalActions[0]!;
    match.submitPlayerAction('P1', {
      requestId: required.payload.request.requestId,
      actionId: chosen.id,
      revision: required.payload.revision,
    });
    await waitFor(() =>
      expect(match.gameReport(CONTEXT).lastSubmittedAction?.requestId).toBe(
        required.payload.request.requestId,
      ),
    );
    expect(match.gameReport(CONTEXT).lastSubmittedAction?.description).toBe(chosen.description);

    match.abandon();
    await match.settled();
  });

  it('after the game: every seat’s decklist and the final status', async () => {
    const sent: ServerToClientMessage[] = [];
    const match = session(sent);
    const chooser = new RandomDecisionProvider('report-player');
    let consumed = 0;
    match.start();
    const deadline = Date.now() + 10_000;
    while (!sent.some((m) => m.type === 'gameOver') && Date.now() < deadline) {
      const required = sent.filter((m): m is ActionRequired => m.type === 'playerActionRequired');
      const next = required[consumed];
      if (next === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      consumed += 1;
      const answer = chooser.decide(next.payload.request);
      match.submitPlayerAction('P1', {
        requestId: next.payload.request.requestId,
        actionId: answer.actionId,
        revision: next.payload.revision,
        ...(answer.targets !== undefined ? { targets: answer.targets } : {}),
      });
    }
    await match.settled();

    const report = match.gameReport(CONTEXT);
    expect(report.status.over).toBe(true);
    expect(report.status.runner).toBe('finished');
    expect(report.pendingChoice).toBeNull();
    for (const seat of report.seats) expect(seat.decklist?.library.length).toBeGreaterThan(0);
    expect(report.seats[2]?.source).toEqual({ kind: 'url', url: 'https://example.test/decks/p3' });
    expect(report.recentLog.length).toBeLessThanOrEqual(REPORT_LOG_LINES);
    expect(report.recentLog.at(-1)).toMatch(/^T\d+/);
  });

  it('reads the seed, tags and decklists from the policy, not from the mode', async () => {
    const sent: ServerToClientMessage[] = [];
    const sealed = {
      ...testerPolicy('singlePlayer'),
      showSeed: false,
      archetypeTags: 'ownHumanSeat',
      decklistsAfterGame: false,
    } as const;
    const match = new MatchSession({
      disclosure: sealed,
      gameId: 'g-report',
      seed: 'report-seed',
      seats: seats(),
      providerKind: 'random',
      gameMode: 'singlePlayer',
      humanSeat: 'P1',
      turnCap: 20,
      livePaceMs: 0,
      send: (message) => sent.push(message),
    });
    match.start();
    await waitFor(() => expect(sent.some((m) => m.type === 'playerActionRequired')).toBe(true));

    const report = match.gameReport(CONTEXT);
    expect(report.game.seed).toBe('');
    expect(report.seats.map((seat) => seat.archetypeTag)).toEqual(['G — test', '', '', '']);
    // The pool seed a seat defaulted to is derived from the game's, so it hides with it.
    expect(report.seats[0]?.source).toEqual({ kind: 'pool', seed: '' });
    expect(JSON.stringify(report)).not.toContain('report-seed');

    match.abandon();
    await match.settled();
    // The tester's own policy still shows all of it.
    const open = session([]);
    const shown = open.gameReport(CONTEXT);
    expect(shown.game.seed).toBe('report-seed');
    expect(shown.seats.map((seat) => seat.archetypeTag)).toEqual(Array(4).fill('G — test'));
    open.abandon();
  });
});

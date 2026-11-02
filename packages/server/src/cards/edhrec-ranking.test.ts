import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cutAtSlotShare,
  isBasicLandName,
  rankEdhrecCards,
  readiness,
  renderReadyList,
  topNonlandNames,
  type EdhrecCardView,
  type EdhrecRanking,
  type EdhrecRow,
} from './edhrec-ranking';

const view = (name: string, decks: number): EdhrecCardView => ({
  name,
  num_decks: decks,
  potential_decks: 1000,
});

describe('rankEdhrecCards', () => {
  it('merges both lists by decks, breaks ties by name, and drops every basic land', () => {
    const rows = rankEdhrecCards(
      [view('Sol Ring', 900), view('Beta', 50), view('Alpha', 50)],
      [
        view('Forest', 950),
        view('Snow-Covered Island', 40),
        view('Wastes', 5),
        view('Command Tower', 800),
      ],
    );
    expect(rows).toEqual([
      ['Sol Ring', 900, 'nonland'],
      ['Command Tower', 800, 'land'],
      ['Alpha', 50, 'nonland'],
      ['Beta', 50, 'nonland'],
    ]);
  });

  it('refuses a card listed twice, which would count its slots twice', () => {
    expect(() => rankEdhrecCards([view('Sol Ring', 9)], [view('Sol Ring', 9)])).toThrow('twice');
  });

  it('refuses a deck count that is not a whole number', () => {
    expect(() => rankEdhrecCards([view('Sol Ring', 1.5)], [])).toThrow('invalid deck count');
  });

  it('knows basics by name only, not by type', () => {
    expect(isBasicLandName('Snow-Covered Wastes')).toBe(true);
    expect(isBasicLandName('Plains')).toBe(true);
    expect(isBasicLandName('Prairie Stream')).toBe(false);
  });
});

describe('cutAtSlotShare', () => {
  const rows: EdhrecRow[] = [
    ['A', 50, 'nonland'],
    ['B', 30, 'nonland'],
    ['C', 15, 'land'],
    ['D', 5, 'nonland'],
  ];

  it('keeps the fewest top cards that reach the share', () => {
    expect(cutAtSlotShare(rows, 0.8).cards.map((row) => row[0])).toEqual(['A', 'B']);
    expect(cutAtSlotShare(rows, 0.81).cards.map((row) => row[0])).toEqual(['A', 'B', 'C']);
    expect(cutAtSlotShare(rows, 1).cards).toHaveLength(4);
    expect(cutAtSlotShare(rows, 0.95).totalSlots).toBe(100);
  });

  it('rejects a share outside (0, 1]', () => {
    expect(() => cutAtSlotShare(rows, 0)).toThrow('slot share');
    expect(() => cutAtSlotShare(rows, 1.2)).toThrow('slot share');
  });

  it('takes staples from nonland cards only', () => {
    expect(topNonlandNames(rows, 3)).toEqual(['A', 'B', 'D']);
    expect(() => topNonlandNames(rows, 4)).toThrow('3 nonland');
  });
});

describe('readiness', () => {
  it('reads a card with no reasons as modeled', () => {
    expect(readiness({ modeled: true, reasons: [] })).toEqual({ status: 'modeled' });
  });

  it('reads one unrecognized line, and nothing else, as one line away', () => {
    expect(
      readiness({ modeled: false, reasons: ['unrecognized rules text: "Draw a card.\nScry 1."'] }),
    ).toEqual({ status: 'one-line', line: 'Draw a card.\nScry 1.' });
  });

  it('never reads a structural blocker or two blockers as one line away', () => {
    expect(readiness({ modeled: false, reasons: ['unsupported layout "saga"'] })).toBeNull();
    expect(
      readiness({
        modeled: false,
        reasons: ['unrecognized rules text: "Flying"', 'unrecognized rules text: "Ward {2}"'],
      }),
    ).toBeNull();
  });

  it('does not trust a modeled flag that still carries a reason', () => {
    expect(readiness({ modeled: true, reasons: ['unrecognized rules text: "Flying"'] })).toBeNull();
  });
});

describe('renderReadyList', () => {
  const ranking: EdhrecRanking = {
    sources: [],
    fetchedAt: '2026-11-02',
    totalDecks: 1000,
    totalSlots: 4000,
    rankedCards: 5,
    slotShare: 0.95,
    cards: [
      ['Sol Ring', 900, 'nonland'],
      ['Grizzly Bears', 600, 'nonland'],
      ['Lim-Dûl the *Necro*', 500, 'nonland'],
      ['Odd Card', 400, 'nonland'],
      ['Saga', 300, 'nonland'],
    ],
  };
  const markdown = renderReadyList({
    ranking,
    oracleSource: '`bank.json`',
    entries: [
      { rank: 1, name: 'Sol Ring', decks: 900, kind: 'nonland', readiness: { status: 'modeled' } },
      {
        rank: 2,
        name: 'Grizzly Bears',
        decks: 600,
        kind: 'nonland',
        readiness: { status: 'modeled' },
      },
      {
        rank: 3,
        name: 'Lim-Dûl the *Necro*',
        decks: 500,
        kind: 'nonland',
        readiness: { status: 'one-line', line: 'Pay `X`:\ndraw.' },
      },
      {
        rank: 4,
        name: 'Odd Card',
        decks: 400,
        kind: 'nonland',
        readiness: { status: 'one-line', line: 'Pay `X`:\ndraw.' },
      },
    ],
    otherCards: 1,
    otherDecks: 300,
  });

  it('counts each group and its share of all slots', () => {
    expect(markdown).toContain('- Modeled: 2 cards, 37.50% of all nonbasic slots');
    expect(markdown).toContain('- One line away: 2 cards, 22.50%');
    expect(markdown).toContain('- Neither: 1 cards, 7.50%');
    expect(markdown).toContain('- Ranked population: 5 cards, 67.50%');
  });

  it('lists each card by rank with its share of decks, escaping names and rules text', () => {
    expect(markdown).toContain('- 1. Sol Ring (90.00%)');
    expect(markdown).toContain('- 3. Lim-Dûl the \\*Necro\\* (50.00%): ``Pay `X`: draw.``');
    expect(markdown.indexOf('## One line away (2)')).toBeLessThan(
      markdown.indexOf('## Modeled (2)'),
    );
  });

  it('groups a line that blocks several cards', () => {
    expect(markdown).toContain('- 2 cards, 22.50% of slots: ``Pay `X`: draw.``');
  });
});

describe('frozen ranking', () => {
  const ranking = JSON.parse(
    readFileSync('packages/server/fixtures/edhrec-ranking.json', 'utf8'),
  ) as EdhrecRanking;

  it('is sorted, holds no basics, and stops at the first card that reaches its share', () => {
    const decks = ranking.cards.map((row) => row[1]);
    expect(decks).toEqual([...decks].sort((a, b) => b - a));
    expect(ranking.cards.some((row) => isBasicLandName(row[0]))).toBe(false);
    const kept = decks.reduce((sum, n) => sum + n, 0);
    expect(kept).toBeGreaterThanOrEqual(ranking.slotShare * ranking.totalSlots);
    expect(kept - decks.at(-1)!).toBeLessThan(ranking.slotShare * ranking.totalSlots);
  });

  it('is the source of the committed staple list', () => {
    const staples = readFileSync('packages/server/fixtures/edh-staples-200.txt', 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(staples).toEqual(topNonlandNames(ranking.cards, 200));
  });
});

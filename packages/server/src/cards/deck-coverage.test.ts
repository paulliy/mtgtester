/**
 * Guards the deck-coverage verdicts, the unblock ranking, the provisional lookup and the
 * EDHREC average-deck parsing. Asserts no figure from the committed report: that moves with
 * every card modeled.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import {
  committedHeadlines,
  measureDeckCoverage,
  NO_PROVISIONAL,
  provisionalFromQueue,
  renderDeckCoverageJson,
  renderDeckCoverageMarkdown,
  type QueueEntryView,
} from './deck-coverage';
import {
  averageDeckInputs,
  averageDeckNames,
  parseAverageDeckPage,
  pinAverageDeckOracle,
  renderAverageDecks,
  renderPinnedOracle,
  type AverageDecksFixture,
} from './edhrec-average-decks';
import { buildOracleIndexFromCards } from './oracle-index';

function card(name: string, oracleText = ''): OracleCard {
  return {
    oracleId: `oracle-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    scryfallId: `scry-${name}`,
    name,
    manaCost: '{1}',
    cmc: 1,
    colors: [],
    colorIdentity: [],
    typeLine: 'Creature — Test',
    supertypes: [],
    types: ['Creature'],
    subtypes: ['Test'],
    oracleText,
    power: '2',
    toughness: '2',
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: false,
  };
}

/** A line no grammar reads, so the card is unmodeled. */
const NONSENSE = 'Frobnicate the zorb thrice before breakfast.';
const bear = card('Test Bear');
const ox = card('Test Ox');
const glitch = card('Glitch', NONSENSE);
const quirk = card('Quirk', NONSENSE);
const oddity = card('Oddity', NONSENSE);

const isProvisional = (c: OracleCard) => c.oracleId === quirk.oracleId;

describe('measureDeckCoverage', () => {
  const decks = [
    { name: 'clean', cards: [bear, ox, bear] },
    { name: 'one provisional', cards: [bear, quirk] },
    { name: 'glitch only', cards: [ox, glitch] },
    { name: 'glitch and quirk', cards: [bear, glitch, quirk] },
    { name: 'three', cards: [glitch, quirk, oddity] },
  ];

  it('gives each deck its verdict', () => {
    const report = measureDeckCoverage(decks, isProvisional);
    expect(report.decks.map((deck) => [deck.name, deck.verdict])).toEqual([
      ['clean', 'exact'],
      ['one provisional', 'provisional'],
      ['glitch only', 'blocked'],
      ['glitch and quirk', 'blocked'],
      ['three', 'blocked'],
    ]);
    expect(report.decks[0]).toMatchObject({ uniqueCards: 2, modeled: 2 });
    expect(report.decks[3]).toMatchObject({
      modeled: 1,
      provisional: ['Quirk'],
      blocking: ['Glitch'],
    });
  });

  it('counts the provisional column cumulatively, and the within-N counts', () => {
    const { summary } = measureDeckCoverage(decks, isProvisional);
    expect(summary).toEqual({
      decks: 5,
      playableExactly: 1,
      playableWithProvisional: 2,
      atMostUnmodeled: { '1': 3, '2': 4, '5': 5 },
      atMostBlocking: { '1': 4, '2': 5, '5': 5 },
    });
  });

  it('turns the provisional column into the exact one without a lookup', () => {
    const { summary } = measureDeckCoverage(decks, NO_PROVISIONAL);
    expect(summary.playableWithProvisional).toBe(summary.playableExactly);
  });

  it('ranks cards by decks they alone would unblock, then by decks shared with one other', () => {
    const { unblock } = measureDeckCoverage(decks, isProvisional);
    expect(unblock).toEqual([
      { name: 'Quirk', onlyBlocker: 1, oneOfTwo: 1, decks: 3, provisional: true },
      { name: 'Glitch', onlyBlocker: 1, oneOfTwo: 1, decks: 3, provisional: false },
      { name: 'Oddity', onlyBlocker: 0, oneOfTwo: 0, decks: 1, provisional: false },
    ]);
  });

  it('counts an unresolved name as a blocker', () => {
    const report = measureDeckCoverage([{ name: 'odd', cards: [bear], unresolved: ['Mystery'] }]);
    expect(report.decks[0]).toMatchObject({
      verdict: 'blocked',
      uniqueCards: 2,
      modeled: 1,
      blocking: ['Mystery'],
    });
  });

  it('renders JSON that parses back and gives the headline', () => {
    const population = {
      name: 'test',
      source: 'unit',
      ...measureDeckCoverage(decks, isProvisional),
    };
    const text = renderDeckCoverageJson([population]);
    expect(JSON.parse(text)).toEqual({ populations: [population] });
    expect(committedHeadlines(text)).toEqual([
      'Deck coverage (test): 1/5 playable exactly, 2/5 with provisional cards, 4/5 within 2 unmodeled cards.',
    ]);
    expect(renderDeckCoverageMarkdown([population])).toContain('| Quirk *(p)* | 1 | 1 | 3 |');
  });
});

describe('provisionalFromQueue', () => {
  const entry = (overrides: Partial<QueueEntryView>): QueueEntryView => ({
    oracleId: quirk.oracleId,
    status: 'compiled-checked',
    patch: 'p.json',
    patchSha256: 'abc',
    review: null,
    ...overrides,
  });
  const hash = (path: string) => (path === 'p.json' ? 'abc' : null);

  it('accepts a compiled-checked entry whose patch is unchanged', () => {
    expect(provisionalFromQueue([entry({})], hash)(quirk)).toBe(true);
    expect(provisionalFromQueue([entry({})], hash)(glitch)).toBe(false);
  });

  it('leaves out a patch demoted by fuzz, but not another patch for the same card', () => {
    const demoted = new Set([`${quirk.oracleId}|abc`]);
    expect(provisionalFromQueue([entry({})], hash, demoted)(quirk)).toBe(false);
    const other = entry({ patch: 'q.json', patchSha256: 'def' });
    const hashBoth = (path: string) => ({ 'p.json': 'abc', 'q.json': 'def' })[path] ?? null;
    expect(provisionalFromQueue([entry({}), other], hashBoth, demoted)(quirk)).toBe(true);
  });

  it('rejects other statuses, rejected reviews, changed and missing patches', () => {
    for (const overrides of [
      { status: 'meaning-differs' },
      { review: { verdict: 'rejected' as const } },
      { patchSha256: 'changed' },
      { patch: 'missing.json' },
      { patch: null },
      { crossCheck: { verdict: 'differs' } },
    ])
      expect(provisionalFromQueue([entry(overrides)], hash)(quirk)).toBe(false);
  });
});

describe('EDHREC average decks', () => {
  const page = {
    deck: {
      commander: ['Test Bear'],
      cards: {
        Creature: [
          ['Test Ox', 1],
          ['Glitch', 1],
        ] as [string, number][],
        Land: [
          ['Forest', 4],
          ['Test Bear', 1],
        ] as [string, number][],
      },
    },
  };

  it('parses an average-deck page, dropping the commander from the 99', () => {
    expect(parseAverageDeckPage('test-bear', page)).toEqual({
      commanders: ['Test Bear'],
      cards: [
        ['Forest', 4],
        ['Glitch', 1],
        ['Test Ox', 1],
      ],
    });
    expect(() => parseAverageDeckPage('x', {})).toThrow(/no deck.commander/);
  });

  const fixture: AverageDecksFixture = {
    source: 'unit',
    fetchedAt: '2026-11-14',
    decks: [{ rank: 1, slug: 'test-bear', decks: 10, ...parseAverageDeckPage('test-bear', page) }],
  };

  it('round-trips the fixture and pins every resolvable card', () => {
    expect(JSON.parse(renderAverageDecks(fixture))).toEqual(fixture);
    expect(averageDeckNames(fixture)).toEqual(['Forest', 'Glitch', 'Test Bear', 'Test Ox']);
    const index = buildOracleIndexFromCards([bear, ox, glitch, quirk]);
    const pinned = pinAverageDeckOracle(fixture, index);
    expect(pinned.cards.map((c) => c.name)).toEqual(['Glitch', 'Test Bear', 'Test Ox']);
    expect(pinned.unresolved).toEqual(['Forest']);
    expect(JSON.parse(renderPinnedOracle(pinned))).toEqual(pinned);
  });

  it('keeps pin-time unresolved names as blockers and fails on a stale pin', () => {
    const index = buildOracleIndexFromCards([bear, ox, glitch]);
    const [deck] = averageDeckInputs(fixture, index, ['Forest']);
    expect(deck).toMatchObject({ name: 'Test Bear', unresolved: ['Forest'] });
    expect(deck!.cards.map((c) => c.name)).toEqual(['Test Bear', 'Glitch', 'Test Ox']);
    expect(() => averageDeckInputs(fixture, index, [])).toThrow(/deck-coverage --pin/);
  });
});

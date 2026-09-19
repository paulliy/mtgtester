/**
 * `runDeckPipeline`'s archetype precedence (brief §8.4, ADR 0022 §6).
 *
 * The rule this file exists to protect: **a tag the user typed is never overwritten.** §8.4 made
 * the field theirs, and inference is an addition to that contract rather than a replacement for
 * it — a classifier that "improves" a deliberate label is a bug, not a feature.
 */

import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { OracleIndex } from '../cards/oracle-index';
import type { BannedList } from './banned';
import { runDeckPipeline } from './pipeline';

function card(name: string, overrides: Partial<OracleCard> = {}): OracleCard {
  return {
    oracleId: `oracle-${name}`,
    scryfallId: `scry-${name}`,
    name,
    manaCost: '{1}{G}',
    cmc: 2,
    colors: ['G'],
    colorIdentity: ['G'],
    typeLine: 'Creature — Elf',
    supertypes: [],
    types: ['Creature'],
    subtypes: ['Elf'],
    oracleText: '',
    power: '2',
    toughness: '2',
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: false,
    ...overrides,
  };
}

const COMMANDER = card('Test General', {
  typeLine: 'Legendary Creature — Elf Druid',
  supertypes: ['Legendary'],
  subtypes: ['Elf', 'Druid'],
});

const FOREST = card('Forest', {
  typeLine: 'Basic Land — Forest',
  types: ['Land'],
  supertypes: ['Basic'],
  subtypes: ['Forest'],
  manaCost: null,
  cmc: 0,
  colors: [],
  power: null,
  toughness: null,
  isBasicLand: true,
});

/** 1 commander + 30 Elves + 69 Forests = a legal 100. */
function decklist(): string {
  return [
    'Commander',
    '1 Test General',
    '',
    'Deck',
    ...Array.from({ length: 30 }, (_, i) => `1 Elf ${i}`),
    '69 Forest',
  ].join('\n');
}

const index: OracleIndex = {
  size: 0,
  resolve: (name) => {
    if (name === 'Test General') return COMMANDER;
    if (name === 'Forest') return FOREST;
    const elf = /^Elf (\d+)$/.exec(name);
    return elf === null ? null : card(name);
  },
  getByOracleId: () => null,
};

const banned: BannedList = { isBanned: () => false, names: [] };

async function run(text: string) {
  return runDeckPipeline(text, { index, banned });
}

describe('runDeckPipeline — archetype precedence', () => {
  it('infers a tag when the user leaves the field blank', async () => {
    const result = await run(decklist());

    expect(result.status).toBe('valid');
    expect(result.archetypeSource).toBe('heuristic');
    // 30 of 31 creatures are Elves, so the tribe is the honest description.
    expect(result.archetypeTag).toBe('Mono-Green elf tribal midrange');
  });

  /**
   * A user-supplied tag cannot be exercised here: `importDeck` takes no metadata, so
   * `resolved.archetypeTag` is always null by the time the pipeline sees it. The user's tag
   * enters one layer up, in `match/setup.ts`, whose precedence expression is
   * `source.archetypeTag || result.archetypeTag || defaultTag(...)` — the inferred tag is the
   * middle term, so it can only ever fill a blank, never replace an entry.
   */
  it('marks an inferred tag as heuristic so a backfill can tell it from a typed one', async () => {
    const result = await run(decklist());

    // Only 'manual' is protected from `retag`; mislabelling inference as manual would freeze
    // every computed tag forever.
    expect(result.archetypeSource).not.toBe('manual');
    expect(result.archetypeSource).toBe('heuristic');
  });

  it('is deterministic across repeated imports of the same list', async () => {
    const [first, second] = await Promise.all([run(decklist()), run(decklist())]);

    expect(first.archetypeTag).toBe(second.archetypeTag);
  });

  it('reports a source even when the deck never resolves', async () => {
    // An unresolved deck has no list to classify; the field must still be a valid value rather
    // than undefined leaking into the insert.
    const result = await run('Commander\n1 Not A Real Card\n\nDeck\n99 Forest');

    expect(result.status).toBe('unresolved');
    expect(result.archetypeSource).toBe('default');
    expect(result.archetypeTag).toBeNull();
  });
});

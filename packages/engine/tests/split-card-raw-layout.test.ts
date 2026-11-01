import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { interpretCard } from '../src/cards/interpret';
import { toOracleCard, type RawScryfallCard } from '../../server/src/cards/scryfall';

/**
 * Wear // Tear's raw Scryfall bulk entry (the fields `toOracleCard` reads), committed so the test
 * runs without the gitignored bulk file (`data/README.md`).
 */
const RAW_FIXTURE = new URL('./fixtures/split-card-raw-scryfall.json', import.meta.url);

describe('raw split card layout', () => {
  it('interprets both halves and fuse', () => {
    const entries = JSON.parse(readFileSync(RAW_FIXTURE, 'utf8')) as RawScryfallCard[];
    const raw = entries.find((entry) => entry.name === 'Wear // Tear');
    expect(raw).toBeDefined();
    const card = toOracleCard(raw!);
    expect(card).not.toBeNull();
    const def = interpretCard(card!);
    expect(def.modeled).toBe(true);
    expect(def.alternativeCasts?.map((cast) => cast.name)).toEqual(
      expect.arrayContaining(['Wear', 'Tear']),
    );
    expect(def.alternativeCasts?.some((cast) => cast.fused)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { interpretCard } from '../src/cards/interpret';
import { toOracleCard, type RawScryfallCard } from '../../server/src/cards/scryfall';

describe('raw split card layout', () => {
  it('interprets both halves and fuse', () => {
    const entries = JSON.parse(
      readFileSync('data/scryfall-oracle-cards.json', 'utf8'),
    ) as RawScryfallCard[];
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

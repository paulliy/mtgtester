import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { buildSupportedPool } from './pool';

interface PinnedFixture {
  cards: { card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../engine/tests/fixtures/reviewed-five-oracle.json'),
    'utf8',
  ),
) as PinnedFixture;

describe('reviewed five-card supported-pool containment', () => {
  it('includes only faithfully repaired cards and excludes the remaining contained cards', () => {
    const pool = buildSupportedPool(fixture.cards.map(({ card }) => card));
    expect(pool.considered).toBe(5);
    expect(pool.cards.map(({ card }) => card.name).sort()).toEqual([
      'Gev, Scaled Scorch',
      'Harmonic Prodigy',
      'Nightscape Familiar',
      'Thran Vigil',
      'Tribute Mage',
    ]);
  });
});

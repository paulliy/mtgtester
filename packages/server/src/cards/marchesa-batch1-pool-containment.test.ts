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
    join(import.meta.dirname, '../../../engine/tests/fixtures/marchesa-batch1-oracle.json'),
    'utf8',
  ),
) as PinnedFixture;

describe('Marchesa catalog audit supported-pool containment', () => {
  // Fail-closed restorations plus the coverage PR01 cards (docs/plans/card-coverage-chunks.md).
  it('includes exactly the independently restored slices', () => {
    const pool = buildSupportedPool(fixture.cards.map(({ card }) => card));
    expect(pool.considered).toBe(198);
    expect(pool.cards.map(({ card }) => card.name)).toEqual([
      'Arcane Denial',
      'Attune with Aether',
      'Beacon of Unrest',
      'Canoptek Spyder',
      'Canoptek Wraith',
      "Conjurer's Closet",
      'Fabled Passage',
      'Forum of Amity',
      'Harvest Season',
      'Land Tax',
      'Mordant Dragon',
      'Myriad Landscape',
      'Necron Deathmark',
      'Plasmancer',
      'Smothering Tithe',
      'Sylvan Reclamation',
      'War Room',
    ]);
  });
});

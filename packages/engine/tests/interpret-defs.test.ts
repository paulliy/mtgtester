/**
 * The golden snapshot of `interpretCard`'s output over the committed 93-card Ur-Dragon fixture
 * (see `cards/interpret-snapshot.ts` for what this proves). The counterpart to
 * `override-defs.test.ts`, for the other half of the pipeline: it caught, on the first run after
 * migrating interpret.ts's ~14 hand-authored special cases onto the shared builders, that
 * `PREDEFINED_TOKENS.treasure` disagreed with the catalog `TREASURE` on its type line — a diff
 * against exactly the two cards in this fixture that create one (Sarkhan, Dragon Ascendant and
 * Old Gnawbone), nothing else moved.
 *
 * Regenerate deliberately after reading the diff, never to make this pass:
 *
 *   bun run scripts/snapshot-interpret-defs.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretSnapshot } from '../src/cards/interpret-snapshot';

const FIXTURE = fileURLToPath(new URL('./fixtures/urdragon-oracle.json', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('./fixtures/interpret-defs.json', import.meta.url));

describe('interpretCard output', () => {
  it('matches the committed snapshot for the Ur-Dragon fixture', () => {
    const cards = JSON.parse(readFileSync(FIXTURE, 'utf8')) as OracleCard[];
    const expected = readFileSync(SNAPSHOT, 'utf8');
    expect(interpretSnapshot(cards)).toBe(expected);
  });
});

/**
 * `interpretCard`'s own Treasure duplicate (`PREDEFINED_TOKENS.treasure`) disagreed with the
 * shared catalog: `typeLine: 'Token Artifact — Treasure'`, encoding-corrupted in source on top of
 * that, versus the catalog's correct `'Artifact — Treasure'`. This is a distinct bug from the
 * three divergent Treasures already fixed in the override files (see token-divergence.test.ts) —
 * this one lived in the generic parser, so it affected every card whose Oracle text says "create
 * a Treasure token" and gets read by the grammar rather than a hand-authored override.
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { TREASURE } from '../src/cards/tokens';
import { oracle } from './fixtures';

describe('generic "create a Treasure token" parsing', () => {
  it('produces the catalog Treasure spec, not a locally spelled one', () => {
    const def = interpretCard(
      oracle({
        name: 'Test Treasure Maker',
        typeLine: 'Creature — Test',
        oracleText: 'When this creature enters, create a Treasure token.',
      }),
    );
    expect(def.modeled).toBe(true);
    const createToken = def.triggers[0]?.effects.find((e) => e.op === 'createToken');
    expect(createToken).toBeDefined();
    expect((createToken as { spec: unknown }).spec).toEqual(TREASURE);
  });
});

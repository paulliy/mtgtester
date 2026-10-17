/** PR08's pin and containment gate; behavior tests accompany each restored card below. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';

interface Pin {
  sha256: string;
  card: OracleCard;
}
const pins = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as { cards: Pin[] }
).cards;
// Move a card into this set only with its complete behavioral tests and lab requirements.
const IMPLEMENTED = new Set<string>([]);
function canonical(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonical);
  if (input !== null && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return input;
}

describe('PR08 Oracle pins and containment', () => {
  it('pins exactly the 23 distinct cards assigned to PR08', () => {
    expect(pins).toHaveLength(23);
    expect(new Set(pins.map((pin) => pin.card.oracleId)).size).toBe(23);
  });
  it.each(pins.map((pin) => [pin.card.name, pin] as const))(
    '%s retains its Oracle pin and explicit implementation status',
    (name, pin) => {
      expect(
        createHash('sha256')
          .update(JSON.stringify(canonical(pin.card)))
          .digest('hex'),
      ).toBe(pin.sha256);
      for (const card of [pin.card, { ...pin.card, oracleId: fixtureOracleId(name) }]) {
        const def = interpretCard(card);
        expect(def.modeled, card.oracleId).toBe(IMPLEMENTED.has(name));
        if (IMPLEMENTED.has(name)) expect(def.unmodeledReasons).toEqual([]);
        else expect(def.unmodeledReasons.length).toBeGreaterThan(0);
      }
    },
  );
});

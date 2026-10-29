/**
 * Plan phase 2 exit: `card:new` reproduces a batch's handledLines. For every PR11b override, the
 * lines card:new would print for the card (each unmodeled reason's `handledLineOf`) are swapped
 * into the registration, and the card must interpret exactly as it does with the authored lines.
 * PR11b wrote whole reasons where card:new prints the quoted Oracle line; applyOverride accepts
 * either for the same reason, so the definitions agree.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import {
  getOverride,
  handledLineOf,
  registerOverride,
  unregisterOverride,
} from '../src/cards/overrides/index';

const source = readFileSync(
  new URL('../src/cards/overrides/coverage-pr11b.ts', import.meta.url),
  'utf8',
);
const ids = [
  ...new Set(
    [...source.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g)].map(
      (match) => match[1]!,
    ),
  ),
];
const fixture = (
  JSON.parse(
    readFileSync(new URL('./fixtures/coverage-pr11-oracle.json', import.meta.url), 'utf8'),
  ) as { cards: Array<{ card: OracleCard }> }
).cards.map((entry) => entry.card);

describe("card:new's handledLines for PR11b", () => {
  it('covers the PR11b registrations', () => {
    expect(ids.length).toBeGreaterThanOrEqual(11);
  });

  it.each(ids)('%s interprets the same with the lines card:new prints', (id) => {
    const card = fixture.find((candidate) => candidate.oracleId === id)!;
    const authored = getOverride(id as OracleCard['oracleId'])!;
    expect(card).toBeDefined();
    const withAuthored = interpretCard(card);
    unregisterOverride(card.oracleId);
    try {
      const printed = interpretCard(card).unmodeledReasons.map(handledLineOf);
      registerOverride({ ...authored, handledLines: printed });
      const withPrinted = interpretCard(card);
      expect(withPrinted.modeled).toBe(withAuthored.modeled);
      expect(withPrinted.unmodeledReasons).toEqual(withAuthored.unmodeledReasons);
      expect(JSON.stringify(withPrinted)).toBe(JSON.stringify(withAuthored));
    } finally {
      unregisterOverride(card.oracleId);
      registerOverride(authored);
    }
  });
});

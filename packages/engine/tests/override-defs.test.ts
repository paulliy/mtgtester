/**
 * The override registry's golden snapshot.
 *
 * Card behavior is authored data, and nothing else in the suite compares that data's *content*:
 * `urdragon-coverage.test.ts` pins which card NAMES are modeled, and `determinism.test.ts`
 * compares a game against a re-run of itself. Both stay green through a refactor that silently
 * rewrites a definition's body — which is exactly the risk when moving ~900 registrations onto a
 * shared builder layer.
 *
 * So this pins the bodies. It is a deliberate tripwire, not a correctness claim: the fixture
 * records what the registry currently says, so a diff here means "authored card data changed",
 * and the only right response is to confirm the change was intended and regenerate:
 *
 *   bun run scripts/snapshot-override-defs.ts
 *
 * Never regenerate to make this pass without reading the diff — a card quietly losing an ability
 * looks identical to a card intentionally gaining one.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { overrideSnapshot } from '../src/cards/overrides/snapshot';
import { listOverrides } from '../src/cards/overrides';

const FIXTURE = new URL('./fixtures/override-defs.json', import.meta.url);

describe('authored override data', () => {
  it('matches the committed snapshot', () => {
    const expected = readFileSync(FIXTURE, 'utf8');
    expect(overrideSnapshot()).toBe(expected);
  });

  it('registers every card under both its real and its fixture oracle id', () => {
    // `defineCard` does both. A card registered under one id only is how behavior ends up
    // reachable in a real game but missing from any test that builds the card by name.
    const byId = new Map(listOverrides().map((o) => [o.oracleId, o]));
    const missing: string[] = [];
    for (const override of byId.values()) {
      if (override.oracleId.startsWith('oracle-')) continue;
      const slug = `oracle-${override.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}`;
      if (!byId.has(slug)) missing.push(`${override.name} (${override.oracleId})`);
    }
    expect(missing).toEqual([]);
  });

  it('has no override whose real id carries behavior its fixture id lacks', () => {
    // The divergence this caught: a card with a real `def` under its Scryfall id and an empty
    // patch under its slug, so the same card behaved differently depending on how it was loaded.
    const byId = new Map(listOverrides().map((o) => [o.oracleId, o]));
    const diverged: string[] = [];
    for (const override of byId.values()) {
      if (override.oracleId.startsWith('oracle-')) continue;
      const slug = `oracle-${override.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}`;
      const twin = byId.get(slug);
      if (twin === undefined) continue;
      const a = Object.keys(override.def).length > 0;
      const b = Object.keys(twin.def).length > 0;
      if (a !== b) diverged.push(override.name);
    }
    expect(diverged).toEqual([]);
  });
});

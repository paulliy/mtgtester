/** PR08 lab containment. Each implemented card adds normal-engine-path outcome tests here. */
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '@mtg/engine';
import { describe, expect, it } from 'vitest';
import { listCardTestScenarios } from './card-test-scenarios';

const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { sha256: string; card: OracleCard }[];
  }
).cards;

describe('PR08 lab containment', () => {
  it('does not publish viewer scenarios for unsupported PR08 cards', () => {
    const unsupported = new Set(
      pins.filter((pin) => !interpretCard(pin.card).modeled).map((pin) => pin.sha256),
    );
    const catalog = listCardTestScenarios();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.filter((scenario) => unsupported.has(scenario.oracleSha256))).toEqual([]);
  });
});

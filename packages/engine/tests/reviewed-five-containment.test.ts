import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

interface ScenarioSpecification {
  schemaVersion: number;
  status: 'specification-only';
  note: string;
  cards: { oracleId: string; name: string; scenarios: string[] }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/reviewed-five-oracle.json'), 'utf8'),
) as PinnedFixture;
const scenarioSpecification = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/reviewed-five-scenarios.json'), 'utf8'),
) as ScenarioSpecification;

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

describe('reviewed five-card Oracle fixture and containment', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'Scryfall oracle-cards bulk data',
      retrievedAt: '2026-09-08',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Tribute Mage',
      'Gev, Scaled Scorch',
      'Nightscape Familiar',
      'Thran Vigil',
      'Harmonic Prodigy',
    ]);
    for (const entry of fixture.cards) {
      expect(entry.card.oracleId).not.toMatch(/^oracle-/);
      expect(entry.card.oracleText.length, entry.card.name).toBeGreaterThan(20);
      expect(
        createHash('sha256').update(canonical(entry.card)).digest('hex'),
        entry.card.name,
      ).toBe(entry.sha256);
    }
  });

  it('keeps every reviewed repair executable under its real and fixture IDs', () => {
    for (const { card } of fixture.cards) {
      const name = card.name;
      const aliasId = fixtureOracleId(name);
      const realOverride = getOverride(card.oracleId);
      const aliasOverride = getOverride(aliasId);
      expect(realOverride?.unsupportedReason, name).toBeUndefined();
      expect(aliasOverride?.unsupportedReason, name).toBeUndefined();

      for (const candidate of [card, { ...card, oracleId: aliasId }]) {
        const interpreted = interpretCard(candidate);
        expect(interpreted.modeled, `${name} (${candidate.oracleId})`).toBe(true);
        expect(interpreted.unmodeledReasons, `${name} (${candidate.oracleId})`).toEqual([]);
      }
    }
  });

  it('does not preserve the known executable placeholder or substitute ward claims', () => {
    const nightscape = getOverride('57296ea3-3c0d-49b7-bc08-0d0d8414e9ad');
    const gev = getOverride('77b832a8-a3af-44fe-bc67-72510d292667');
    expect(JSON.stringify(nightscape?.def)).not.toContain('"op":"noOp"');
    expect(gev?.def.ward).toEqual({ kind: 'life', amount: 2 });
  });

  it('keeps future regression scenarios explicitly non-evidentiary until repairs land', () => {
    expect(scenarioSpecification).toMatchObject({
      schemaVersion: 1,
      status: 'specification-only',
    });
    expect(scenarioSpecification.note).toContain('not passing verification');
    expect(scenarioSpecification.cards.map(({ oracleId }) => oracleId)).toEqual(
      fixture.cards.map(({ card }) => card.oracleId),
    );
    for (const card of scenarioSpecification.cards) {
      expect(card.scenarios.length, card.name).toBeGreaterThanOrEqual(5);
      expect(new Set(card.scenarios).size, card.name).toBe(card.scenarios.length);
    }
  });
});

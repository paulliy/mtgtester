import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { assertFixtureCompatibility, loadSuite } from './cases';
import { benchmarkSourceHashes } from './manifest';

describe('committed benchmark fixtures', () => {
  it('pass runtime contracts and immutable content hashes', () => {
    const loaded = loadSuite(resolve(process.cwd(), 'benchmarks/suites/core-fast.json'));
    expect(loaded.cases.map((item) => item.role).sort()).toEqual(['strategist', 'tactician']);
    expect(() =>
      assertFixtureCompatibility(loaded.cases, benchmarkSourceHashes(process.cwd())),
    ).not.toThrow();
  });

  it('fails closed when a fixture declares different engine or card semantics', () => {
    const loaded = loadSuite(resolve(process.cwd(), 'benchmarks/suites/core-fast.json'));
    const first = loaded.cases[0]!;
    const expected = {
      engine: first.supportedEngineVersion,
      cardDefinitions: first.supportedCardDefinitionHash,
    };
    expect(() => assertFixtureCompatibility(loaded.cases, expected)).not.toThrow();
    expect(() =>
      assertFixtureCompatibility(loaded.cases, { ...expected, engine: 'different-engine' }),
    ).toThrow('engine compatibility mismatch');
    expect(() =>
      assertFixtureCompatibility(loaded.cases, {
        ...expected,
        cardDefinitions: 'different-cards',
      }),
    ).toThrow('card-definition compatibility mismatch');
  });
});

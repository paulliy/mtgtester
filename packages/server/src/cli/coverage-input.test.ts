import { describe, expect, it } from 'vitest';
import { coverageInput } from './coverage-input';
import { checkCoverageBaseline } from '../cards/coverage-baseline';
import { measureCoverage } from '../cards/coverage';

const pinned = 'packages/server/fixtures/coverage-oracle.json';
describe('reproducible coverage Oracle input', () => {
  it('preserves other flags and reads the complete pinned population without a bulk dependency', () => {
    const result = coverageInput(['--json', '--oracle-fixture', pinned, '--complete']);
    expect(result.args).toEqual(['--json', '--complete']);
    expect(result.index.size).toBe(1031);
    const signet = result.index.resolve('Arcane Signet')!;
    const report = measureCoverage([{ name: 'input probe', cards: [signet] }]);
    // Baseline population is checked separately by each CLI; the input must retain the exact pin.
    expect(signet.scryfallId).toBe('1cad1bd2-7c56-4ce0-99a6-b2a49c1288dd');
    expect(report.cards[0]?.oracleId).toBe('0bc7f093-bef0-4f1a-852c-4b75ebf54838');
    expect(() => checkCoverageBaseline(report, result.index, 'staples')).toThrow();
  });
  it('defaults to the pinned fixture so the gate cannot drift with the local Scryfall download', () => {
    const result = coverageInput(['--json']);
    expect(result.path).toBe(pinned);
    expect(result.args).toEqual(['--json']);
    expect(result.index.size).toBe(1031);
  });
  it('rejects combining the bulk download with a fixture', () => {
    expect(() => coverageInput(['--bulk', '--oracle-fixture', pinned])).toThrow(
      'mutually exclusive',
    );
  });
  it.each([
    { args: ['--oracle-fixture'] },
    { args: ['--oracle-fixture', '--json'] },
    { args: ['--oracle-fixture', pinned, '--oracle-fixture', pinned] },
  ])('rejects incomplete or conflicting fixture selections (%j)', ({ args }) => {
    expect(() => coverageInput(args)).toThrow(/--oracle-fixture/);
  });
  it('rejects a JSON object instead of weakening the inventory to an empty population', () => {
    expect(() =>
      coverageInput(['--oracle-fixture', 'packages/server/fixtures/coverage-contract.json']),
    ).toThrow('array of complete Oracle card projections');
  });
});

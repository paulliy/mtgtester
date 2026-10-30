import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import {
  populationProblems,
  populationSmoke,
} from '../../../../scripts/contracts/population-smoke';

const coverage = JSON.parse(
  readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
) as OracleCard[];

describe('population smoke (ADR 0034 decision 9)', () => {
  it('interprets every card of the coverage fixture and validates each modeled one', () => {
    const smoke = populationSmoke(coverage);
    expect(smoke.cards).toBe(coverage.length);
    expect(smoke.threw).toEqual([]);
    expect(smoke.invalid).toEqual([]);
    expect(smoke.modeled).toBeGreaterThan(coverage.length / 2);
    expect(populationProblems(smoke, { modeled: smoke.modeled })).toEqual([]);
  });

  it('fails a throw, invalid IR, and fewer modeled cards than the baseline', () => {
    const smoke = {
      cards: 3,
      modeled: 1,
      threw: [{ name: 'Thrower', message: 'boom' }],
      invalid: [{ name: 'Invalid', issues: ['triggers[0]: no effect'] }],
    };
    expect(populationProblems(smoke, { modeled: 2 })).toEqual([
      'Thrower: interpretation threw: boom',
      'Invalid: invalid modeled IR: triggers[0]: no effect',
      'modeled cards fell from 2 to 1',
    ]);
    expect(populationProblems({ ...smoke, threw: [], invalid: [] }, { modeled: 1 })).toEqual([]);
    expect(populationProblems({ ...smoke, threw: [], invalid: [] }, undefined)).toEqual([]);
  });
});

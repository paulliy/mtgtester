import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CoverageReport } from './coverage';
import type { OracleIndex } from './oracle-index';
import {
  assertCoveragePopulation,
  canonicalOracle,
  type CoveragePopulation,
} from './coverage-contract';
interface Baseline {
  fixtures: CoveragePopulation;
  staples: CoveragePopulation;
  oracle: { oracleId: string; name: string; sha256: string }[];
}
export function checkCoverageBaseline(
  report: CoverageReport,
  index: OracleIndex,
  population: 'fixtures' | 'staples',
): void {
  const baseline = JSON.parse(
    readFileSync(resolve('packages/server/fixtures/coverage-contract.json'), 'utf8'),
  ) as Baseline;
  assertCoveragePopulation(report, baseline[population]);
  const measured = new Set(report.cards.map((card) => card.oracleId));
  for (const expected of baseline.oracle) {
    if (!measured.has(expected.oracleId)) continue;
    const card = index.getByOracleId(expected.oracleId);
    if (
      card === null ||
      createHash('sha256').update(canonicalOracle(card)).digest('hex') !== expected.sha256
    ) {
      throw new Error(
        `coverage Oracle input changed: ${expected.name}; review and explicitly revise the baseline`,
      );
    }
  }
}

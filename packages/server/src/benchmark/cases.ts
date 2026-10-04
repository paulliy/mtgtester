import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseBenchmarkCase, type BenchmarkCase, type BenchmarkSuite } from './contracts';
import { sha256 } from './hash';
import { confinedBenchmarkPath } from './paths';

export interface FixtureCompatibility {
  engine: string;
  cardDefinitions: string;
}

export function caseContent(caseValue: BenchmarkCase): Omit<BenchmarkCase, 'contentHash'> {
  const { contentHash: _hash, ...content } = caseValue;
  return content;
}

export function validateCaseHash(caseValue: BenchmarkCase): void {
  const actual = sha256(caseContent(caseValue));
  if (caseValue.contentHash !== actual) {
    throw new Error(
      `case ${caseValue.caseId} hash mismatch: expected ${caseValue.contentHash}, got ${actual}`,
    );
  }
}

export function loadCase(path: string): BenchmarkCase {
  const parsed = parseBenchmarkCase(JSON.parse(readFileSync(path, 'utf8')));
  validateCaseHash(parsed);
  return parsed;
}

export function loadSuite(path: string): { suite: BenchmarkSuite; cases: BenchmarkCase[] } {
  const repositoryRoot = dirname(dirname(dirname(resolve(path))));
  confinedBenchmarkPath(repositoryRoot, path, 'suites');
  const suite = JSON.parse(readFileSync(path, 'utf8')) as BenchmarkSuite;
  if (suite.schemaVersion !== 1 || !Array.isArray(suite.caseFiles)) {
    throw new Error(`invalid benchmark suite ${path}`);
  }
  const root = dirname(path);
  if (!suite.caseFiles.every((file) => typeof file === 'string'))
    throw new Error(`invalid benchmark suite ${path}`);
  return {
    suite,
    cases: suite.caseFiles.map((file) =>
      loadCase(
        confinedBenchmarkPath(repositoryRoot, file, 'benchmarks', {
          origin: root,
          relativeOnly: true,
        }),
      ),
    ),
  };
}

/** Refuse to score a snapshot against engine/card semantics other than those it declares. */
export function assertFixtureCompatibility(
  cases: readonly BenchmarkCase[],
  expected: FixtureCompatibility,
): void {
  for (const caseValue of cases) {
    if (caseValue.supportedEngineVersion !== expected.engine) {
      throw new Error(
        `case ${caseValue.caseId} engine compatibility mismatch: ` +
          `${caseValue.supportedEngineVersion} != ${expected.engine}`,
      );
    }
    if (caseValue.supportedCardDefinitionHash !== expected.cardDefinitions) {
      throw new Error(
        `case ${caseValue.caseId} card-definition compatibility mismatch: ` +
          `${caseValue.supportedCardDefinitionHash} != ${expected.cardDefinitions}`,
      );
    }
  }
}

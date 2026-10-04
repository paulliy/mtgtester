import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseBenchmarkCase, type BenchmarkCase } from './contracts';
import { caseContent } from './cases';
import { sha256 } from './hash';
import { benchmarkSourceHashes } from './manifest';

export interface CaptureOptions {
  /** Repository whose engine sources define the semantics this snapshot is scoreable against. */
  repositoryRoot: string;
}

/** Validate and seal a captured snapshot without allowing its annotation to alter model input. */
export function captureCase(
  value: unknown,
  outputPath: string,
  options: CaptureOptions,
): BenchmarkCase {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('capture input must be a benchmark case object');
  }
  const source = value as Record<string, unknown>;
  const compatibility = benchmarkSourceHashes(options.repositoryRoot);
  const withPlaceholder = {
    ...source,
    // A snapshot is only scoreable against the engine and card semantics it was taken from, so
    // both pins are derived from the tree being captured. A pin carried on the input is ignored:
    // capture inputs are routinely copied from older cases, and honouring their pin would seal a
    // snapshot against semantics it was never taken from. Re-pinning an existing fixture is a
    // separate, explicit operation — see `refreshCaseCompatibility`.
    supportedEngineVersion: compatibility.engine,
    supportedCardDefinitionHash: compatibility.cardDefinitions,
    contentHash: 'pending',
  };
  const parsed = parseBenchmarkCase(withPlaceholder);
  const sealed = { ...parsed, contentHash: sha256(caseContent(parsed)) } as BenchmarkCase;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(sealed, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return sealed;
}

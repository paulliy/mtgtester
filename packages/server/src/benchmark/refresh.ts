import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { caseContent, validateCaseHash } from './cases';
import { parseBenchmarkCase } from './contracts';
import { sha256 } from './hash';
import { benchmarkSourceHashes } from './manifest';
import { confinedBenchmarkPath } from './paths';

export type RefreshField = 'supportedEngineVersion' | 'supportedCardDefinitionHash' | 'contentHash';

export interface CompatibilityChange {
  field: RefreshField;
  from: string;
  to: string;
}

export interface CaseRefresh {
  path: string;
  caseId: string;
  changes: CompatibilityChange[];
}

export interface RefreshReport {
  write: boolean;
  cases: CaseRefresh[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite one scalar in place rather than re-serializing the document. Re-serializing would
 * reformat the whole fixture and bury the three-line repin in unrelated churn; an anchored
 * single-occurrence substitution keeps the committed Prettier formatting byte-for-byte.
 */
function replaceScalar(text: string, field: RefreshField, from: string, to: string): string {
  const pattern = new RegExp(`("${field}"\\s*:\\s*")${escapeRegExp(from)}(")`, 'g');
  const matches = text.match(pattern);
  if (matches?.length !== 1) {
    throw new Error(
      `expected exactly one ${field} entry to rewrite, found ${matches?.length ?? 0}`,
    );
  }
  return text.replace(pattern, `$1${to}$2`);
}

/**
 * Re-pin existing snapshots to the current engine and card-definition semantics and reseal their
 * content hash. Snapshot *content* stays immutable: only the compatibility pins and the digest
 * that covers them move, so this can never launder a semantic edit into a fixture.
 *
 * Dry run is the default; nothing is written unless `write` is explicitly true.
 */
export function refreshCaseCompatibility(input: {
  repositoryRoot: string;
  casePaths: readonly string[];
  write?: boolean;
  /** Fault injection for filesystem contract tests. */
  rename?: (from: string, to: string) => void;
}): RefreshReport {
  const write = input.write === true;
  const compatibility = benchmarkSourceHashes(input.repositoryRoot);
  const cases: CaseRefresh[] = [];
  const pending: Array<{ path: string; updated: string }> = [];

  for (const candidatePath of input.casePaths) {
    const path = confinedBenchmarkPath(input.repositoryRoot, candidatePath, 'benchmarks');
    const text = readFileSync(path, 'utf8');
    let original;
    try {
      original = parseBenchmarkCase(JSON.parse(text));
      validateCaseHash(original);
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const repinned = parseBenchmarkCase({
      ...original,
      supportedEngineVersion: compatibility.engine,
      supportedCardDefinitionHash: compatibility.cardDefinitions,
    });
    const contentHash = sha256(caseContent(repinned));

    const candidates: CompatibilityChange[] = [
      {
        field: 'supportedEngineVersion',
        from: original.supportedEngineVersion,
        to: compatibility.engine,
      },
      {
        field: 'supportedCardDefinitionHash',
        from: original.supportedCardDefinitionHash,
        to: compatibility.cardDefinitions,
      },
      { field: 'contentHash', from: original.contentHash, to: contentHash },
    ];
    const changes = candidates.filter((change) => change.from !== change.to);

    if (changes.length > 0) {
      let updated = text;
      for (const change of changes) {
        updated = replaceScalar(updated, change.field, change.from, change.to);
      }
      pending.push({ path, updated });
    }
    cases.push({ path, caseId: original.caseId, changes });
  }

  if (write) {
    const updatedPaths: string[] = [];
    for (const item of pending) {
      const temp = join(dirname(item.path), `.${basename(item.path)}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, item.updated, { encoding: 'utf8', flag: 'wx' });
        (input.rename ?? renameSync)(temp, item.path);
        updatedPaths.push(item.path);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          /* rename may already have consumed the temp */
        }
        throw new Error(
          `refresh failed at ${item.path}; already updated: ${updatedPaths.length ? updatedPaths.join(', ') : '(none)'}; ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return { write, cases };
}

/** One line per moved field, so a review can see exactly what a `--write` would reseal. */
export function formatRefreshReport(report: RefreshReport): string {
  const lines: string[] = [
    report.write ? 'refresh: wrote changes' : 'refresh: dry run (no writes)',
  ];
  for (const entry of report.cases) {
    lines.push(`${entry.caseId} (${entry.path})`);
    if (entry.changes.length === 0) lines.push('  already current');
    for (const change of entry.changes)
      lines.push(`  ${change.field}: ${change.from} -> ${change.to}`);
  }
  if (!report.write && report.cases.some((entry) => entry.changes.length > 0)) {
    lines.push('re-run with --write to apply');
  }
  return lines.join('\n');
}

import { existsSync } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'blocked' | 'not-run';

export interface CheckResult {
  id: string;
  label: string;
  kind: 'vitest' | 'bounded-engine' | 'inventory';
  status: CheckStatus;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  detail: string;
}

export interface VitestJsonReport {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
}

export class RequiredInputError extends Error {
  override readonly name = 'RequiredInputError';
}

type Spawn = (
  command: string,
  args: readonly string[],
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

export function classifyVitestReport(
  id: string,
  label: string,
  report: VitestJsonReport,
): CheckResult {
  const skipped = report.numPendingTests + report.numTodoTests;
  const base = {
    id,
    label,
    kind: 'vitest' as const,
    executed: report.numPassedTests + report.numFailedTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped,
  };
  if (report.numTotalTests === 0 || base.executed === 0) {
    return { ...base, status: 'failed', detail: 'zero required tests executed' };
  }
  if (!report.success || report.numFailedTests > 0) {
    return {
      ...base,
      status: 'failed',
      detail: `${report.numFailedTests} of ${report.numTotalTests} tests failed`,
    };
  }
  if (skipped > 0) {
    return {
      ...base,
      status: 'skipped',
      detail: `${skipped} required tests skipped or todo`,
    };
  }
  return {
    ...base,
    status: 'passed',
    detail: `${report.numPassedTests} required tests passed`,
  };
}

function parseVitestJson(stdout: string): VitestJsonReport | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i] as string) as Partial<VitestJsonReport>;
      if (
        typeof parsed.success === 'boolean' &&
        typeof parsed.numTotalTests === 'number' &&
        typeof parsed.numPassedTests === 'number' &&
        typeof parsed.numFailedTests === 'number' &&
        typeof parsed.numPendingTests === 'number' &&
        typeof parsed.numTodoTests === 'number'
      ) {
        return parsed as VitestJsonReport;
      }
    } catch {
      // Vitest or Bun may print non-JSON status lines around the reporter payload.
    }
  }
  return null;
}

export function runVitestCheck(
  id: string,
  label: string,
  file: string,
  dependencies: {
    exists?: (path: string) => boolean;
    spawn?: Spawn;
  } = {},
): CheckResult {
  const fileExists = dependencies.exists ?? existsSync;
  if (!fileExists(file)) {
    return {
      id,
      label,
      kind: 'vitest',
      status: 'blocked',
      executed: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      detail: `required test file is missing: ${file}`,
    };
  }

  const spawn =
    dependencies.spawn ??
    ((command, args) =>
      spawnSync(command, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
  const result = spawn(process.execPath, ['run', 'test', '--', '--reporter=json', file]);
  const report = parseVitestJson(result.stdout ?? '');
  if (report !== null) return classifyVitestReport(id, label, report);

  return {
    id,
    label,
    kind: 'vitest',
    status: result.error === undefined ? 'failed' : 'blocked',
    executed: 0,
    passed: 0,
    failed: result.status === 0 ? 0 : 1,
    skipped: 0,
    detail:
      result.error?.message ??
      result.stderr?.trim() ??
      `Vitest exited ${String(result.status)} without a JSON report`,
  };
}

export function captureRequiredCheck(
  id: string,
  label: string,
  kind: CheckResult['kind'],
  run: () => CheckResult,
): CheckResult {
  try {
    return run();
  } catch (error) {
    return {
      id,
      label,
      kind,
      status: error instanceof RequiredInputError ? 'blocked' : 'failed',
      executed: 0,
      passed: 0,
      failed: error instanceof RequiredInputError ? 0 : 1,
      skipped: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function requiredChecksPassed(results: readonly CheckResult[]): boolean {
  return results.length > 0 && results.every((result) => result.status === 'passed');
}

export function requiredCheckExitCode(results: readonly CheckResult[]): 0 | 1 {
  return requiredChecksPassed(results) ? 0 : 1;
}

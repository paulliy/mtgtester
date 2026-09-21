import { describe, expect, it, vi } from 'vitest';
import {
  captureRequiredCheck,
  classifyVitestReport,
  RequiredInputError,
  requiredCheckExitCode,
  requiredChecksPassed,
  runVitestCheck,
  type CheckResult,
  type VitestJsonReport,
} from './card-test-reporting';

const report = (patch: Partial<VitestJsonReport> = {}): VitestJsonReport => ({
  success: true,
  numTotalTests: 2,
  numPassedTests: 2,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  ...patch,
});

describe('truthful card-check reporting', () => {
  it('cannot classify a deliberate Vitest failure as passing', () => {
    const result = classifyVitestReport(
      'broken',
      'deliberately broken suite',
      report({
        success: false,
        numPassedTests: 1,
        numFailedTests: 1,
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.executed).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('blocks a missing required test file without invoking Vitest', () => {
    const spawn = vi.fn();
    const result = runVitestCheck('missing', 'missing suite', 'missing.test.ts', {
      exists: () => false,
      spawn,
    });
    expect(result.status).toBe('blocked');
    expect(result.executed).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails reports with zero executed required tests', () => {
    const result = classifyVitestReport(
      'empty',
      'empty suite',
      report({ numTotalTests: 0, numPassedTests: 0 }),
    );
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('zero');
  });

  it('does not hide skipped or todo required tests inside a passing report', () => {
    const result = classifyVitestReport(
      'skipped',
      'skipped suite',
      report({
        numTotalTests: 3,
        numPendingTests: 1,
      }),
    );
    expect(result.status).toBe('skipped');
    expect(requiredChecksPassed([result])).toBe(false);
  });

  it('reports missing required inputs as blocked and unexpected failures as failed', () => {
    const blocked = captureRequiredCheck('input', 'input check', 'bounded-engine', () => {
      throw new RequiredInputError('fixture missing');
    });
    const failed = captureRequiredCheck('runtime', 'runtime check', 'bounded-engine', () => {
      throw new Error('engine crashed');
    });
    expect(blocked).toMatchObject({ status: 'blocked', executed: 0 });
    expect(failed).toMatchObject({ status: 'failed', failed: 1 });
  });

  it('requires a nonempty list in which every check passed', () => {
    const passed: CheckResult = {
      id: 'ok',
      label: 'ok',
      kind: 'vitest',
      status: 'passed',
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      detail: '1 required test passed',
    };
    expect(requiredChecksPassed([])).toBe(false);
    expect(requiredChecksPassed([passed])).toBe(true);
    expect(requiredChecksPassed([{ ...passed, status: 'not-run' }])).toBe(false);
    expect(requiredCheckExitCode([passed])).toBe(0);
    expect(requiredCheckExitCode([{ ...passed, status: 'failed' }])).toBe(1);
  });
});

import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateViewerTraceZip } from './card-evidence-input';

export interface Pr08ScenarioRequirement {
  id: string;
  title: string;
  oracleSha256: string;
  clauseIds: readonly string[];
}
type Row = Record<string, unknown>;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PR08 evidence: ${message}`);
}
function object(value: unknown): Row {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'malformed object',
  );
  return value as Row;
}
function array(value: unknown): unknown[] {
  requireValue(Array.isArray(value), 'malformed array');
  return value;
}
function noErrors(row: Row) {
  requireValue(
    row['error'] === undefined &&
      (row['errors'] === undefined || array(row['errors']).length === 0),
    'execution errors',
  );
}
export const evidenceSha256 = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

export function validatePr08EngineReport(input: unknown, requiredIds: readonly string[]) {
  const report = object(input);
  requireValue(
    report['success'] === true &&
      report['numFailedTests'] === 0 &&
      report['numPendingTests'] === 0 &&
      report['numTodoTests'] === 0,
    'engine tests failed or skipped',
  );
  requireValue(
    typeof report['numPassedTests'] === 'number' &&
      report['numPassedTests'] > 0 &&
      report['numPassedTests'] === report['numTotalTests'],
    'engine execution count',
  );
  const names: string[] = [];
  for (const value of array(report['testResults'])) {
    const module = object(value);
    requireValue(module['status'] === 'passed', 'engine module failed');
    for (const value of array(module['assertionResults'])) {
      const test = object(value);
      requireValue(
        test['status'] === 'passed' && typeof test['fullName'] === 'string',
        'engine assertion failed or skipped',
      );
      requireValue(array(test['failureMessages']).length === 0, 'engine assertion errors');
      names.push(test['fullName']);
    }
  }
  requireValue(
    names.length === report['numPassedTests'],
    'engine assertion count differs from summary',
  );
  for (const id of new Set(requiredIds))
    requireValue(
      names.some((name) => name.includes(`${id} —`)),
      `engine clause case missing: ${id}`,
    );
  return { passed: report['numPassedTests'], requiredIds: [...new Set(requiredIds)].sort() };
}

/** Require exactly one first-attempt real browser execution and retained trace per scenario. */
export async function validatePr08ViewerReport(
  input: unknown,
  requirements: readonly Pr08ScenarioRequirement[],
  allowedFiles: readonly string[],
  reportPath: string,
  outputRoot: string,
) {
  requireValue(
    new Set(requirements.map((entry) => entry.id)).size === requirements.length,
    'duplicate scenario requirement',
  );
  const report = object(input);
  noErrors(report);
  const stats = object(report['stats']);
  requireValue(
    stats['expected'] === requirements.length &&
      stats['unexpected'] === 0 &&
      stats['flaky'] === 0 &&
      stats['skipped'] === 0,
    'viewer tests failed, skipped, retried or missing',
  );
  const root = realpathSync(outputRoot);
  const traces: Record<string, { path: string; sha256: string }> = {};
  const specs: Row[] = [];
  function walk(values: unknown[]) {
    for (const value of values) {
      const suite = object(value);
      noErrors(suite);
      for (const spec of array(suite['specs'] ?? [])) specs.push(object(spec));
      walk(array(suite['suites'] ?? []));
    }
  }
  walk(array(report['suites']));
  requireValue(specs.length === requirements.length, 'viewer spec count');
  let project: string | undefined;
  for (const spec of specs) {
    noErrors(spec);
    requireValue(
      spec['ok'] === true && typeof spec['title'] === 'string' && typeof spec['file'] === 'string',
      'viewer spec failed',
    );
    requireValue(
      allowedFiles.map((file) => basename(file)).includes(spec['file']),
      'unexpected viewer file',
    );
    const candidates = requirements.filter(
      (entry) => entry.id === spec['title'] || entry.title === spec['title'],
    );
    requireValue(candidates.length === 1, 'unexpected or ambiguous scenario title');
    const requirement = candidates[0]!;
    requireValue(
      traces[requirement.id] === undefined,
      `duplicate viewer scenario: ${requirement.id}`,
    );
    const executions = array(spec['tests']);
    requireValue(executions.length === 1, 'ambiguous viewer project');
    const test = object(executions[0]);
    noErrors(test);
    requireValue(
      test['expectedStatus'] === 'passed' &&
        test['status'] === 'expected' &&
        typeof test['projectName'] === 'string',
      'unexpected viewer execution',
    );
    const identity = JSON.stringify([test['projectName'], test['projectId'] ?? '']);
    project ??= identity;
    requireValue(project === identity, 'multiple viewer projects');
    const attempts = array(test['results']);
    requireValue(attempts.length === 1, 'retried viewer execution');
    const result = object(attempts[0]);
    noErrors(result);
    requireValue(
      result['status'] === 'passed' && result['retry'] === 0,
      'viewer first attempt failed',
    );
    const attachments = array(result['attachments'])
      .map(object)
      .filter((attachment) => attachment['name'] === 'trace');
    requireValue(
      attachments.length === 1 &&
        typeof attachments[0]!['path'] === 'string' &&
        attachments[0]!['contentType'] === 'application/zip',
      'missing or ambiguous retained trace',
    );
    const path = realpathSync(
      resolve(resolve(reportPath, '..'), attachments[0]!['path'] as string),
    );
    const within = relative(root, path);
    requireValue(
      within !== '' && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within),
      'trace escapes output root',
    );
    const bytes = readFileSync(path);
    await validateViewerTraceZip(bytes);
    traces[requirement.id] = { path, sha256: evidenceSha256(bytes) };
  }
  for (const requirement of requirements)
    requireValue(traces[requirement.id], `viewer scenario missing: ${requirement.id}`);
  return traces;
}

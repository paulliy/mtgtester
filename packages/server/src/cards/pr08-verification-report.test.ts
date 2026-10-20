import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  validatePr08EngineReport,
  validatePr08ViewerReport,
} from '../../../../scripts/pr08-verification-report';

const directory = mkdtempSync(resolve(tmpdir(), 'pr08-report-contract-'));
const tracePath = resolve(directory, 'trace.zip');
const requirement = {
  id: 'independent-scenario',
  title: 'Independent real scenario',
  oracleSha256: 'a'.repeat(64),
  clauseIds: ['independent-clause'],
};
beforeAll(() => {
  const zip = execFileSync('python', [
    '-c',
    'import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z:\n z.writestr("0-trace.trace",\'{"version":8,"type":"context-options","browserName":"chromium"}\\n{"type":"before","callId":"call@1","apiName":"page.goto"}\\n\')\nsys.stdout.buffer.write(b.getvalue())',
  ]);
  writeFileSync(tracePath, zip);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function engine() {
  return {
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        status: 'passed',
        assertionResults: [
          {
            status: 'passed',
            fullName: 'Independent group proof-positive — exercises a real cast',
            failureMessages: [],
          },
        ],
      },
    ],
  };
}
function viewer() {
  return {
    errors: [],
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [
      {
        file: 'independent.spec.ts',
        specs: [
          {
            file: 'independent.spec.ts',
            title: requirement.title,
            ok: true,
            tests: [
              {
                projectName: 'chromium',
                expectedStatus: 'passed',
                status: 'expected',
                results: [
                  {
                    status: 'passed',
                    retry: 0,
                    errors: [],
                    attachments: [
                      { name: 'trace', contentType: 'application/zip', path: tracePath },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
const validate = (report: unknown) =>
  validatePr08ViewerReport(
    report,
    [requirement],
    ['apps/web/e2e/independent.spec.ts'],
    resolve(directory, 'report.json'),
    directory,
  );

describe('PR08 generated report validation', () => {
  it('accepts executed engine clauses and rejects missing, skipped or fabricated counts', () => {
    expect(validatePr08EngineReport(engine(), ['proof-positive']).passed).toBe(1);
    expect(() => validatePr08EngineReport(engine(), ['missing-case'])).toThrow('case missing');
    expect(() =>
      validatePr08EngineReport({ ...engine(), numPendingTests: 1 }, ['proof-positive']),
    ).toThrow('failed or skipped');
    expect(() =>
      validatePr08EngineReport({ ...engine(), numTotalTests: 2, numPassedTests: 2 }, [
        'proof-positive',
      ]),
    ).toThrow('assertion count');
  });
  it('accepts exactly one first-attempt browser assertion with an actual CRC-valid trace', async () => {
    const traces = await validate(viewer());
    expect(traces[requirement.id]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(traces[requirement.id]!.path).toBe(tracePath);
  });
  it('rejects retries, skipped cases, unexpected files and missing traces', async () => {
    const retried = viewer();
    retried.suites[0]!.specs[0]!.tests[0]!.results[0]!.retry = 1;
    await expect(validate(retried)).rejects.toThrow('first attempt');
    const skipped = viewer();
    skipped.stats.skipped = 1;
    await expect(validate(skipped)).rejects.toThrow('skipped');
    const wrongFile = viewer();
    wrongFile.suites[0]!.specs[0]!.file = 'other.spec.ts';
    await expect(validate(wrongFile)).rejects.toThrow('unexpected viewer file');
    const noTrace = viewer();
    noTrace.suites[0]!.specs[0]!.tests[0]!.results[0]!.attachments = [];
    await expect(validate(noTrace)).rejects.toThrow('retained trace');
  });
  it('rejects duplicate and unmapped scenario executions', async () => {
    const duplicate = viewer();
    duplicate.stats.expected = 2;
    duplicate.suites[0]!.specs.push(duplicate.suites[0]!.specs[0]!);
    await expect(
      validatePr08ViewerReport(
        duplicate,
        [requirement, { ...requirement, id: 'second', title: 'Second scenario' }],
        ['independent.spec.ts'],
        resolve(directory, 'report.json'),
        directory,
      ),
    ).rejects.toThrow('duplicate viewer scenario');
    const unmapped = viewer();
    unmapped.suites[0]!.specs[0]!.title = 'Unmapped scenario';
    await expect(validate(unmapped)).rejects.toThrow('ambiguous scenario');
  });
});

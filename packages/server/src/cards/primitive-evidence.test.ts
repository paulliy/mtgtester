import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { CardDefinition } from '../../../engine/src/cards/definition';
import type { Value } from '../../../engine/src/cards/value';
import { bear } from '../../../engine/tests/fixtures';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { PRIMITIVE_CONTRACTS } from '../../../../scripts/contracts/primitive-contracts';
import {
  cardPrimitiveEligibility,
  cardPrimitiveEligibilityBatch,
  loadPrimitiveEvidence,
  validateCurrentPrimitiveEvidence,
  validatePrimitiveReport,
  type PrimitiveEvidence,
} from '../../../../scripts/contracts/primitive-evidence';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
const root = resolve(import.meta.dirname, '../../../..');
let runDirectory: string;
let actualReport: Record<string, unknown>;
let actualImpact: {
  modeled: number;
  primitiveEvidence: { eligible: number; blocked: number; engineProven: string[] };
};
const scratch: string[] = [];

beforeAll(() => {
  runDirectory = mkdtempSync(resolve(tmpdir(), 'mtg-primitive-actual-run-'));
  scratch.push(runDirectory);
  const run = spawnSync('bun', ['run', 'test:primitive-contracts', '--output', runDirectory], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (run.status !== 0)
    throw new Error(`Actual primitive execution failed: ${run.stdout}\n${run.stderr}`);
  actualReport = JSON.parse(readFileSync(resolve(runDirectory, 'report.json'), 'utf8'));
  const impact = spawnSync(
    'bun',
    ['run', 'card-capabilities', '--primitive-evidence', runDirectory],
    { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (impact.status !== 0)
    throw new Error(
      `Actual eligibility inventory failed: ${impact.error?.message ?? impact.status}\n${impact.stderr}`,
    );
  actualImpact = JSON.parse(impact.stdout);
}, 35_000);
afterEach(() => vi.restoreAllMocks());

function copyReceipt(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'mtg-primitive-receipt-'));
  scratch.push(directory);
  for (const file of ['manifest.json', 'report.json'])
    writeFileSync(resolve(directory, file), readFileSync(resolve(runDirectory, file)));
  return directory;
}
function definition(count: number | Value = 1): CardDefinition {
  return {
    ...interpretCard(bear()),
    spellAbility: {
      kind: 'spell',
      targets: [{ kind: 'permanent' }],
      effects: [{ op: 'removeCounters', target: 0, counter: 'charge', count }],
    },
  };
}

describe('primitive evidence and eligibility', () => {
  it('loads evidence from actual independent execution and freezes generated facts', () => {
    const evidence = loadPrimitiveEvidence(root, runDirectory);
    expect(evidence.capabilities).toEqual(['Effect.removeCounters']);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.capabilities)).toBe(true);
    validateCurrentPrimitiveEvidence(evidence);
  });

  it('keeps uncontracted dependencies experimental despite a passing primitive', () => {
    const result = cardPrimitiveEligibility(
      definition(),
      loadPrimitiveEvidence(root, runDirectory),
    );
    expect(result.eligible).toBe(false);
    expect(result.dependencies).toContain('Effect.removeCounters');
    expect(result.blocked.some((entry) => entry.capability === 'Effect.removeCounters')).toBe(
      false,
    );
    expect(result.blocked.some((entry) => entry.reason.includes('experimental'))).toBe(true);
  });

  it('binds actual capability CLI eligibility to current primitive evidence', () => {
    expect(actualImpact.primitiveEvidence.engineProven).toEqual(['Effect.removeCounters']);
    expect(actualImpact.primitiveEvidence.eligible).toBe(0);
    expect(actualImpact.primitiveEvidence.blocked).toBe(actualImpact.modeled);
    expect(actualImpact.modeled).toBeGreaterThan(600);
  });

  it('validates batch eligibility with the same fail-closed result', () => {
    const evidence = loadPrimitiveEvidence(root, runDirectory);
    const def = definition();
    expect(cardPrimitiveEligibilityBatch([def], evidence)).toEqual([
      cardPrimitiveEligibility(def, evidence),
    ]);
    expect(() => cardPrimitiveEligibilityBatch([def], {} as PrimitiveEvidence)).toThrow(
      'loader-validated',
    );
  });

  it('blocks dynamic amounts outside the proven scope', () => {
    const result = cardPrimitiveEligibility(
      definition({ kind: 'countOpponents' }),
      loadPrimitiveEvidence(root, runDirectory),
    );
    expect(result.blocked).toContainEqual({
      capability: 'Effect.removeCounters',
      reason: 'outside proven contract scope',
    });
  });

  it('requires a privately loader-validated context', () => {
    expect(() => cardPrimitiveEligibility(definition(), {} as PrimitiveEvidence)).toThrow(
      'loader-validated',
    );
  });

  it.each([
    ['state', 'skipped'],
    ['state', 'failed'],
    ['completions', 0],
    ['completions', 2],
    ['retryCount', 1],
    ['repeatCount', 1],
    ['flaky', true],
    ['retryCount', null],
  ])('rejects report execution diagnostic %s=%s', (field, value) => {
    // Mutated copies test the parser boundary; they never provide passing execution evidence.
    const report = structuredClone(actualReport);
    const cases = report['cases'] as Record<string, unknown>[];
    cases[0]![field as string] = value;
    expect(() => validatePrimitiveReport(report)).toThrow('case failed');
  });

  it('rejects an omitted required negative case', () => {
    const report = structuredClone(actualReport);
    report['cases'] = (report['cases'] as Record<string, unknown>[]).filter(
      (test) =>
        !(test['titlePath'] as string[]).includes(
          'does not remove counters from an illegal target',
        ),
    );
    expect(() => validatePrimitiveReport(report)).toThrow('missing case');
  });

  it('rejects duplicated cases and missing modules', () => {
    const report = structuredClone(actualReport);
    const cases = report['cases'] as Record<string, unknown>[];
    cases.push(cases[0]!);
    expect(() => validatePrimitiveReport(report)).toThrow('duplicate case');
    report['cases'] = actualReport['cases'];
    report['modules'] = [];
    expect(() => validatePrimitiveReport(report)).toThrow('module set');
  });

  it.each(['testedTree', 'framework', 'executionRuntime'])('rejects stale capture %s', (field) => {
    const directory = copyReceipt();
    const path = resolve(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.capture[field] = 'stale';
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => loadPrimitiveEvidence(root, directory)).toThrow('stale or incomplete');
  });

  it('rejects an incomplete source union', () => {
    const directory = copyReceipt();
    const path = resolve(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest.capture.files['packages/engine/src/cards/capabilities.ts'];
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => loadPrimitiveEvidence(root, directory)).toThrow('stale or incomplete');
  });

  it('rejects report bytes changed before and after load', () => {
    const directory = copyReceipt();
    const evidence = loadPrimitiveEvidence(root, directory);
    const path = resolve(directory, 'report.json');
    writeFileSync(path, readFileSync(path, 'utf8') + ' ');
    expect(() => validateCurrentPrimitiveEvidence(evidence)).toThrow('receipt bytes changed');
    expect(() => loadPrimitiveEvidence(root, directory)).toThrow('report bytes changed');
  });

  it('rejects source-byte drift even when primitive tags are unchanged', () => {
    const evidence = loadPrimitiveEvidence(root, runDirectory);
    const original = fs.readFileSync;
    const changed = resolve(root, 'packages/engine/src/effects/resolve.ts');
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path: unknown, ...args: unknown[]) => {
      const bytes = Reflect.apply(original, fs, [path, ...args]);
      return path === changed && Buffer.isBuffer(bytes)
        ? Buffer.concat([bytes, Buffer.from('\n// semantic drift simulation')])
        : bytes;
    }) as typeof fs.readFileSync);
    expect(() => validateCurrentPrimitiveEvidence(evidence)).toThrow('sources changed');
  });

  it('rejects duplicate JSON keys and extra manifest claims', () => {
    const directory = copyReceipt();
    const path = resolve(directory, 'manifest.json');
    const bytes = readFileSync(path, 'utf8');
    writeFileSync(path, bytes.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
    expect(() => loadPrimitiveEvidence(root, directory)).toThrow();
    const manifest = JSON.parse(bytes);
    manifest.lifecycle = 'engine-proven';
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => loadPrimitiveEvidence(root, directory)).toThrow('fields');
  });

  it('keeps the registry immutable and requires real permanent-slot scope', () => {
    const contract = PRIMITIVE_CONTRACTS[0]!;
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.cases)).toBe(true);
    const def = definition();
    def.spellAbility!.targets = [{ kind: 'player' }];
    expect(contract.supports(def)).toBe(false);
  });
});

afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

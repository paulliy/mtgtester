import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { deriveCardCapabilities } from '../../packages/engine/src/cards/capabilities';
import { discoverGeneratorSourceFilesForEntries, parseEvidenceJson } from '../card-evidence-input';
import { PRIMITIVE_CONTRACTS } from './primitive-contracts';
import { isPathWithinRoot } from './source-containment';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Primitive evidence: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value), 'object');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  requireInput(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    'fields',
  );
}
function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    requireInput(!entry.isSymbolicLink(), `unexpected source symlink: ${path}`);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}
function frameworkIdentity(root: string): string {
  const rootRequire = createRequire(resolve(root, 'package.json'));
  const require = createRequire(rootRequire.resolve('vitest/package.json'));
  const packages = [
    'vitest',
    '@vitest/runner',
    '@vitest/expect',
    '@vitest/utils',
    'vite',
    'vite-node',
  ];
  return sha(
    JSON.stringify(
      packages.map((name) => {
        const metadata = realpathSync(require.resolve(`${name}/package.json`));
        const directory = dirname(metadata);
        return [
          name,
          directory,
          walkFiles(directory)
            .sort()
            .map((path) => [relative(directory, path), sha(readFileSync(path))]),
        ];
      }),
    ),
  );
}
export interface PrimitiveCapture {
  schemaVersion: 1;
  testedTree: string;
  executionRuntime: string;
  framework: string;
  files: Readonly<Record<string, string>>;
}

/** Capture the actual test closures, all engine sources, runner, registry, and execution tooling. */
export function capturePrimitiveSources(repoRoot: string): PrimitiveCapture {
  const root = realpathSync(repoRoot);
  requireInput(
    execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    }).trim() === '',
    'working tree must be clean to bind testedTree',
  );
  const paths = new Set([
    'package.json',
    'bun.lock',
    'vitest.config.ts',
    'scripts/test-primitive-contracts.ts',
    'scripts/card-capability-impact.ts',
    'scripts/check-primitive-promotions.ts',
    'scripts/contracts/primitive-promotions.ts',
    '.github/workflows/ci.yml',
    'packages/server/fixtures/card-verification-manifest.json',
    'scripts/contracts/primitive-contracts.ts',
    'scripts/contracts/primitive-reporter.ts',
    'scripts/contracts/tsconfig.json',
    'tsconfig.base.json',
    'scripts/contracts/primitive-evidence.ts',
    'scripts/contracts/source-containment.ts',
    'scripts/contracts/bounded-hand-discard.ts',
    'scripts/card-evidence-input.ts',
  ]);
  const testFiles = new Set(
    PRIMITIVE_CONTRACTS.flatMap((contract) => contract.cases.map((test) => test.file)),
  );
  for (const path of discoverGeneratorSourceFilesForEntries(root, [...testFiles])) paths.add(path);
  for (const path of walkFiles(resolve(root, 'packages/engine/src'))) {
    if (path.endsWith('.ts')) paths.add(relative(root, path).replaceAll('\\', '/'));
  }
  const files: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const absolute = realpathSync(resolve(root, path));
    requireInput(isPathWithinRoot(root, absolute), `source escaped repository: ${path}`);
    files[path] = sha(readFileSync(absolute));
  }
  return {
    schemaVersion: 1,
    testedTree: execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD^{tree}'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    executionRuntime: execFileSync(
      'node',
      ['-p', 'JSON.stringify({version:process.version, executable:process.execPath})'],
      { encoding: 'utf8' },
    ).trim(),
    framework: frameworkIdentity(root),
    files,
  };
}

function caseKey(file: unknown, titles: unknown): string {
  requireInput(
    typeof file === 'string' &&
      Array.isArray(titles) &&
      titles.length > 0 &&
      titles.every((value) => typeof value === 'string'),
    'case identity',
  );
  return JSON.stringify([file, titles]);
}

/** Pure report validation is separately testable; a parsed report alone is never evidence. */
export function validatePrimitiveReport(value: unknown): readonly string[] {
  const report = object(value);
  exact(report, ['schemaVersion', 'reason', 'unhandledErrors', 'modules', 'cases']);
  requireInput(
    report['schemaVersion'] === 1 &&
      report['reason'] === 'passed' &&
      report['unhandledErrors'] === 0,
    'run failed or interrupted',
  );
  requireInput(Array.isArray(report['modules']) && Array.isArray(report['cases']), 'run contents');
  const requiredFiles = [
    ...new Set(PRIMITIVE_CONTRACTS.flatMap((contract) => contract.cases.map((test) => test.file))),
  ].sort();
  const modules = report['modules'].map((value) => {
    const module = object(value);
    exact(module, ['file', 'passed', 'errors']);
    requireInput(
      typeof module['file'] === 'string' && module['passed'] === true && module['errors'] === 0,
      'module failed',
    );
    return module['file'];
  });
  requireInput(JSON.stringify(modules.sort()) === JSON.stringify(requiredFiles), 'module set');
  const cases = new Map<string, Record<string, unknown>>();
  for (const value of report['cases']) {
    const test = object(value);
    exact(test, [
      'file',
      'titlePath',
      'state',
      'completions',
      'retryCount',
      'repeatCount',
      'flaky',
    ]);
    requireInput(requiredFiles.includes(test['file'] as string), 'unexpected case file');
    const key = caseKey(test['file'], test['titlePath']);
    requireInput(!cases.has(key), 'duplicate case');
    requireInput(
      test['state'] === 'passed' &&
        test['completions'] === 1 &&
        test['retryCount'] === 0 &&
        test['repeatCount'] === 0 &&
        test['flaky'] === false,
      'case failed, skipped, repeated, or retried',
    );
    cases.set(key, test);
  }
  const ids = new Set<string>();
  const requiredExecutions = new Set<string>();
  const capabilities = new Set<string>();
  for (const contract of PRIMITIVE_CONTRACTS) {
    requireInput(!capabilities.has(contract.capability), 'duplicate primitive');
    capabilities.add(contract.capability);
    requireInput(
      contract.scope.length > 0 &&
        contract.cases.some((test) => test.role === 'positive') &&
        contract.cases.some((test) => test.role === 'negative'),
      'contract needs scope and positive/negative executions',
    );
    for (const test of contract.cases) {
      requireInput(!ids.has(test.id), 'duplicate contract case id');
      ids.add(test.id);
      const key = caseKey(test.file, test.titlePath);
      requireInput(!requiredExecutions.has(key), 'duplicate required execution');
      requiredExecutions.add(key);
      requireInput(cases.has(key), `missing case: ${test.id}`);
    }
  }
  return [...capabilities].sort();
}

const brand: unique symbol = Symbol('validated primitive evidence');
export interface PrimitiveEvidence {
  readonly [brand]: true;
  readonly capabilities: readonly string[];
  readonly testedTree: string;
  readonly reportSha256: string;
}
const contexts = new WeakMap<
  PrimitiveEvidence,
  {
    root: string;
    manifestPath: string;
    reportPath: string;
    manifestSha: string;
    capture: PrimitiveCapture;
  }
>();

export function loadPrimitiveEvidence(repoRoot: string, directory: string): PrimitiveEvidence {
  const root = realpathSync(repoRoot);
  const manifestPath = resolve(directory, 'manifest.json');
  const reportPath = resolve(directory, 'report.json');
  const bytes = readFileSync(manifestPath);
  const manifest = object(parseEvidenceJson(bytes.toString('utf8')));
  exact(manifest, ['schemaVersion', 'capture', 'reportSha256', 'exitCode']);
  requireInput(
    manifest['schemaVersion'] === 1 && manifest['exitCode'] === 0,
    'execution did not pass',
  );
  const capture = capturePrimitiveSources(root);
  requireInput(
    JSON.stringify(manifest['capture']) === JSON.stringify(capture),
    'stale or incomplete source capture',
  );
  const report = readFileSync(reportPath);
  requireInput(sha(report) === manifest['reportSha256'], 'report bytes changed');
  const evidence: PrimitiveEvidence = Object.freeze({
    [brand]: true as const,
    capabilities: Object.freeze([
      ...validatePrimitiveReport(parseEvidenceJson(report.toString('utf8'))),
    ]),
    testedTree: capture.testedTree,
    reportSha256: sha(report),
  });
  contexts.set(evidence, { root, manifestPath, reportPath, manifestSha: sha(bytes), capture });
  return evidence;
}

export function validateCurrentPrimitiveEvidence(
  evidence: PrimitiveEvidence,
  repoRoot?: string,
): void {
  const context = contexts.get(evidence);
  requireInput(context, 'loader-validated evidence required');
  if (repoRoot !== undefined)
    requireInput(realpathSync(repoRoot) === context.root, 'validated repository changed');
  requireInput(
    JSON.stringify(capturePrimitiveSources(context.root)) === JSON.stringify(context.capture),
    'sources changed after evidence load',
  );
  requireInput(
    sha(readFileSync(context.manifestPath)) === context.manifestSha &&
      sha(readFileSync(context.reportPath)) === evidence.reportSha256,
    'receipt bytes changed',
  );
}

export type PrimitiveLifecycle = 'experimental' | 'implemented' | 'engine-proven';

/** Lifecycle facts describe a contract, not arbitrary card compositions using its tag. */
export function primitiveCapabilityLifecycle(
  capabilities: readonly string[],
  evidence?: PrimitiveEvidence,
) {
  if (evidence !== undefined) validateCurrentPrimitiveEvidence(evidence);
  const facts = Object.fromEntries(
    [...new Set(capabilities)].sort().map((capability) => {
      const contract = PRIMITIVE_CONTRACTS.find((entry) => entry.capability === capability);
      const status: PrimitiveLifecycle =
        contract === undefined
          ? 'experimental'
          : evidence?.capabilities.includes(capability)
            ? 'engine-proven'
            : 'implemented';
      return [
        capability,
        {
          status,
          ...(contract === undefined
            ? {}
            : {
                scope: contract.scope,
                requiredCases: contract.cases.map((test) => test.id),
              }),
          ...(status !== 'engine-proven'
            ? {}
            : {
                testedTree: evidence!.testedTree,
                reportSha256: evidence!.reportSha256,
              }),
        },
      ];
    }),
  );
  if (evidence !== undefined) validateCurrentPrimitiveEvidence(evidence);
  return facts;
}

/** A review/promotion boundary cannot substitute a reviewed declaration for primitive proof. */
export function requireReviewedPrimitiveEligibility(
  consumers: readonly { canonicalOracleId: string; definition: CardDefinition }[],
  reviewedOracleIds: readonly string[],
  evidence: PrimitiveEvidence,
): void {
  requireInput(
    new Set(reviewedOracleIds).size === reviewedOracleIds.length,
    'duplicate reviewed identity',
  );
  const byId = new Map(
    consumers.map((consumer) => [consumer.canonicalOracleId, consumer.definition]),
  );
  requireInput(byId.size === consumers.length, 'duplicate consumer identity');
  const definitions = reviewedOracleIds.map((id) => {
    const definition = byId.get(id);
    requireInput(definition, `reviewed card missing from current modeled input: ${id}`);
    return definition;
  });
  const results = cardPrimitiveEligibilityBatch(definitions, evidence);
  const blocked = results.flatMap((result, index) =>
    result.eligible
      ? []
      : [
          {
            oracleId: reviewedOracleIds[index],
            blocked: result.blocked,
          },
        ],
  );
  requireInput(
    blocked.length === 0,
    `reviewed primitives are not proven: ${JSON.stringify(blocked)}`,
  );
}

/** Primitive proof is a prerequisite; this never supplies card, viewer, or AI proof. */
export function cardPrimitiveEligibility(definition: CardDefinition, evidence: PrimitiveEvidence) {
  validateCurrentPrimitiveEvidence(evidence);
  return eligibility(definition, evidence);
}

/** Validate once around a synchronous inventory rather than rereading sources per card. */
export function cardPrimitiveEligibilityBatch(
  definitions: readonly CardDefinition[],
  evidence: PrimitiveEvidence,
) {
  validateCurrentPrimitiveEvidence(evidence);
  const results = definitions.map((definition) => eligibility(definition, evidence));
  validateCurrentPrimitiveEvidence(evidence);
  return results;
}

function eligibility(definition: CardDefinition, evidence: PrimitiveEvidence) {
  const dependencies = deriveCardCapabilities(definition);
  const blocked = dependencies.flatMap((capability) => {
    const contract = PRIMITIVE_CONTRACTS.find((entry) => entry.capability === capability);
    if (!contract) return [{ capability, reason: 'experimental: no executable contract' }];
    if (!evidence.capabilities.includes(capability))
      return [{ capability, reason: 'implemented: contract evidence missing' }];
    if (!contract.supports(definition))
      return [{ capability, reason: 'outside proven contract scope' }];
    return [];
  });
  return { dependencies, eligible: blocked.length === 0, blocked };
}

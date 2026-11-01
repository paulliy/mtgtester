/**
 * `bun run check:manifest-tests` (ADR 0034 decision 5): every engine test the card verification
 * manifest names is exactly one collected Vitest test whose file names the card. It lists the
 * Vitest collection (`vitest list`, nothing runs), or reads one given with `--collected <json>`.
 * `--report` prints every problem and exits 0.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bulkReferenceProblem,
  checkReference,
  indexTests,
  manifestReferences,
  type CollectedTest,
} from './contracts/manifest-tests';

const MANIFEST = 'packages/server/fixtures/card-verification-manifest.json';
const args = process.argv.slice(2);
const collectedFlag = args.indexOf('--collected');
const report = args.includes('--report');
const root = `${process.cwd().replaceAll('\\', '/')}/`;

function collect(): CollectedTest[] {
  let path = collectedFlag === -1 ? null : args[collectedFlag + 1]!;
  const scratch = path === null ? mkdtempSync(join(tmpdir(), 'manifest-tests-')) : null;
  try {
    if (path === null) {
      path = join(scratch!, 'tests.json');
      execFileSync('bunx', ['vitest', 'list', `--json=${path}`], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
    }
    return (JSON.parse(readFileSync(path, 'utf8')) as Array<{ name: string; file: string }>).map(
      (entry) => ({
        file: entry.file.replaceAll('\\', '/').replace(root, ''),
        fullName: entry.name,
      }),
    );
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}

const tests = collect();
const index = indexTests(tests);
const references = manifestReferences(readFileSync(MANIFEST, 'utf8'));
const files = execFileSync('git', ['ls-files', '-z', '*.test.ts'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
const read = (path: string) => sources.get(path) ?? readFileSync(path, 'utf8');
const problems: string[] = [];
for (const reference of references) {
  const result = checkReference(reference, index, read);
  const problem =
    result.problem ??
    (reference.notExecutableInCi ? bulkReferenceProblem(reference, sources) : null);
  if (problem !== null) problems.push(`${reference.card}: "${reference.id}" ${problem}`);
}
for (const problem of problems) console.log(problem);
console.log(
  `${references.length} manifest test references, ${tests.length} collected tests: ${problems.length} problem(s)`,
);
process.exit(problems.length > 0 && !report ? 1 : 0);

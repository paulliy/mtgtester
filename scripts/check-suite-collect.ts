/**
 * ADR 0034 decision 9, second half: every tracked test file collects at least one test from the
 * runner that claims it. `check:suite-integrity` proves each file has exactly one runner by reading
 * the configs; this runs each runner's own listing (`vitest list`, `playwright test --list`, which
 * import the files but run nothing and start no server) and fails on a file it collects nothing
 * from. A file that declares untracked data with `// suite-requires: <path>` may collect nothing
 * while that path is missing; the run lists it, so what CI never runs stays visible.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countPlaywrightList,
  countVitestList,
  discoverRunners,
  emptySuiteErrors,
  suiteRequirements,
} from './contracts/suite-integrity';

const root = process.cwd().replaceAll('\\', '/');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter((file) => file !== '');
const { runners, errors } = discoverRunners({ files, read: (path) => readFileSync(path, 'utf8') });
if (errors.length > 0) {
  console.error('Suite configs could not be read; run check:suite-integrity first.');
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

const collected = new Map<string, Map<string, number>>();
const scratch = mkdtempSync(join(tmpdir(), 'suite-collect-'));
try {
  for (const runner of runners) {
    const started = Date.now();
    if (runner.kind === 'vitest') {
      const out = join(scratch, 'vitest.json');
      execFileSync('bunx', ['vitest', 'list', '--config', runner.config, `--json=${out}`], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      collected.set(runner.config, countVitestList(readFileSync(out, 'utf8'), root));
    } else {
      const json = execFileSync(
        'bunx',
        ['playwright', 'test', '--config', runner.config, '--list', '--reporter=json'],
        { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] },
      );
      collected.set(runner.config, countPlaywrightList(json, runner.testDir));
    }
    const tests = [...(collected.get(runner.config)?.values() ?? [])].reduce((a, b) => a + b, 0);
    console.log(`${runner.config}: ${tests} tests listed in ${Date.now() - started} ms`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const { errors: empty, excused } = emptySuiteErrors(files, runners, collected, (file) => {
  const missing = suiteRequirements(readFileSync(file, 'utf8')).filter((path) => !existsSync(path));
  return missing.length === 0 ? null : missing.join(', ');
});
for (const note of excused) console.log(`not run here: ${note}`);
if (empty.length > 0) {
  console.error(`Suite collection failed (${empty.length}):`);
  for (const error of empty) console.error(`  ${error}`);
  process.exit(1);
}
console.log(
  `suite collection ok: every tracked test file collects at least one test${excused.length > 0 ? ` (${excused.length} wait on untracked data)` : ''}`,
);

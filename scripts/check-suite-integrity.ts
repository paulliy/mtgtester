import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkSuiteIntegrity } from './contracts/suite-integrity';

// ADR 0034 decision 9: every tracked test file is claimed by exactly one runner, and every
// `test:card-gate` entry matches a tracked test file.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter((file) => file !== '');
const result = checkSuiteIntegrity({ files, read: (path) => readFileSync(path, 'utf8') });
if (result.errors.length > 0) {
  console.error(`Suite integrity failed (${result.errors.length}):`);
  for (const error of result.errors) console.error(`  ${error}`);
  process.exit(1);
}
console.log(
  `suite integrity ok: ${result.testFiles} test files, each claimed by exactly one of ${result.runners.join(', ')}; ${result.cardGateEntries} card-gate entries all match`,
);

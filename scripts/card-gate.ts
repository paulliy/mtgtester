/**
 * `bun run test:card-gate`'s test run (ADR 0033 decision 1, plan phase 2 step 6): every Vitest
 * test file matching an entry of the committed list `scripts/card-gate.txt`. An entry that
 * matches no file fails before anything runs; the resolved files go to Vitest by path, so the set
 * that runs is exactly the one printed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  CARD_GATE_LIST,
  cardGateEntries,
  cardGateErrors,
  cardGateFiles,
  discoverRunners,
} from './contracts/suite-integrity';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter((file) => file !== '');
const read = (path: string) => readFileSync(path, 'utf8');
const { runners, errors } = discoverRunners({ files, read });
const entries = cardGateEntries(read(CARD_GATE_LIST));
errors.push(...cardGateErrors(entries, files, runners));
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
const gate = cardGateFiles(entries, files, runners);
console.log(`card gate: ${entries.length} entries, ${gate.length} test files`);
const result = spawnSync('bunx', ['vitest', 'run', ...gate, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);

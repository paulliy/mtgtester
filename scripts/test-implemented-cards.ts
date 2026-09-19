import {
  runL4PracticeMatch,
  runL6SpectatorMatch,
} from '../packages/server/src/cli/test-cards-l4-l6';
import { runL7CoverageCheck } from '../packages/server/src/cli/test-cards-l7-coverage';
import {
  captureRequiredCheck,
  type CheckResult,
  requiredCheckExitCode,
  requiredChecksPassed,
  runVitestCheck,
} from '../packages/server/src/cli/card-test-reporting';

console.log('======================================================================');
console.log('        TOKEN TRIUMPH CARD-CHECK REPORT');
console.log('======================================================================\n');

const results: CheckResult[] = [
  runVitestCheck(
    'l1-l3-deck',
    'L1–L3 Token Triumph deck suite',
    'packages/server/src/cards/token-triumph-deck.test.ts',
  ),
  runVitestCheck(
    'l1-l3-cards',
    'L1–L3 card-specific suite',
    'packages/server/src/cards/card-suite-l1-l3.test.ts',
  ),
  runVitestCheck(
    'l5-reachability',
    'L5 engine-option reachability suite',
    'packages/server/src/cards/card-suite-l5-ui.test.ts',
  ),
  captureRequiredCheck(
    'l4-bounded-rules',
    'L4 deterministic bounded rules-engine smoke',
    'bounded-engine',
    runL4PracticeMatch,
  ),
  captureRequiredCheck(
    'l6-bounded-policy',
    'L6 deterministic rule-based-provider bounded smoke',
    'bounded-engine',
    runL6SpectatorMatch,
  ),
  captureRequiredCheck(
    'l7-inventory',
    'L7 aggregate modeled-card inventory',
    'inventory',
    runL7CoverageCheck,
  ),
];

for (const result of results) {
  console.log(`${result.status.toUpperCase().padEnd(8)} ${result.label} — ${result.detail}`);
}

console.log('\nMachine-readable results:');
console.log(JSON.stringify({ checks: results }, null, 2));

if (!requiredChecksPassed(results)) {
  const failed = results
    .filter((result) => result.status !== 'passed')
    .map((result) => `${result.id}=${result.status}`);
  console.error(`\nRequired card checks did not pass: ${failed.join(', ')}`);
} else {
  console.log('\nAll declared checks executed and passed.');
}
process.exitCode = requiredCheckExitCode(results);
console.log(
  'These results do not certify individual card behavior or the complete coverage population.',
);

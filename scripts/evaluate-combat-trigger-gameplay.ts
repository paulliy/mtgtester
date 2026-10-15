/** Retained provider-quality observations; never a card rules-correctness receipt. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { evaluateCombatTriggerGameplayAi } from '../packages/server/src/cards/gameplay-ai-evaluation';

const output = process.argv[2] ?? 'docs/reviews/combat-trigger-gameplay-ai.json';
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean);
const sourceHashes = Object.fromEntries(
  [...new Set(files)]
    .sort()
    .filter(
      (file) =>
        /^packages\/(engine|server|bot|shared)\/(src|fixtures|tests\/fixtures)\//.test(file) ||
        file === 'scripts/evaluate-combat-trigger-gameplay.ts',
    )
    .map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
);
const report = {
  ...evaluateCombatTriggerGameplayAi(),
  executionContext: {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    sourceHashes,
    scope:
      'Random/heuristic provider observations bound to these source bytes; not a rules receipt or review promotion.',
  },
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const halted = report.runs.filter((run) => run.halted).length;
console.log(
  JSON.stringify({
    output,
    runs: report.runs.length,
    halted,
    usedSubject: report.runs.filter((run) => run.usedSubjectCard).length,
  }),
);
if (halted > 0) process.exitCode = 1;

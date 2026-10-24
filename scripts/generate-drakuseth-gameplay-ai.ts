import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { evaluateDrakusethWordingGameplayAi } from '../packages/server/src/cards/gameplay-ai-evaluation';

const outputPath = resolve(process.argv[2] ?? 'test-results/drakuseth-wording-gameplay-ai.json');
const sourcePaths = [
  'packages/server/src/cards/gameplay-ai-evaluation.ts',
  'packages/server/src/cards/drakuseth-wording-scenarios.ts',
  'packages/server/src/cards/drakuseth-wording-scenarios.test.ts',
  'packages/engine/src/cards/interpret.ts',
  'packages/engine/src/cards/ability.ts',
  'packages/engine/tests/fixtures/drakuseth-wording-oracle.json',
];
const files = Object.fromEntries(
  sourcePaths.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
);
const dirtyPaths = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], {
  encoding: 'utf8',
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
})
  .split(/\r?\n/)
  .filter((line) => line.length > 0);
const report = {
  schemaVersion: 1,
  evidenceId: 'drakuseth-wording-gameplay-ai-quality',
  qualityStatus: 'implemented-unreviewed',
  generatedBy: 'scripts/generate-drakuseth-gameplay-ai.ts',
  workspaceRevision: {
    gitHead: execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim(),
    workingTreeDirty: dirtyPaths.length > 0,
    dirtyPaths,
    sourceSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  },
  ...evaluateDrakusethWordingGameplayAi(),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);

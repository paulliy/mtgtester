import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');

describe('mandatory card CI gate', () => {
  it('exposes stable required-check names on pull requests', () => {
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('name: Quality / Format');
    expect(workflow).toContain('name: Quality / Typecheck');
    expect(workflow).toContain('name: Quality / Lint');
    expect(workflow).toContain('name: Quality / Web build');
    expect(workflow).toContain('name: Engine / Full test suite');
    expect(workflow).toContain('name: Cards / Offline verification gate');
  });

  it('runs the offline gate and both authored-data snapshot checks', () => {
    expect(workflow).toContain('bun run test:card-gate');
    expect(workflow).toContain('bun run snapshots:check');
    expect(packageJson.scripts['snapshots:check']).toContain('snapshot-interpret-defs.ts --check');
    expect(packageJson.scripts['snapshots:check']).toContain('snapshot-override-defs.ts --check');
  });

  it('keeps mandatory card tests independent of the gitignored bulk file', () => {
    const command = packageJson.scripts['test:card-gate'];
    expect(command).toContain('card-test-reporting.test.ts');
    expect(command).toContain('reviewed-five-containment.test.ts');
    expect(command).toContain('reviewed-five-pool-containment.test.ts');
    expect(command).toContain('card-verification-manifest.test.ts');
    expect(command).toContain('marchesa-batch1-containment.test.ts');
    expect(command).toContain('marchesa-catalog-audit.test.ts');
    expect(command).toContain('marchesa-batch1-pool-containment.test.ts');
    expect(command).toContain('marchesa-engine-batch1.test.ts');
    expect(command).toContain('marchesa-engine-batch2.test.ts');
    expect(command).toContain('marchesa-engine-batch3.test.ts');
    expect(command).toContain('queen-engine-batch1.test.ts');
    expect(command).toContain('queen-engine-batch2.test.ts');
    expect(command).toContain('queen-engine-batch3.test.ts');
    expect(command).toContain('silverquill-remaining-engine-batch1.test.ts');
    expect(command).toContain('silverquill-main-engine-batch1.test.ts');
    expect(command).toContain('necron-remaining-engine-batch1.test.ts');
    expect(command).toContain('necron-main-engine-batch1.test.ts');
    expect(command).toContain('necron-main-engine-batch2.test.ts');
    expect(command).toContain('token-triumph-engine-batch1.test.ts');
    expect(command).toContain('draconic-engine-batch1.test.ts');
    expect(command).toContain('urdragon-engine-batch1.test.ts');
    expect(command).toContain('w1-remaining-engine-batch1.test.ts');
    expect(command).toContain('token-triumph-engine-batch2.test.ts');
    expect(command).toContain('draconic-engine-batch2.test.ts');
    expect(command).toContain('token-triumph-engine-batch3.test.ts');
    expect(command).toContain('draconic-engine-batch3.test.ts');
    expect(command).toContain('w2-remaining-engine-batch1.test.ts');
    expect(command).toContain('w2-remaining-engine-batch2.test.ts');
    expect(command).toContain('living-energy-engine-batch1.test.ts');
    expect(command).toContain('living-energy-engine-batch2.test.ts');
    expect(command).toContain('living-energy-engine-batch3.test.ts');
    expect(command).toContain('living-energy-engine-batch4.test.ts');
    expect(command).toContain('living-energy-engine-batch5.test.ts');
    expect(command).toContain('catalog-engine-evidence.test.ts');
    // The fail-closed restoration workstream: the five restored cards and the three still
    // contained by unsupportedCard() must both be gated offline, or a containment guard can
    // be dropped without any required check noticing.
    expect(command).toContain('fail-closed-restoration.test.ts');
    expect(command).toContain('arcane-denial.test.ts');
    expect(command).toContain('fabled-passage.test.ts');
    expect(command).toContain('myriad-landscape.test.ts');
    expect(command).toContain('smothering-tithe.test.ts');
    expect(command).toContain('war-room.test.ts');
    expect(command).toContain('toxic-deluge.test.ts');
    expect(command).toContain('chaos-warp.test.ts');
    // Coverage PR01 restorations and their Card Test Lab scenarios.
    expect(command).toContain('pr01-card-coverage.test.ts');
    expect(command).toContain('card-test-scenarios-pr01.test.ts');
    // Coverage PR02 restorations and their Card Test Lab scenarios.
    expect(command).toContain('pr02-card-coverage.test.ts');
    expect(command).toContain('card-test-scenarios-pr02.test.ts');
    expect(command).toContain('packages/engine/tests/per-player-targets.test.ts');
    expect(command).toContain('packages/engine/tests/pr09');
    expect(command).toContain('packages/server/src/cards/pr09');
    expect(command).toContain('packages/engine/tests/pr10');
    expect(command).toContain('packages/server/src/cards/pr10');
    expect(command).toContain('packages/engine/tests/pr11');
    expect(command).toContain('packages/server/src/cards/pr11');
    expect(command).toContain('packages/engine/tests/pr12');
    expect(command).toContain('packages/server/src/cards/pr12');
    expect(command).toContain('packages/server/src/cards/pr13');
    expect(command).not.toContain('token-triumph-deck.test.ts');
    expect(command).not.toContain('data/scryfall-oracle-cards.json');
  });
});

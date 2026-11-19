/**
 * Viewer-evidence merge gate (implementation plan step 13).
 *
 * Registering a Card Test Lab scenario is a promise that the scenario is reachable in the real
 * viewer and exercised by an unmocked end-to-end run. This suite fails — and with it
 * `bun run test:card-gate` — when that promise is not kept.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameId } from '@mtg/shared';
import { PR02_FOLLOW_UP_SCENARIO_IDS } from './pr02-follow-up-scenarios';
import { PR08_SCENARIO_IDS } from './pr08-scenario-catalog';
import { PR09_ALL_SCENARIO_IDS } from './pr09-scenario-catalog';
import { PR10_ALL_SCENARIO_IDS } from './pr10-scenario-catalog';
import { PR11_ALL_SCENARIO_IDS } from './pr11-scenario-catalog';
import { PR12_ALL_SCENARIO_IDS } from './pr12-scenario-catalog';
import { PILOT_CURRENT_ALL_SCENARIO_IDS } from './pilot-current-scenario-catalog';
import { PR13_ALL_SCENARIO_IDS } from './pr13-scenario-catalog';
import { CASTING_STATICS_ALL_SCENARIO_IDS } from './casting-statics-scenario-catalog';
import { PR11B_ALL_SCENARIO_IDS } from './pr11b-scenario-catalog';
import {
  CARD_TEST_SCENARIO_IDS,
  strictCardTestScenario,
  listCardTestScenarios,
} from './card-test-scenarios';

const labView = readFileSync(resolve('apps/web/src/views/CardTestLabView.vue'), 'utf8');
const labSpec = readFileSync(resolve('apps/web/e2e/card-test-lab.spec.ts'), 'utf8');
const pr02Spec = readFileSync(resolve('apps/web/e2e/pr02-limited-mechanics.spec.ts'), 'utf8');
const labSelection = readFileSync(resolve('apps/web/e2e/lab-selection.ts'), 'utf8');
const playwrightConfig = readFileSync(resolve('playwright.config.ts'), 'utf8');
const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const gameServer = readFileSync(resolve('packages/server/src/ws/server.ts'), 'utf8');

describe('Card Test Lab viewer-evidence gate', () => {
  it('requires the dedicated PR09 browser batches and excludes them from generic walkthroughs', () => {
    for (const id of PR09_ALL_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('!PR09_ALL_SCENARIO_IDS.includes(scenarioId)');
    expect(labSpec).toContain('!PR09_ALL_SCENARIO_IDS.includes(id)');
    for (const batch of ['', '-library', '-permanent', '-choice']) {
      const spec = readFileSync(resolve(`apps/web/e2e/pr09${batch}-card-test-lab.spec.ts`), 'utf8');
      expect(spec).toContain('exercised.add(id)');
      expect(spec).toContain('test.afterAll(');
      expect(spec).toContain("trace: 'on'");
      expect(spec).not.toContain('routeWebSocket');
      expect(spec).not.toContain('page.route(');
    }
  });
  it('requires the dedicated PR10 browser batch and excludes it from generic walkthroughs', () => {
    for (const id of PR10_ALL_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('!PR10_ALL_SCENARIO_IDS.includes(scenarioId)');
    expect(labSpec).toContain('!PR10_ALL_SCENARIO_IDS.includes(id)');
    const spec = readFileSync(resolve('apps/web/e2e/pr10-card-test-lab.spec.ts'), 'utf8');
    expect(spec).toContain('exercised.add(id)');
    expect(spec).toContain('test.afterAll(');
    expect(spec).toContain("trace: 'on'");
    expect(spec).not.toContain('routeWebSocket');
    expect(spec).not.toContain('page.route(');
  });
  it('requires the dedicated PR11 browser batch and excludes it from generic walkthroughs', () => {
    for (const id of PR11_ALL_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('!PR11_ALL_SCENARIO_IDS.includes(scenarioId)');
    expect(labSpec).toContain('!PR11_ALL_SCENARIO_IDS.includes(id)');
    const spec = readFileSync(resolve('apps/web/e2e/pr11-card-test-lab.spec.ts'), 'utf8');
    expect(spec).toContain('exercised.add(id)');
    expect(spec).toContain('test.afterAll(');
    expect(spec).toContain("trace: 'on'");
    expect(spec).not.toContain('routeWebSocket');
    expect(spec).not.toContain('page.route(');
  });
  it('requires the dedicated PR12 browser batch and excludes it from generic walkthroughs', () => {
    for (const id of PR12_ALL_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('!PR12_ALL_SCENARIO_IDS.includes(scenarioId)');
    expect(labSpec).toContain('!PR12_ALL_SCENARIO_IDS.includes(id)');
    const spec = readFileSync(resolve('apps/web/e2e/pr12-card-test-lab.spec.ts'), 'utf8');
    expect(spec).toContain('exercised.add(id)');
    expect(spec).toContain('test.afterAll(');
    expect(spec).toContain("trace: 'on'");
    expect(spec).not.toContain('routeWebSocket');
    expect(spec).not.toContain('page.route(');
  });
  it('requires the dedicated PR11b browser batch and excludes it from generic walkthroughs', () => {
    for (const id of PR11B_ALL_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('!PR11B_ALL_SCENARIO_IDS.includes(scenarioId)');
    expect(labSpec).toContain('!PR11B_ALL_SCENARIO_IDS.includes(id)');
    const spec = readFileSync(resolve('apps/web/e2e/pr11b-card-test-lab.spec.ts'), 'utf8');
    expect(spec).toContain('exercised.add(id)');
    expect(spec).toContain('test.afterAll(');
    expect(spec).toContain("trace: 'on'");
    expect(spec).not.toContain('routeWebSocket');
    expect(spec).not.toContain('page.route(');
  });
  it('requires the dedicated pilot-current browser batch and excludes it from generic walkthroughs', () => {
    for (const id of PILOT_CURRENT_ALL_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('!PILOT_CURRENT_ALL_SCENARIO_IDS.includes(scenarioId)');
    expect(labSpec).toContain('!PILOT_CURRENT_ALL_SCENARIO_IDS.includes(id)');
    const spec = readFileSync(resolve('apps/web/e2e/pilot-current-card-test-lab.spec.ts'), 'utf8');
    expect(spec).toContain('exercised.add(id)');
    expect(spec).toContain('test.afterAll(');
    expect(spec).toContain("trace: 'on'");
    expect(spec).not.toContain('routeWebSocket');
    expect(spec).not.toContain('page.route(');
  });
  it('requires the dedicated casting-statics browser batch and excludes it from generic walkthroughs', () => {
    for (const id of CASTING_STATICS_ALL_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('!CASTING_STATICS_ALL_SCENARIO_IDS.includes(scenarioId)');
    expect(labSpec).toContain('!CASTING_STATICS_ALL_SCENARIO_IDS.includes(id)');
    const spec = readFileSync(
      resolve('apps/web/e2e/casting-statics-card-test-lab.spec.ts'),
      'utf8',
    );
    expect(spec).toContain('exercised.add(id)');
    expect(spec).toContain('test.afterAll(');
    expect(spec).toContain("trace: 'on'");
    expect(spec).not.toContain('routeWebSocket');
    expect(spec).not.toContain('page.route(');
  });
  it('requires the dedicated PR13 browser batch and excludes it from generic walkthroughs', () => {
    for (const id of PR13_ALL_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('!PR13_ALL_SCENARIO_IDS.includes(scenarioId)');
    expect(labSpec).toContain('!PR13_ALL_SCENARIO_IDS.includes(id)');
    const spec = readFileSync(resolve('apps/web/e2e/pr13-card-test-lab.spec.ts'), 'utf8');
    expect(spec).toContain('exercised.add(id)');
    expect(spec).toContain('test.afterAll(');
    expect(spec).toContain("trace: 'on'");
    expect(spec).not.toContain('routeWebSocket');
    expect(spec).not.toContain('page.route(');
  });
  it('requires the dedicated PR11b browser batch and excludes it from generic walkthroughs', () => {
    for (const id of PR11B_ALL_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('!PR11B_ALL_SCENARIO_IDS.includes(scenarioId)');
    expect(labSpec).toContain('!PR11B_ALL_SCENARIO_IDS.includes(id)');
    const spec = readFileSync(resolve('apps/web/e2e/pr11b-card-test-lab.spec.ts'), 'utf8');
    expect(spec).toContain('exercised.add(id)');
    expect(spec).toContain('test.afterAll(');
    expect(spec).toContain("trace: 'on'");
    expect(spec).not.toContain('routeWebSocket');
    expect(spec).not.toContain('page.route(');
  });
  it('requires exhaustive independent real-viewer coverage for PR08', () => {
    const pr08Spec = readFileSync(resolve('apps/web/e2e/pr08-card-test-lab.spec.ts'), 'utf8');
    for (const id of PR08_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('!PR08_SCENARIO_IDS.includes(scenarioId)');
    expect(labSpec).toContain('!PR08_SCENARIO_IDS.includes(id)');
    expect(pr08Spec).toContain('exercised.add(id)');
    expect(pr08Spec).toContain('expectLabCoverage(exercised, PR08_SCENARIO_IDS)');
    expect(pr08Spec).toContain("trace: 'on'");
    expect(pr08Spec).not.toContain('routeWebSocket');
    expect(pr08Spec).not.toContain('page.route(');
  });
  it('requires independent real viewer coverage for the PR02 supplemental catalog', () => {
    for (const id of PR02_FOLLOW_UP_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('PR02_FOLLOW_UP_SCENARIO_IDS.includes');
    expect(pr02Spec).toContain('exercised.add(id)');
    expect(pr02Spec).toContain('expectLabCoverage(exercised, PR02_FOLLOW_UP_SCENARIO_IDS)');
    expect(pr02Spec).toContain("trace: 'on'");
    expect(pr02Spec).not.toContain('routeWebSocket');
    expect(pr02Spec).not.toContain('page.route(');
  });
  it('wires every registered scenario into the catalog the viewer fetches', () => {
    expect(CARD_TEST_SCENARIO_IDS.length).toBeGreaterThan(0);
    expect(labView).toContain('/api/card-test-scenarios');
    expect(labView).toContain('startCardTestScenario');
    expect(gameServer).toContain('/api/card-test-scenarios');
    expect(gameServer).toContain('listCardTestScenarios');
    expect(listCardTestScenarios().map((entry) => entry.id)).toEqual([...CARD_TEST_SCENARIO_IDS]);
  });

  it('requires the unmocked Playwright spec to prove registry coverage at runtime', () => {
    for (const scenarioId of CARD_TEST_SCENARIO_IDS) {
      const scenario = strictCardTestScenario(scenarioId, 'gate-check' as GameId);
      expect(scenario, scenarioId).not.toBeNull();
    }
    // The Playwright process records the IDs actually selected from the live catalog. Its
    // afterAll equality check fails when a registered scenario is skipped or selected twice.
    // The CI assertion below guarantees that this runtime check is executed. A sampled CI run
    // (ADR 0037) checks the selected subset instead; a run without LAB_SELECTION (local, weekly,
    // `ci:lab-verbose`) still demands exact equality with the whole catalog.
    expect(labSpec).toContain('const catalogScenarioIds = new Set<string>()');
    expect(labSpec).toContain('const exercisedScenarioIds = new Set<string>()');
    expect(labSpec).toContain('const scenarioId = await picker.inputValue()');
    expect(labSpec).toContain('exercisedScenarioIds.add(scenarioId)');
    expect(labSpec).toContain('expectLabCoverage(exercisedScenarioIds, catalogScenarioIds)');
    expect(labSelection).toContain('if (selection === null) {');
    expect(labSelection).toContain('expect([...exercised].sort()).toEqual(all);');
    // The lab spec must never mock its transport: mocked UI checks are not viewer evidence.
    expect(labSpec).not.toContain('routeWebSocket');
    expect(labSpec).not.toContain('page.route(');
    expect(labSpec).toContain("trace: 'on'");
  });

  it('keeps passing-run traces as retained evidence', () => {
    expect(playwrightConfig).toContain("preserveOutput: 'always'");
    expect(playwrightConfig).toContain('--card-test-lab');
  });

  it('runs the viewer evidence job in CI and uploads the traces of a failing run', () => {
    expect(workflow).toContain('name: Viewer / Card Test Lab evidence');
    expect(workflow).toContain('bun run test:e2e');
    expect(workflow).toContain('name: Require viewer traces');
    expect(workflow).toContain('card-test-lab-traces');
    expect(workflow).toContain('if-no-files-found: error');
  });
});

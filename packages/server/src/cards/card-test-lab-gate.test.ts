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
import {
  CARD_TEST_SCENARIO_IDS,
  createCardTestScenario,
  listCardTestScenarios,
} from './card-test-scenarios';

const labView = readFileSync(resolve('apps/web/src/views/CardTestLabView.vue'), 'utf8');
const labSpec = readFileSync(resolve('apps/web/e2e/card-test-lab.spec.ts'), 'utf8');
const pr02Spec = readFileSync(resolve('apps/web/e2e/pr02-limited-mechanics.spec.ts'), 'utf8');
const playwrightConfig = readFileSync(resolve('playwright.config.ts'), 'utf8');
const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const gameServer = readFileSync(resolve('packages/server/src/ws/server.ts'), 'utf8');

describe('Card Test Lab viewer-evidence gate', () => {
  it('requires independent real viewer coverage for the PR02 supplemental catalog', () => {
    for (const id of PR02_FOLLOW_UP_SCENARIO_IDS) expect(CARD_TEST_SCENARIO_IDS).toContain(id);
    expect(labSpec).toContain('PR02_FOLLOW_UP_SCENARIO_IDS.includes');
    expect(pr02Spec).toContain('exercised.add(id)');
    expect(pr02Spec).toContain(
      'expect([...exercised].sort()).toEqual([...PR02_FOLLOW_UP_SCENARIO_IDS].sort())',
    );
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
      const scenario = createCardTestScenario(scenarioId, 'gate-check' as GameId);
      expect(scenario, scenarioId).not.toBeNull();
    }
    // The Playwright process records the IDs actually selected from the live catalog. Its
    // afterAll equality check fails when a registered scenario is skipped or selected twice.
    // The CI assertion below guarantees that this runtime check is executed.
    expect(labSpec).toContain('const catalogScenarioIds = new Set<string>()');
    expect(labSpec).toContain('const exercisedScenarioIds = new Set<string>()');
    expect(labSpec).toContain('const scenarioId = await picker.inputValue()');
    expect(labSpec).toContain('exercisedScenarioIds.add(scenarioId)');
    expect(labSpec).toContain(
      'expect([...exercisedScenarioIds].sort()).toEqual([...catalogScenarioIds].sort())',
    );
    // The lab spec must never mock its transport: mocked UI checks are not viewer evidence.
    expect(labSpec).not.toContain('routeWebSocket');
    expect(labSpec).not.toContain('page.route(');
    expect(labSpec).toContain("trace: 'on'");
  });

  it('keeps passing-run traces as retained evidence', () => {
    expect(playwrightConfig).toContain("preserveOutput: 'always'");
    expect(playwrightConfig).toContain('--card-test-lab');
  });

  it('runs the viewer evidence job in CI and uploads traces', () => {
    expect(workflow).toContain('name: Viewer / Card Test Lab evidence');
    expect(workflow).toContain('bun run test:e2e');
    expect(workflow).toContain('card-test-lab-traces');
    expect(workflow).toContain('if-no-files-found: error');
  });
});

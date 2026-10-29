import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scenarioAction, scenarioTargets } from '@mtg/engine';
import type { GameId } from '@mtg/shared';
import { CARD_TEST_SCENARIO_IDS } from './card-test-scenarios';
import {
  RUNNER_SCENARIOS,
  RUNNER_SCENARIO_FILES,
  runnerClauseIds,
  runnerScenario,
} from './runner-scenarios';

describe('runner scenarios in the Card Test Lab', () => {
  it('reads every scenario file in engine/tests/scenarios, and nothing else', () => {
    const directory = new URL('../../../engine/tests/scenarios/', import.meta.url);
    expect(RUNNER_SCENARIO_FILES.map(({ name }) => name)).toEqual(
      readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .sort(),
    );
  });

  it('lists every scenario file entry once, under its own id', () => {
    const ids = RUNNER_SCENARIOS.map(({ id }) => id);
    expect(ids).toContain('path-to-exile-search');
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids)
      expect(CARD_TEST_SCENARIO_IDS.filter((other) => other === id)).toEqual([id]);
  });

  it('reaches the outcome the engine test checks when P1 plays its steps', () => {
    const scenario = runnerScenario('path-to-exile-search', 'lab-runner-test' as GameId);
    expect(scenario.metadata.clauseIds).toEqual(runnerClauseIds('Path to Exile', [1]));
    const { engine } = scenario;
    const p1Steps = [
      { player: 'P1' as const, choose: '/^Cast Path to Exile/', targets: ['Scenario Bear'] },
    ];
    for (let count = 0; count < 200; count++) {
      const step = engine.advance();
      if (step.kind !== 'decision') continue;
      const request = step.request;
      if (request.decidingPlayer === 'P1') {
        const action = scenarioAction(request, p1Steps[0]);
        if (action === null) {
          if (engine.getState().stack.length === 0 && p1Steps.length === 0) break;
          const pass = request.legalActions.find((candidate) => candidate.type === 'pass')!;
          engine.submit({ requestId: request.requestId, actionId: pass.id });
          continue;
        }
        const targets = scenarioTargets(engine.getState(), request, action, p1Steps[0]!);
        engine.submit({
          requestId: request.requestId,
          actionId: action.id,
          ...(targets && { targets }),
        });
        p1Steps.shift();
        continue;
      }
      engine.submit(scenario.decisionProviderOverrides![request.decidingPlayer]!.decide(request));
    }
    const state = engine.getState();
    expect(state.exile.map((card) => card.name)).toContain('Scenario Bear');
    expect(
      state.battlefield.filter((perm) => perm.controllerId === 'P2' && perm.name === 'Plains'),
    ).toHaveLength(1);
  });
});

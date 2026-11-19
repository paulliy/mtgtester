/** Turn Aside (common blocking lines, PR #89): scenarios in ../../scenarios/turn-aside.json. */
import { describe, expect, it } from 'vitest';
import {
  buildCardScenario,
  scenarioAction,
  scenarioTargets,
  type CardScenario,
} from '../../../src/testing/card-scenario';
import {
  loadScenarioFile,
  resolveScenarioCard,
  runScenario,
  scenarioFailures,
} from '../../scenario/runner';

const file = loadScenarioFile(new URL('../../scenarios/turn-aside.json', import.meta.url));

describe('Turn Aside', () => {
  it.each(file.scenarios.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(scenarioFailures(runScenario(file, entry), entry)).toEqual([]);
  });

  /** What P1 is offered at the first priority it gets while P2's spell is on the stack. */
  function offeredWithSpellOnStack(scenario: CardScenario): string[] {
    const { engine } = buildCardScenario(file, scenario, resolveScenarioCard, {
      gameId: `offer-${scenario.id}`,
      strictInvariants: true,
    });
    let next = 0;
    for (let count = 0; count < 500; count++) {
      const stepResult = engine.advance();
      if (stepResult.kind === 'gameOver') return [];
      if (stepResult.kind === 'continue') continue;
      const request = stepResult.request;
      const step = scenario.script[next];
      const action = scenarioAction(request, step);
      if (action !== null) {
        engine.submit({
          requestId: request.requestId,
          actionId: action.id,
          ...(action.targets !== undefined
            ? { targets: scenarioTargets(engine.getState(), request, action, step!) ?? [] }
            : {}),
        });
        next += 1;
        continue;
      }
      if (
        next >= scenario.script.length &&
        request.decidingPlayer === 'P1' &&
        engine.getState().stack.length > 0
      )
        return request.legalActions.map((candidate) => candidate.description);
      const pass = request.legalActions.find((candidate) => candidate.type === 'pass');
      if (pass === undefined) throw new Error(`${scenario.id}: unexpected decision`);
      engine.submit({ requestId: request.requestId, actionId: pass.id });
    }
    throw new Error(`${scenario.id}: no end`);
  }

  it('turn-aside-spell-targeting-opponents-permanent-not-counterable: Turn Aside is not offered, but is when the spell targets your permanent', () => {
    const scenario = (id: string) => file.scenarios.find((entry) => entry.id === id)!;
    const negative = scenario('turn-aside-spell-targeting-opponents-permanent-not-counterable');
    expect(
      offeredWithSpellOnStack(negative).some((text) => text.startsWith('Cast Turn Aside')),
    ).toBe(false);
    // Control: the same position with P2's spell aimed at P1's Scenario Bear offers it.
    const control = {
      ...scenario('turn-aside-counters-spell-targeting-your-permanent'),
      script: scenario('turn-aside-counters-spell-targeting-your-permanent').script.slice(0, 1),
    };
    expect(
      offeredWithSpellOnStack(control).some((text) => text.startsWith('Cast Turn Aside')),
    ).toBe(true);
  });
});

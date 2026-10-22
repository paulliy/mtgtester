import { describe, expect, it } from 'vitest';
import { formatPlayerLog } from '@mtg/engine';
import { createCardTestScenario } from './card-test-scenarios';

function replay(mode: 'duplicates' | 'decline' | 'shroud') {
  const scenario = createCardTestScenario(
    `druid-of-purification-viewer-${mode}`,
    'pr08-druid-replay',
  )!;
  expect(scenario).not.toBeNull();
  const chosenName = mode === 'shroud' ? 'Lab Shrouded Artifact' : 'Lab Shared Artifact';
  const choices: string[] = [];
  let cast = false,
    sawSpell = false,
    sawTrigger = false,
    decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    const state = scenario.engine.getState();
    sawSpell ||= state.stack.some(
      (item) => item.kind === 'spell' && item.description === 'Druid of Purification',
    );
    sawTrigger ||= state.stack.some(
      (item) => item.kind === 'triggeredAbility' && item.description.includes('Starting with you'),
    );
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (++decisions > 150) throw new Error('Druid lab did not terminate');
    const request = step.request;
    const isChoice = request.legalActions.some((a) => a.description === `Destroy ${chosenName}`);
    let action = request.legalActions.find((a) => a.type === 'pass') ?? request.legalActions[0]!;
    if (!cast && request.decidingPlayer === 'P1') {
      const castAction = request.legalActions.find(
        (a) => a.type === 'castSpell' && a.description.includes('Druid of Purification'),
      );
      if (castAction) {
        action = castAction;
        cast = true;
      }
    }
    if (isChoice) {
      expect(state.battlefield.some((p) => p.name === chosenName)).toBe(true);
      expect(state.eventLog.filter((e) => e.type === 'destroy')).toHaveLength(0);
      expect(request.prompt).toContain("P1 doesn't control");
      expect(request.legalActions.map((a) => a.description)).not.toContain(
        'Destroy Lab Own Artifact',
      );
      expect(request.legalActions.map((a) => a.description)).toContain(`Destroy ${chosenName}`);
      expect(
        formatPlayerLog(state.eventLog, request.decidingPlayer).filter(
          (e) => e.text.includes('Druid of Purification') && e.text.includes(': chooses '),
        ),
      ).toHaveLength(choices.length);
      choices.push(request.decidingPlayer);
      action = request.legalActions.find((a) =>
        mode === 'decline' ? a.type === 'decline' : a.description === `Destroy ${chosenName}`,
      )!;
      expect(action).toBeDefined();
    }
    scenario.engine.submit({ requestId: request.requestId, actionId: action.id });
  }
  expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
  expect({ cast, sawSpell, sawTrigger }).toEqual({ cast: true, sawSpell: true, sawTrigger: true });
  expect(choices).toEqual(['P1', 'P2', 'P3', 'P4']);
  const state = scenario.engine.getState();
  expect(state.battlefield.some((p) => p.name === 'Druid of Purification')).toBe(true);
  expect(state.battlefield.some((p) => p.name === 'Lab Own Artifact')).toBe(true);
  expect(state.battlefield.some((p) => p.name === chosenName)).toBe(mode === 'decline');
  expect(state.eventLog.filter((e) => e.type === 'destroy')).toHaveLength(
    mode === 'decline' ? 0 : 1,
  );
  expect(
    state.eventLog.filter((e) => e.type === 'permanentChoice').map((e) => e.payload['name']),
  ).toEqual(Array.from({ length: 4 }, () => (mode === 'decline' ? null : chosenName)));
  expect(
    state.eventLog.filter(
      (e) => e.type === 'castSpell' && e.payload['name'] === 'Druid of Purification',
    ),
  ).toHaveLength(1);
  expect(
    state.battlefield
      .filter((p) => p.name === 'Forest' && p.controllerId === 'P1')
      .every((p) => p.tapped),
  ).toBe(true);
  return state.eventLog;
}

describe('Druid of Purification Card Test Lab', () => {
  it.each(['duplicates', 'decline', 'shroud'] as const)(
    'druid-lab-replay — %s is deterministic through real casting',
    (mode) => {
      expect(replay(mode)).toEqual(replay(mode));
    },
  );
});

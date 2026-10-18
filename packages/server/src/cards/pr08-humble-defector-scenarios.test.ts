import { describe, expect, it } from 'vitest';
import { createCardTestScenario } from './card-test-scenarios';

function replay(offTurn: boolean) {
  const id = offTurn
    ? 'humble-defector-viewer-off-turn'
    : 'humble-defector-viewer-draw-then-opponent-takes-control';
  const scenario = createCardTestScenario(id, 'pr08-humble-replay')!;
  expect(scenario).not.toBeNull();
  let activated = false,
    sawStack = false,
    sawPaidTap = false,
    checkedOffTurn = false,
    decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    const state = scenario.engine.getState();
    const source = state.battlefield.find((p) => p.name === 'Humble Defector')!;
    if (activated && state.stack.length > 0) {
      sawStack = true;
      sawPaidTap = source.tapped;
    }
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (++decisions > 100) throw new Error(`Humble ${id} did not finish`);
    const req = step.request,
      actions = req.legalActions;
    const ability = actions.find(
      (a) => a.type === 'activateAbility' && a.description.includes('Draw two cards'),
    );
    let action = actions.find((a) => a.type === 'pass') ?? actions[0]!;
    let targets: Array<{ slot: number; choice: string }> | undefined;
    if (req.decidingPlayer === 'P1') {
      if (offTurn) {
        expect(state.turnOrder[state.activePlayerIndex]).toBe('P2');
        expect(ability).toBeUndefined();
        expect(
          actions.some(
            (a) => a.type === 'castSpell' && a.description.includes('Lab Priority Witness'),
          ),
        ).toBe(true);
        checkedOffTurn = true;
      } else if (!activated && ability) {
        action = ability;
        activated = true;
        const slots = ability.targets;
        expect(slots?.[0]?.options.slice().sort()).toEqual(['P2', 'P3', 'P4']);
        targets = [{ slot: slots![0]!.slot, choice: 'P3' }];
      }
    }
    scenario.engine.submit({
      requestId: req.requestId,
      actionId: action.id,
      ...(targets ? { targets } : {}),
    });
  }
  expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
  const state = scenario.engine.getState();
  const source = state.battlefield.find((p) => p.name === 'Humble Defector')!;
  if (offTurn) {
    expect(checkedOffTurn).toBe(true);
    expect(source).toMatchObject({ controllerId: 'P1', tapped: false });
    expect(activated).toBe(false);
  } else {
    expect(activated && sawStack && sawPaidTap).toBe(true);
    expect(source).toMatchObject({ controllerId: 'P3', tapped: true });
    expect(state.players.find((p) => p.id === 'P1')!.hand).toHaveLength(3);
    for (const seat of ['P2', 'P3', 'P4'])
      expect(state.players.find((p) => p.id === seat)!.hand).toHaveLength(0);
    expect(state.eventLog.filter((e) => e.type === 'draw').map((e) => e.payload['player'])).toEqual(
      ['P1', 'P1'],
    );
  }
  return state.eventLog;
}
describe('Humble Defector Card Test Lab', () => {
  it.each([false, true])(
    'humble-defector-lab-replay — normal priority path, off-turn=%s',
    (offTurn) => {
      expect(replay(offTurn)).toEqual(replay(offTurn));
    },
  );
});

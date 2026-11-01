import { describe, expect, it } from 'vitest';
import { strictCardTestScenario } from './card-test-scenarios';

function replay(mode: 'graft-yes' | 'graft-no' | 'control-duration') {
  const scenario = strictCardTestScenario(
    `cytoplast-manipulator-viewer-${mode}`,
    'pr08-cytoplast-test',
  )!;
  expect(scenario).not.toBeNull();
  let cast = false,
    servo = false,
    activated = false,
    recalled = false,
    sawControl = false,
    optional = false;
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    const state = scenario.engine.getState();
    const source = state.battlefield.find((p) => p.name === 'Cytoplast Manipulator');
    const ox = state.battlefield.find((p) => p.name === 'Lab Ox');
    if (ox?.controllerId === 'P1') {
      sawControl = true;
      expect(ox.tapped).toBe(true);
    }
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (++decisions > 100) throw new Error(`Cytoplast ${mode} failed to finish`);
    const req = step.request;
    const actions = req.legalActions;
    let action = actions.find((a) => a.type === 'pass') ?? actions[0]!;
    let targets: Array<{ slot: number; choice: string }> | undefined;
    if (req.decidingPlayer === 'P1') {
      const castAction = actions.find(
        (a) => a.type === 'castSpell' && a.description.startsWith('Cast Cytoplast Manipulator'),
      );
      const servoAction = actions.find(
        (a) => a.type === 'castSpell' && a.description.startsWith('Cast Lab Servo'),
      );
      const activateAction = actions.find(
        (a) => a.type === 'activateAbility' && a.description.includes('Gain control'),
      );
      const recallAction = actions.find(
        (a) => a.type === 'castSpell' && a.description.startsWith('Cast Lab Source Recall'),
      );
      if (!cast && mode !== 'control-duration' && castAction) {
        action = castAction;
        cast = true;
      } else if (!servo && source && state.stack.length === 0 && servoAction) {
        action = servoAction;
        servo = true;
      } else if (mode === 'control-duration' && !activated && activateAction) {
        action = activateAction;
        activated = true;
        const slot = action.targets?.[0];
        expect(slot).toBeDefined();
        const bare = state.battlefield.find((p) => p.name === 'Lab Servo')!;
        expect(slot!.options).not.toContain(bare.id);
        expect(slot!.options).toContain(ox!.id);
        targets = [{ slot: slot!.slot, choice: ox!.id }];
      } else if (sawControl && !recalled && state.stack.length === 0 && recallAction) {
        action = recallAction;
        recalled = true;
        targets = [{ slot: action.targets![0]!.slot, choice: source!.id }];
      } else if (/use this ability/i.test(req.prompt ?? '')) {
        action = actions.find((a) => a.description === (mode === 'graft-yes' ? 'Yes' : 'No'))!;
        expect(action).toBeDefined();
        optional = true;
      }
    }
    scenario.engine.submit({
      requestId: req.requestId,
      actionId: action.id,
      ...(targets ? { targets } : {}),
    });
  }
  expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
  return {
    state: scenario.engine.getState(),
    cast,
    servo,
    activated,
    recalled,
    sawControl,
    optional,
  };
}

describe('Cytoplast Manipulator Card Test Lab', () => {
  it.each(['graft-yes', 'graft-no'] as const)(
    'cytoplast-manipulator-viewer-%s — normal casts and the chosen optional graft outcome',
    (mode) => {
      const first = replay(mode),
        second = replay(mode);
      expect(first.state.eventLog).toEqual(second.state.eventLog);
      expect(first.cast && first.servo && first.optional).toBe(true);
      const source = first.state.battlefield.find((p) => p.name === 'Cytoplast Manipulator')!;
      const servo = first.state.battlefield.find((p) => p.name === 'Lab Servo')!;
      expect(source.counters['+1/+1']).toBe(mode === 'graft-yes' ? 1 : 2);
      expect(servo.counters['+1/+1'] ?? 0).toBe(mode === 'graft-yes' ? 1 : 0);
      expect(
        first.state.eventLog.filter((e) => e.type === 'castSpell').map((e) => e.payload['name']),
      ).toEqual(['Cytoplast Manipulator', 'Lab Servo']);
    },
  );
  it('cytoplast-manipulator-viewer-control-duration — paid activation steals until the source leaves', () => {
    const first = replay('control-duration'),
      second = replay('control-duration');
    expect(first.state.eventLog).toEqual(second.state.eventLog);
    expect(first.activated && first.sawControl && first.recalled).toBe(true);
    expect(first.state.battlefield.find((p) => p.name === 'Lab Ox')).toMatchObject({
      controllerId: 'P2',
      tapped: true,
    });
    expect(first.state.battlefield.find((p) => p.name === 'Cytoplast Manipulator')).toBeUndefined();
    expect(
      first.state.players
        .find((p) => p.id === 'P1')!
        .hand.some((c) => c.name === 'Cytoplast Manipulator'),
    ).toBe(true);
  });
});

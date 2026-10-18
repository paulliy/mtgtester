import { describe, expect, it } from 'vitest';
import { formatPlayerLog } from '@mtg/engine';
import { createCardTestScenario } from './card-test-scenarios';

function replay(mode: 'cast-search-and-gift' | 'empty-library' | 'off-turn') {
  const scenario = createCardTestScenario(
    `wishclaw-talisman-viewer-${mode}`,
    'pr08-wishclaw-replay',
  )!;
  expect(scenario).not.toBeNull();
  const normalCast = mode === 'cast-search-and-gift';
  let cast = false,
    activated = false,
    sawCastStack = false,
    sawAbilityStack = false,
    sawFind = false,
    sawGift = false,
    checkedOffTurn = false,
    decisions = 0;
  for (;;) {
    const step = scenario.engine.advance(),
      state = scenario.engine.getState();
    const source = state.battlefield.find((p) => p.name === 'Wishclaw Talisman');
    const p1 = state.players.find((p) => p.id === 'P1')!;
    if (
      state.stack.some((item) => item.kind === 'spell' && item.description === 'Wishclaw Talisman')
    ) {
      sawCastStack = true;
      expect(state.battlefield.filter((p) => p.name === 'Swamp' && p.tapped)).toHaveLength(2);
    }
    if (
      state.stack.some(
        (item) =>
          item.kind === 'activatedAbility' && item.description.includes('Search your library'),
      )
    ) {
      sawAbilityStack = true;
      expect(source).toMatchObject({ controllerId: 'P1', tapped: true, counters: { wish: 2 } });
      expect(state.battlefield.filter((p) => p.name === 'Swamp' && p.tapped)).toHaveLength(
        normalCast ? 3 : 1,
      );
    }
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    if (++decisions > 120) throw Error('Wishclaw lab did not terminate');
    const request = step.request,
      actions = request.legalActions;
    const activation = actions.find(
      (a) => a.type === 'activateAbility' && a.description.includes('Search your library'),
    );
    let action = actions.find((a) => a.type === 'pass') ?? actions[0]!;
    if (request.decidingPlayer === 'P1') {
      if (mode === 'off-turn') {
        expect(state.turnOrder[state.activePlayerIndex]).toBe('P2');
        expect(activation).toBeUndefined();
        expect(
          actions.some(
            (a) => a.type === 'castSpell' && a.description.includes('Lab Priority Witness'),
          ),
        ).toBe(true);
        checkedOffTurn = true;
      } else if (normalCast && !cast) {
        const option = actions.find(
          (a) => a.type === 'castSpell' && a.description.includes('Wishclaw Talisman'),
        );
        if (option) {
          action = option;
          cast = true;
        }
      } else if (!activated && activation) {
        expect(source?.counters['wish']).toBe(3);
        expect(activation.targets ?? []).toEqual([]);
        action = activation;
        activated = true;
      }
    }
    if (actions.some((a) => a.type === 'findCard')) {
      expect(mode).toBe('cast-search-and-gift');
      expect(request.decidingPlayer).toBe('P1');
      expect(actions.some((a) => a.type === 'findNothing')).toBe(false);
      sawFind = true;
      action = actions.find((a) => a.description === 'Put Lab Wishclaw Beta into your hand')!;
      expect(action).toBeDefined();
    }
    if (actions.some((a) => a.type === 'choosePlayer')) {
      expect(request.decidingPlayer).toBe('P1');
      sawGift = true;
      expect(source).toMatchObject({ controllerId: 'P1', tapped: true, counters: { wish: 2 } });
      expect(state.eventLog.filter((e) => e.type === 'shuffle')).toHaveLength(1);
      expect(p1.hand.some((c) => c.name === 'Lab Wishclaw Beta')).toBe(normalCast);
      expect(actions.map((a) => a.description)).toEqual([
        'P2 gains control of Wishclaw Talisman',
        'P3 gains control of Wishclaw Talisman',
        'P4 gains control of Wishclaw Talisman',
      ]);
      expect(
        actions.every(
          (a) =>
            a.interaction?.kind === 'choice' &&
            a.interaction.subjectId === undefined &&
            (a.targets ?? []).length === 0,
        ),
      ).toBe(true);
      for (const seat of ['P2', 'P3', 'P4'])
        expect(
          formatPlayerLog(state.eventLog, seat).some((line) =>
            line.text.includes('Lab Wishclaw Beta'),
          ),
        ).toBe(false);
      action = actions[1]!;
    }
    scenario.engine.submit({ requestId: request.requestId, actionId: action.id });
  }
  expect(scenario.engine.getResult()?.haltReason ?? null).toBeNull();
  const state = scenario.engine.getState(),
    source = state.battlefield.find((p) => p.name === 'Wishclaw Talisman');
  if (mode === 'off-turn') {
    expect(checkedOffTurn).toBe(true);
    expect(activated).toBe(false);
    expect(source).toMatchObject({ controllerId: 'P1', tapped: false, counters: { wish: 3 } });
  } else {
    expect(activated && sawAbilityStack && sawGift).toBe(true);
    expect(sawFind).toBe(normalCast);
    expect(cast && sawCastStack).toBe(normalCast);
    expect(source).toMatchObject({ controllerId: 'P3', tapped: true, counters: { wish: 2 } });
    expect(state.players.find((p) => p.id === 'P1')!.hand).toHaveLength(normalCast ? 2 : 1);
  }
  return state.eventLog;
}
describe('Wishclaw Talisman Card Test Lab', () => {
  it.each(['cast-search-and-gift', 'empty-library', 'off-turn'] as const)(
    'wishclaw-lab-replay — %s follows normal priority deterministically',
    (mode) => {
      expect(replay(mode)).toEqual(replay(mode));
    },
  );
});

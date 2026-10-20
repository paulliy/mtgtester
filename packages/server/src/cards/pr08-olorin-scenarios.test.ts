import { describe, expect, it } from 'vitest';
import { OLORIN_SCENARIO_IDS, pr08OlorinScenario } from './pr08-olorin-scenarios';

describe('pinned Olórin viewer scenarios', () => {
  it.each(OLORIN_SCENARIO_IDS)(
    '%s uses a normal paid cast and the correct mastery threshold',
    (id) => {
      const scenario = pr08OlorinScenario(id, `test-${id}`);
      let cast = false,
        count = 0;
      for (;;) {
        const step = scenario.engine.advance();
        if (step.kind === 'gameOver') break;
        if (step.kind === 'continue') continue;
        const request = step.request;
        const action =
          (!cast
            ? request.legalActions.find(
                (action) =>
                  action.type === 'castSpell' && action.description.includes('Searing Light'),
              )
            : undefined) ??
          request.legalActions.find((action) => action.type === 'pass') ??
          request.legalActions[0]!;
        if (action.type === 'castSpell') cast = true;
        scenario.engine.submit({ requestId: request.requestId, actionId: action.id });
        if (++count > 250) throw new Error('Olórin scenario exceeded decision limit');
      }
      expect(cast).toBe(true);
      const state = scenario.engine.getState();
      expect(state.exile.some((card) => card.name === 'Lab Greatest Bear')).toBe(true);
      expect(state.battlefield.some((card) => card.name === 'Lab Lesser Bear')).toBe(true);
      expect(state.players.find((player) => player.id === 'P2')!.life).toBe(
        id === OLORIN_SCENARIO_IDS[0] ? 36 : 40,
      );
      expect(
        state.eventLog.filter((event) => event.type === 'tapForMana' && event.actorSeat === 'P1'),
      ).toHaveLength(4);
    },
  );
});

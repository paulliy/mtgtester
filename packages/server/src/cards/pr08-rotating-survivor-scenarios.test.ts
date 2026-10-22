import { describe, expect, it } from 'vitest';
import {
  ROTATING_SURVIVOR_SCENARIO_IDS,
  pr08RotatingSurvivorScenario,
} from './pr08-rotating-survivor-scenarios';

describe('pinned rotating control and Survivor viewer scenarios', () => {
  it.each(ROTATING_SURVIVOR_SCENARIO_IDS)(
    '%s follows ordinary casting, priority, combat and triggers',
    (id) => {
      const scenario = pr08RotatingSurvivorScenario(id, `test-${id}`);
      let cast = false,
        count = 0;
      for (;;) {
        const step = scenario.engine.advance();
        if (step.kind === 'gameOver') break;
        if (step.kind === 'continue') continue;
        const request = step.request;
        if (request.decidingPlayer === 'P2')
          scenario.engine.submit(scenario.decisionProviderOverrides!['P2']!.decide(request));
        else {
          let action = !cast
            ? request.legalActions.find((action) => action.type === 'castSpell')
            : undefined;
          let targets: { slot: number; choice: string }[] | undefined;
          if (action) cast = true;
          if (request.decisionType === 'declareAttackers') {
            action = request.legalActions.find((action) => action.type === 'attackDeclaration');
            if (action)
              targets = action.targets?.map((slot) => ({ slot: slot.slot, choice: 'P2' }));
          }
          action ??=
            request.legalActions.find((action) => action.type === 'pass') ??
            request.legalActions[0]!;
          scenario.engine.submit({
            requestId: request.requestId,
            actionId: action.id,
            ...(targets ? { targets } : {}),
          });
        }
        if (++count > 300) throw new Error('Rotating Survivor decision limit');
      }
      const state = scenario.engine.getState();
      if (id === ROTATING_SURVIVOR_SCENARIO_IDS[0]) {
        expect(cast).toBe(true);
        const source = state.battlefield.find((card) => card.name.startsWith('Alexios'))!;
        expect(source.controllerId).toBe('P2');
        expect(source.counters['+1/+1']).toBe(1);
        expect(source.tapped).toBe(false);
      } else if (id === ROTATING_SURVIVOR_SCENARIO_IDS[1]) {
        expect(cast).toBe(true);
        expect(state.players[0]!.graveyard.some((card) => card.name.startsWith('Varchild'))).toBe(
          true,
        );
        expect(
          state.battlefield.filter(
            (card) => card.name === 'Lab Survivor' && card.controllerId === 'P1',
          ),
        ).toHaveLength(2);
      } else {
        expect(state.players[1]!.life).toBe(37);
        expect(
          state.battlefield.filter(
            (card) => card.name === 'Survivor' && card.controllerId === 'P2',
          ),
        ).toHaveLength(3);
      }
    },
  );
});

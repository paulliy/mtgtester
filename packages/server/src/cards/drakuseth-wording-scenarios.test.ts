import { describe, expect, it } from 'vitest';
import type { DecisionResponse } from '@mtg/shared';
import {
  DRAKUSETH_WORDING_SCENARIO_IDS,
  drakusethWordingScenario,
  drakusethWordingScenarioDetails,
  drakusethWordingScenarioSubject,
} from './drakuseth-wording-scenarios';

function run(id: (typeof DRAKUSETH_WORDING_SCENARIO_IDS)[number]) {
  const scenario = drakusethWordingScenario(id, `drakuseth-wording-${id}`);
  let cast = false;
  let castAtPrintedCost = false;
  let attacked = false;
  let p2LifeBeforeAttack: number | undefined;
  let declinedAscendancy = false;
  let fixedTarget: string | undefined;
  const otherTargets: string[] = [];
  let decisions = 0;

  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request;
    let response: DecisionResponse;
    if (request.decidingPlayer !== 'P1') {
      const provider =
        scenario.decisionProviderOverrides?.[request.decidingPlayer as 'P2' | 'P3' | 'P4'];
      const pass =
        request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
      response = provider?.decide(request) ?? { requestId: request.requestId, actionId: pass.id };
    } else {
      const actions = request.legalActions;
      const castAction = !cast
        ? actions.find(
            (action) =>
              action.type === 'castSpell' && action.description.startsWith('Cast Drakuseth'),
          )
        : undefined;
      const declineDraw =
        request.decisionType === 'optionalTrigger'
          ? actions.find((action) => action.description === 'No')
          : undefined;
      const attack =
        request.decisionType === 'declareAttackers'
          ? actions.find((action) => action.description.startsWith('Declare attackers'))
          : undefined;
      const fixedDamage =
        request.decisionType === 'chooseTargets'
          ? actions.find((action) => action.description.startsWith('Targets for Drakuseth'))
          : undefined;
      const chooseOther =
        request.decisionType === 'general' && request.prompt.includes('Drakuseth')
          ? id.endsWith('three-targets')
            ? actions.find(
                (action) =>
                  action.description === `Target ${otherTargets.length === 0 ? 'P3' : 'P4'}`,
              )
            : actions.find((action) => action.description === 'Choose no more targets')
          : undefined;
      const pass = actions.find((action) => action.type === 'pass') ?? actions[0]!;
      const action = castAction ?? declineDraw ?? attack ?? fixedDamage ?? chooseOther ?? pass;
      const targets = (action.targets ?? []).map((slot) => ({
        slot: slot.slot,
        choice: slot.options.includes('P2') ? 'P2' : slot.options[0]!,
      }));
      if (castAction) {
        cast = true;
        castAtPrintedCost =
          castAction.description.includes('{4}{R}{R}{R}') &&
          !castAction.description.includes('without paying');
      }
      if (declineDraw) declinedAscendancy = true;
      if (attack) {
        attacked = true;
        p2LifeBeforeAttack = scenario.engine
          .getState()
          .players.find((player) => player.id === 'P2')!.life;
      }
      if (fixedDamage) fixedTarget = targets[0]?.choice;
      if (chooseOther && action.description.startsWith('Target '))
        otherTargets.push(action.description.slice('Target '.length));
      response = {
        requestId: request.requestId,
        actionId: action.id,
        ...(targets.length ? { targets } : {}),
      };
    }
    scenario.engine.submit(response);
    if (++decisions > 300) throw new Error(`${id} exceeded 300 decisions`);
  }

  return {
    scenario,
    cast,
    castAtPrintedCost,
    attacked,
    p2LifeBeforeAttack,
    declinedAscendancy,
    fixedTarget,
    otherTargets,
    decisions,
  };
}

describe('Drakuseth current-wording viewer scenarios', () => {
  it('does not offer the normal cast with only six Mountains', () => {
    const scenario = drakusethWordingScenario(
      DRAKUSETH_WORDING_SCENARIO_IDS[0],
      'drakuseth-insufficient-mana',
      6,
    );
    for (let decisions = 0; ; decisions++) {
      if (decisions > 100) throw new Error('Insufficient-mana scenario failed to terminate');
      const step = scenario.engine.advance();
      if (step.kind === 'gameOver') break;
      if (step.kind === 'continue') continue;
      expect(
        step.request.legalActions.some((action) => action.description.startsWith('Cast Drakuseth')),
      ).toBe(false);
      const action =
        step.request.legalActions.find((candidate) => candidate.type === 'pass') ??
        step.request.legalActions[0]!;
      scenario.engine.submit({ requestId: step.request.requestId, actionId: action.id });
    }
    expect(
      scenario.engine
        .getState()
        .battlefield.some((card) => card.name === 'Drakuseth, Maw of Flames'),
    ).toBe(false);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      false,
    );
  });
  it.each(DRAKUSETH_WORDING_SCENARIO_IDS)(
    '%s casts, attacks, and resolves the printed damage',
    (id) => {
      const result = run(id);
      const { scenario } = result;
      const state = scenario.engine.getState();
      const current = drakusethWordingScenarioSubject(id);
      const source = state.battlefield.find((permanent) => permanent.name === current);
      const expectedOthers = id.endsWith('three-targets') ? ['P3', 'P4'] : [];

      expect(result.cast).toBe(true);
      expect(result.castAtPrintedCost).toBe(true);
      expect(result.attacked).toBe(true);
      expect(result.p2LifeBeforeAttack).toBe(40);
      expect(result.declinedAscendancy).toBe(true);
      expect(result.decisions).toBeLessThanOrEqual(300);
      expect(result.fixedTarget).toBe('P2');
      expect(result.otherTargets).toEqual(expectedOthers);
      expect(new Set(result.otherTargets).size).toBe(result.otherTargets.length);
      expect(source).toMatchObject({
        typeLine: expect.stringContaining('Creature'),
        power: 7,
        toughness: 7,
      });
      expect(source?.oracleText).toContain('Flying');
      expect(state.players.find((player) => player.id === 'P2')!.life).toBe(29);
      expect(state.players.find((player) => player.id === 'P3')!.life).toBe(
        expectedOthers.includes('P3') ? 37 : 40,
      );
      expect(state.players.find((player) => player.id === 'P4')!.life).toBe(
        expectedOthers.includes('P4') ? 37 : 40,
      );
      const castEvent = state.eventLog.find(
        (event) => event.type === 'castSpell' && event.payload['name'] === current,
      );
      expect(castEvent).toBeDefined();
      expect(scenario.metadata.oracleSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(drakuDetails(id).expected).toBe(scenario.metadata.expectedOutcome);
    },
  );
});

function drakuDetails(id: string) {
  return drakusethWordingScenarioDetails(id);
}

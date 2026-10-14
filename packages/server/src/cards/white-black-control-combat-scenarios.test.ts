import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WHITE_BLACK_COMBAT_SCENARIO_IDS,
  whiteBlackControlCombatScenario,
} from './white-black-control-combat-scenarios';

interface RunResult {
  eventLogHash: string;
  decisionTrace: Array<{
    player: string;
    decisionType: string;
    action: string;
    targetChoices: string[];
  }>;
  result: ReturnType<ReturnType<typeof whiteBlackControlCombatScenario>['engine']['advance']>;
  engine: ReturnType<typeof whiteBlackControlCombatScenario>['engine'];
}

function runScenario(id: string): RunResult {
  const scenario = whiteBlackControlCombatScenario(id, `lab-test-${id}` as never);
  const engine = scenario.engine;
  const decisionTrace: RunResult['decisionTrace'] = [];
  let castFromHand = false;
  let gameOver: RunResult['result'] | null = null;

  for (let stepCount = 0; stepCount < 80; stepCount++) {
    const step = engine.advance();
    if (step.kind === 'continue') continue;
    if (step.kind === 'gameOver') {
      gameOver = step;
      break;
    }

    const request = step.request;
    let action = undefined;
    const targetChoices: string[] = [];

    if (request.decidingPlayer === 'P1' && request.decisionType === 'priority' && !castFromHand) {
      action = request.legalActions.find(
        (candidate) =>
          candidate.type === 'castSpell' &&
          candidate.description.includes(
            scenario.metadata.title.startsWith('Breena') ? 'Breena' : "Duelist's Heritage",
          ),
      );
      if (action !== undefined) castFromHand = true;
    }

    if (request.decisionType === 'declareAttackers') {
      action = request.legalActions.find((candidate) => candidate.type === 'attackDeclaration');
      expect(action).toBeDefined();
      for (const slot of action!.targets ?? []) {
        expect(slot.options).toContain('P2');
        targetChoices.push('P2');
      }
      expect(targetChoices).toHaveLength(2);
    } else if (request.decisionType === 'chooseTargets') {
      action = request.legalActions.find((candidate) => (candidate.targets?.length ?? 0) > 0);
      expect(action).toBeDefined();
      const alpha = engine
        .getState()
        .battlefield.find((permanent) => permanent.name === 'Lab Attack Witness Alpha');
      expect(alpha).toBeDefined();
      for (const slot of action!.targets ?? []) {
        expect(slot.options).toContain(alpha!.id);
        targetChoices.push(alpha!.id);
      }
    } else if (request.legalActions.some((candidate) => candidate.description === 'Yes')) {
      action = request.legalActions.find((candidate) => candidate.description === 'Yes');
    }

    action ??= request.legalActions.find((candidate) => candidate.type === 'pass');
    action ??= request.legalActions[0];
    expect(action).toBeDefined();
    decisionTrace.push({
      player: request.decidingPlayer,
      decisionType: request.decisionType,
      action: action!.description,
      targetChoices,
    });
    engine.submit({
      requestId: request.requestId,
      actionId: action!.id,
      targets: (action!.targets ?? []).map((slot) => ({
        slot: slot.slot,
        choice:
          request.decisionType === 'declareAttackers'
            ? 'P2'
            : (slot.options.find((candidate) => targetChoices.includes(candidate)) ??
              slot.options[0]!),
      })),
    });
  }

  expect(castFromHand).toBe(true);
  expect(gameOver).not.toBeNull();
  const eventLogHash = createHash('sha256')
    .update(JSON.stringify(engine.getState().eventLog))
    .digest('hex');
  return { eventLogHash, decisionTrace, result: gameOver!, engine };
}

describe('white-black control prepared combat scenarios', () => {
  it.each(WHITE_BLACK_COMBAT_SCENARIO_IDS)(
    '%s runs cast and combat through Engine deterministically',
    (id) => {
      const first = runScenario(id);
      const replay = runScenario(id);

      expect(first.result.kind).toBe('gameOver');
      if (first.result.kind !== 'gameOver') throw new Error('scenario did not finish');
      expect(first.result.result).toMatchObject({ halted: false, winnerSeat: null });
      expect(first.eventLogHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.eventLogHash).toBe(replay.eventLogHash);
      expect(first.decisionTrace).toEqual(replay.decisionTrace);
      expect(
        first.decisionTrace.some((decision) => decision.decisionType === 'declareAttackers'),
      ).toBe(true);
      expect(
        first.decisionTrace.filter((decision) => decision.decisionType === 'declareAttackers')[0]
          ?.targetChoices,
      ).toEqual(['P2', 'P2']);

      const state = first.engine.getState();
      expect(state.players.find((player) => player.id === 'P2')?.life).toBe(39);

      if (id === WHITE_BLACK_COMBAT_SCENARIO_IDS[0]) {
        expect(
          state.players.find((player) => player.id === 'P1')?.hand.map((card) => card.name),
        ).toEqual(['Lab Breena Draw']);
        expect(
          state.battlefield.find((permanent) => permanent.name === 'Lab Attack Witness Alpha')
            ?.counters['+1/+1'],
        ).toBe(2);
        expect(
          state.battlefield.find((permanent) => permanent.name === 'Lab Attack Witness Beta')
            ?.counters['+1/+1'] ?? 0,
        ).toBe(0);
        expect(
          first.decisionTrace.filter((decision) => decision.decisionType === 'chooseTargets'),
        ).toHaveLength(1);
      } else {
        const view = first.engine.view('P1');
        expect(
          view.battlefield.find((permanent) => permanent.name === 'Lab Attack Witness Alpha')
            ?.keywords,
        ).toContain('double strike');
        expect(
          view.battlefield.find((permanent) => permanent.name === 'Lab Attack Witness Beta')
            ?.keywords ?? [],
        ).not.toContain('double strike');
        expect(first.decisionTrace.filter((decision) => decision.action === 'Yes')).toHaveLength(1);
        expect(
          first.decisionTrace.filter((decision) => decision.decisionType === 'chooseTargets'),
        ).toHaveLength(1);
      }
    },
  );
});

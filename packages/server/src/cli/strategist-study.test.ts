/**
 * The study over a small offline capture: evaluators resolve by name (an unknown one is refused),
 * incomplete rollouts never reach a verdict, and the deals a capture enforced reach the forks.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DecisionRequest, OracleCard, PlayerView } from '@mtg/shared';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import { DEFAULT_AI_CONFIG } from '../ai/config';
import type { ArmRun } from '../benchmark/turn-counterfactual';
import { ReferenceLineError, referenceArm } from '../benchmark/turn-arms';
import { captureStrategistGame, type StrategistCapture } from './strategist-capture';
import { completed, markTurns, resolveEvaluator, runStudy } from './strategist-study';

let capture: StrategistCapture;

beforeAll(async () => {
  const pool = buildSupportedPool(
    JSON.parse(
      readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
    ) as OracleCard[],
  );
  capture = await captureStrategistGame({
    seed: 'study-test',
    turnCap: 10,
    decks: [1, 2, 3, 4].map((i) => generateCommanderDeck(pool, { seed: `study-test-seat${i}` })),
    config: { ...DEFAULT_AI_CONFIG },
    strategist: null,
    offline: true,
    diplomacy: true,
  });
}, 60_000);

describe('evaluators by name', () => {
  it('resolves the fixed evaluators and pressure on a seat, and refuses anything else', () => {
    expect(resolveEvaluator('survival-v1').version).toBe('survival-v1');
    expect(resolveEvaluator('pressure-on-P3-v1').version).toBe('pressure-on-P3-v1');
    expect(() => resolveEvaluator('pressure-on-P9-v1')).toThrow(/unknown evaluator/);
    expect(() => resolveEvaluator('vibes-v1')).toThrow(/unknown evaluator/);
  });

  it('refuses a line naming an unknown evaluator before running any arm', async () => {
    await expect(
      runStudy({
        capture,
        captureName: 'study-test',
        seeds: ['r1'],
        sampleRate: 1,
        margin: 2,
        evaluator: 'own-position-v2',
        maxTurns: 1,
        lines: { '0': { steps: [], evaluator: 'nonsense-v1' } },
      }),
    ).rejects.toThrow(/unknown evaluator/);
  });
});

describe('incomplete rollouts', () => {
  it('counts the horizon, a game over and an elimination as complete, and nothing else', () => {
    const run = (termination: ArmRun['termination']) => ({ termination }) as ArmRun;
    expect(completed(run('horizon'))).toBe(true);
    expect(completed(run('game_over'))).toBe(true);
    expect(completed(run('seat_eliminated'))).toBe(true);
    expect(completed(run('decision_limit'))).toBe(false);
    expect(completed(run('illegal_response'))).toBe(false);
  });
});

describe('a study turn with a reviewer line', () => {
  it('scores the line on the evaluator it names, including pressure on a seat', async () => {
    const turn = markTurns(capture, 1, 'study-test').find((t) => t.turn >= 2)!;
    const target = turn.seat === 'P2' ? 'P3' : 'P2';
    const report = await runStudy({
      capture,
      captureName: 'study-test',
      seeds: ['r1'],
      sampleRate: 1,
      margin: 2,
      evaluator: 'own-position-v2',
      maxTurns: 50,
      // Two arms keep the test quick; the evaluator plumbing is the same for the full grid.
      gridArms: ['defaults'],
      lines: {
        [String(turn.forkDecisionIndex)]: {
          steps: [{ choose: 'Pass priority' }],
          evaluator: `pressure-on-${target}-v1`,
        },
      },
    });
    const studied = report.markedTurns.find((t) => t.forkDecisionIndex === turn.forkDecisionIndex)!;
    expect(studied.verdict?.evaluator).toBe(`pressure-on-${target}-v1`);
    // Every arm carries the named evaluator's value: it was computed, not defaulted.
    for (const arm of studied.arms) expect(arm.values).toHaveProperty(`pressure-on-${target}-v1`);
    expect(studied.incompleteRuns).toBe(0);
  }, 120_000);
});

describe('a study turn whose rollouts are cut off', () => {
  it('gives no verdict, and keeps the cut-off runs out of every comparison', async () => {
    const turn = markTurns(capture, 1, 'study-test').find((t) => t.turn >= 2)!;
    const report = await runStudy({
      capture,
      captureName: 'study-test',
      seeds: ['r1'],
      sampleRate: 1,
      margin: 2,
      evaluator: 'own-position-v2',
      maxTurns: 50,
      gridArms: ['defaults'],
      // One decision per rollout: no arm, and no reference, reaches the horizon.
      maxDecisions: 1,
      lines: { [String(turn.forkDecisionIndex)]: { steps: [{ choose: 'Pass priority' }] } },
    });
    const studied = report.markedTurns.find((t) => t.forkDecisionIndex === turn.forkDecisionIndex)!;
    expect(studied.arms.every((arm) => arm.termination === 'decision_limit')).toBe(true);
    expect(studied.incompleteRuns).toBe(studied.arms.length);
    expect(studied.disagree).toBe(false);
    expect(studied.verdict).toMatchObject({ verdict: null, needs: 'completedRuns' });
  }, 60_000);
});

describe('a reference line with a step that is never played', () => {
  it('ends the reference as an invalid line once the forked turn is over, with no verdict', async () => {
    const turn = markTurns(capture, 1, 'study-test').find((t) => t.turn >= 2)!;
    const report = await runStudy({
      capture,
      captureName: 'study-test',
      seeds: ['r1'],
      sampleRate: 1,
      margin: 2,
      evaluator: 'own-position-v2',
      maxTurns: 50,
      gridArms: ['defaults'],
      lines: {
        [String(turn.forkDecisionIndex)]: { steps: [{ choose: 'Cast Nothing That Exists' }] },
      },
    });
    const studied = report.markedTurns.find((t) => t.forkDecisionIndex === turn.forkDecisionIndex)!;
    const reference = studied.arms.find((arm) => arm.arm === 'reference')!;
    expect(reference.termination).toBe('invalid_line');
    expect(reference.error).toMatch(/never played/);
    expect(studied.verdict).toMatchObject({ verdict: null, needs: 'completedRuns' });
    expect(studied.verdict?.reason).toMatch(/invalid_line: .*never played/);
  }, 120_000);
});

describe('deals in the forks', () => {
  it("records every seat's binding obligations at each turn of a capture with diplomacy", () => {
    const withTurns = capture.turns.filter((t) => t.turn >= 1);
    expect(withTurns.length).toBeGreaterThan(0);
    for (const t of withTurns) {
      expect(Object.keys(t.obligations).sort()).toEqual(['P1', 'P2', 'P3', 'P4']);
      for (const list of Object.values(t.obligations))
        for (const o of list ?? []) expect(o.obligation.by).toBeDefined();
    }
  });
});

describe('reference line targets', () => {
  const view = {
    seat: 'P1',
    life: 30,
    hand: [],
    deck: [],
    graveyard: [],
    exile: [],
    commanders: [],
    availableMana: {},
    manaSources: [],
    opponents: [{ seat: 'P2', graveyard: [{ id: 'g-1', name: 'Grave Titan' }] }],
    battlefield: [
      { id: 'o-1', controller: 'P2', name: 'Grizzly Bears', tapped: false, status: [] },
      { id: 'o-2', controller: 'P3', name: 'Twin', tapped: false, status: [] },
      { id: 'o-3', controller: 'P4', name: 'Twin', tapped: false, status: [] },
    ],
    stack: [],
    recentLog: [],
  } as unknown as PlayerView;
  const request = {
    requestId: 'r',
    gameId: 'g',
    turn: 3,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'combat',
    step: 'declareAttackers',
    decisionType: 'declareAttackers',
    prompt: '',
    legalActions: [
      {
        id: 0,
        type: 'attackDeclaration',
        description: 'Declare attackers',
        targets: [{ slot: 0, options: ['P2', 'o-1', 'o-2', 'o-3', 'g-1', '__no_attack__'] }],
      },
    ],
  } as unknown as DecisionRequest;
  const play = (target: string) =>
    referenceArm([{ choose: 'Declare attackers', targets: [target] }])(undefined as never, 'P1')(
      request,
      view,
    );

  it('takes a literal option, a seat, or a uniquely named object', () => {
    expect(play('__no_attack__')).toMatchObject({
      targets: [{ slot: 0, choice: '__no_attack__' }],
    });
    expect(play('P2')).toMatchObject({ targets: [{ slot: 0, choice: 'P2' }] });
    expect(play('Grizzly Bears')).toMatchObject({ targets: [{ slot: 0, choice: 'o-1' }] });
    // A card in an opponent's graveyard, as a reanimation or graveyard-hate line names it.
    expect(play('Grave Titan')).toMatchObject({ targets: [{ slot: 0, choice: 'g-1' }] });
  });

  it('refuses a step that names fewer or more targets than the action has slots', () => {
    const steps = (targets?: string[]) =>
      referenceArm([{ choose: 'Declare attackers', ...(targets && { targets }) }])(
        undefined as never,
        'P1',
      )(request, view);
    expect(() => steps()).toThrow(/names 0 target\(s\) for 1 slot/);
    expect(() => steps(['P2', 'P2'])).toThrow(/names 2 target\(s\) for 1 slot/);
  });

  it('refuses a target it cannot find, or one the name leaves ambiguous', () => {
    expect(() => play('Ghost')).toThrow(ReferenceLineError);
    expect(() => play('Twin')).toThrow(ReferenceLineError);
  });

  it('counts a halt or an unplayable line as incomplete', () => {
    const run = (termination: ArmRun['termination']) => ({ termination }) as ArmRun;
    expect(completed(run('halted'))).toBe(false);
    expect(completed(run('invalid_line'))).toBe(false);
  });
});

/**
 * The study over a small offline capture: evaluators resolve by name (an unknown one is refused),
 * incomplete rollouts never reach a verdict, and the deals a capture enforced reach the forks.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import { DEFAULT_AI_CONFIG } from '../ai/config';
import type { ArmRun } from '../benchmark/turn-counterfactual';
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
        evaluator: 'own-position-v1',
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
      evaluator: 'own-position-v1',
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

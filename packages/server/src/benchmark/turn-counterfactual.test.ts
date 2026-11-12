import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import { DEFAULT_AI_CONFIG } from '../ai/config';
import type { AiClient } from '../ai/client';
import { captureStrategistGame, type StrategistCapture } from '../cli/strategist-capture';
import { seatTurns, OWN_POSITION, SURVIVAL, ELIMINATIONS, GAME_RESULT } from './turn-study';
import { runArm, type StudyArm, type TurnFork } from './turn-counterfactual';
import { referenceArm, tacticianArm } from './turn-arms';

const evaluators = [OWN_POSITION, SURVIVAL, ELIMINATIONS, GAME_RESULT];
let capture: StrategistCapture;
let fork: TurnFork;

beforeAll(async () => {
  const pool = buildSupportedPool(
    JSON.parse(
      readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
    ) as OracleCard[],
  );
  const decks = [1, 2, 3, 4].map((i) => generateCommanderDeck(pool, { seed: `s1-seat${i}` }));
  capture = await captureStrategistGame({
    seed: 's1',
    turnCap: 8,
    decks,
    config: { ...DEFAULT_AI_CONFIG },
    strategist: null,
    offline: true,
    diplomacy: false,
  });
  const turn = seatTurns(capture.transcript).find((t) => t.turn >= 2)!;
  const entry = capture.turns.find((t) => t.decisionIndex === turn.forkDecisionIndex)!;
  fork = {
    transcript: capture.transcript,
    forkDecisionIndex: turn.forkDecisionIndex,
    seat: turn.seat,
    knobsBySeat: entry.knobs,
  };
}, 120_000);

const botArm = (id = 'strategist'): StudyArm => ({
  kind: 'bot',
  id,
  steering: fork.knobsBySeat[fork.seat],
});

describe('runArm', () => {
  it('runs a bot arm to the horizon with a value per evaluator', async () => {
    const run = await runArm(fork, botArm(), { rolloutSeed: 'r1', evaluators });
    expect(['horizon', 'game_over']).toContain(run.termination);
    for (const evaluator of evaluators) expect(typeof run.values[evaluator.version]).toBe('number');
    expect(run.arm).toBe('strategist');
    expect(run.rolloutSeed).toBe('r1');
  }, 50_000);

  it('is deterministic for the same arm and seed', async () => {
    const a = await runArm(fork, botArm(), { rolloutSeed: 'r2', evaluators });
    const b = await runArm(fork, botArm(), { rolloutSeed: 'r2', evaluators });
    expect(a.finalStateHash).toBe(b.finalStateHash);
    expect(a.values).toEqual(b.values);
    expect(a.forkedTurnActions).toEqual(b.forkedTurnActions);
  }, 50_000);

  it('records the forked turn actions of a reference arm', async () => {
    const arm: StudyArm = {
      kind: 'reference',
      id: 'ref',
      policyFor: referenceArm([{ choose: 'Pass priority' }]),
    };
    const run = await runArm(fork, arm, { rolloutSeed: 'r1', evaluators });
    expect(run.forkedTurnActions.length).toBeGreaterThan(0);
    expect(run.forkedTurnActions[0]).toContain('Pass priority');
    expect(run.termination).not.toBe('illegal_response');
  }, 50_000);

  it('hands decisions to the bot when the tactician client fails', async () => {
    const client: AiClient = {
      activeModel: 'stub',
      requestDecision: () => Promise.reject(new Error('down')),
    };
    const arm: StudyArm = {
      kind: 'tactician',
      id: 'tactician',
      withContext: false,
      policyFor: tacticianArm(client, { ...DEFAULT_AI_CONFIG }, null),
    };
    const run = await runArm(fork, arm, { rolloutSeed: 'r1', evaluators });
    expect(run.handedToBot).toBeGreaterThan(0);
    expect(run.termination).not.toBe('illegal_response');
  }, 55_000);

  it('refuses a fork that is not the seat’s own decision in its own turn', async () => {
    const index = capture.transcript.decisions.findIndex(
      (d) => d.request.decidingPlayer !== d.request.activePlayer,
    );
    if (index === -1) return;
    const request = capture.transcript.decisions[index]!.request;
    await expect(
      runArm({ ...fork, forkDecisionIndex: index, seat: request.activePlayer }, botArm(), {
        rolloutSeed: 'r1',
        evaluators,
      }),
    ).rejects.toThrow(/is not/);
  }, 50_000);
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decide as heuristicDecide, Rng } from '@mtg/bot';
import type { GameConfig } from '@mtg/engine';
import type { OracleCard, PlayerId } from '@mtg/shared';
import { evaluateCounterfactual } from './counterfactual';
import { runControlledLeague, type LeaguePolicyFactory } from './league';
import { evaluatePromotion, parseReleasePolicy, type ReleasePolicy } from './promotion';
import { captureReplayTranscript, type ObservationPolicy } from './replay';
import type { VariantReport } from './report';

function forest(index: number): OracleCard {
  return {
    oracleId: `forest-${index}`,
    scryfallId: `forest-print-${index}`,
    name: 'Forest',
    manaCost: null,
    cmc: 0,
    colors: [],
    colorIdentity: ['G'],
    typeLine: 'Basic Land — Forest',
    supertypes: ['Basic'],
    types: ['Land'],
    subtypes: ['Forest'],
    oracleText: '',
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: true,
  };
}

function commander(seat: PlayerId): OracleCard {
  return {
    ...forest(0),
    oracleId: `commander-${seat}`,
    scryfallId: `commander-print-${seat}`,
    name: `Commander ${seat}`,
    manaCost: '{G}',
    cmc: 1,
    colors: ['G'],
    typeLine: 'Legendary Creature — Elf',
    supertypes: ['Legendary'],
    types: ['Creature'],
    subtypes: ['Elf'],
    power: '2',
    toughness: '2',
    isBasicLand: false,
  };
}

function config(turnCap = 5): GameConfig {
  return {
    gameId: 'hk-test',
    seed: 'hk-seed',
    turnCap,
    players: ['P1', 'P2'].map((seat) => ({
      id: seat,
      deckId: `deck-${seat}`,
      commanders: [commander(seat)],
      cards: Array.from({ length: 30 }, (_, index) => forest(index)),
    })),
  };
}

function heuristicPolicies(seed: string): (seat: PlayerId) => ObservationPolicy {
  const rngs = new Map<PlayerId, Rng>();
  return (seat) => (request, view) => {
    const rng = rngs.get(seat) ?? new Rng(`${seed}:${seat}`);
    rngs.set(seat, rng);
    return heuristicDecide(request, view, rng);
  };
}

function report(overrides: Partial<VariantReport> = {}): VariantReport {
  return {
    variantId: 'v',
    role: 'tactician',
    mode: 'production',
    trials: 100,
    scored: 100,
    acceptable: 95,
    acceptableRate: 0.95,
    rawValidityRate: 1,
    schemaValidityRate: 1,
    knownCostUsd: 0.1,
    costCoverage: 1,
    p95EndToEndMs: 100,
    failures: 0,
    networkAttempts: 100,
    unknownCostAttempts: 0,
    ...overrides,
  };
}

describe('H-K benchmark extensions', () => {
  it('runtime-validates the committed preregistered release policy', () => {
    const policy = parseReleasePolicy(
      JSON.parse(readFileSync('benchmarks/release-policy.json', 'utf8')),
    );
    expect(policy.status).toBe('proposed');
    expect(policy.cost.unit).toBe('ai-seat-active-turn');
  });

  it('forks identical engines, applies complete responses, and repeats deterministically', async () => {
    const transcript = await captureReplayTranscript(config(), heuristicPolicies('capture'), {
      maxDecisions: 100,
    });
    const fork = transcript.decisions.findIndex((record) =>
      record.request.legalActions.some((action) => action.type === 'castSpell'),
    );
    expect(fork).toBeGreaterThanOrEqual(0);
    const request = transcript.decisions[fork]!.request;
    const cast = request.legalActions.find((action) => action.type === 'castSpell')!;
    const pass = request.legalActions.find((action) => action.type === 'pass')!;
    const policies = {
      policyId: 'labeled-pass-microtest-v1',
      rngPolicyId: 'no-random-choice-v1',
      policyFor: () => () => (nextRequest: typeof request) => {
        const passAction = nextRequest.legalActions.find((action) => action.type === 'pass');
        return {
          requestId: nextRequest.requestId,
          actionId: (passAction ?? nextRequest.legalActions[0]!).id,
        };
      },
    };
    const run = () =>
      evaluateCounterfactual({
        transcript,
        forkDecisionIndex: fork,
        actor: request.decidingPlayer,
        candidateResponse: { requestId: request.requestId, actionId: cast.id },
        baselineResponse: { requestId: request.requestId, actionId: pass.id },
        policies,
        horizon: { kind: 'end_of_active_turn' },
        maxTransitions: 8_000,
      });
    const first = await run();
    const second = await run();
    expect(first.sourceParity).toBe(true);
    expect(first.candidate.termination).toBe('horizon');
    expect(first.baseline.termination).toBe('horizon');
    expect(first.baselineDisadvantage).toBeLessThan(0);
    expect(first.verdict).toBe('candidate_better');
    expect(first).toEqual(second);
  });

  it('does not claim a stack-resolved horizon before either branch has seen a stack', async () => {
    const transcript = await captureReplayTranscript(config(), heuristicPolicies('capture'), {
      maxDecisions: 100,
    });
    const fork = transcript.decisions.findIndex(
      (record) =>
        record.request.turn > 0 &&
        record.observerView.stack.length === 0 &&
        record.request.legalActions.some((action) => action.type === 'pass'),
    );
    expect(fork).toBeGreaterThanOrEqual(0);
    const request = transcript.decisions[fork]!.request;
    const pass = request.legalActions.find((action) => action.type === 'pass')!;
    const passPolicies = {
      policyId: 'always-pass-v1',
      rngPolicyId: 'none-v1',
      policyFor: () => () => (nextRequest: typeof request) => ({
        requestId: nextRequest.requestId,
        actionId:
          nextRequest.legalActions.find((action) => action.type === 'pass')?.id ??
          nextRequest.legalActions[0]!.id,
      }),
    };
    const result = await evaluateCounterfactual({
      transcript,
      forkDecisionIndex: fork,
      actor: request.decidingPlayer,
      candidateResponse: { requestId: request.requestId, actionId: pass.id },
      baselineResponse: { requestId: request.requestId, actionId: pass.id },
      policies: passPolicies,
      horizon: { kind: 'stack_resolved' },
      maxTransitions: 8_000,
    });
    expect(result.candidate.termination).toBe('horizon_unreachable');
    expect(result.baseline.termination).toBe('horizon_unreachable');
    expect(result.candidate.transitions).toBeGreaterThan(0);
    expect(result.verdict).toBe('inconclusive');
  });

  it('keeps a proposed policy inconclusive and fails hard invariants', () => {
    const policy = parseReleasePolicy({
      schemaVersion: 1,
      status: 'proposed',
      quality: { maximumAcceptableRateDropPoints: 2, newConfirmedCriticalBlundersAllowed: 0 },
      reliability: { maximumFailureRate: 0.05 },
      latency: { maximumComparableP95IncreasePercent: 15 },
      cost: {
        unit: 'ai-seat-active-turn',
        proposedCeilingUsd: 0.003,
        requireCompleteAccountingForUnqualifiedPass: true,
        spendCapUsd: 10,
      },
      sampleExpansion: { onInconclusive: true, maximumMultiplier: 2 },
      criticalCaseIds: [],
      verdicts: ['pass', 'fail', 'inconclusive'],
    } satisfies ReleasePolicy);
    const baseEvidence = {
      baseline: report(),
      candidate: report(),
      newConfirmedCriticalBlunders: 0,
      comparableWorkload: true,
      deterministicGatesPassed: true,
      hiddenInformationLeaks: 0,
      engineAcceptedIllegalActions: 0,
      candidateActiveTurnCostUsd: 0.002,
    };
    expect(evaluatePromotion(policy, baseEvidence).verdict).toBe('inconclusive');
    expect(evaluatePromotion(policy, { ...baseEvidence, hiddenInformationLeaks: 1 }).verdict).toBe(
      'fail',
    );
    expect(() =>
      evaluatePromotion(policy, {
        ...baseEvidence,
        hiddenInformationLeaks: undefined,
      } as unknown as typeof baseEvidence),
    ).toThrow('promotion invariant evidence must be explicit');
  });

  it('rotates candidate seats and deck assignments in a deterministic controlled league', async () => {
    const factory: LeaguePolicyFactory = ({ seed, seat, role }) => {
      const rng = new Rng(`${seed}:${seat}:${role}`);
      return {
        decide: (request, view) => heuristicDecide(request, view, rng),
        telemetry: () => ({ knownCostUsd: 0, costKnown: true }),
      };
    };
    const result = await runControlledLeague({
      scenarios: [{ scenarioId: 'small', config: config(1) }],
      candidateFactory: factory,
      opponentFactory: factory,
      includeAllCandidateTables: true,
      maxTransitions: 20_000,
    });
    expect(result.singleSeatGames).toBe(4);
    expect(result.allCandidateGames).toBe(2);
    expect(result.games.map((game) => game.deckRotation)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(result.costCoverage).toBe(1);
  });
});

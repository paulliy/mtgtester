import { describe, expect, it } from 'vitest';
import { decide as heuristicDecide, Rng } from '@mtg/bot';
import { Engine, type GameConfig } from '@mtg/engine';
import type { DecisionResponse, OracleCard, PlayerId, TurnStrategy } from '@mtg/shared';
import {
  ReplayMismatchError,
  captureReplayTranscript,
  replayTranscript,
  runTurnHarness,
  type ObservationPolicy,
} from './replay';

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

function config(): GameConfig {
  return {
    gameId: 'replay-test',
    seed: 'replay-seed',
    turnCap: 8,
    players: ['P1', 'P2'].map((seat) => ({
      id: seat,
      deckId: `deck-${seat}`,
      commanders: [commander(seat)],
      cards: Array.from({ length: 30 }, (_, index) => forest(index)),
    })),
  };
}

function policies(seed: string): (seat: PlayerId) => ObservationPolicy {
  const rngs = new Map<PlayerId, Rng>();
  return (seat) => (request, view) => {
    let rng = rngs.get(seat);
    if (rng === undefined) {
      rng = new Rng(`${seed}:${seat}`);
      rngs.set(seat, rng);
    }
    return heuristicDecide(request, view, rng);
  };
}

describe('verified transcript replay', () => {
  it('reconstructs fresh engines with request, permitted-view, and state parity', async () => {
    const transcript = await captureReplayTranscript(config(), policies('capture'), {
      maxDecisions: 60,
    });
    expect(transcript.decisions.length).toBeGreaterThan(10);
    const parity = replayTranscript(transcript);
    expect(parity.matchedDecisions).toBe(transcript.decisions.length);
    expect(parity.termination).toBe(transcript.termination);
  });

  it('rejects a changed fork surface instead of silently replaying old action ids', async () => {
    const transcript = await captureReplayTranscript(config(), policies('capture'), {
      maxDecisions: 10,
    });
    transcript.decisions[0]!.requestHash = 'tampered';
    expect(() => replayTranscript(transcript)).toThrow(ReplayMismatchError);
  });

  it('binds stored request, view, and semantic response payloads to their replay hashes', async () => {
    const transcript = await captureReplayTranscript(config(), policies('capture'), {
      maxDecisions: 10,
    });
    const changedRequest = structuredClone(transcript);
    changedRequest.decisions[0]!.request.prompt = 'tampered stored prompt';
    expect(() => replayTranscript(changedRequest)).toThrow(/recorded_request/);

    const changedView = structuredClone(transcript);
    changedView.decisions[0]!.observerView.life--;
    expect(() => replayTranscript(changedView)).toThrow(/recorded_view/);

    const changedResponse = structuredClone(transcript);
    changedResponse.decisions[0]!.response.actionId = 999;
    expect(() => replayTranscript(changedResponse)).toThrow(/response/);

    const debugOnly = structuredClone(transcript);
    debugOnly.decisions[0]!.response.note = 'changed debug-only note';
    expect(replayTranscript(debugOnly).matchedDecisions).toBe(transcript.decisions.length);
  });

  it('records the complete submitted response in the authoritative decision event', () => {
    const engine = new Engine(config());
    let request;
    for (;;) {
      const step = engine.advance();
      if (step.kind === 'decision') {
        request = step.request;
        break;
      }
      if (step.kind === 'gameOver') throw new Error('expected a surfaced setup decision');
    }
    const response: DecisionResponse = {
      requestId: request.requestId,
      actionId: request.legalActions[0]!.id,
      modes: [1],
      xValue: 3,
      manaSplit: { G: 1 },
      combatDamageSplit: { target: 2 },
      order: [2, 1],
      note: 'complete replay payload',
    };
    engine.submit(response);
    const decision = engine.eventsSince(0).find((event) => event.type === 'decision');
    expect(decision?.payload['submittedResponse']).toEqual(response);
  });

  it('keeps ready and asynchronous turn modes explicit and deterministic', async () => {
    const transcript = await captureReplayTranscript(config(), policies('capture'), {
      maxDecisions: 100,
    });
    const fork = transcript.decisions.findIndex(
      (record) =>
        record.request.turn > 0 &&
        record.request.decidingPlayer === record.request.activePlayer &&
        record.request.legalActions.some((action) => action.type === 'pass'),
    );
    expect(fork).toBeGreaterThanOrEqual(0);
    const source = transcript.decisions[fork]!.request;
    const strategy: TurnStrategy = {
      intent: 'Preserve priority',
      plannedActions: [{ type: 'pass', phase: source.phase, step: source.step }],
    };
    const readyA = await runTurnHarness({
      transcript,
      forkDecisionIndex: fork,
      mode: 'ready',
      actingSeat: source.activePlayer,
      policyFor: policies('turn'),
      strategy,
      maxTransitions: 8_000,
    });
    const readyB = await runTurnHarness({
      transcript,
      forkDecisionIndex: fork,
      mode: 'ready',
      actingSeat: source.activePlayer,
      policyFor: policies('turn'),
      strategy,
      maxTransitions: 8_000,
    });
    expect(readyA).toEqual(readyB);
    expect(readyA.mode).toBe('ready');
    expect(readyA.planActionsAccepted).toBeGreaterThan(0);

    const asynchronous = await runTurnHarness({
      transcript,
      forkDecisionIndex: fork,
      mode: 'asynchronous',
      actingSeat: source.activePlayer,
      policyFor: policies('turn'),
      strategyFactory: () => Promise.resolve(strategy),
      maxTransitions: 8_000,
    });
    expect(asynchronous.mode).toBe('asynchronous');
    expect(asynchronous.planGenerationSettled).toBe(true);
  });
});

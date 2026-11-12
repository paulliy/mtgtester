import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import { DEFAULT_AI_CONFIG } from '../ai/config';
import type { AiClient } from '../ai/client';
import { localCallMeta } from '../ai/logger';
import { replayTranscript } from '../benchmark/replay';
import { captureStrategistGame, type CaptureOptions } from './strategist-capture';
import { capTurns } from './strategist-study';

let base: Pick<CaptureOptions, 'seed' | 'turnCap' | 'decks' | 'config' | 'diplomacy'>;

beforeAll(() => {
  const pool = buildSupportedPool(
    JSON.parse(
      readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
    ) as OracleCard[],
  );
  base = {
    seed: 's1',
    turnCap: 8,
    decks: [1, 2, 3, 4].map((i) => generateCommanderDeck(pool, { seed: `s1-seat${i}` })),
    config: { ...DEFAULT_AI_CONFIG },
    diplomacy: false,
  };
});

function stubStrategist(reason: string): AiClient {
  return {
    activeModel: 'stub',
    requestDecision: (_prompt, request) =>
      Promise.resolve({
        response: {
          requestId: request.requestId,
          actionId: 0,
          turnStrategy: {
            intent: 'x',
            plannedActions: [],
            steering: { aggression: 0.5 },
            tacticianRequest: { reason },
          },
        },
        meta: localCallMeta(),
      }),
  };
}

describe('captureStrategistGame offline', () => {
  it('replays with every decision matching', async () => {
    const capture = await captureStrategistGame({
      ...base,
      strategist: null,
      offline: true,
    });
    expect(capture.transcript.decisions.length).toBeGreaterThan(0);
    const parity = replayTranscript(capture.transcript);
    expect(parity.matchedDecisions).toBe(capture.transcript.decisions.length);

    expect(capture.turns.length).toBeGreaterThan(0);
    for (const entry of capture.turns) {
      const request = capture.transcript.decisions[entry.decisionIndex]!.request;
      expect(request.decidingPlayer).toBe(entry.seat);
      expect(request.activePlayer).toBe(entry.seat);
      expect(request.turn).toBe(entry.turn);
    }
    // The offline strategist sets aggression 0.5 for seats that have knobs.
    const withKnobs = capture.turns.flatMap((t) => Object.values(t.knobs));
    expect(withKnobs.length).toBeGreaterThan(0);
    for (const knobs of withKnobs) expect(knobs!.aggression).toBe(0.5);
    expect(capture.tacticianRequests).toEqual([]);
  }, 55_000);
});

describe('captureStrategistGame with a strategist client', () => {
  it('records tactician requests with seat, reason and wake', async () => {
    const capture = await captureStrategistGame({
      ...base,
      strategist: stubStrategist('lethal on P3 needs a sequence'),
      offline: false,
    });
    expect(capture.tacticianRequests.length).toBeGreaterThan(0);
    const first = capture.tacticianRequests[0]!;
    expect(first.reason).toBe('lethal on P3 needs a sequence');
    expect(first.seat).toMatch(/^P[1-4]$/);
    expect(first.wake).toEqual(['first knobs']);
    for (const record of capture.tacticianRequests) {
      // An empty wake means onChange would have reused the old knobs (everyTurn replans anyway).
      expect(Array.isArray(record.wake)).toBe(true);
      expect(record.knobs).toBe(true);
    }
    expect(capture.strategist.calls).toBeGreaterThan(0);
  }, 55_000);

  it('truncates a long reason to 160 characters', async () => {
    const capture = await captureStrategistGame({
      ...base,
      strategist: stubStrategist('y'.repeat(400)),
      offline: false,
    });
    expect(capture.tacticianRequests[0]!.reason).toHaveLength(160);
  }, 55_000);
});

describe('capTurns', () => {
  it('keeps every turn under the cap, and draws a seeded spread above it, in game order', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ forkDecisionIndex: i * 3 }));
    expect(capTurns(turns, 30, 'x')).toEqual(turns);
    const capped = capTurns(turns, 5, 'x');
    expect(capped).toHaveLength(5);
    expect(capped).toEqual(capTurns(turns, 5, 'x'));
    expect([...capped].sort((a, b) => a.forkDecisionIndex - b.forkDecisionIndex)).toEqual(capped);
    // Not simply the first five.
    expect(capped).not.toEqual(turns.slice(0, 5));
  });
});

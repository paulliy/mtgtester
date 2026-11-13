/**
 * A live strategist answers far slower than the bot decides. The capture must wait for each
 * turn's answer, so the knobs it records for a turn are the ones that turn played with.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { buildSupportedPool } from '../cards/pool';
import { generateCommanderDeck } from '../decks/generate';
import { DEFAULT_AI_CONFIG } from '../ai/config';
import type { AiClient } from '../ai/client';
import { localCallMeta } from '../ai/logger';
import { captureStrategistGame } from './strategist-capture';

/** Answers after a delay, with knobs that name the turn they were asked for. */
function slowStrategist(delayMs: number): AiClient {
  return {
    activeModel: 'slow',
    requestDecision: async (_prompt, request: DecisionRequest) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        response: {
          requestId: request.requestId,
          actionId: 0,
          turnStrategy: {
            intent: `turn ${request.turn}`,
            plannedActions: [],
            steering: { aggression: request.turn / 100 },
            ...(request.turn === 3 ? { tacticianRequest: { reason: 'turn three' } } : {}),
          },
        },
        meta: localCallMeta(),
      };
    },
  };
}

describe('a capture with a slow strategist', () => {
  it("records each turn's own knobs, and stamps each request with its own turn", async () => {
    const pool = buildSupportedPool(
      JSON.parse(
        readFileSync('packages/server/fixtures/coverage-oracle.json', 'utf8'),
      ) as OracleCard[],
    );
    const capture = await captureStrategistGame({
      seed: 'slow',
      turnCap: 6,
      decks: [1, 2, 3, 4].map((i) => generateCommanderDeck(pool, { seed: `slow-seat${i}` })),
      config: { ...DEFAULT_AI_CONFIG },
      strategist: slowStrategist(20),
      offline: false,
      diplomacy: false,
    });
    const own = capture.turns.filter((turn) => turn.turn >= 1);
    expect(own.length).toBeGreaterThan(2);
    for (const turn of own) expect(turn.knobs[turn.seat]?.aggression).toBe(turn.turn / 100);
    expect(capture.tacticianRequests.map((r) => r.turn)).toEqual([3]);
    expect(capture.tacticianRequests[0]?.reason).toBe('turn three');
  }, 60_000);
});

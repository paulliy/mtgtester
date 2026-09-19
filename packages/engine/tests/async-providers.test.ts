import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine';
import {
  RandomDecisionProvider,
  runToCompletionAsync,
  type AsyncDecisionProvider,
} from '../src/providers/providers';
import type { DecisionRequest, DecisionResponse } from '@mtg/shared';
import {
  bear,
  bolt,
  commanderFor,
  copies,
  forest,
  gameConfig,
  giantGrowth,
  keywordCreature,
  mountain,
  type SeatSpec,
} from './fixtures';

function pod(): SeatSpec[] {
  return [0, 1, 2, 3].map((i) => ({
    commander: commanderFor((['G', 'R', 'W', 'G'] as const)[i] ?? 'G', `Warlord ${i + 1}`),
    cards: [
      ...copies(12, forest),
      ...copies(4, mountain),
      ...copies(8, bear),
      ...copies(2, () => keywordCreature('Sky Knight', 'Flying, vigilance', '{1}{W}', '2/3')),
      ...copies(2, () => keywordCreature('Rampager', 'Trample, haste', '{2}{R}', '3/2')),
      ...copies(2, giantGrowth),
      ...copies(2, bolt),
    ],
  }));
}

describe('runToCompletionAsync', () => {
  it('plays to completion with an async decision provider', async () => {
    const seed = 'async-test-1';
    const engine = new Engine(gameConfig(pod(), { gameId: `async-${seed}`, seed, turnCap: 150 }));
    const syncProviders = new Map<string, RandomDecisionProvider>();
    const decisionsNotified: Array<{ req: DecisionRequest; res: DecisionResponse }> = [];

    const asyncProviderFor = (playerId: string): AsyncDecisionProvider => {
      let syncP = syncProviders.get(playerId);
      if (syncP === undefined) {
        syncP = new RandomDecisionProvider(`${seed}-${playerId}`);
        syncProviders.set(playerId, syncP);
      }
      return {
        async decide(request) {
          // Simulate async tick
          await Promise.resolve();
          return syncP.decide(request);
        },
      };
    };

    const result = await runToCompletionAsync(engine, asyncProviderFor, {
      onDecision(req, res) {
        decisionsNotified.push({ req, res });
      },
    });

    expect(result.halted).toBe(false);
    expect(result.winnerSeat).not.toBeNull();
    expect(decisionsNotified.length).toBeGreaterThan(0);
    expect(decisionsNotified[0]?.req.requestId).toBeDefined();
    expect(decisionsNotified[0]?.res.actionId).toBeDefined();
    // This is a full multiplayer game; legal upkeep/combat responses add decisions.
    // Allow headroom for contention when the whole suite runs concurrently.
  }, 15_000);

  it('propagates provider errors without corrupting engine', async () => {
    const seed = 'async-err-test';
    const engine = new Engine(gameConfig(pod(), { gameId: `async-${seed}`, seed, turnCap: 10 }));
    const failingProvider: AsyncDecisionProvider = {
      async decide() {
        throw new Error('Async API failure');
      },
    };

    await expect(runToCompletionAsync(engine, () => failingProvider)).rejects.toThrow(
      'Async API failure',
    );
  });
});

/**
 * The Phase 2 done-criterion (brief §14.1): a full four-player Commander game plays from
 * opening hands to a single surviving winner under a scripted/random decision provider,
 * with eliminations happening mid-game and the game continuing among survivors.
 */

import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine';
import { RandomDecisionProvider, runToCompletion } from '../src/providers/providers';
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
} from './fixtures';
import type { SeatSpec } from './fixtures';

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

function playRandomGame(seed: string): {
  engine: Engine;
  result: import('@mtg/shared').GameResult;
} {
  const engine = new Engine(gameConfig(pod(), { gameId: `full-${seed}`, seed, turnCap: 150 }));
  const providers = new Map<string, RandomDecisionProvider>();
  const result = runToCompletion(engine, (playerId) => {
    let p = providers.get(playerId);
    if (p === undefined) {
      p = new RandomDecisionProvider(`${seed}-${playerId}`);
      providers.set(playerId, p);
    }
    return p;
  });
  return { engine, result };
}

describe('full four-player game (brief §14.1 Phase 2 done-criterion)', () => {
  // A full random-fuzzed game; see determinism.test.ts's note on why these need headroom past
  // vitest's 5s default under full-suite parallel load (ADR 0023 items 13/14/18's added
  // decision points — batched attack declarations occasionally add a rejection/retry cycle on
  // top of the per-step damage-division ask).
  it('plays to a single surviving winner with random decisions', () => {
    const { engine, result } = playRandomGame('full-game-1');

    expect(result.halted).toBe(false);
    expect(result.haltReason).toBeNull();
    expect(result.winnerSeat).not.toBeNull();
    expect(result.finishingOrder).toHaveLength(4);
    expect(result.finishingOrder[3]).toBe(result.winnerSeat);

    const state = engine.getState();
    expect(state.eliminatedPlayers).toHaveLength(3);
    expect(state.turnOrder).toEqual([result.winnerSeat]);

    // Eliminations happened mid-game and the game CONTINUED: there are turnBegin events
    // after the first elimination (brief §12 — elimination with the game continuing).
    const log = state.eventLog;
    const firstElim = log.findIndex((e) => e.type === 'playerEliminated');
    expect(firstElim).toBeGreaterThan(0);
    expect(log.slice(firstElim).some((e) => e.type === 'turnBegin')).toBe(true);

    // Something actually happened: spells were cast and combat damage was dealt.
    expect(log.some((e) => e.type === 'castSpell')).toBe(true);
    expect(log.some((e) => e.type === 'damage' && e.payload['combat'] === true)).toBe(true);
  }, 30_000);

  it('reaches a winner across several different seeds', () => {
    // Three full random-fuzzed games; see determinism.test.ts's note on why this needs
    // headroom past vitest's 5s default (ADR 0023 items 13/14/18's added decision points).
    for (const seed of ['pod-A', 'pod-B', 'pod-C']) {
      const { result } = playRandomGame(seed);
      expect(result.halted).toBe(false);
      expect(result.winnerSeat).not.toBeNull();
    }
  }, 30_000);
});

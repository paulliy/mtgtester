/**
 * Determinism (brief §5.9, §12): same seed + same scripted decisions ⇒ byte-identical
 * event logs. The engine contains no `Math.random()`; every random call draws from the
 * game PRNG in a deterministic order.
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
  mountain,
} from './fixtures';
import type { SeatSpec } from './fixtures';

function pod(): SeatSpec[] {
  return [0, 1, 2, 3].map((i) => ({
    commander: commanderFor(i % 2 === 0 ? 'G' : 'R', `Test General ${i + 1}`),
    cards: [
      ...copies(10, forest),
      ...copies(4, mountain),
      ...copies(6, bear),
      ...copies(2, giantGrowth),
      ...copies(2, bolt),
    ],
  }));
}

function playOnce(gameSeed: string, providerSeed: string): string {
  const engine = new Engine(gameConfig(pod(), { gameId: 'det', seed: gameSeed, turnCap: 100 }));
  const providers = new Map<string, RandomDecisionProvider>();
  runToCompletion(engine, (playerId) => {
    let p = providers.get(playerId);
    if (p === undefined) {
      p = new RandomDecisionProvider(`${providerSeed}-${playerId}`);
      providers.set(playerId, p);
    }
    return p;
  });
  return JSON.stringify(engine.getState().eventLog);
}

describe('determinism (brief §5.9)', () => {
  // Two full random-fuzzed 4-player games per test; batched combat declarations (ADR 0023 items
  // 13/14/18) add real decision points — a fresh damage-division ask per combat-damage step
  // rather than once for the whole combat, plus an occasional rejection/retry cycle when a
  // random attack proposal hits a joint attack-tax violation — which push this well over
  // vitest's 5s default under full-suite parallel load. Not a hang — see the ADR's landed-fixes
  // note.
  it('same seed + same decisions ⇒ byte-identical event logs', () => {
    const a = playOnce('seed-A', 'prov-A');
    const b = playOnce('seed-A', 'prov-A');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(1000); // a real game happened
  }, 30_000);

  it('a different game seed produces a different game', () => {
    const a = playOnce('seed-A', 'prov-A');
    const c = playOnce('seed-B', 'prov-A');
    expect(a).not.toBe(c);
  }, 30_000);
});

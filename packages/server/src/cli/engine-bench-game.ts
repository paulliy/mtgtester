/**
 * The benchmark game (`bench/bench-game.ts`) as `engine-bench` and `hill-climb` play it in Bun,
 * hashing the transcript with `node:crypto`.
 */
import { createHash } from 'node:crypto';
import { playBenchGame, type GameRun } from '../bench/bench-game';
import type { FuzzDeck, FuzzProvider } from './fuzz-game';

export { sumWork, type GameRun } from '../bench/bench-game';

/**
 * Plays seed `seed`'s pod to the end. The fingerprint is a SHA-256 over every decision request
 * (with its full option menu), every response, the final event log and the outcome.
 */
export function playGame(
  seed: number,
  decks: FuzzDeck[],
  providerKinds: FuzzProvider[],
  turnCap: number,
): GameRun {
  const hash = createHash('sha256');
  return playBenchGame(seed, decks, providerKinds, turnCap, {
    update: (text) => hash.update(text),
    digestHex: () => hash.digest('hex'),
  });
}

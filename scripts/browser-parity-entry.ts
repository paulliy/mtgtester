/**
 * The browser side of the fingerprint parity check (ADR 0053): plays the benchmark pods the
 * harness hands it with the same game code Bun runs (`bench/bench-game.ts`), hashing with the
 * browser-safe `createSha256`, and returns each game's fingerprint.
 */
// By path: scripts/ is outside the workspaces, so it cannot resolve `@mtg/shared` by name.
import { createSha256 } from '../packages/shared/src/sha256';
import { playBenchGame } from '../packages/server/src/bench/bench-game';
import type { FuzzDeck, FuzzProvider } from '../packages/server/src/cli/fuzz-game';

export interface ParityPod {
  seed: number;
  decks: FuzzDeck[];
  providers: FuzzProvider[];
  turnCap: number;
}

async function runParity(url: string): Promise<Array<{ seed: number; fingerprint: string }>> {
  const pods = (await (await fetch(url)).json()) as ParityPod[];
  return pods.map((pod) => ({
    seed: pod.seed,
    fingerprint: playBenchGame(pod.seed, pod.decks, pod.providers, pod.turnCap, createSha256())
      .fingerprint,
  }));
}

(globalThis as unknown as { runParity: typeof runParity }).runParity = runParity;

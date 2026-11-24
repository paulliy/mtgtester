/**
 * One seeded four-player benchmark game: engine time apart from the providers, and a fingerprint
 * over everything the engine surfaced. `engine-bench` and `hill-climb` play these through
 * `cli/engine-bench-game.ts`, which hashes with `node:crypto`; the browser parity check
 * (ADR 0053) plays the same games in headless Chromium with `createSha256`. Nothing here needs a
 * runtime API, so both sides run this one copy.
 */
import type { DecisionResponse, PlayerId } from '@mtg/shared';
import {
  Engine,
  RandomDecisionProvider,
  engineWork,
  engineWorkSince,
  type DecisionProvider,
  type EngineWork,
} from '@mtg/engine';
import { HeuristicDecisionProvider } from '@mtg/bot';
import { TABLE_ENGINE_LIMITS } from '../match/engine-limits';
import type { FuzzDeck, FuzzProvider } from '../cli/fuzz-game';

/** A running SHA-256 fed the game's transcript in pieces. */
export interface TranscriptHash {
  update(text: string): unknown;
  digestHex(): string;
}

export interface GameRun {
  seed: number;
  turns: number;
  decisions: number;
  engineMs: number;
  providerMs: number;
  outcome: string;
  fingerprint: string;
  /** Exact counts of the engine's expensive operations in this game, the bot's queries included. */
  work: EngineWork;
  /**
   * Distinct objects and arrays the game's per-log-line boards (`sequenceSnapshots`) hold at the
   * end: what playback retains, the largest thing a game accumulates. Exact on any machine.
   */
  snapshotObjects: number;
}

/** Distinct objects and arrays reachable from `roots`, each counted once however often shared. */
export function countDistinctObjects(roots: Iterable<unknown>): number {
  const seen = new Set<object>();
  const pending: unknown[] = [...roots];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) pending.push(child);
  }
  return seen.size;
}

/** The work of several games, added up counter by counter. */
export function sumWork(works: readonly EngineWork[]): EngineWork {
  const total = engineWorkSince(engineWork());
  for (const work of works)
    for (const kind of Object.keys(total) as Array<keyof EngineWork>) total[kind] += work[kind];
  return total;
}

/**
 * Plays seed `seed`'s pod to the end. The fingerprint is a SHA-256 over every decision request
 * (with its full option menu), every response, the final event log and the outcome.
 */
export function playBenchGame(
  seed: number,
  decks: FuzzDeck[],
  providerKinds: FuzzProvider[],
  turnCap: number,
  hash: TranscriptHash,
): GameRun {
  const seedText = `fuzz-${seed}`;
  // Taken before construction, so the opening hands and mulligans are counted too.
  const workBefore = engineWork();
  const engine = new Engine(
    {
      gameId: 'bench',
      seed: seedText,
      turnCap,
      players: decks.map((deck, seat) => ({
        id: `P${seat + 1}`,
        deckId: deck.label,
        commanders: deck.commanders,
        cards: deck.cards,
      })),
    },
    TABLE_ENGINE_LIMITS,
  );
  const providers = new Map<PlayerId, DecisionProvider>();
  const providerFor = (seat: PlayerId): DecisionProvider => {
    let provider = providers.get(seat);
    if (provider === undefined) {
      const index = Number(seat.slice(1)) - 1;
      provider =
        providerKinds[index] === 'random'
          ? new RandomDecisionProvider(`${seedText}-${seat}`)
          : new HeuristicDecisionProvider(`${seedText}-${seat}`, () => engine.view(seat));
      providers.set(seat, provider);
    }
    return provider;
  };
  let engineMs = 0;
  let providerMs = 0;
  let decisions = 0;
  let outcome = 'running';
  try {
    for (;;) {
      let t = performance.now();
      const step = engine.advance();
      engineMs += performance.now() - t;
      if (step.kind === 'gameOver') {
        outcome = step.result.halted
          ? `halted: ${step.result.haltReason ?? ''}`
          : `winner ${step.result.winnerSeat ?? 'none'}`;
        break;
      }
      if (step.kind === 'continue') continue;
      decisions++;
      hash.update(JSON.stringify(step.request));
      t = performance.now();
      const response: DecisionResponse = providerFor(step.request.decidingPlayer).decide(
        step.request,
      );
      providerMs += performance.now() - t;
      hash.update(JSON.stringify(response));
      t = performance.now();
      engine.submit(response);
      engineMs += performance.now() - t;
    }
  } catch (error) {
    outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  hash.update(JSON.stringify(engine.eventsSince(0)));
  hash.update(outcome);
  const work = engineWorkSince(workBefore);
  const snapshots = engine.getState().sequenceSnapshots;
  return {
    seed,
    turns: engine.getState().turnNumber,
    decisions,
    engineMs: Math.round(engineMs),
    providerMs: Math.round(providerMs),
    outcome,
    fingerprint: hash.digestHex().slice(0, 16),
    work,
    snapshotObjects: snapshots === undefined ? 0 : countDistinctObjects(snapshots.values()),
  };
}

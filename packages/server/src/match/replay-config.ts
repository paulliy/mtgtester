/**
 * What a game stores so it can be replayed from its inputs (ADR 0031 decision 8): the card-data
 * hash, deck snapshot ids, manual mana per seat, turn cap, RNG kind and key, and the runner's step
 * budget, plus the build the game ran on. The recorded decisions are the other half.
 *
 * Deck snapshot ids stand in for card objects. The Oracle data itself is not in git and
 * `card_cache` is overwritten by every re-import, so the hash is what lets a replay refuse to run
 * on card data that is not the card data the game saw.
 */

import type { GameReportBuild, PlayerId } from '@mtg/shared';
import type { GameReplayConfig, GameReplayRecord } from '../db/games';
import { DEFAULT_MAX_DECISIONS } from './runner';

/** What the entry point knows about the process, which the session cannot see for itself. */
export interface ReplayIdentity {
  /** The sha256 "Copy game report" already names; null when the server loaded no card file. */
  cardDataSha256: string | null;
  build: GameReportBuild;
}

export function buildReplayRecord(input: {
  identity: ReplayIdentity;
  seats: ReadonlyArray<{ seat: PlayerId; deckSnapshotId: string }>;
  manualMana: ReadonlySet<PlayerId>;
  turnCap: number;
  rng: GameReplayConfig['rng'];
  /** The engine's work limits, when the game set any (a table's). Absent for the tester's. */
  engineLimits?: { maxStepWork: number; maxObjects: number };
  /** The provisional patches the game played (H1), when it played any. */
  provisional?: GameReplayConfig['provisional'];
}): GameReplayRecord {
  const config: GameReplayConfig = {
    schemaVersion: 1,
    cardDataSha256: input.identity.cardDataSha256,
    seats: input.seats.map((s) => ({
      seat: s.seat,
      deckSnapshotId: s.deckSnapshotId,
      manualMana: input.manualMana.has(s.seat),
    })),
    turnCap: input.turnCap,
    // A `legacy` game's key is empty because the stream is seeded from the public seed in the row.
    // A `chacha20` key lives here, in the stored config, and nowhere a viewer reads before the end.
    rng: input.rng,
    engineOptions: {
      maxDecisions: DEFAULT_MAX_DECISIONS,
      ...(input.engineLimits !== undefined && input.engineLimits),
    },
    ...(input.provisional !== undefined &&
      input.provisional.length > 0 && { provisional: input.provisional }),
  };
  return {
    config,
    buildCommit: input.identity.build.commit,
    buildDirty: input.identity.build.dirty,
  };
}

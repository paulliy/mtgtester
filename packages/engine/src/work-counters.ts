/**
 * Exact counts of the engine's expensive operations, for performance work (`bun run hill-climb`).
 *
 * Wall-clock time in a shared cloud container moves 15-30% between runs, so a 5% CPU win cannot be
 * proved by timing. A count of the work done repeats to the last digit on any machine: if a change
 * leaves every benchmark game identical and does fewer layer passes, it is a real win however
 * noisy the clock is.
 *
 * The counters are process-wide and only ever incremented. Nothing in the engine reads them, so
 * they cannot change a game. To measure a stretch of work, take `engineWork()` before and after and
 * subtract (`engineWorkSince`). Games running interleaved in one process share the counters, so
 * measure one game at a time. The checks run by `MTG_VERIFY_LAYER_CACHE=1` and `strictInvariants`
 * are not counted, so the counts are the same with them on or off.
 */
export interface EngineWork {
  /** CR 613 layer passes over the whole battlefield: layer-cache misses. */
  layerPasses: number;
  /** Characteristics queries answered from the layer cache. */
  layerCacheHits: number;
  /** Digests of the layer inputs, each a hash over every permanent: once per read scope, else per query. */
  layerDigests: number;
  /** CR 613.8 dependency trial states (a whole-board clone plus one applied effect): probes the read/write prefilter could not skip. */
  layerDependencyProbes: number;
  /** Whole-battlefield scans for a layer effect's `Value` ("for each creature you control"): one per effect, not one per object it applies to, when the op cannot change the count. */
  layerValueCounts: number;
  /** Casting checkpoints: each captures every object in the game for in-place rollback. */
  castCheckpoints: number;
  /** Casting previews: a shallow projection of the game with the card moved to the stack. */
  castPreviews: number;
  /** Mana source listings: every mana ability a player's permanents have, judged as payable now. */
  manaSourceListings: number;
  /** Spell payment searches: a joint witness for a spell's mana and non-mana costs. */
  spellPaymentSearches: number;
  /** Payments the stateful mana planner searched (sources whose output depends on the state). */
  manaPlannerSearches: number;
  /** Game states the stateful mana planner visited. */
  manaPlannerStates: number;
  /** Deep copies of the game state, made by the stateful mana planner for each state it tries. */
  stateCopies: number;
  /** Selector candidates built: a permanent's characteristics as a selector reads them, once per permanent and effect or query. */
  selectorCandidates: number;
  /** Permanents folded into layer digests: the bulk of a digest's cost, since each folds every permanent. */
  layerDigestPermanents: number;
}

const WORK: EngineWork = {
  layerPasses: 0,
  layerCacheHits: 0,
  layerDigests: 0,
  layerDependencyProbes: 0,
  layerValueCounts: 0,
  castCheckpoints: 0,
  castPreviews: 0,
  manaSourceListings: 0,
  spellPaymentSearches: 0,
  manaPlannerSearches: 0,
  manaPlannerStates: 0,
  stateCopies: 0,
  selectorCandidates: 0,
  layerDigestPermanents: 0,
};

/** Depth of `uncounted` calls: a check's own work is not the engine's. */
let uncountedDepth = 0;

/** Count one more `kind` of work. */
export function countWork(kind: keyof EngineWork): void {
  if (uncountedDepth === 0) WORK[kind]++;
}

/**
 * Run a verification check without counting its work, so that turning a check on
 * (`MTG_VERIFY_LAYER_CACHE=1`, `strictInvariants`) changes no count.
 */
export function uncounted<T>(run: () => T): T {
  uncountedDepth++;
  try {
    return run();
  } finally {
    uncountedDepth--;
  }
}

/** The counts so far in this process, as a copy. */
export function engineWork(): EngineWork {
  return { ...WORK };
}

/** The work done since `before` was taken with `engineWork()`. */
export function engineWorkSince(before: EngineWork): EngineWork {
  const now = engineWork();
  for (const key of Object.keys(now) as Array<keyof EngineWork>) now[key] -= before[key];
  return now;
}

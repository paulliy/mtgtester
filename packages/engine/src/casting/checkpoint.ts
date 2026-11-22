import { clearCached, getCached, setCached } from '../effects/layer-cache';
import type { GameContext } from '../state/types';
import { countWork } from '../work-counters';

/**
 * In-place recovery for the supported casting payment scope. It preserves references held by
 * enclosing generators. Library/reveal/shuffle mana riders must be rejected before proposal;
 * this is not a general reversal of arbitrary game actions (CR 733.1).
 */
export function castingCheckpoint(ctx: GameContext): () => void {
  countWork('castCheckpoints');
  const restore: (() => void)[] = [];
  const seen = new WeakSet<object>();
  function capture(value: unknown): void {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      const entries = [...value.entries()];
      restore.push(() => {
        value.clear();
        for (const [key, entry] of entries) value.set(key, entry);
      });
      return;
    }
    if (value instanceof Set) {
      const entries = [...value];
      restore.push(() => {
        value.clear();
        for (const entry of entries) value.add(entry);
      });
      return;
    }
    if (Object.isFrozen(value)) return;
    // Keys and values side by side, as `Object.entries` lists them, without a pair per property:
    // a cast captures every object in the game.
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const values = new Array<unknown>(keys.length);
    for (let i = 0; i < keys.length; i++) values[i] = record[keys[i]!];
    const originalLength = Array.isArray(value) ? value.length : undefined;
    restore.push(() => {
      for (const key of Object.keys(record)) delete record[key];
      for (let i = 0; i < keys.length; i++) record[keys[i]!] = values[i];
      if (originalLength !== undefined) (value as unknown[]).length = originalLength;
    });
    for (let i = 0; i < values.length; i++) capture(values[i]);
  }
  // The event log and the debug log are append-only: a logged entry is never edited (see
  // `emit` and the mana planner's `clone`), so rolling one back is truncating it. Walking every
  // entry, as the generic capture does, made each cast cost time in proportion to the length of
  // the game so far: in a bot game nothing drains either log.
  const appendOnly = (log: unknown[]): void => {
    seen.add(log);
    const length = log.length;
    restore.push(() => {
      log.length = length;
    });
  };
  appendOnly(ctx.state.eventLog);
  appendOnly(ctx.debugLog);
  capture(ctx.state);
  capture(ctx.rng);
  capture(ctx.defs);
  capture(ctx.resolutionObjectMoves);
  capture(ctx.resolutionObjectFacts);
  // What a rolled-back cast recorded never happened (ADR 0034 decision 4).
  const diagnostics = ctx.diagnostics?.mark();
  // The layer results for the state being restored. Every read checks them against a digest of
  // the current state, so restoring them is no less safe than clearing, and saves a full pass.
  const layers = getCached(ctx);
  return () => {
    for (const revert of restore) revert();
    if (diagnostics !== undefined) ctx.diagnostics?.truncate(diagnostics);
    if (layers === undefined) clearCached(ctx);
    else setCached(ctx, layers);
  };
}

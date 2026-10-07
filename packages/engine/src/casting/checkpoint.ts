import { clearCached } from '../effects/layer-cache';
import type { GameContext } from '../state/types';

/**
 * In-place recovery for the supported casting payment scope. It preserves references held by
 * enclosing generators. Library/reveal/shuffle mana riders must be rejected before proposal;
 * this is not a general reversal of arbitrary game actions (CR 733.1).
 */
export function castingCheckpoint(ctx: GameContext): () => void {
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
    const entries = Object.entries(value);
    const originalLength = Array.isArray(value) ? value.length : undefined;
    restore.push(() => {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) delete record[key];
      for (const [key, entry] of entries) record[key] = entry;
      if (originalLength !== undefined) (value as unknown[]).length = originalLength;
    });
    for (const [, entry] of entries) capture(entry);
  }
  capture(ctx.state);
  capture(ctx.rng);
  capture(ctx.debugLog);
  capture(ctx.defs);
  capture(ctx.resolutionObjectMoves);
  capture(ctx.resolutionObjectFacts);
  return () => {
    for (const revert of restore) revert();
    clearCached(ctx);
  };
}

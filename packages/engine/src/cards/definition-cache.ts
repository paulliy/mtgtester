import type { OracleCard } from '@mtg/shared';
import type { CardDefinition } from './definition';
import { overrideRegistryGeneration } from './overrides/index';

/**
 * Per-process cache of interpreted card definitions (plan E9, a stopgap until cards ship as a
 * precompiled definitions file).
 *
 * Interpreting a card is a pure function of the `OracleCard` and the authored-override registry,
 * so a batch, fuzz run or table server that starts many games with the same decks only needs to
 * parse each card once. Two things keep that true:
 *
 * - The key is the card's canonical JSON, not its oracle id alone, so a test fixture that reuses
 *   an id with different text gets its own entry.
 * - The whole cache is dropped when the override registry's generation moves, so a runtime
 *   `registerOverride` / `unregisterOverride` is never answered with a stale definition.
 *
 * The cache holds definitions BEFORE the test-only `transformDefinition` hook; `interpretCard`
 * applies the hook on every read, so IR mutation still sees and changes each card.
 *
 * Cached definitions are shared by every game in the process, so nothing may mutate one. Under
 * vitest each definition is deep-frozen as it enters the cache, so a mutation throws in tests
 * instead of leaking state between games. Production skips the freeze.
 */

const cache = new Map<string, CardDefinition>();
// Read lazily: this module can load before the registry finishes initialising (import cycle).
let cachedGeneration = -1;

/** Deep-freeze entries under vitest only: the freeze costs time and production relies on tests. */
const FREEZE =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'VITEST'
  ] !== undefined;

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
}

/** The cached definition for `card`, interpreting it with `interpret` on a miss. */
export function cachedDefinition(
  card: OracleCard,
  interpret: (card: OracleCard) => CardDefinition,
): CardDefinition {
  const generation = overrideRegistryGeneration();
  if (generation !== cachedGeneration) {
    cache.clear();
    cachedGeneration = generation;
  }
  const key = JSON.stringify(card);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const definition = interpret(card);
  if (FREEZE) deepFreeze(definition);
  cache.set(key, definition);
  return definition;
}

/** Number of cached definitions, for stats. */
export function definitionCacheSize(): number {
  return cache.size;
}

/** Test seam: forget every cached definition. */
export function clearDefinitionCache(): void {
  cache.clear();
}

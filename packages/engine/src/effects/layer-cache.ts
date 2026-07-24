/**
 * Memoization for the CR 613 layer pass (ADR 0007).
 *
 * Forge and XMage both recompute continuous effects *once per state change* and store the
 * result on the objects, so reads are cheap. This engine computes on demand from the queried
 * call site instead, which is simpler and always fresh — but recomputing the whole battlefield
 * per `effectivePT` call is O(battlefield × effects), and measured at 17× slower once four
 * static abilities are in play (an ordinary Commander board).
 *
 * Rather than a revision counter bumped at every mutation site — which silently returns stale
 * characteristics the moment a site is missed, and which the test suite's direct state surgery
 * (`perm.counters['+1/+1'] = 1`) would defeat — the cache is keyed on a **content digest** of
 * exactly the state the layer pass reads. A digest cannot miss a mutation: if an input changed,
 * the key changes.
 *
 * The one variable-cost input is graveyard contents, read only by state-dependent `Value`s
 * (Tarmogoyf's CDA). Folding every graveyard on every call would undo the savings, so the
 * cache records whether the last pass actually used one. If it did not, graveyards are left out
 * of the key — which is sound, because a change no effect reads cannot change the answer, and
 * a Tarmogoyf *entering* changes the battlefield portion of the digest and forces a miss.
 */

import type { EnginePermanent, GameContext } from '../state/types';
import type { Characteristics } from '../cards/continuous-types';

export interface LayerCacheEntry {
  digest: number;
  /** Whether the computed pass read graveyard contents (a state-dependent `Value`). */
  usedGraveyards: boolean;
  /** Identity of the off-battlefield permanent folded into this pass, if any. */
  extraCardId: string | null;
  map: Map<string, Characteristics>;
}

/** Per-game, garbage-collected with the context. */
const CACHE = new WeakMap<GameContext, LayerCacheEntry>();

export function getCached(ctx: GameContext): LayerCacheEntry | undefined {
  return CACHE.get(ctx);
}

export function setCached(ctx: GameContext, entry: LayerCacheEntry): void {
  CACHE.set(ctx, entry);
}

/**
 * Oracle ids and counter names are drawn from a small fixed vocabulary and are shared across
 * games, so hashing them once is safe and bounded.
 */
const STRING_HASH = new Map<string, number>();

function mix(h: number, x: number): number {
  return Math.imul((h ^ x) >>> 0, 0x01000193) >>> 0;
}

function hashString(s: string): number {
  const cached = STRING_HASH.get(s);
  if (cached !== undefined) return cached;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i));
  STRING_HASH.set(s, h);
  return h;
}

/**
 * Fold every counter generically rather than the two the layer engine reads today, so an op
 * that starts reading a new counter kind cannot silently get a stale answer. String key order
 * is insertion order, which is deterministic.
 */
function foldCounters(h: number, perm: EnginePermanent): number {
  for (const name in perm.counters) {
    h = mix(h, hashString(name));
    // Offset so that negative counts stay distinct under the xor.
    h = mix(h, (perm.counters[name] ?? 0) + 0x10000);
  }
  return h;
}

/**
 * Digest of everything `runLayers` reads. `timestamp` is unique per permanent and per
 * until-end-of-turn effect and never changes, so it identifies membership exactly; until-eot
 * effects are immutable once created, so their timestamp alone covers them.
 */
export function digestOf(
  ctx: GameContext,
  extra: EnginePermanent | undefined,
  includeGraveyards: boolean,
): number {
  const s = ctx.state;
  let h = 0x811c9dc5;

  h = mix(h, s.battlefield.length);
  for (const perm of s.battlefield) {
    h = mix(h, perm.timestamp);
    h = mix(h, hashString(perm.oracleId));
    h = mix(h, (perm.power ?? 0) + 0x10000);
    h = mix(h, (perm.toughness ?? 0) + 0x10000);
    h = foldCounters(h, perm);
  }

  h = mix(h, s.effects.length);
  for (const eff of s.effects) h = mix(h, eff.timestamp);

  h = mix(h, extra === undefined ? 0 : extra.timestamp + 1);

  if (includeGraveyards) {
    for (const player of s.players) {
      h = mix(h, player.graveyard.length);
      for (const card of player.graveyard) h = mix(h, hashString(card.oracleId));
    }
  }

  return h;
}

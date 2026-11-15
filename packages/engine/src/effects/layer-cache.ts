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
 *
 * `MTG_VERIFY_LAYER_CACHE=1` recomputes on every hit and throws if the results disagree. It is
 * ~20× slower, so it needs a raised timeout or the whole-game tests fail as timeouts rather
 * than staleness:
 *
 *     MTG_VERIFY_LAYER_CACHE=1 npx vitest run --testTimeout=300000
 */

import type { EnginePermanent, GameContext } from '../state/types';
import type { Characteristics } from '../cards/continuous-types';
import { countWork } from '../work-counters';

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
 * Under `strictInvariants` (ADR 0034 decision 8) one cache hit in `SAMPLE_EVERY` is recomputed
 * and compared, as `MTG_VERIFY_LAYER_CACHE=1` does for every hit. A per-game count picks the
 * sample, so it draws no randomness and a game plays the same with it on or off.
 */
const SAMPLE_EVERY = 64;
const HITS = new WeakMap<GameContext, number>();

export function sampleCacheHit(ctx: GameContext): boolean {
  return sampleHit(HITS, ctx);
}

/** Scoped digest hits count apart: a scoped query also counts as a cache hit, and one shared
 * counter would step by two per query, so one of the two samples would never fire in a scope. */
const SCOPED_HITS = new WeakMap<GameContext, number>();

function sampleHit(counter: WeakMap<GameContext, number>, ctx: GameContext): boolean {
  if (ctx.strictInvariants !== true) return false;
  const hits = (counter.get(ctx) ?? 0) + 1;
  counter.set(ctx, hits);
  return hits % SAMPLE_EVERY === 0;
}

/** Discard a speculative casting pass after in-place recovery. */
export function clearCached(ctx: GameContext): void {
  CACHE.delete(ctx);
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
 * Like `hashString`, but uncached — for values with effectively unbounded cardinality
 * (`attachedTo`'s `ObjectId`s grow with every object a long game creates), where memoizing
 * every distinct value in the module-level `STRING_HASH` map would leak across games.
 */
function hashStringUncached(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i));
  return h;
}

/**
 * A number for each definition object, so the digest sees a definition replaced under the same
 * oracle id (`ctx.defs.set`). The engine adds definitions only under new oracle ids, but a test
 * or a tool that swaps one must not read the old one's results. Weak, so definitions are not kept.
 *
 * The numbers are per game (per definitions map, shared with the planner's copies through
 * `shareDefinitionIds`). Numbered process-wide, the same game digested to different values
 * depending on how many games the process had played before, so which states happened to share
 * a digest, and with it the engine's work, changed from run to run (found by the work counters).
 */
interface DefinitionIds {
  ids: WeakMap<object, number>;
  next: number;
}
const DEFINITION_IDS = new WeakMap<object, DefinitionIds>();
/** The last table looked up: a digest asks once per permanent, almost always of one game. */
let lastDefs: object | null = null;
let lastTable: DefinitionIds | null = null;

function definitionIds(defs: object): DefinitionIds {
  if (defs === lastDefs) return lastTable!;
  let table = DEFINITION_IDS.get(defs);
  if (table === undefined) {
    table = { ids: new WeakMap(), next: 1 };
    DEFINITION_IDS.set(defs, table);
  }
  lastDefs = defs;
  lastTable = table;
  return table;
}

function definitionId(ctx: GameContext, definition: object | undefined): number {
  if (definition === undefined) return 0;
  const table = definitionIds(ctx.defs);
  let id = table.ids.get(definition);
  if (id === undefined) {
    id = table.next++;
    table.ids.set(definition, id);
  }
  return id;
}

/** A copy of `from` with its own definitions map numbers definitions as `from` does. */
export function shareDefinitionIds(from: GameContext, to: GameContext): void {
  DEFINITION_IDS.set(to.defs, definitionIds(from.defs));
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
    h = mix(h, perm.counterTimestamps?.[name] ?? perm.timestamp);
  }
  return h;
}

/**
 * Digest of everything `runLayers` reads. `timestamp` is unique per permanent and per
 * until-end-of-turn effect, so it identifies membership exactly; an Aura or Equipment gets a new
 * one as it becomes attached (CR 613.7e), which the digest sees like any other change. Until-eot
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
    h = mix(h, perm.classLevel ?? 1);
    // A Room's characteristics are its unlocked doors' (CR 709.5).
    h = mix(
      h,
      (perm.unlockedDoors?.includes('left') ? 1 : 0) +
        (perm.unlockedDoors?.includes('right') ? 2 : 0),
    );
    h = mix(h, hashString(perm.oracleId));
    h = mix(h, definitionId(ctx, ctx.defs.get(perm.oracleId)));
    // Selectors read the controller ("creatures you control"). Nothing reassigns this today —
    // layer 2 is not implemented — but folding it keeps the digest honest when it arrives.
    h = mix(h, hashString(perm.controllerId));
    h = mix(h, (perm.power ?? 0) + 0x10000);
    h = mix(h, (perm.toughness ?? 0) + 0x10000);
    h = mix(h, perm.faceDown === true ? 1 : 0);
    h = mix(h, perm.faceDownWard === true ? 1 : 0);
    h = mix(h, perm.transformed ? 1 : 0);
    // A bestowed Aura's type-changing effect ends as it becomes unattached (CR 702.103f).
    h = mix(h, perm.bestowed === true ? 1 : 0);
    // A static ability can be conditional on being untapped (Iymrith's ward {4}), so tapping is
    // a layer input like any other. Omitting it meant a query before tapping and a query after
    // it returned the same cached characteristics, and ward is read during targeting/payment.
    h = mix(h, perm.tapped ? 1 : 0);
    // Combat-dependent statics must expire even if no other characteristic input changes.
    // `attackingDefenderId` also reads whether it attacks a planeswalker, and whether that one is
    // still in combat.
    h = mix(
      h,
      perm.attacking !== null
        ? 1 +
            (perm.attackingPlaneswalker !== null ? 2 : 0) +
            (perm.attackedPlaneswalkerRemoved ? 4 : 0)
        : perm.blocking !== null
          ? 8
          : 0,
    );
    // `timesAttackedThisTurn` feeds a layer-7 value (Moraug).
    h = mix(h, perm.timesAttackedThisTurn ?? 0);
    // The `hadToAttackThisCombat` condition reads this per-combat flag.
    h = mix(h, perm.hadToAttackThisCombat === true ? 1 : 0);
    // `?? []` would allocate a throwaway array on every digest call for the overwhelming
    // majority of permanents, which never set any of these — an `undefined` guard keeps the
    // fast path (this function runs on every characteristics query) allocation-free.
    if (perm.copyAddTypes !== undefined)
      for (const type of perm.copyAddTypes) h = mix(h, hashString(type));
    if (perm.copyAddKeywords !== undefined)
      for (const kw of perm.copyAddKeywords) h = mix(h, hashString(kw));
    if (perm.copyRemoveSupertypes !== undefined)
      for (const st of perm.copyRemoveSupertypes) h = mix(h, hashString(st));
    if (perm.copyAddSupertypes !== undefined)
      for (const st of perm.copyAddSupertypes) h = mix(h, hashString(st));
    if (perm.copyAddTriggers !== undefined)
      for (const tr of perm.copyAddTriggers) h = mix(h, hashString(tr.description ?? ''));
    // Duplicant reads which linked cards are still in exile (CR 607.2a).
    if (perm.exiledWithIds !== undefined)
      for (const id of perm.exiledWithIds) {
        h = mix(h, hashString(id));
        h = mix(h, s.exile.some((card) => card.id === id) ? 1 : 0);
      }
    h = foldCounters(h, perm);
    // `attachedToSource`/`isEnchanted`/`isEquipped` read this; attaching/detaching changes
    // none of the fields above, so it must be folded in explicitly (ADR 0007).
    h = mix(h, perm.attachedTo === null ? 0 : hashStringUncached(perm.attachedTo));
    // `chosenColor`/`chosenType` selectors read this (Caged Sun, Cloud Key, Flickering Ward).
    h = mix(h, perm.chosenOption === undefined ? 0 : hashString(perm.chosenOption));
  }

  h = mix(h, s.effects.length);
  for (const eff of s.effects) h = mix(h, eff.timestamp);

  // Commander's Insignia and similar static P/T ops read this (`commanderCastCount`, a
  // resolving-scope Value the layer engine now answers from the source's controller). It is
  // bounded by commander count per player — one or two, with partners — so unlike graveyards
  // it costs nothing to fold in unconditionally rather than gating it behind a "did a pass
  // actually use it" flag.
  for (const player of s.players) {
    for (const cardId in player.commanderCastCount) {
      h = mix(h, hashStringUncached(cardId));
      h = mix(h, (player.commanderCastCount[cardId] ?? 0) + 0x10000);
    }
  }

  h = mix(h, extra === undefined ? 0 : extra.timestamp + 1);
  if (extra !== undefined) h = mix(h, definitionId(ctx, ctx.defs.get(extra.oracleId)));

  // A static ability's `condition` can read game-level state no permanent carries: "as long as
  // it entered this turn" (the turn number), "during your turn" (the active player), graveyard,
  // hand and life counts, spells cast this turn, the monarch. Each is a cheap scalar, so fold
  // them all rather than learn which one a new condition starts reading from a stale cache.
  h = mix(h, s.turnNumber + 0x10000);
  h = mix(h, hashString(s.currentTurnPlayer ?? ''));
  h = mix(h, hashString(s.phase ?? ''));
  h = mix(h, hashString(s.step ?? ''));
  h = mix(h, s.monarchPlayerId === null ? 0 : hashString(s.monarchPlayerId));
  h = mix(h, s.eliminatedPlayers.length);
  h = mix(h, s.creaturesDiedThisTurn + 0x10000);
  h = mix(h, Object.keys(s.modifiedCreatureDiedThisTurn ?? {}).length);
  h = mix(h, s.excessDamageControllerIds.length);
  for (const player of s.players) {
    // A player who has lost is no opponent (Nighthawk Scavenger's count), from the loss until
    // the elimination that removes their cards: `eliminatedPlayers` alone misses that window.
    h = mix(h, player.hasLost ? 1 : 0);
    h = mix(h, player.life + 0x10000);
    h = mix(h, player.hand.length);
    h = mix(h, player.library.length);
    h = mix(h, player.graveyard.length);
    h = mix(h, player.spellsCastThisTurn);
    h = mix(h, player.noncreatureSpellsCastThisTurn);
    h = mix(h, player.cardsDrawnThisTurn);
    h = mix(h, player.cardsDrawnThisDrawStep);
    h = mix(h, (s.damageDealtToPlayersThisTurn[player.id] ?? 0) + 0x10000);
    h = mix(h, s.createdTokenThisTurn?.[player.id] === true ? 1 : 0);
  }

  if (includeGraveyards) {
    for (const player of s.players) {
      h = mix(h, player.graveyard.length);
      for (const card of player.graveyard) h = mix(h, hashString(card.oracleId));
    }
  }

  return h;
}

/**
 * Read scopes: a stretch of engine code that changes nothing the layer digest covers, such as
 * building a priority menu, gathering mana sources, or matching triggers to an event. Inside one
 * each distinct digest is computed once and reused. Without a scope every characteristics query
 * re-digests the whole battlefield, and the many loops that query each permanent in turn made
 * those reads quadratic in board size: about 40% of engine CPU in measured bot games.
 *
 * A scope belongs to one context object. A speculative copy (the mana planner's `clone`, a
 * casting preview) is a different object and digests as before, so it may be changed freely.
 * State the digest does not read (the event log, pending triggers) may change inside a scope;
 * anything it does read must not. The safety net: `MTG_VERIFY_LAYER_CACHE=1` re-digests on every
 * scoped hit, and under `strictInvariants` one scoped hit in `SAMPLE_EVERY` is re-digested and
 * each scope re-digests the state as it closes, so fuzz and the strict tests fail loudly when a
 * scoped read starts changing a layer input.
 */
const SCOPES = new WeakMap<GameContext, Map<string, number>>();

const VERIFY_SCOPES =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'MTG_VERIFY_LAYER_CACHE'
  ] === '1';

const STALE = 'engine bug: a layer input changed inside a read scope';

/** Run `read` inside a read scope on `ctx`. A nested scope on the same context joins the outer. */
export function withReadScope<T>(ctx: GameContext, read: () => T): T {
  if (SCOPES.has(ctx)) return read();
  const digests = new Map<string, number>();
  SCOPES.set(ctx, digests);
  let result: T;
  try {
    result = read();
  } finally {
    SCOPES.delete(ctx);
  }
  if (ctx.strictInvariants === true || VERIFY_SCOPES) {
    for (const [key, digest] of digests) {
      if (key.startsWith('-|') && digestOf(ctx, undefined, key === '-|g') !== digest)
        throw new Error(STALE);
    }
  }
  return result;
}

/** `digestOf`, computed once per read scope for each distinct `extra` and graveyard flag. */
export function scopedDigestOf(
  ctx: GameContext,
  extra: EnginePermanent | undefined,
  includeGraveyards: boolean,
): number {
  const scope = SCOPES.get(ctx);
  if (scope === undefined) {
    countWork('layerDigests');
    return digestOf(ctx, extra, includeGraveyards);
  }
  const key =
    (extra === undefined ? '-' : `${extra.cardId}:${extra.timestamp}:${extra.oracleId}`) +
    (includeGraveyards ? '|g' : '|n');
  const known = scope.get(key);
  if (known === undefined) {
    countWork('layerDigests');
    const digest = digestOf(ctx, extra, includeGraveyards);
    scope.set(key, digest);
    return digest;
  }
  if (
    (VERIFY_SCOPES || sampleHit(SCOPED_HITS, ctx)) &&
    digestOf(ctx, extra, includeGraveyards) !== known
  )
    throw new Error(STALE);
  return known;
}

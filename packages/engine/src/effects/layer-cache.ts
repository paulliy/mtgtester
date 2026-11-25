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
 * The game-level scalars (turn, phase, step, active player, monarch, life and zone counts) share
 * that flag. They are cheap to fold but change at every step, and only a condition, a dynamic
 * value or a turn-scoped selector test reads them, each counted by `gameStateRead`. A pass that
 * read none answers for every step and turn of the same board.
 *
 * Tapped status is gated the same way (ADR 0007, amendment 2), for a different reason: it is
 * cheap to fold but changes constantly, and the mana planner taps a land in every state it
 * searches. Only a few conditions and values read it (Iymrith's "as long as it's untapped"), each
 * through `tappedState`, which counts its reads, so the pass knows exactly whether it read any.
 * Unread, a different tapped mix of the same board has the same answer.
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
  /**
   * Whether the computed pass read game state beyond the permanents: graveyard contents, a
   * condition, a dynamic value or a turn-scoped selector test (`gameStateRead`). When it did not,
   * graveyards and the game-level scalars are left out of the next lookup's key.
   */
  usedGameState: boolean;
  /**
   * Whether the computed pass read any permanent's tapped status. When it did not, `tapped` is
   * left out of the next lookup's key, so a tap alone does not cost a pass.
   */
  usedTapped: boolean;
  /** Identity of the off-battlefield permanent folded into this pass, if any. */
  extraCardId: string | null;
  map: Map<string, Characteristics>;
  /** Set once a sampled hit has recomputed this pass and found it fresh (`sampleCacheHit`). */
  verified?: true;
  /**
   * For a verified pass that read no tapped status: the digest with tapped status folded in, as
   * it was when the pass was verified. The key leaves tapped status out, so a tap alone reuses
   * the pass; when this digest changes, the pass is sampled again.
   */
  verifiedTappedDigest?: number;
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
 * Recent layer passes shared by one game's live context and the casting previews made from it.
 * Previews of one state differ only in which card left which zone, which the digest sees as zone
 * sizes (and a command-zone cast as no change at all), so a priority round that previews each
 * player's cards in turn moved one preview's results back and forth between a few digests and
 * recomputed a full pass at each switch. A context that misses its own entry checks these first.
 * Each is matched on the digest of that context's own state, computed with that pass's flags, so a
 * match is exactly as sound as a hit on its own entry. The live context takes part both ways:
 * measured, leaving it out gave back nearly all of the saving.
 *
 * An entry's strict-mode `verified` mark travels with it, as it already did when a preview was
 * seeded with its base's entry: a pass verified fresh is the same pass whatever context holds it.
 */
interface SharedPasses {
  entries: LayerCacheEntry[];
}
/** The pool of each context in it: a game's live context and every preview made from it. */
const SHARED_PASSES = new WeakMap<GameContext, SharedPasses>();
/** Enough for one preview per seat of a four-player game, and its command-zone variants. */
const SHARED_PASS_LIMIT = 8;

/** Put `preview` in the pool of `base`, the context it was made from. */
export function sharePassesWith(base: GameContext, preview: GameContext): void {
  let shared = SHARED_PASSES.get(base);
  if (shared === undefined) {
    shared = { entries: [] };
    SHARED_PASSES.set(base, shared);
  }
  SHARED_PASSES.set(preview, shared);
}

/**
 * A recent pass from this context's pool for this state, if any: one read with the same flags as
 * the context's own entry and recorded under the digest the context just computed with them.
 * Only those are checked, so a lookup computes no digest of its own.
 */
export function sharedPassFor(
  ctx: GameContext,
  digest: number,
  includeGameState: boolean,
  includeTapped: boolean,
  extraCardId: string | null,
): LayerCacheEntry | undefined {
  const shared = SHARED_PASSES.get(ctx);
  if (shared === undefined) return undefined;
  for (const entry of shared.entries)
    if (
      entry.digest === digest &&
      entry.extraCardId === extraCardId &&
      entry.usedGameState === includeGameState &&
      entry.usedTapped === includeTapped
    )
      return entry;
  return undefined;
}

/** Offer a pass to the rest of its context's pool, newest first. */
export function sharePass(ctx: GameContext, entry: LayerCacheEntry): void {
  const shared = SHARED_PASSES.get(ctx);
  if (shared === undefined) return;
  shared.entries.unshift(entry);
  if (shared.entries.length > SHARED_PASS_LIMIT) shared.entries.length = SHARED_PASS_LIMIT;
}

/**
 * Under `strictInvariants` (ADR 0034 decision 8) one cache hit in `SAMPLE_EVERY` is recomputed
 * and compared, as `MTG_VERIFY_LAYER_CACHE=1` does for every hit. A per-game count picks the
 * sample, so it draws no randomness and a game plays the same with it on or off.
 *
 * Each cached pass is verified at most once: hits on an entry already found fresh neither sample
 * nor count. A sample costs a whole layer pass, and loops that query every permanent hit one
 * entry once per permanent, so sampling every hit made the checking grow with board size squared:
 * a 300-token fuzz board (fuzz-203) hit each entry about 1,200 times and spent more time
 * verifying than playing. Now the checking costs at most one extra pass per pass computed.
 *
 * A pass that read no tapped status is reused across taps (ADR 0007, amendment 2), which is an
 * input the key leaves out on that pass's word. So such a pass is verified once per tapped state
 * of the board: `computeAllCharacteristics` clears `verified` when the tapped digest moves.
 */
const SAMPLE_EVERY = 64;
const HITS = new WeakMap<GameContext, number>();

export function sampleCacheHit(ctx: GameContext, entry: LayerCacheEntry): boolean {
  if (entry.verified === true) return false;
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
 * The digest is a 53-bit hash of a stream of 32-bit words, built from two independent
 * MurmurHash3-style lanes. It used to be one 32-bit lane of `h = (h ^ x) * prime`, which is
 * weak for structured words: the multiply only carries low bits upward, so flipping the top bit
 * of one word and of the next cancels (`(h ^ x ^ 2^31) * p = (h ^ x) * p ^ 2^31` for an odd
 * `p`), and the work counters measured about 3 collisions in 16 benchmark games, each one a
 * cache hit on a different state. Every word is now scrambled before it enters a lane, and the
 * two lanes rotate and multiply differently, so a collision needs both 32-bit lanes to collide
 * at once on a full-avalanche hash: about 2^-53 per comparison.
 *
 * The lanes are module state, not a returned value, so a digest allocates nothing. `digestOf`
 * is not reentrant (nothing it calls digests), and it resets them on entry.
 */
let laneA = 0;
let laneB = 0;
let words = 0;

function feed(x: number): void {
  let k = Math.imul(x | 0, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  laneA ^= Math.imul(k, 0x1b873593);
  laneA = (laneA << 13) | (laneA >>> 19);
  laneA = (Math.imul(laneA, 5) + 0xe6546b64) | 0;
  let j = Math.imul(x | 0, 0x85ebca6b);
  j = (j << 16) | (j >>> 16);
  laneB ^= Math.imul(j, 0xc2b2ae35);
  laneB = (laneB << 17) | (laneB >>> 15);
  laneB = (Math.imul(laneB, 9) + 0x2b6a8e19) | 0;
  words++;
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function startDigest(): void {
  laneA = 0x811c9dc5 | 0;
  laneB = 0x9e3779b9 | 0;
  words = 0;
}

/** The 53 bits a JS number holds exactly: 21 from lane B above 32 from lane A. */
function finishDigest(): number {
  const a = fmix(laneA ^ words);
  const b = fmix(laneB ^ Math.imul(words, 0x27d4eb2f));
  return (b >>> 11) * 0x100000000 + a;
}

/**
 * A string's own digest, as one 53-bit number. Oracle ids and counter names are drawn from a
 * small fixed vocabulary and are shared across games, so hashing them once is safe and bounded.
 * Hashed with the same lanes, saved and restored around the string, so a string folds in as two
 * well-mixed words rather than one 32-bit value that could collide with another string's.
 */
const STRING_HASH = new Map<string, number>();

function stringDigest(s: string): number {
  const a = laneA;
  const b = laneB;
  const n = words;
  startDigest();
  feed(s.length);
  for (let i = 0; i < s.length; i++) feed(s.charCodeAt(i));
  const digest = finishDigest();
  laneA = a;
  laneB = b;
  words = n;
  return digest;
}

function feedDigest(digest: number): void {
  feed(digest >>> 0);
  feed(Math.floor(digest / 0x100000000));
}

function feedString(s: string): void {
  let digest = STRING_HASH.get(s);
  if (digest === undefined) {
    digest = stringDigest(s);
    STRING_HASH.set(s, digest);
  }
  feedDigest(digest);
}

/**
 * Like `feedString`, but uncached — for values with effectively unbounded cardinality
 * (`attachedTo`'s `ObjectId`s grow with every object a long game creates), where memoizing
 * every distinct value in the module-level `STRING_HASH` map would leak across games.
 */
function feedStringUncached(s: string): void {
  feed(s.length);
  for (let i = 0; i < s.length; i++) feed(s.charCodeAt(i));
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
function foldCounters(perm: EnginePermanent): void {
  for (const name in perm.counters) {
    feedString(name);
    // Offset so that negative counts stay positive words.
    feed((perm.counters[name] ?? 0) + 0x10000);
    feed(perm.counterTimestamps?.[name] ?? perm.timestamp);
  }
  // Ends the variable-length run, so counters cannot be read as the fields that follow.
  feed(0x7fffffff);
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
  includeGameState: boolean,
  includeTapped: boolean,
  /** Count the permanents this digest folds (`layerDigestPermanents`): engine work, not a check. */
  counted = false,
): number {
  const s = ctx.state;
  startDigest();
  if (counted) for (let i = 0; i < s.battlefield.length; i++) countWork('layerDigestPermanents');
  feed(s.battlefield.length);
  for (const perm of s.battlefield) {
    feed(perm.timestamp);
    feed(perm.classLevel ?? 1);
    // A Room's characteristics are its unlocked doors' (CR 709.5).
    feed(
      (perm.unlockedDoors?.includes('left') ? 1 : 0) +
        (perm.unlockedDoors?.includes('right') ? 2 : 0),
    );
    feedString(perm.oracleId);
    feed(definitionId(ctx, ctx.defs.get(perm.oracleId)));
    // Selectors read the controller ("creatures you control"). Nothing reassigns this today —
    // layer 2 is not implemented — but folding it keeps the digest honest when it arrives.
    feedString(perm.controllerId);
    feed((perm.power ?? 0) + 0x10000);
    feed((perm.toughness ?? 0) + 0x10000);
    feed(perm.faceDown === true ? 1 : 0);
    feed(perm.faceDownWard === true ? 1 : 0);
    feed(perm.transformed ? 1 : 0);
    // A bestowed Aura's type-changing effect ends as it becomes unattached (CR 702.103f).
    feed(perm.bestowed === true ? 1 : 0);
    // A static ability can be conditional on being untapped (Iymrith's ward {4}), so tapping is
    // a layer input whenever the last pass read it. Omitting it then meant a query before tapping
    // and a query after it returned the same cached characteristics, and ward is read during
    // targeting/payment.
    if (includeTapped) feed(perm.tapped ? 1 : 0);
    // Combat-dependent statics must expire even if no other characteristic input changes.
    // `attackingDefenderId` also reads whether it attacks a planeswalker, and whether that one is
    // still in combat.
    feed(
      perm.attacking !== null
        ? 1 +
            (perm.attackingPlaneswalker !== null ? 2 : 0) +
            (perm.attackedPlaneswalkerRemoved ? 4 : 0)
        : perm.blocking !== null
          ? 8
          : 0,
    );
    // `timesAttackedThisTurn` feeds a layer-7 value (Moraug).
    feed(perm.timesAttackedThisTurn ?? 0);
    // The `hadToAttackThisCombat` condition reads this per-combat flag.
    feed(perm.hadToAttackThisCombat === true ? 1 : 0);
    // `?? []` would allocate a throwaway array on every digest call for the overwhelming
    // majority of permanents, which never set any of these — an `undefined` guard keeps the
    // fast path (this function runs on every characteristics query) allocation-free.
    if (perm.copyAddTypes !== undefined) {
      feed(perm.copyAddTypes.length);
      for (const type of perm.copyAddTypes) feedString(type);
    }
    if (perm.copyAddKeywords !== undefined) {
      feed(perm.copyAddKeywords.length);
      for (const kw of perm.copyAddKeywords) feedString(kw);
    }
    if (perm.copyRemoveSupertypes !== undefined) {
      feed(perm.copyRemoveSupertypes.length);
      for (const st of perm.copyRemoveSupertypes) feedString(st);
    }
    if (perm.copyAddSupertypes !== undefined) {
      feed(perm.copyAddSupertypes.length);
      for (const st of perm.copyAddSupertypes) feedString(st);
    }
    if (perm.copyAddTriggers !== undefined) {
      feed(perm.copyAddTriggers.length);
      for (const tr of perm.copyAddTriggers) feedString(tr.description ?? '');
    }
    // Duplicant reads which linked cards are still in exile (CR 607.2a).
    if (perm.exiledWithIds !== undefined) feed(perm.exiledWithIds.length);
    if (perm.exiledWithIds !== undefined)
      for (const id of perm.exiledWithIds) {
        feedString(id);
        feed(s.exile.some((card) => card.id === id) ? 1 : 0);
      }
    foldCounters(perm);
    // `attachedToSource`/`isEnchanted`/`isEquipped` read this; attaching/detaching changes
    // none of the fields above, so it must be folded in explicitly (ADR 0007).
    if (perm.attachedTo === null) feed(0);
    else {
      feed(1);
      feedStringUncached(perm.attachedTo);
    }
    // `chosenColor`/`chosenType` selectors read this (Caged Sun, Cloud Key, Flickering Ward).
    if (perm.chosenOption === undefined) feed(0);
    else {
      feed(1);
      feedString(perm.chosenOption);
    }
  }

  feed(s.effects.length);
  for (const eff of s.effects) feed(eff.timestamp);

  // Commander's Insignia and similar static P/T ops read this (`commanderCastCount`, a
  // resolving-scope Value the layer engine now answers from the source's controller). It is
  // bounded by commander count per player — one or two, with partners — so unlike graveyards
  // it costs nothing to fold in unconditionally rather than gating it behind a "did a pass
  // actually use it" flag.
  for (const player of s.players) {
    feed(0x7ffffffe);
    for (const cardId in player.commanderCastCount) {
      feedStringUncached(cardId);
      feed((player.commanderCastCount[cardId] ?? 0) + 0x10000);
    }
  }

  feed(extra === undefined ? 0 : extra.timestamp + 1);
  if (extra !== undefined) feed(definitionId(ctx, ctx.defs.get(extra.oracleId)));

  // Everything before the game state, kept so a re-digest after a pass that changed only that
  // flag finishes from here (`scopedDigestAfterPass`).
  prefixCtx = ctx;
  prefixExtra = extra;
  prefixTapped = includeTapped;
  prefixA = laneA;
  prefixB = laneB;
  prefixWords = words;
  foldGameState(ctx, includeGameState);
  return finishDigest();
}

/** The game-state part of `digestOf`, last so a digest can be finished either way from one walk. */
function foldGameState(ctx: GameContext, includeGameState: boolean): void {
  const s = ctx.state;
  // A static ability's `condition` can read game-level state no permanent carries: "as long as
  // it entered this turn" (the turn number), "during your turn" (the active player), graveyard,
  // hand and life counts, spells cast this turn, the monarch. Each is a cheap scalar, so fold
  // them all rather than learn which one a new condition starts reading from a stale cache, but
  // only when the last pass read any game state (`gameStateRead`): on a board whose statics read
  // none, a new step or turn is no reason for a fresh pass.
  if (includeGameState) {
    feed(s.turnNumber + 0x10000);
    feedString(s.currentTurnPlayer ?? '');
    feedString(s.phase ?? '');
    feedString(s.step ?? '');
    if (s.monarchPlayerId === null) feed(0);
    else {
      feed(1);
      feedString(s.monarchPlayerId);
    }
    feed(s.eliminatedPlayers.length);
    feed(s.creaturesDiedThisTurn + 0x10000);
    feed(Object.keys(s.modifiedCreatureDiedThisTurn ?? {}).length);
    feed(s.excessDamageControllerIds.length);
    for (const player of s.players) {
      // A player who has lost is no opponent (Nighthawk Scavenger's count), from the loss until
      // the elimination that removes their cards: `eliminatedPlayers` alone misses that window.
      feed(player.hasLost ? 1 : 0);
      feed(player.life + 0x10000);
      feed(player.hand.length);
      feed(player.library.length);
      feed(player.graveyard.length);
      feed(player.spellsCastThisTurn);
      feed(player.noncreatureSpellsCastThisTurn);
      feed(player.cardsDrawnThisTurn);
      feed(player.cardsDrawnThisDrawStep);
      feed((s.damageDealtToPlayersThisTurn[player.id] ?? 0) + 0x10000);
      feed(s.createdTokenThisTurn?.[player.id] === true ? 1 : 0);
    }
  }

  if (includeGameState) {
    for (const player of s.players) {
      feed(player.graveyard.length);
      for (const card of player.graveyard) feedString(card.oracleId);
    }
  }
}

/** The lanes of the last `digestOf` before its game state, and what that digest was of. */
let prefixCtx: GameContext | null = null;
let prefixExtra: EnginePermanent | undefined;
let prefixTapped = false;
let prefixA = 0;
let prefixB = 0;
let prefixWords = 0;

/**
 * The digest a pass's own flags call for, right after the lookup that missed: `scopedDigestOf`,
 * except that when only the game-state flag differs from the lookup's, it is finished from the
 * lookup's walk (the battlefield, effects and commander parts are the same) rather than walking
 * the board again. A pass changes nothing the digest reads, so that walk still describes the
 * state; the saved part is used only when the last digest walked was of this context, `extra`
 * and tapped flag, and `MTG_VERIFY_LAYER_CACHE=1` checks it against a full digest.
 */
export function scopedDigestAfterPass(
  ctx: GameContext,
  extra: EnginePermanent | undefined,
  includeGameState: boolean,
  includeTapped: boolean,
): number {
  if (prefixCtx !== ctx || prefixExtra !== extra || prefixTapped !== includeTapped)
    return scopedDigestOf(ctx, extra, includeGameState, includeTapped);
  const scope = SCOPES.get(ctx);
  const key = scope === undefined ? undefined : scopeKey(extra, includeGameState, includeTapped);
  const known = key === undefined ? undefined : scope!.get(key);
  if (known !== undefined) return known;
  startDigest();
  laneA = prefixA;
  laneB = prefixB;
  words = prefixWords;
  foldGameState(ctx, includeGameState);
  const digest = finishDigest();
  if (VERIFY_SCOPES && digestOf(ctx, extra, includeGameState, includeTapped) !== digest)
    throw new Error(STALE);
  if (key !== undefined) scope!.set(key, digest);
  return digest;
}

/**
 * Read scopes: a stretch of engine code that changes nothing the layer digest covers, such as
 * building a priority menu, gathering mana sources, or matching triggers to an event. Inside one
 * each distinct digest is computed once and reused. Without a scope every characteristics query
 * re-digests the whole battlefield, and the many loops that query each permanent in turn made
 * those reads quadratic in board size: about 40% of engine CPU in measured bot games.
 *
 * A scope belongs to one context object. A speculative copy (the mana planner's `clone`, a
 * casting preview) is a different object and digests as before, so it may be changed freely
 * outside a scope of its own. A casting preview has one while its cast options are built
 * (`offerCast`), and must not be changed then.
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

/**
 * The open read scope on `ctx`, if any, as an identity token: a query memoized against it can
 * reuse its answer for as long as the scope is open, because nothing the layer digest covers may
 * change inside one (the battlefield, its counters, attachments and controllers among them).
 */
export function readScopeToken(ctx: GameContext): object | undefined {
  return SCOPES.get(ctx);
}

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
    SCOPE_BATTLEFIELDS.delete(ctx);
  }
  if (ctx.strictInvariants === true || VERIFY_SCOPES) {
    for (const [key, digest] of digests) {
      if (
        key.startsWith('-|') &&
        digestOf(ctx, undefined, key[2] === 'g', key[3] === 't') !== digest
      )
        throw new Error(STALE);
    }
  }
  return result;
}

/**
 * The card ids on the battlefield, built once per read scope. Battlefield membership is a digest
 * input (each permanent's timestamp), so it cannot change inside a scope, and the closing check
 * under `strictInvariants` would catch it if it did.
 */
const SCOPE_BATTLEFIELDS = new WeakMap<GameContext, Set<string>>();

/**
 * Whether a permanent with `cardId` is on the battlefield: a set lookup inside a read scope, a
 * scan outside one. `computeCharacteristics` asks this on every query, and the scan made each
 * loop over the board quadratic in its size.
 */
export function battlefieldHasCard(ctx: GameContext, cardId: string): boolean {
  if (!SCOPES.has(ctx)) return ctx.state.battlefield.some((p) => p.cardId === cardId);
  let ids = SCOPE_BATTLEFIELDS.get(ctx);
  if (ids === undefined) {
    ids = new Set(ctx.state.battlefield.map((p) => p.cardId));
    SCOPE_BATTLEFIELDS.set(ctx, ids);
  }
  return ids.has(cardId);
}

/** Digests only the strict checks read, kept apart so they leave the scope and counters alone. */
const CHECK_DIGESTS = new WeakMap<Map<string, number>, Map<string, number>>();

/**
 * The digest with tapped status folded in, for the strict sampling check in
 * `computeAllCharacteristics` (see `LayerCacheEntry.verifiedTappedDigest`). Checking is not engine
 * work, so it is not counted (`countWork`), and it does not enter the read scope's digests, which
 * the scope re-checks as it closes; inside a scope it is still computed once per key.
 */
export function tappedDigestForChecks(
  ctx: GameContext,
  extra: EnginePermanent | undefined,
  includeGameState: boolean,
): number {
  const scope = SCOPES.get(ctx);
  if (scope === undefined) return digestOf(ctx, extra, includeGameState, true);
  let checks = CHECK_DIGESTS.get(scope);
  if (checks === undefined) {
    checks = new Map();
    CHECK_DIGESTS.set(scope, checks);
  }
  const key =
    (extra === undefined ? '-' : `${extra.cardId}:${extra.timestamp}:${extra.oracleId}`) +
    (includeGameState ? '|g' : '|n');
  let digest = checks.get(key);
  if (digest === undefined) {
    digest = digestOf(ctx, extra, includeGameState, true);
    checks.set(key, digest);
  }
  return digest;
}

/**
 * The scope keys of the board alone, by flags (game state 2, tapped 1): the key nearly every query
 * asks for, built once rather than concatenated on each of them.
 */
const BOARD_KEYS = ['-|nn', '-|nt', '-|gn', '-|gt'] as const;

function scopeKey(
  extra: EnginePermanent | undefined,
  includeGameState: boolean,
  includeTapped: boolean,
): string {
  return extra === undefined
    ? BOARD_KEYS[(includeGameState ? 2 : 0) + (includeTapped ? 1 : 0)]!
    : `${extra.cardId}:${extra.timestamp}:${extra.oracleId}` +
        (includeGameState ? '|g' : '|n') +
        (includeTapped ? 't' : 'n');
}

/** `digestOf`, computed once per read scope for each distinct `extra` and pair of flags. */
export function scopedDigestOf(
  ctx: GameContext,
  extra: EnginePermanent | undefined,
  includeGameState: boolean,
  includeTapped: boolean,
): number {
  const scope = SCOPES.get(ctx);
  if (scope === undefined) {
    countWork('layerDigests');
    return digestOf(ctx, extra, includeGameState, includeTapped, true);
  }
  // `-|` then the two flags for the board alone, which `withReadScope` re-checks on close.
  const key = scopeKey(extra, includeGameState, includeTapped);
  const known = scope.get(key);
  if (known === undefined) {
    countWork('layerDigests');
    const digest = digestOf(ctx, extra, includeGameState, includeTapped, true);
    scope.set(key, digest);
    return digest;
  }
  if (
    (VERIFY_SCOPES || sampleHit(SCOPED_HITS, ctx)) &&
    digestOf(ctx, extra, includeGameState, includeTapped) !== known
  )
    throw new Error(STALE);
  return known;
}

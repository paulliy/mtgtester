/**
 * Bounded combat search — ADR 0024 Phase 7b.
 *
 * Phase 4's combat heuristics (`evaluate.ts`) answer each combat question as a one-shot look at
 * the current board: this blocker, that attacker, is the trade good? ADR 0024's premise is that
 * combat is the one decision type where that is known-weak, because the cost of a block or a
 * damage split usually lands a turn later — the chump block that leaves nothing to block with
 * next turn, the trade that opens a lethal swing back.
 *
 * So this module does two things Phase 4 does not:
 *
 * 1. **Considers whole assignments, not one blocker at a time.** Phase 4 has each blocker answer
 *    independently, which cannot gang-block, cannot leave an attacker for a better-suited body,
 *    and cannot notice that two "individually fine" blocks add up to a wrecked board. A bounded
 *    beam search over the assignment space can.
 * 2. **Scores the board a ply deeper.** Each candidate is resolved on a `CombatSnapshot`
 *    (Phase 7a) and then charged for the swing it leaves available — `nextSwingExposure` below.
 *
 * ## What this module is NOT allowed to do
 *
 * - **It never decides legality** (ADR 0024 Decision item 4). Every candidate is a permutation of
 *   the per-slot menu the engine already offered (`LegalAction.targets[].options`), never a
 *   superset of it, and the engine re-validates and repairs the assembled declaration regardless.
 *   The one place this module looks at a rule itself — the menace filter in `menaceViolation` —
 *   is there to avoid *proposing* something the engine would only reject and repair, which would
 *   mean scoring a candidate that can never happen. It narrows the search; it never widens it.
 * - **It never sees hidden state** (brief §7.1). Everything is built from the deciding seat's
 *   `PlayerView`, exactly like every other bot decision.
 * - **It is never a dependency.** Every entry point returns `null` when the board is wider than
 *   the bound in `WEIGHTS.combat`, or when the view can't supply an honest body for something in
 *   combat, and the caller falls back to Phase 4's static answer (Decision item 5).
 * - **It never uses `Math.random()`** (brief §4/§5.9). Ties are broken lexicographically on the
 *   candidate's own key, which is stronger than the seeded-RNG tie-break Decision item 6 allows
 *   for: the same board yields the same answer without the RNG needing to be threaded in at all.
 */

import type { LegalAction, ObjectId, PermanentView, PlayerId, PlayerView } from '@mtg/shared';
import { NO_BLOCK_TARGET } from '@mtg/shared';
import type {
  CombatOutcome,
  CombatSnapshot,
  SnapshotAttacker,
  SnapshotCreature,
} from './combat-snapshot';
import { resolveCombatSnapshot } from './combat-snapshot';
import { WEIGHTS } from './weights';

const MENACE = 'menace';
const DEATHTOUCH = 'deathtouch';
const TRAMPLE = 'trample';

/**
 * Per-call overrides for the search's bounds, and the switch that turns it off entirely.
 *
 * Every field defaults to `WEIGHTS.combat`, which stays the one place the shipped numbers live.
 * This exists because ADR 0024's success criterion is measurable only if both arms can run in the
 * SAME process against the SAME seeds: "bot-with-search versus bot-without, over a fixed set of
 * seeded games". A module constant cannot express that, so the bounds have to be reachable from
 * the outside — see `packages/server/src/cli/combat-sweep.ts`.
 *
 * It is not a general configuration surface, and nothing in normal play passes it.
 */
export interface CombatSearchOptions {
  /** False makes every entry point decline immediately — the Phase 4 control arm. */
  enabled?: boolean;
  topK?: number;
  maxAttackers?: number;
  maxCombatPermanents?: number;
  maxSplitBlockers?: number;
  /**
   * Telemetry only, and never consulted for a decision. The sweep needs to know whether a bound it
   * moved actually changed how often the search ran: a cutoff that never binds and a cutoff that
   * binds without helping both look like "no win-rate change" from the outside, and they call for
   * opposite corrections.
   */
  onSearch?: (kind: 'block' | 'split', searched: boolean) => void;
}

interface ResolvedSearchConfig {
  enabled: boolean;
  topK: number;
  maxAttackers: number;
  maxCombatPermanents: number;
  maxSplitBlockers: number;
  onSearch: ((kind: 'block' | 'split', searched: boolean) => void) | null;
}

function resolveConfig(opts: CombatSearchOptions | undefined): ResolvedSearchConfig {
  const w = WEIGHTS.combat;
  return {
    enabled: opts?.enabled ?? true,
    topK: opts?.topK ?? w.topK,
    maxAttackers: opts?.maxAttackers ?? w.maxAttackers,
    maxCombatPermanents: opts?.maxCombatPermanents ?? w.maxCombatPermanents,
    maxSplitBlockers: opts?.maxSplitBlockers ?? w.maxSplitBlockers,
    onSearch: opts?.onSearch ?? null,
  };
}

/** The subset of `combat.ts`'s `BlockDeclarationSubject` that survives into `action.data`. */
export interface BlockSubjectData {
  subjectId: string;
  power: number;
  toughness: number;
  mustBlock: boolean;
}

export function parseBlockSubjects(action: LegalAction): BlockSubjectData[] {
  const raw = action.data?.['subjects'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is BlockSubjectData => {
    if (typeof s !== 'object' || s === null) return false;
    const v = s as Record<string, unknown>;
    return (
      typeof v['subjectId'] === 'string' &&
      typeof v['power'] === 'number' &&
      typeof v['toughness'] === 'number' &&
      typeof v['mustBlock'] === 'boolean'
    );
  });
}

/** A creature as the search models it, or `null` for a permanent that isn't one. */
function toCreature(p: PermanentView): SnapshotCreature | null {
  if (p.power === undefined || p.power === null) return null;
  if (p.toughness === undefined || p.toughness === null) return null;
  return {
    id: p.id,
    controller: p.controller,
    power: p.power,
    toughness: p.toughness,
    // Absent (not empty) means face down — an unknown body. Empty means genuinely no keywords.
    // The distinction doesn't change the math here, but it is why this defaults rather than
    // refusing: a face-down 2/2 with no abilities is exactly what `?? []` models.
    keywords: p.keywords ?? [],
  };
}

const has = (c: SnapshotCreature, keyword: string): boolean => c.keywords.includes(keyword);

/** Every creature on every battlefield the view can see, by id. */
function creatureIndex(view: PlayerView): Map<ObjectId, SnapshotCreature> {
  const index = new Map<ObjectId, SnapshotCreature>();
  for (const perm of view.battlefield) {
    const creature = toCreature(perm);
    if (creature !== null) index.set(creature.id, creature);
  }
  return index;
}

/** A creature's worth in LEP — see `WEIGHTS.combat.creatureBaseValue` for how it is priced. */
function creatureValue(c: SnapshotCreature): number {
  const w = WEIGHTS.combat;
  return (
    w.creatureBaseValue +
    Math.max(0, c.power) * w.creaturePowerValue +
    Math.max(0, c.toughness) * w.creatureToughnessValue +
    c.keywords.length * w.keywordValue
  );
}

function lifeOf(view: PlayerView, player: PlayerId): number {
  if (player === view.seat) return view.life;
  return view.opponents.find((o) => o.seat === player)?.life ?? Infinity;
}

/**
 * Immediate value of a resolved combat, from `us`'s side: life swung, bodies traded, lifelink.
 * Positive is good for us. Damage to an opponent is discounted by `opponentLifePointValue` — see
 * that weight's own comment for why parity would be wrong.
 *
 * Our OWN lethal is not checked here. It belongs on the far side of the 1-ply response, in
 * `positionScore`, because a candidate that survives this combat and dies to the swing it invites
 * is not a survivable candidate.
 */
function immediateValue(
  outcome: CombatOutcome,
  us: PlayerId,
  view: PlayerView,
  creatures: ReadonlyMap<ObjectId, SnapshotCreature>,
): number {
  const w = WEIGHTS.combat;
  let score = 0;

  for (const [player, damage] of Object.entries(outcome.damageToPlayers)) {
    if (player === us) {
      score -= damage * WEIGHTS.lifePointValue;
    } else {
      score += damage * w.opponentLifePointValue;
      if (damage >= lifeOf(view, player)) score += w.lethalSwingValue * w.opponentLifePointValue;
    }
  }

  for (const [player, gained] of Object.entries(outcome.lifeGained)) {
    score += player === us ? gained * WEIGHTS.lifePointValue : -gained * w.opponentLifePointValue;
  }

  for (const id of outcome.deaths) {
    const dead = creatures.get(id);
    if (dead === undefined) continue;
    score += dead.controller === us ? -creatureValue(dead) : creatureValue(dead);
  }

  return score;
}

/**
 * Greedy block pairing for the 1-ply response (ADR 0024 Decision item 3's "greedy top-1" — the cap
 * that keeps 7d's attacker-side search from nesting one bounded search inside another).
 *
 * Deliberately the same rule Phase 4's `blockDeclarationTargets` applies — block what you survive
 * or trade with, chump anything once life is short — because the opponent this models is most
 * often another instance of this same bot. Preference order is survive-and-kill, then survive,
 * then trade, then (only when desperate) chump.
 */
function greedyBlocks(
  attackersIn: readonly SnapshotCreature[],
  blockersIn: readonly SnapshotCreature[],
  defenderLife: number,
): Map<ObjectId, ObjectId[]> {
  const desperate = defenderLife <= WEIGHTS.dangerousLifeThreshold;
  const byAttacker = new Map<ObjectId, ObjectId[]>();
  const available = [...blockersIn].sort(
    (a, b) => b.toughness - a.toughness || a.id.localeCompare(b.id),
  );
  const order = [...attackersIn].sort((a, b) => b.power - a.power || a.id.localeCompare(b.id));

  for (const attacker of order) {
    // Menace (CR 702.111b) needs two bodies or none — a single-blocker proposal is simply illegal,
    // so the greedy model must not produce one.
    const needed = has(attacker, MENACE) ? 2 : 1;
    const ranked = available
      .map((b) => {
        const survives = b.toughness > attacker.power && !has(attacker, DEATHTOUCH);
        const kills = b.power >= attacker.toughness || has(b, DEATHTOUCH);
        return { body: b, rank: (survives ? 2 : 0) + (kills ? 1 : 0) };
      })
      .filter((c) => c.rank > 0 || desperate)
      .sort(
        (x, y) =>
          y.rank - x.rank ||
          y.body.toughness - x.body.toughness ||
          x.body.id.localeCompare(y.body.id),
      );
    if (ranked.length < needed) continue;
    const chosen = ranked.slice(0, needed);
    byAttacker.set(
      attacker.id,
      chosen.map((c) => c.body.id),
    );
    for (const c of chosen) {
      const at = available.indexOf(c.body);
      if (at >= 0) available.splice(at, 1);
    }
  }
  return byAttacker;
}

/**
 * How an attacker will most likely divide its damage among 2+ blockers (CR 510.1c-d). The search
 * has to assume something here: the division is the ATTACKING player's choice, made in a later
 * decision this bot does not control, and leaving it undefined would make the simulator fall
 * through to "everything on the first blocker" — which flatters every gang block.
 *
 * Modelled as cheapest-lethal-first with trample overflow, which is both what a competent attacker
 * does and what this same bot does when it is the one attacking (`staticDamageSplit`).
 *
 * One known imprecision: a single division is computed up front and reused for both damage steps,
 * whereas the engine re-asks per step (`assignDamageDivisions`), so a blocker that dies to first
 * strike leaves its share unassigned here instead of redistributed. That understates a
 * first-striking attacker slightly. It is an assumption about the opponent, not a rules claim, and
 * the parity suite deliberately does not cover it.
 */
function assumedDivision(
  attacker: SnapshotCreature,
  blockers: readonly SnapshotCreature[],
  defendingPlayer: PlayerId,
): Record<string, number> {
  const deathtouch = has(attacker, DEATHTOUCH);
  const lethalFor = (b: SnapshotCreature): number => (deathtouch ? 1 : Math.max(1, b.toughness));
  const ordered = [...blockers].sort(
    (a, b) => lethalFor(a) - lethalFor(b) || a.id.localeCompare(b.id),
  );
  const division: Record<string, number> = {};
  let remaining = attacker.power;
  let allCovered = true;
  for (const b of ordered) {
    const lethal = lethalFor(b);
    if (remaining >= lethal) {
      division[b.id] = lethal;
      remaining -= lethal;
    } else {
      allCovered = false;
    }
  }
  if (remaining > 0) {
    if (allCovered && has(attacker, TRAMPLE)) {
      division[defendingPlayer] = remaining;
    } else {
      const last = ordered[ordered.length - 1];
      if (last !== undefined) division[last.id] = (division[last.id] ?? 0) + remaining;
    }
  }
  return division;
}

/**
 * The 1-ply opponent response (ADR 0024 Decision item 3), charged against `us`: given the board
 * that survives a candidate, how much damage do the surviving enemy creatures put on us on their
 * next swing, if we block them greedily with whatever we have left?
 *
 * This is the term that makes the search worth having. It is what prices a chump block (a body
 * spent now is a body missing from this estimate) and what prices a trade that empties our side of
 * the board. Two deliberate simplifications, both stated because they matter for reading the
 * numbers 7c will produce:
 *
 * - Every surviving enemy creature is assumed to attack. That is less a guess about a real
 *   opponent than a faithful model of THIS bot, whose `attackDeclarationTargets` attacks with
 *   everything it legally can, every turn, into any board (ADR 0024 Decision item 1).
 * - Tapped state is ignored. Untap steps and turn order between here and that swing make it
 *   nearly unknowable, and since every candidate shares the same prior it barely discriminates
 *   between them. This is an exposure estimate, not a prediction.
 */
function nextSwingExposure(
  survivors: readonly SnapshotCreature[],
  us: PlayerId,
  projectedLife: number,
): number {
  const enemies = survivors.filter((c) => c.controller !== us && c.power > 0);
  const ours = survivors.filter((c) => c.controller === us);
  if (enemies.length === 0) return 0;

  const blocks = greedyBlocks(enemies, ours, projectedLife);
  const blockingBy = new Map<ObjectId, ObjectId>();
  for (const [attackerId, blockerIds] of blocks) {
    for (const blockerId of blockerIds) blockingBy.set(blockerId, attackerId);
  }

  const attackers: SnapshotAttacker[] = enemies.map((c) => {
    const assigned = blocks.get(c.id) ?? [];
    const attacker: SnapshotAttacker = { ...c, defendingPlayer: us, blockedBy: assigned };
    if (assigned.length >= 2) {
      const bodies = assigned
        .map((id) => ours.find((o) => o.id === id))
        .filter((o): o is SnapshotCreature => o !== undefined);
      attacker.damageDivision = assumedDivision(c, bodies, us);
    }
    return attacker;
  });
  const blockers = ours
    .filter((c) => blockingBy.has(c.id))
    .map((c) => ({ ...c, blocking: blockingBy.get(c.id) as ObjectId }));

  return resolveCombatSnapshot({ attackers, blockers }).damageToPlayers[us] ?? 0;
}

/** Creatures left standing after a resolved combat. */
function survivorsAfter(
  creatures: ReadonlyMap<ObjectId, SnapshotCreature>,
  outcome: CombatOutcome,
): SnapshotCreature[] {
  const dead = new Set(outcome.deaths);
  return [...creatures.values()].filter((c) => !dead.has(c.id));
}

/**
 * The score every candidate in this module is ranked on: what this combat is immediately worth,
 * minus the swing it leaves available, minus everything if we do not survive that swing.
 *
 * The lethal horizon is the point. Checking it against life-after-this-combat alone would let a
 * candidate look safe for exactly as long as it takes the opponent to untap; checking it one ply
 * out is what makes the chump-block question answer itself. At 40 life a 1/1 declines to trade
 * itself for 5 damage; at 10 the same 1/1 chumps, because there and only there does declining
 * leave the next swing lethal. Phase 4 needed a flat `dangerousLifeThreshold` to approximate that
 * (and still does, in `staticBlockChoices` and `greedyBlocks`); here it falls out of the model.
 */
function positionScore(
  outcome: CombatOutcome,
  us: PlayerId,
  view: PlayerView,
  creatures: ReadonlyMap<ObjectId, SnapshotCreature>,
): number {
  const projectedLife = view.life - (outcome.damageToPlayers[us] ?? 0);
  const exposure = nextSwingExposure(survivorsAfter(creatures, outcome), us, projectedLife);
  let score = immediateValue(outcome, us, view, creatures) - exposure * WEIGHTS.lifePointValue;
  if (projectedLife - exposure <= 0) score -= WEIGHTS.combat.lethalSwingValue;
  // Dying to THIS combat is charged again, on top. It has to strictly outrank dying to the swing
  // this candidate invites, because the second is a prediction that the intervening turn can still
  // answer and the first is simply the end of the game.
  if (projectedLife <= 0) score -= WEIGHTS.combat.lethalSwingValue;
  return score;
}

// ---------------------------------------------------------------------------------------------
// Block declaration
// ---------------------------------------------------------------------------------------------

/** One candidate block declaration: the chosen attacker per slot, `null` meaning decline. */
export type BlockAssignment = readonly (ObjectId | null)[];

interface BlockContext {
  view: PlayerView;
  /** Blocker bodies by slot — stats from the engine's own subject data, keywords from the view. */
  blockers: SnapshotCreature[];
  attackers: Map<ObjectId, SnapshotCreature>;
  creatures: Map<ObjectId, SnapshotCreature>;
}

/**
 * An attacker with menace and exactly one assigned blocker (CR 702.111b). The engine catches this
 * too — `validateBlockDeclaration` rejects the proposal and `repairBlockDeclaration` fixes it — so
 * this is not the search taking over legality (Decision item 4). It is the search declining to
 * spend its budget scoring a declaration that would never be applied as proposed.
 */
function menaceViolation(ctx: BlockContext, assignment: BlockAssignment): boolean {
  const counts = new Map<ObjectId, number>();
  for (const choice of assignment) {
    if (choice !== null) counts.set(choice, (counts.get(choice) ?? 0) + 1);
  }
  for (const [attackerId, count] of counts) {
    const attacker = ctx.attackers.get(attackerId);
    if (attacker !== undefined && has(attacker, MENACE) && count === 1) return true;
  }
  return false;
}

function blockSnapshot(ctx: BlockContext, assignment: BlockAssignment): CombatSnapshot {
  const us = ctx.view.seat;
  const blockersByAttacker = new Map<ObjectId, SnapshotCreature[]>();
  const blocking: (SnapshotCreature & { blocking: ObjectId })[] = [];
  assignment.forEach((choice, slot) => {
    const body = ctx.blockers[slot];
    if (choice === null || body === undefined) return;
    blocking.push({ ...body, blocking: choice });
    const list = blockersByAttacker.get(choice) ?? [];
    list.push(body);
    blockersByAttacker.set(choice, list);
  });

  const attackers: SnapshotAttacker[] = [...ctx.attackers.values()].map((c) => {
    const assigned = blockersByAttacker.get(c.id) ?? [];
    const attacker: SnapshotAttacker = {
      ...c,
      defendingPlayer: us,
      blockedBy: assigned.map((b) => b.id),
    };
    if (assigned.length >= 2) attacker.damageDivision = assumedDivision(c, assigned, us);
    return attacker;
  });

  return { attackers, blockers: blocking };
}

function scoreBlockAssignment(ctx: BlockContext, assignment: BlockAssignment): number {
  const outcome = resolveCombatSnapshot(blockSnapshot(ctx, assignment));
  return positionScore(outcome, ctx.view.seat, ctx.view, ctx.creatures);
}

const assignmentKey = (a: BlockAssignment): string => a.map((c) => c ?? '-').join('|');

/**
 * Phase 4's per-blocker heuristic, extracted so it can serve as BOTH the fallback when the search
 * declines and a seed candidate inside it. Seeding it matters: it guarantees the search can never
 * return something its own scoring rates below the answer it replaces.
 */
export function staticBlockChoices(action: LegalAction, view: PlayerView): (ObjectId | null)[] {
  const subjects = parseBlockSubjects(action);
  const permById = new Map(view.battlefield.map((p) => [p.id, p]));
  const desperate = view.life <= WEIGHTS.dangerousLifeThreshold;

  return (action.targets ?? []).map((slot) => {
    const subject = subjects[slot.slot];
    const real = slot.options.filter((o) => o !== NO_BLOCK_TARGET);
    if (subject === undefined || real.length === 0) {
      const only = slot.options[0];
      return only === undefined || only === NO_BLOCK_TARGET ? null : only;
    }
    const worthwhile = real.filter((id) => {
      const attacker = permById.get(id);
      const attackerPower = attacker?.power ?? 0;
      const attackerToughness = attacker?.toughness ?? 1;
      return desperate || subject.toughness > attackerPower || subject.power >= attackerToughness;
    });
    if (worthwhile.length === 0) return subject.mustBlock ? (real[0] as ObjectId) : null;
    return worthwhile.reduce((a, b) =>
      (permById.get(a)?.power ?? 0) >= (permById.get(b)?.power ?? 0) ? a : b,
    );
  });
}

/**
 * Top-K block-assignment search (ADR 0024 Decision item 3).
 *
 * A beam search over slots rather than an enumeration: the full assignment space is
 * `(options+1)^blockers`, which a wide board makes combinatorial. Each slot extends every partial
 * assignment in the beam by each of its legal choices, the extended set is scored with the
 * still-undecided slots treated as declining, and the best `topK` survive to the next slot. Cost
 * is bounded at `slots × topK × (options+1)` snapshot resolutions, on top of the hard width cutoff
 * that stops the search running at all on a board wide enough for that to matter.
 *
 * Returns `null` when the search declines — width bound exceeded, or the view can't supply a body
 * for something in combat — and the caller falls back to `staticBlockChoices`.
 */
export function searchBlockAssignment(
  action: LegalAction,
  view: PlayerView,
  opts?: CombatSearchOptions,
): (ObjectId | null)[] | null {
  const cfg = resolveConfig(opts);
  const decline = (): null => {
    cfg.onSearch?.('block', false);
    return null;
  };

  const slots = action.targets ?? [];
  const subjects = parseBlockSubjects(action);
  if (!cfg.enabled || slots.length === 0 || subjects.length !== slots.length) return decline();

  const optionsBySlot = slots.map((slot) => slot.options.filter((o) => o !== NO_BLOCK_TARGET));
  const attackerIds = [...new Set(optionsBySlot.flat())];
  if (attackerIds.length > cfg.maxAttackers) return decline();
  if (attackerIds.length + subjects.length > cfg.maxCombatPermanents) return decline();

  const index = creatureIndex(view);
  const attackers = new Map<ObjectId, SnapshotCreature>();
  for (const id of attackerIds) {
    const attacker = index.get(id);
    if (attacker === undefined) return decline(); // not a creature we can see: don't guess
    attackers.set(id, attacker);
  }

  // Stats come from the engine's own `subjects` (already layer-computed, and authoritative for
  // this decision); keywords have to come from the view, which is the projection 7-pre added.
  const blockers: SnapshotCreature[] = [];
  for (const subject of subjects) {
    const seen = index.get(subject.subjectId);
    if (seen === undefined) return decline();
    blockers.push({
      id: subject.subjectId,
      controller: view.seat,
      power: subject.power,
      toughness: subject.toughness,
      keywords: seen.keywords,
    });
  }

  const creatures = new Map(index);
  for (const blocker of blockers) creatures.set(blocker.id, blocker);

  const ctx: BlockContext = { view, blockers, attackers, creatures };

  // Slots the beam hasn't reached yet are scored as declining, so a partial candidate is always a
  // complete, resolvable declaration. A `mustBlock` creature has no decline option at all, so its
  // placeholder has to be a real block for the partial score to mean anything.
  const complete = (from: BlockAssignment): (ObjectId | null)[] => {
    const full: (ObjectId | null)[] = [...from];
    for (let i = from.length; i < slots.length; i++) {
      const subject = subjects[i] as BlockSubjectData;
      full.push(subject.mustBlock ? ((optionsBySlot[i] as ObjectId[])[0] ?? null) : null);
    }
    return full;
  };

  const rank = (candidates: readonly BlockAssignment[]): BlockAssignment[] =>
    candidates
      .map((candidate) => ({ candidate, score: scoreBlockAssignment(ctx, complete(candidate)) }))
      .sort(
        (a, b) =>
          b.score - a.score || assignmentKey(a.candidate).localeCompare(assignmentKey(b.candidate)),
      )
      .map((entry) => entry.candidate);

  let beam: BlockAssignment[] = [[]];
  for (let slot = 0; slot < slots.length; slot++) {
    const subject = subjects[slot] as BlockSubjectData;
    const choices: (ObjectId | null)[] = [...(optionsBySlot[slot] as ObjectId[])];
    if (!subject.mustBlock || choices.length === 0) choices.push(null);

    const extended: BlockAssignment[] = [];
    for (const partial of beam) {
      for (const choice of choices) extended.push([...partial, choice]);
    }
    beam = rank(extended).slice(0, cfg.topK);
  }

  const legal = [...beam, staticBlockChoices(action, view)].filter(
    (candidate) => !menaceViolation(ctx, candidate),
  );
  if (legal.length === 0) return decline();
  const best = rank(legal)[0];
  if (best === undefined) return decline();
  cfg.onSearch?.('block', true);
  return [...best];
}

// ---------------------------------------------------------------------------------------------
// Combat damage division
// ---------------------------------------------------------------------------------------------

export interface DamageSplitSpec {
  amount: number;
  targets: ObjectId[];
}

/**
 * Phase 4's cheapest-lethal-first division, extracted as both fallback and seed candidate — the
 * same arrangement as `staticBlockChoices`, for the same reason.
 *
 * Reads "lethal" as plain toughness. That was forced in Phase 4 (no keyword projection) and is
 * merely conservative now: deathtouch-aware lethal is what the SEARCH below uses, and assigning
 * more than lethal to a blocker is always legal, never illegal.
 */
export function staticDamageSplit(
  spec: DamageSplitSpec,
  view: PlayerView,
): Record<ObjectId, number> {
  const permById = new Map(view.battlefield.map((p) => [p.id, p]));
  // A trampler's excess goes to the player or planeswalker it attacks. A planeswalker is on the
  // battlefield but is no blocker, so blockers are the targets that are creatures.
  const blockerIds = spec.targets.filter((id) => {
    const perm = permById.get(id);
    return perm !== undefined && toCreature(perm) !== null;
  });
  const playerTargetId = spec.targets.find((id) => !blockerIds.includes(id));
  const lethalFor = (id: ObjectId): number => Math.max(1, permById.get(id)?.toughness ?? 1);

  const ordered = [...blockerIds].sort((a, b) => lethalFor(a) - lethalFor(b));
  const split: Record<ObjectId, number> = {};
  let remaining = spec.amount;
  for (const id of ordered) {
    const lethal = lethalFor(id);
    if (remaining < lethal) continue;
    split[id] = lethal;
    remaining -= lethal;
  }
  if (remaining > 0) {
    if (playerTargetId !== undefined) {
      split[playerTargetId] = remaining;
    } else {
      const last = ordered[ordered.length - 1];
      if (last !== undefined) split[last] = (split[last] ?? 0) + remaining;
    }
  }
  return split;
}

/**
 * Identify the attacker whose damage is being divided. The decision request carries the amount and
 * the recipients but not the source, so it is recovered from the view: our own creature, with this
 * exact power, blocked by exactly these blockers. `blockedBy` is projected for every permanent, so
 * the match is usually unique; when it isn't, the search declines rather than reading the keywords
 * off the wrong body.
 */
function findDividingAttacker(
  spec: DamageSplitSpec,
  view: PlayerView,
  blockerIds: readonly ObjectId[],
): SnapshotCreature | null {
  const matches = view.battlefield.filter((p) => {
    if (p.controller !== view.seat || p.power !== spec.amount) return false;
    const blocked = p.blockedBy ?? [];
    return blockerIds.every((id) => blocked.includes(id));
  });
  const only = matches.length === 1 ? matches[0] : undefined;
  return only === undefined ? null : toCreature(only);
}

/**
 * Bounded search over combat-damage divisions (CR 510.1c-d) — ADR 0024 Decision item 3 applied to
 * the attacking side of the damage step.
 *
 * The candidate space is every composition of `amount` over the recipients, far too large to
 * enumerate — but nearly all of it is pointless, because damage that isn't lethal to something is
 * wasted. So the candidates are the *subsets of blockers to kill*: each subset gets exactly lethal
 * on every member (deathtouch counts 1, CR 702.2c — the thing Phase 4 could not see), and whatever
 * is left goes over the top with trample or onto a blocker without it. Bounded at
 * `2^maxSplitBlockers`, with the search declining above that.
 *
 * The engine still validates the result (`resolveDamageDivision`) and still substitutes its own if
 * it doesn't like it, exactly as before. CR 702.19b's "nothing to the player until every blocker
 * has lethal" is enforced there; it is mirrored here only so candidates aren't spent on divisions
 * that would be thrown away.
 */
export function searchDamageSplit(
  spec: DamageSplitSpec,
  view: PlayerView,
  opts?: CombatSearchOptions,
): Record<ObjectId, number> | null {
  const cfg = resolveConfig(opts);
  const decline = (): null => {
    cfg.onSearch?.('split', false);
    return null;
  };

  const index = creatureIndex(view);
  const blockerIds = spec.targets.filter((id) => index.has(id));
  const playerTargetId = spec.targets.find((id) => !index.has(id));
  // A single blocker permits a split when trample can send excess to the defending player.
  if (
    !cfg.enabled ||
    blockerIds.length === 0 ||
    (blockerIds.length === 1 && playerTargetId === undefined)
  )
    return decline();
  if (blockerIds.length > cfg.maxSplitBlockers) return decline();

  const blockers = blockerIds.map((id) => index.get(id) as SnapshotCreature);
  const attacker = findDividingAttacker(spec, view, blockerIds);
  if (attacker === null) return decline();

  const deathtouch = has(attacker, DEATHTOUCH);
  const trample = has(attacker, TRAMPLE);
  const lethalFor = (b: SnapshotCreature): number => (deathtouch ? 1 : Math.max(1, b.toughness));

  const divisions: Record<ObjectId, number>[] = [staticDamageSplit(spec, view)];
  for (let mask = 0; mask < 1 << blockers.length; mask++) {
    const kill = blockers.filter((_, i) => (mask & (1 << i)) !== 0);
    const cost = kill.reduce((total, b) => total + lethalFor(b), 0);
    if (cost > spec.amount) continue;
    const division: Record<ObjectId, number> = {};
    for (const b of kill) division[b.id] = lethalFor(b);
    const leftover = spec.amount - cost;
    if (leftover > 0) {
      if (trample && kill.length === blockers.length && playerTargetId !== undefined) {
        division[playerTargetId] = leftover;
      } else {
        // Nowhere useful for it to go: park it on the biggest body so the division stays
        // well-formed (it has to sum to exactly `amount`) without pretending it accomplished
        // anything. Deterministic, and never illegal.
        const dump = [...blockers].sort(
          (a, b) => b.toughness - a.toughness || a.id.localeCompare(b.id),
        )[0];
        if (dump === undefined) continue;
        division[dump.id] = (division[dump.id] ?? 0) + leftover;
      }
    }
    divisions.push(division);
  }

  const us = view.seat;
  // With no trample there is no player among the targets and none of the damage can reach one;
  // the placeholder only exists so the snapshot has a well-typed defender to name.
  const defendingPlayer = playerTargetId ?? `${us}__defender`;
  const scored = divisions.map((division) => {
    const snapshot: CombatSnapshot = {
      attackers: [
        { ...attacker, defendingPlayer, blockedBy: blockerIds, damageDivision: division },
      ],
      blockers: blockers.map((b) => ({ ...b, blocking: attacker.id })),
    };
    return {
      division,
      score: positionScore(resolveCombatSnapshot(snapshot), us, view, index),
      key: spec.targets.map((id) => `${id}=${division[id] ?? 0}`).join(','),
    };
  });

  const best = scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))[0];
  if (best === undefined) return decline();
  cfg.onSearch?.('split', true);
  return best.division;
}

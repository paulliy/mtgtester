import type {
  DecisionRequest,
  DecisionResponse,
  LegalAction,
  ObjectId,
  PlayerView,
  TargetChoice,
} from '@mtg/shared';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import type { Rng } from './rng';
import { passesVeto, totalDiscardCount, totalLifeCost, totalSacrificeCount } from './veto';
import { WEIGHTS } from './weights';

export interface ScoredAction {
  action: LegalAction;
  score: number;
}

export interface EvaluateOptions {
  /** How many times this action's source ability has already been chosen this turn (item 5). */
  repeatCount?: (action: LegalAction) => number;
}

function firstTargets(action: LegalAction): TargetChoice[] {
  return (action.targets ?? []).map((slot) => ({
    slot: slot.slot,
    choice: slot.options[0] as string,
  }));
}

/**
 * Per-slot target choice for the batched `attackDeclaration` action (ADR 0023 items 13/14):
 * `firstTargets` would blindly pick whichever defender happened to be listed first for every
 * creature, which is correct but not remotely threat-aware. This realizes item 8's per-opponent
 * threat weighting in its simplest honest form — attack the legal defender at the lowest life
 * total — rather than leaving the whole declaration to positional luck. `mustAttack` slots have
 * no `NO_ATTACK_TARGET` option to begin with, so a slot with only `NO_ATTACK_TARGET` left after
 * filtering just means "no legal defender for this creature" and is answered with it. Full
 * keyword-aware group evaluation (trades, blockers already visible) remains a Workstream A
 * refinement, not yet built — see the ADR's scoring-model section.
 */
function attackDeclarationTargets(action: LegalAction, view: PlayerView): TargetChoice[] {
  const lifeBySeat = new Map(view.opponents.map((o) => [o.seat, o.life]));
  return (action.targets ?? []).map((slot) => {
    const real = slot.options.filter((o) => o !== NO_ATTACK_TARGET);
    if (real.length === 0) {
      return { slot: slot.slot, choice: slot.options[0] as string };
    }
    const best = real.reduce((a, b) =>
      (lifeBySeat.get(a) ?? Infinity) <= (lifeBySeat.get(b) ?? Infinity) ? a : b,
    );
    return { slot: slot.slot, choice: best };
  });
}

interface BlockSubjectData {
  subjectId: string;
  power: number;
  toughness: number;
  mustBlock: boolean;
}

function parseBlockSubjects(action: LegalAction): BlockSubjectData[] {
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

/**
 * Per-slot target choice for the batched `blockDeclaration` action (ADR 0023 Phase 4) — the
 * blocker-side mirror of `attackDeclarationTargets`. Each blocker independently answers its own
 * "is this block worth it" question: block the biggest-power incoming attacker it can either
 * survive (its toughness beats that attacker's power) or trade with (its power kills that
 * attacker too), or — once the defending player is at `dangerousLifeThreshold` or below — any
 * attacker at all, a chump block being better than dying. Declines otherwise. No cross-blocker
 * coordination (no gang-blocking a threat down together, no leaving a double-covered attacker for
 * someone else to answer) — the same "simplest honest realization" of item 8 the attacker side
 * landed with in Phase 3b, not yet the full keyword-aware group evaluation still scoped as a
 * Workstream A refinement. `data.subjects` and `targets` come from the SAME `subjects` array in
 * `combat.ts`'s `buildBlockOption`, so they line up by index (`slot.slot`) without needing a
 * lookup by id.
 */
function blockDeclarationTargets(action: LegalAction, view: PlayerView): TargetChoice[] {
  const subjects = parseBlockSubjects(action);
  const permById = new Map(view.battlefield.map((p) => [p.id, p]));
  const desperate = view.life <= WEIGHTS.dangerousLifeThreshold;

  return (action.targets ?? []).map((slot) => {
    const subject = subjects[slot.slot];
    const real = slot.options.filter((o) => o !== NO_BLOCK_TARGET);
    if (subject === undefined || real.length === 0) {
      return { slot: slot.slot, choice: slot.options[0] as string };
    }
    const worthwhile = real.filter((id) => {
      const attacker = permById.get(id);
      const attackerPower = attacker?.power ?? 0;
      const attackerToughness = attacker?.toughness ?? 1;
      const survives = subject.toughness > attackerPower;
      const tradesUp = subject.power >= attackerToughness;
      return desperate || survives || tradesUp;
    });
    if (worthwhile.length === 0) {
      return { slot: slot.slot, choice: subject.mustBlock ? (real[0] as string) : NO_BLOCK_TARGET };
    }
    const best = worthwhile.reduce((a, b) =>
      (permById.get(a)?.power ?? 0) >= (permById.get(b)?.power ?? 0) ? a : b,
    );
    return { slot: slot.slot, choice: best };
  });
}

function targetsFor(action: LegalAction, view: PlayerView): TargetChoice[] {
  if (action.type === 'attackDeclaration') return attackDeclarationTargets(action, view);
  if (action.type === 'blockDeclaration') return blockDeclarationTargets(action, view);
  return firstTargets(action);
}

/**
 * Real answer for a batched combat-damage-division decision (ADR 0023 Phase 4, CR 510.1c-d):
 * unlike every other decision, the choice that matters here isn't which `assignDamage` option
 * gets picked (those exist only so a provider that doesn't know this field — the random fuzzer —
 * still has something to pick from) but the `combatDamageSplit` map itself. Kills blockers
 * cheapest-lethal-first until the attacker's power runs out, then — with trample — sends
 * whatever's left over the top; a trampler's own creature never leaves power unassigned once every
 * blocker is already covered. `PermanentView` doesn't carry damage already marked or deathtouch
 * (no `keywords` projection yet — item 20's deferred half), so "lethal" is read as plain
 * toughness: always a safe (if occasionally wasteful) overestimate, never an illegal split.
 */
function combatDamageSplitFor(
  spec: { amount: number; targets: ObjectId[] },
  view: PlayerView,
): Record<ObjectId, number> {
  const permById = new Map(view.battlefield.map((p) => [p.id, p]));
  const blockerIds = spec.targets.filter((id) => permById.has(id));
  const playerTargetId = spec.targets.find((id) => !permById.has(id));
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
 * Baseline value for taking this action at all, before its costs are subtracted (ADR items 4
 * and 7). Mana value is the intended universal prior for cast/activate impact once
 * `LegalAction.data` carries it (item 19); until then, a flat presence bonus per action type
 * from `weights.ts` stands in, which is enough to beat `pass` without pretending to rank two
 * spells against each other.
 */
function baseValue(action: LegalAction): number {
  switch (action.type) {
    case 'pass':
    case 'passAndYieldTurn':
    case 'yieldToAbility':
      return WEIGHTS.passBaseline;
    case 'playLand':
      return WEIGHTS.tempo.playLand;
    case 'castSpell':
      return WEIGHTS.tempo.castSpell;
    case 'activateAbility':
      return WEIGHTS.tempo.activateAbility;
    default:
      // The long tail (item 6): triggers, modal choices, and the rest of the priority menu.
      // A small non-zero default keeps a real effect from silently losing to `pass` just
      // because it hasn't been given its own case yet.
      return WEIGHTS.tempo.activateAbility;
  }
}

/** Total LEP cost of this action's ability costs, per the flat placeholders in `weights.ts`. */
function costValue(action: LegalAction, view: PlayerView): number {
  const life = totalLifeCost(action) * WEIGHTS.lifePointValue;
  const sacrifice = totalSacrificeCount(action) * WEIGHTS.sacrificePermanentValue;
  const discard = totalDiscardCount(action, view.hand.length) * WEIGHTS.discardCardValue;
  return life + sacrifice + discard;
}

/**
 * Score every legal action for the deciding player's `PlayerView` (ADR 0023 items 3-7).
 * Vetoed actions (item 5) are excluded outright, never merely scored low — a scoring mistake
 * must not be able to reach them. Ranked highest-first.
 */
export function evaluate(
  request: DecisionRequest,
  view: PlayerView,
  opts: EvaluateOptions = {},
): ScoredAction[] {
  const repeatCount = opts.repeatCount ?? (() => 0);
  return request.legalActions
    .filter((action) => passesVeto(action, view.life))
    .map((action) => {
      // The damper decays the BENEFIT, not the net score: a fixed cost subtracted after decay
      // is what lets repeated activation eventually score below `pass` and stop (item 5). If
      // the whole net score were decayed instead, a positive net would only ever shrink toward
      // zero without crossing it, and the loop would never actually die.
      const decay = WEIGHTS.repeatActivationDecay ** repeatCount(action);
      const score = baseValue(action) * decay - costValue(action, view);
      return { action, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Pick the highest-scoring legal action, breaking ties with a seeded `Rng` (item 11 —
 * determinism survives even when several candidates tie exactly, e.g. two untapped basics).
 */
export function decide(
  request: DecisionRequest,
  view: PlayerView,
  rng: Rng,
  opts: EvaluateOptions = {},
): DecisionResponse {
  // Combat-damage division (ADR 0023 Phase 4) isn't a "which option" choice at all — see
  // `combatDamageSplitFor`. Handled before the normal ranked-evaluate path since every offered
  // `assignDamage` option scores identically (all fall to the same default case in `baseValue`)
  // and picking among them would be meaningless without also attaching the real split.
  if (request.combatDamageSplit !== undefined) {
    const fallback = request.legalActions[0];
    if (fallback === undefined) {
      throw new Error(`decision ${request.requestId} has no legal actions`);
    }
    return {
      requestId: request.requestId,
      actionId: fallback.id,
      combatDamageSplit: combatDamageSplitFor(request.combatDamageSplit, view),
      note: 'Heuristic bot: dividing combat damage cheapest-lethal-first among blockers',
    };
  }

  const ranked = evaluate(request, view, opts);

  if (ranked.length === 0) {
    // Every candidate failed the veto — CR guarantees a legal action always exists (`pass` has
    // no cost, so this means every option happened to carry a payLife cost at or above current
    // life). Better an unscored action than a stalled game.
    const fallback = request.legalActions[0];
    if (fallback === undefined) {
      throw new Error(`decision ${request.requestId} has no legal actions`);
    }
    const targets = targetsFor(fallback, view);
    const response: DecisionResponse = { requestId: request.requestId, actionId: fallback.id };
    if (targets.length > 0) response.targets = targets;
    response.note = 'Heuristic bot: veto excluded every candidate, using first legal action';
    return response;
  }

  const topScore = ranked[0]!.score;
  const tied = ranked.filter((r) => r.score === topScore);
  const chosen = (tied[rng.nextInt(tied.length)] ?? ranked[0]!).action;
  const targets = targetsFor(chosen, view);
  const response: DecisionResponse = { requestId: request.requestId, actionId: chosen.id };
  if (targets.length > 0) response.targets = targets;
  response.note = `Heuristic bot: ${chosen.type} (score ${topScore.toFixed(2)})`;
  return response;
}

import type {
  BotSteering,
  DecisionRequest,
  DecisionResponse,
  LegalAction,
  ObjectId,
  PlayerView,
  TargetChoice,
} from '@mtg/shared';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import {
  searchBlockAssignment,
  searchDamageSplit,
  staticBlockChoices,
  staticDamageSplit,
} from './combat-search';
import type { CombatSearchOptions } from './combat-search';
import {
  complyingTargets,
  planAttackDeclaration,
  targetBreachPenalty,
  type DiplomacyPlay,
} from './diplomacy/play';
import type { CardKnowledge } from './card-knowledge';
import { DEFAULT_POLICY_FIXES, type PolicyFix } from './fixes';
import {
  actionValue,
  chooseAttacks,
  chooseTargets,
  choiceValue,
  type PolicyContext,
} from './policy';
import type { RandomSource } from './rng';
import { passesVeto, totalDiscardCount, totalLifeCost, totalSacrificeCount } from './veto';
import { WEIGHTS } from './weights';

export interface ScoredAction {
  action: LegalAction;
  score: number;
}

export interface EvaluateOptions {
  /** How many times this action's source ability has already been chosen this turn (item 5). */
  repeatCount?: (action: LegalAction) => number;
  /**
   * Bounds for ADR 0024's combat search, and the switch that turns it off. Absent everywhere in
   * normal play — it exists so the sweep that tunes those bounds can run both arms against the
   * same seeds in one process. See `CombatSearchOptions`.
   */
  combatSearch?: CombatSearchOptions;
  /**
   * Table diplomacy (ADR 0035). Absent unless a game turns deals on; when present, attack targets
   * become threat-aware and this seat's deal obligations shape its targets and scores.
   */
  diplomacy?: DiplomacyPlay;
  /** Card traits from the IR, by name (ADR 0039). Absent, the bot reads only the menu. */
  knowledge?: CardKnowledge;
  /** Strategist knobs (ADR 0039). Absent, every knob keeps its neutral default. */
  steering?: BotSteering;
  /** Mulligans this seat has taken this game, for the keep rule. */
  mulligansTaken?: number;
  /**
   * Score with the pre-ADR 0039 flat per-type bonuses and first-option targets. Kept only so the
   * bot league can measure the new policy against the old one inside one build.
   */
  legacy?: boolean;
  /** ADR 0043's policy fixes; omitted is `DEFAULT_POLICY_FIXES`. */
  fixes?: readonly PolicyFix[];
}

function policyContext(
  request: DecisionRequest,
  view: PlayerView,
  opts: EvaluateOptions,
): PolicyContext {
  return {
    request,
    view,
    ...(opts.knowledge === undefined ? {} : { knowledge: opts.knowledge }),
    ...(opts.steering === undefined ? {} : { steering: opts.steering }),
    ...(opts.mulligansTaken === undefined ? {} : { mulligansTaken: opts.mulligansTaken }),
    ...(opts.repeatCount === undefined ? {} : { repeatCount: opts.repeatCount }),
    fixes: new Set(opts.fixes ?? DEFAULT_POLICY_FIXES),
  };
}

function firstTargets(action: LegalAction): TargetChoice[] {
  // "Another target" slots (CR 115.3) must differ from earlier ones, which the menu cannot mark,
  // so take the first option no earlier slot took whenever there is one.
  const taken = new Set<string>();
  const slots = action.targets ?? [];
  const order = slots
    .map((_, i) => i)
    .sort((a, b) => slots[a]!.options.length - slots[b]!.options.length);
  const chosen: TargetChoice[] = new Array<TargetChoice>(slots.length);
  for (const i of order) {
    const slot = slots[i]!;
    const choice = (slot.options.find((o) => !taken.has(o)) ?? slot.options[0]) as string;
    taken.add(choice);
    chosen[i] = { slot: slot.slot, choice };
  }
  return chosen;
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
  // Choosing only WHICH of another player's creatures attack (Master Warcraft): the attacking
  // player picks the targets, so no defender is chosen here. Keep every creature home that the
  // rules let stay, which leaves only the ones that are required to attack.
  if (action.data?.['chooseAttackers'] === true) {
    return (action.targets ?? []).map((slot) => ({
      slot: slot.slot,
      choice: slot.options.includes(NO_ATTACK_TARGET)
        ? NO_ATTACK_TARGET
        : (slot.options[0] as string),
    }));
  }
  const lifeBySeat = new Map(view.opponents.map((o) => [o.seat, o.life]));
  for (const permanent of view.battlefield) {
    const life = lifeBySeat.get(permanent.controller);
    if (life !== undefined) lifeBySeat.set(permanent.id, life);
  }
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

/**
 * Per-slot target choice for the batched `blockDeclaration` action — Phase 4's per-blocker
 * heuristic (`staticBlockChoices`, now in `combat-search.ts`) with ADR 0024 Phase 7b's bounded
 * search in front of it.
 *
 * The search is an enhancement, never a dependency (0024 Decision item 5): it declines outright
 * on a board wider than `WEIGHTS.combat`'s cutoff, or when the view can't supply a body for
 * something in combat, and this falls straight back to the Phase 4 answer. That answer is also
 * seeded into the search's own candidate set, so the search cannot return something its own
 * scoring rates below the heuristic it replaces.
 *
 * What the search adds over Phase 4 is the two things a per-blocker rule structurally cannot do:
 * consider blockers together (gang blocks, and leaving an attacker for a better-suited body), and
 * charge each candidate for the swing it leaves available next turn.
 */
function blockDeclarationTargets(
  action: LegalAction,
  view: PlayerView,
  opts: CombatSearchOptions | undefined,
): TargetChoice[] {
  const slots = action.targets ?? [];
  // Choosing blocks for another player's creatures (Master Warcraft): this seat's board and
  // life are not at stake in them, so it blocks with none that it is free not to.
  const blockingPlayer = action.data?.['blockingPlayer'];
  if (typeof blockingPlayer === 'string' && blockingPlayer !== view.seat) {
    return slots.map((slot) => ({
      slot: slot.slot,
      choice: slot.options.includes(NO_BLOCK_TARGET)
        ? NO_BLOCK_TARGET
        : (slot.options[0] as string),
    }));
  }
  const choices = searchBlockAssignment(action, view, opts) ?? staticBlockChoices(action, view);
  return slots.map((slot, i) => ({
    slot: slot.slot,
    choice: choices[i] ?? NO_BLOCK_TARGET,
  }));
}

function targetsFor(
  action: LegalAction,
  view: PlayerView,
  opts: CombatSearchOptions | undefined,
  diplomacy?: DiplomacyPlay,
  policy?: PolicyContext,
): TargetChoice[] {
  if (action.type === 'attackDeclaration') {
    // With deals in force the diplomacy planner decides who may be attacked. With none, the
    // card-aware policy (and the strategist's aggression and target order) decides as usual;
    // the plain bot keeps the planner's threat-aware targets.
    if (
      diplomacy !== undefined &&
      action.data?.['chooseAttackers'] !== true &&
      (policy === undefined || diplomacy.obligations().length > 0)
    ) {
      const plan = planAttackDeclaration(action, view, diplomacy);
      if (plan.breach !== undefined) {
        diplomacy.reportBreach?.(plan.breach.dealId, plan.breach.reason);
      }
      return plan.targets;
    }
    if (policy !== undefined && action.data?.['chooseAttackers'] !== true) {
      return chooseAttacks(action, policy);
    }
    return attackDeclarationTargets(action, view);
  }
  if (action.type === 'blockDeclaration') return blockDeclarationTargets(action, view, opts);
  if (diplomacy !== undefined) {
    // Deals narrow the options; the card-aware policy still picks among what is left.
    return complyingTargets(
      action,
      view,
      diplomacy,
      policy === undefined ? undefined : (restricted) => chooseTargets(restricted, policy),
    );
  }
  if (policy !== undefined) return chooseTargets(action, policy);
  return firstTargets(action);
}

/**
 * Real answer for a batched combat-damage-division decision (CR 510.1c-d): unlike every other
 * decision, the choice that matters here isn't which `assignDamage` option gets picked (those
 * exist only so a provider that doesn't know this field — the random fuzzer — still has something
 * to pick from) but the `combatDamageSplit` map itself.
 *
 * ADR 0024 Phase 7b's search over kill-subsets first, falling back to Phase 4's cheapest-lethal-
 * first division (`staticDamageSplit`) whenever it declines. The search's advantage is that it
 * can see deathtouch — Phase 4 had to read "lethal" as plain toughness for want of a keyword
 * projection, wasting most of a deathtoucher's damage on the first blocker it covered.
 */
function combatDamageSplitFor(
  spec: { amount: number; targets: ObjectId[] },
  view: PlayerView,
  opts: CombatSearchOptions | undefined,
): Record<ObjectId, number> {
  return searchDamageSplit(spec, view, opts) ?? staticDamageSplit(spec, view);
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
  const diplomacy = request.decisionType === 'priority' ? opts.diplomacy : undefined;
  const policy = opts.legacy === true ? undefined : policyContext(request, view, opts);
  return request.legalActions
    .filter((action) => passesVeto(action, view.life))
    .map((action) => {
      // The damper decays the BENEFIT, not the net score: a fixed amount subtracted after decay
      // is what lets repeated activation eventually score below `pass` and stop (item 5). If
      // the whole net score were decayed instead, a positive net would only ever shrink toward
      // zero without crossing it, and the loop would never actually die.
      //
      // `repeatActivationPenalty` is what guarantees there IS such a fixed amount. Relying on the
      // ability's own costs left a hole for `{0}` abilities, which have none — see that weight's
      // comment for the 1,270-activation game that found it.
      const repeats = repeatCount(action);
      const decay = WEIGHTS.repeatActivationDecay ** repeats;
      const base =
        policy === undefined
          ? baseValue(action)
          : (actionValue(action, policy) ?? choiceValue(action, policy) ?? baseValue(action));
      const score =
        base * decay -
        costValue(action, view) -
        repeats * WEIGHTS.repeatActivationPenalty -
        (diplomacy === undefined ? 0 : targetBreachPenalty(action, view, diplomacy));
      return { action, score };
    })
    .sort((a, b) => b.score - a.score);
}

/** A decision plus the ranking it came from, for callers that judge the bot's confidence. */
export interface ScoredDecision {
  response: DecisionResponse;
  /** Every non-vetoed action, best first. Empty for a forced or unscored path. */
  ranked: ScoredAction[];
}

/**
 * Pick the highest-scoring legal action, breaking ties with a seeded `Rng`, or any `RandomSource` (item 11 —
 * determinism survives even when several candidates tie exactly, e.g. two untapped basics).
 */
export function decide(
  request: DecisionRequest,
  view: PlayerView,
  rng: RandomSource,
  opts: EvaluateOptions = {},
): DecisionResponse {
  return decideScored(request, view, rng, opts).response;
}

/** `decide`, also returning the ranking (ADR 0039's escalate-when-unsure reads its margin). */
export function decideScored(
  request: DecisionRequest,
  view: PlayerView,
  rng: RandomSource,
  opts: EvaluateOptions = {},
): ScoredDecision {
  const policy = opts.legacy === true ? undefined : policyContext(request, view, opts);
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
      ranked: [],
      response: {
        requestId: request.requestId,
        actionId: fallback.id,
        combatDamageSplit: combatDamageSplitFor(request.combatDamageSplit, view, opts.combatSearch),
        note: 'Heuristic bot: dividing combat damage cheapest-lethal-first among blockers',
      },
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
    const targets = targetsFor(fallback, view, opts.combatSearch, opts.diplomacy, policy);
    const response: DecisionResponse = { requestId: request.requestId, actionId: fallback.id };
    if (targets.length > 0) response.targets = targets;
    response.note = 'Heuristic bot: veto excluded every candidate, using first legal action';
    return { response, ranked };
  }

  const topScore = ranked[0]!.score;
  const tied = ranked.filter((r) => r.score === topScore);
  const chosen = (tied[rng.nextInt(tied.length)] ?? ranked[0]!).action;
  const targets = targetsFor(chosen, view, opts.combatSearch, opts.diplomacy, policy);
  const response: DecisionResponse = { requestId: request.requestId, actionId: chosen.id };
  if (targets.length > 0) response.targets = targets;
  response.note = `Heuristic bot: ${chosen.type} (score ${topScore.toFixed(2)})`;
  return { response, ranked };
}

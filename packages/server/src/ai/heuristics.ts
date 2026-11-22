/**
 * Pre-flight heuristics: answer a decision locally when the AI could not meaningfully
 * disagree, so no Gemini call is made at all.
 *
 * This is a *cost* mechanism, not a rules mechanism. The engine already auto-resolves the
 * genuinely forced case — one legal option (`isForced` in `@mtg/engine`'s `decisions.ts`) —
 * before a `DecisionRequest` is ever built. What survives that filter but is still not a real
 * choice is the dominated case: several legal options exist, but all but one are strictly
 * pointless. In a logged 30-turn game that case accounted for the large majority of calls —
 * an idle player asked "pass priority?" at every step of every turn for ten straight turns,
 * and a 0-power creature asked "does it attack?" every combat.
 *
 * Every rule here must be *unambiguous*: if a competent player could reasonably pick the other
 * option, it does not belong in this file — it belongs in the prompt. Judgment calls (holding
 * back a 3/3 blocker, choosing between two removal targets) still go to the AI. Rules are kept
 * deliberately narrow at the cost of leaving some savings on the table, because a heuristic
 * that fires wrongly silently degrades play quality in a way the turn log will not obviously
 * show.
 */

import type { DecisionRequest, DecisionResponse, LegalAction, PlayerView, Step } from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import type { CardKnowledge } from '@mtg/bot';

/**
 * Combat steps where holding an instant is still obviously safe. The steps left out —
 * declare-attackers, declare-blockers and both damage steps — are exactly the windows where a
 * trick changes the outcome (pump a blocked creature, save it from lethal damage), so those
 * always go to the model.
 */
const HARMLESS_COMBAT_STEPS: ReadonlySet<Step> = new Set<Step>(['beginCombat', 'endCombat']);

/**
 * Rule A — defer an instant when there is nothing to respond to.
 *
 * A combat trick or pump spell that can legally target *some* creature stays a legal
 * `castSpell` option for the rest of the game, which is why `isForced` never fires for an
 * otherwise idle player: the menu is `[pass, Cast Predator's Strike]` at every step of every
 * turn. But casting an instant into an empty stack outside combat is never right — holding it
 * costs nothing and keeps every option open, which is precisely the reasoning the model itself
 * gave on all ~140 such calls in the sample game.
 *
 * Two guards make this safe. A non-empty stack means there is something to respond to, so it
 * is a real decision. The combat steps where a trick actually changes the outcome are excluded,
 * because that is where instant timing matters. Everywhere else, an all-instants menu means the
 * player has no land to play and nothing sorcery-speed to cast — there is no line to be missed
 * by waiting.
 */
function isPassAction(action: LegalAction): boolean {
  return (
    action.type === 'pass' || action.type === 'passAndYieldTurn' || action.type === 'yieldToAbility'
  );
}

function tryDeferInstant(request: DecisionRequest, view: PlayerView): DecisionResponse | null {
  if (request.decisionType !== 'priority') return null;
  // Combat tricks are a genuine judgment call — but only in the steps where they can change
  // anything. The bookend steps are as inert as an upkeep.
  if (request.phase === 'combat') {
    if (request.step === null || !HARMLESS_COMBAT_STEPS.has(request.step)) return null;
  }
  if (view.stack.length > 0) return null;

  const passActions = request.legalActions.filter(isPassAction);
  if (passActions.length === 0) return null;

  const nonPassActions = request.legalActions.filter((a) => !isPassAction(a));
  if (nonPassActions.length === 0) return null; // engine would have auto-resolved this already

  const allDeferrableInstants = nonPassActions.every(
    (a) => a.type === 'castSpell' && a.data?.['instantSpeed'] === true,
  );
  if (!allDeferrableInstants) return null;

  const isOpponentTurn = request.decidingPlayer !== request.activePlayer;
  const yieldPass = isOpponentTurn
    ? passActions.find((a) => a.type === 'passAndYieldTurn')
    : undefined;
  const chosenPass = yieldPass ?? passActions.find((a) => a.type === 'pass') ?? passActions[0]!;

  return {
    requestId: request.requestId,
    actionId: chosenPass.id,
    note: 'Heuristic: holding instant-speed spells, nothing on the stack to respond to',
  };
}

/**
 * Rule C — take the land drop when it is the only thing on offer.
 *
 * The land drop is free, is capped at one per turn, and no modeled card punishes having more
 * lands, so declining it is never right — it only throws the turn away. Measured over full
 * games this is the single largest remaining bucket of calls, and in the sample game every one
 * of them came back as "Playing a land to increase mana base".
 *
 * Restricted to a menu of exactly `pass` plus ONE land. Two different lands is a real colour
 * choice, and a land alongside castable spells is a real sequencing choice; both still go to
 * the model.
 */
function tryObviousLandDrop(request: DecisionRequest): DecisionResponse | null {
  if (request.decisionType !== 'priority') return null;

  const passActions = request.legalActions.filter(isPassAction);
  if (passActions.length === 0) return null;

  const nonPassActions = request.legalActions.filter((a) => !isPassAction(a));
  if (nonPassActions.length !== 1) return null;
  const land = nonPassActions[0];
  if (land === undefined || land.type !== 'playLand') return null;

  return {
    requestId: request.requestId,
    actionId: land.id,
    note: 'Heuristic: taking the free once-per-turn land drop',
  };
}

interface AttackSubjectData {
  subjectId: string;
  power: number;
  toughness: number;
  hasTriggers: boolean;
  mustAttack: boolean;
}

function isAttackSubjectData(value: unknown): value is AttackSubjectData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['subjectId'] === 'string' &&
    typeof v['power'] === 'number' &&
    typeof v['hasTriggers'] === 'boolean' &&
    typeof v['mustAttack'] === 'boolean'
  );
}

/**
 * Rule B — decline the WHOLE attack when not one creature in it could matter.
 *
 * Attacking with 0 power deals no damage and taps the creature (CR 508.1f), removing it as a
 * blocker for a full turn cycle. That is strictly worse than staying home *only* if the attack
 * itself cannot produce value, so several things have to be ruled out first — and since ADR 0023
 * items 13/14 batched the whole declaration into one decision, this rule can only fire on the
 * WHOLE decision now, not creature by creature: a mixed board (one real attacker among several
 * powerless ones) always goes to the model, which decides every subject in the same call anyway.
 *
 * `hasTriggers` — a creature that puts an ability on the stack when it attacks is worth
 * attacking with at any power. No `TriggerEvent` keys on attacking today, so this is always
 * false for that reason, but the engine reports it per creature rather than the rule assuming
 * it: on the day an attack trigger is modeled, a 0/1 that draws a card when it attacks goes to
 * the model automatically instead of being silently benched by a stale assumption here. (A
 * trigger on some *other* permanent — "whenever a creature you control attacks" — is a
 * different shape that no `TriggerEvent` expresses either; adding one means revisiting this.)
 *
 * `mustAttack` — a goaded creature can be forced to attack regardless of power (CR 508.1d cares
 * about cost, never about power), so `NO_ATTACK_TARGET` isn't even a legal choice for that
 * subject's slot; the whole-decision decline this rule proposes would be illegal if any subject
 * is `mustAttack`, so that also routes to the model.
 *
 * A currently castable instant — "attack with the 0/1, then pump it" is a real line, and pump
 * instants are modeled and common in the supported pool. The legal menu is the authoritative
 * affordability check: merely holding an instant is not enough to preserve that line. We still
 * deliberately over-approximate a castable instant as combat-relevant until spell-effect data is
 * exposed on legal actions; that is conservative and keeps a real trick with the tactician.
 */
function tryDeclineZeroPowerAttack(
  request: DecisionRequest,
  _view: PlayerView,
): DecisionResponse | null {
  if (request.decisionType !== 'declareAttackers') return null;
  // "Attack with the 0/1, then pump it" is a real line only when that instant is actually
  // castable now. `legalActions` has already applied timing, target, and mana checks.
  if (
    request.legalActions.some(
      (action) => action.type === 'castSpell' && action.data?.['instantSpeed'] === true,
    )
  ) {
    return null;
  }

  const action = request.legalActions.find((a) => a.type === 'attackDeclaration');
  if (action === undefined) return null;
  const raw = action.data?.['subjects'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const subjects = raw.filter(isAttackSubjectData);
  if (subjects.length !== raw.length) return null; // malformed data — let the model see it

  const allHarmless = subjects.every((s) => s.power <= 0 && !s.hasTriggers && !s.mustAttack);
  if (!allHarmless) return null;

  const targets = (action.targets ?? []).map((slot) => ({
    slot: slot.slot,
    choice: NO_ATTACK_TARGET,
  }));

  return {
    requestId: request.requestId,
    actionId: action.id,
    targets,
    note: `Heuristic: all ${subjects.length} eligible creature(s) have no power and would deal no combat damage`,
  };
}

/** What the card-traits table knows about one activated ability on the menu. */
export interface AbilityFacts {
  /** The ability's roles (`CardRole` names); empty when it has none the table recognizes. */
  roles: readonly string[];
  /** The polarity of each of its target slots. */
  targets: readonly string[];
}

/** Looks up an `activateAbility` action's facts; undefined when the card or ability is unknown. */
export type AbilityFactsLookup = (
  action: LegalAction,
  view: PlayerView,
) => AbilityFacts | undefined;

/** Roles that act on opponents, where timing against their main phase can matter. */
const HOSTILE_ROLES: ReadonlySet<string> = new Set([
  'removal',
  'wipe',
  'counter',
  'burn',
  'discard',
  'extraTurn',
]);

const EARLY_STEPS: ReadonlySet<Step> = new Set<Step>(['upkeep', 'draw']);

/**
 * Rule D's lookup over the card-traits table: the ability's source by name, then its roles and
 * target polarities by ability index. Undefined whenever any of those is missing.
 */
export function abilityFactsFrom(knowledge: CardKnowledge): AbilityFactsLookup {
  return (action, view) => {
    if (action.interaction?.kind !== 'source') return undefined;
    const { sourceId, abilityIndex } = action.interaction;
    if (abilityIndex === undefined) return undefined;
    const named = action.data?.['sourceName'];
    const name =
      typeof named === 'string'
        ? named
        : (view.battlefield.find((p) => p.id === sourceId)?.name ??
          view.hand.find((c) => c.id === sourceId)?.name);
    if (name === undefined) return undefined;
    const traits = knowledge(name);
    const roles = traits?.abilityRoles?.[abilityIndex];
    const targets = traits?.abilityTargets?.[abilityIndex];
    if (roles === undefined || targets === undefined) return undefined;
    return { roles, targets };
  };
}

/**
 * Rule D — defer a non-hostile activated ability through an opponent's upkeep and draw step.
 *
 * An activated ability that can be used at any time (Zopandrel's indestructible counter) keeps a
 * priority window non-dominated for the whole game, so Rule A never fires and every step of every
 * opponent's turn becomes a paid call that comes back "pass": 58 of one seat's 86 calls in a
 * 2026-11-22 four-seat game. In an opponent's upkeep and draw step that opponent has not had a
 * main phase yet. Whatever they do before this seat next gets priority goes on the stack (a land
 * drop aside), and a non-empty stack is always a real decision for the model. So waiting loses no
 * line for an ability that does not act on opponents: the model still sees the main phase, every
 * combat step, the end step and every response.
 *
 * Guards: opponent's turn only (an own-upkeep activation can matter before the draw); empty stack;
 * every non-pass option is an instant (Rule A's reasoning) or a non-mana activated ability whose
 * traits are known, with no hostile target slot and no hostile role. A plain `pass` is chosen, not
 * a yield, so the later windows still reach the model.
 */
function tryDeferQuietAbility(
  request: DecisionRequest,
  view: PlayerView,
  abilityFacts: AbilityFactsLookup | undefined,
): DecisionResponse | null {
  if (abilityFacts === undefined || request.decisionType !== 'priority') return null;
  if (request.decidingPlayer === request.activePlayer) return null;
  if (request.phase !== 'beginning' || request.step === null || !EARLY_STEPS.has(request.step))
    return null;
  if (view.stack.length > 0) return null;

  const pass = request.legalActions.find((a) => a.type === 'pass');
  if (pass === undefined) return null;
  const nonPass = request.legalActions.filter((a) => !isPassAction(a));
  if (!nonPass.some((a) => a.type === 'activateAbility')) return null;

  for (const action of nonPass) {
    if (action.type === 'castSpell' && action.data?.['instantSpeed'] === true) continue;
    if (action.type !== 'activateAbility' || action.data?.['producesMana'] === true) return null;
    const facts = abilityFacts(action, view);
    if (facts === undefined) return null;
    if (facts.targets.includes('hostile')) return null;
    if (facts.roles.some((role) => HOSTILE_ROLES.has(role))) return null;
  }

  return {
    requestId: request.requestId,
    actionId: pass.id,
    note: "Heuristic: no reason to use a non-hostile ability before the opponent's main phase",
  };
}

/**
 * The safe local answer for a decision the AI could not meaningfully improve on, or `null`
 * when the decision is a real one and must go to the model. Rule D runs only when the caller can
 * describe the menu's activated abilities.
 */
export function tryHeuristic(
  request: DecisionRequest,
  view: PlayerView,
  abilityFacts?: AbilityFactsLookup,
): DecisionResponse | null {
  return (
    tryDeferInstant(request, view) ??
    tryObviousLandDrop(request) ??
    tryDeclineZeroPowerAttack(request, view) ??
    tryDeferQuietAbility(request, view, abilityFacts)
  );
}

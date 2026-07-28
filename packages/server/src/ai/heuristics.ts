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

/**
 * Combat steps where holding an instant is still obviously safe. The steps left out —
 * declare-attackers, declare-blockers and both damage steps — are exactly the windows where a
 * trick changes the outcome (pump a blocked creature, save it from lethal damage), so those
 * always go to the model.
 */
const HARMLESS_COMBAT_STEPS: ReadonlySet<Step> = new Set<Step>(['beginCombat', 'endCombat']);

/** Read a numeric field out of an option's descriptive `data` bag (engine-populated). */
function numericData(action: LegalAction | undefined, key: string): number | null {
  const value = action?.data?.[key];
  return typeof value === 'number' ? value : null;
}

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
    action.type === 'pass' ||
    action.type === 'passAndYieldTurn' ||
    action.type === 'yieldToAbility'
  );
}

function tryDeferInstant(
  request: DecisionRequest,
  view: PlayerView,
): DecisionResponse | null {
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

/**
 * Rule B — a creature with no power does not attack, when nothing could make it matter.
 *
 * Attacking with 0 power deals no damage and taps the creature (CR 508.1f), removing it as a
 * blocker for a full turn cycle. That is strictly worse than staying home *only* if the attack
 * itself cannot produce value, so two things have to be ruled out first.
 *
 * `hasTriggers` — a creature that puts an ability on the stack when it attacks is worth
 * attacking with at any power. No `TriggerEvent` keys on attacking today, so this is always
 * false for that reason, but the engine reports it per creature rather than the rule assuming
 * it: on the day an attack trigger is modeled, a 0/1 that draws a card when it attacks goes to
 * the model automatically instead of being silently benched by a stale assumption here. (A
 * trigger on some *other* permanent — "whenever a creature you control attacks" — is a
 * different shape that no `TriggerEvent` expresses either; adding one means revisiting this.)
 *
 * A currently castable instant — "attack with the 0/1, then pump it" is a real line, and pump
 * instants are modeled and common in the supported pool. The legal menu is the authoritative
 * affordability check: merely holding an instant is not enough to preserve that line. We still
 * deliberately over-approximate a castable instant as combat-relevant until spell-effect data is
 * exposed on legal actions; that is conservative and keeps a real trick with the tactician.
 *
 * When the engine offers its `noAttackRest` batch shortcut, the same test is applied to the
 * whole undeclared group (`maxPower`/`hasTriggers` aggregate every creature left), which
 * collapses a powerless board's entire declare-attackers step into a single answer rather than
 * one per creature. The individual `noAttack` remains for the mixed board, where this creature
 * is powerless but a later one is not.
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

  // Prefer the batch decline: when *every* creature still to declare is powerless, one answer
  // settles the whole combat instead of repeating this rule once per creature.
  const noAttackRest = request.legalActions.find((a) => a.type === 'noAttackRest');
  if (noAttackRest !== undefined) {
    const maxPower = numericData(noAttackRest, 'maxPower');
    const count = numericData(noAttackRest, 'count');
    if (
      maxPower !== null &&
      maxPower <= 0 &&
      noAttackRest.data?.['hasTriggers'] === false &&
      count !== null
    ) {
      return {
        requestId: request.requestId,
        actionId: noAttackRest.id,
        note: `Heuristic: all ${count} undeclared creatures have no power and would deal no combat damage`,
      };
    }
  }

  const noAttack = request.legalActions.find((a) => a.type === 'noAttack');
  if (noAttack === undefined) return null;

  const power = numericData(noAttack, 'power');
  if (power === null || power > 0) return null;
  if (noAttack.data?.['hasTriggers'] !== false) return null;

  return {
    requestId: request.requestId,
    actionId: noAttack.id,
    note: `Heuristic: ${power}-power creature would deal no combat damage`,
  };
}

/**
 * The safe local answer for a decision the AI could not meaningfully improve on, or `null`
 * when the decision is a real one and must go to the model.
 */
export function tryHeuristic(
  request: DecisionRequest,
  view: PlayerView,
): DecisionResponse | null {
  return (
    tryDeferInstant(request, view) ??
    tryObviousLandDrop(request) ??
    tryDeclineZeroPowerAttack(request, view)
  );
}

import { counterCount } from '../state/counters';
import { eventObjectFacts } from './source-identity';
import { assertNever } from '../utils/assert-never';
/**
 * `Condition` — a predicate over game state, and the counterpart to `Selector` (ADR 0008).
 *
 * A `Selector` answers "which permanents?"; a `Condition` answers "is this true right now?".
 * They compose: most conditions are a *count* over a selector ("you control two or more other
 * lands", "your opponents control eight or more lands"), so the selector grammar is reused
 * verbatim rather than duplicated.
 *
 * Conditions come in two flavors, and the distinction is load-bearing:
 *
 * - **State conditions** are answerable from `GameContext` alone. They must stay pure, because
 *   legal-action generation calls them (an activation restriction like "only if you control a
 *   Dragon" is evaluated while building a decision menu, where yielding is impossible).
 * - **Choice conditions** (`mayPayLife`) ask a player. They can only be evaluated inside a
 *   generator, via `resolveCondition`.
 *
 * `evaluateCondition` therefore throws on a choice condition rather than guessing a default —
 * a silent "no" would make a shockland always enter tapped, which is exactly the kind of quiet
 * misplay the brief forbids (§6.3).
 */

import type { GameGen } from '../decisions';
import { loseLife, payManaCost } from '../effects/resolve';
import { emit } from '../log/log';
import { allowanceFor, manaSourcesFor, opponentsOf } from '../state/queries';
import type { GameContext } from '../state/types';
import { canPay, describeManaCost } from '../mana/cost';
import type { ParsedManaCost } from '../mana/cost';
import { computeCharacteristics, selectPermanents } from '../effects/continuous';
import type { Selector, SelectorSource } from './selector';
import { ofType, selectMatches } from './selector';
import type { PlayerId } from '@mtg/shared';
import type { EnginePermanent } from '../state/types';

/**
 * How a counted condition compares. `'=='` is not decoration: "whenever you draw your **second**
 * card each turn" fires once, on the second draw, and `'>='` would keep firing on the third and
 * fourth. An "or more"/"or greater" phrasing is what asks for `'>='`.
 */
export type Comparison = '>=' | '<=' | '==';

export type Condition =
  /**
   * "you control two or more other lands" — count the permanents matching `selector` within
   * `scope`, and compare. `scope` narrows *whose* permanents are counted before the selector
   * runs, so a selector that says nothing about control still means the right thing.
   */
  | {
      kind: 'countPermanents';
      selector: Selector;
      scope: 'you' | 'opponents' | 'all';
      cmp: '>=' | '<=';
      n: number;
    }
  /**
   * "if an opponent controls more lands than you" (Land Tax, Ghirapur Orrery) — a per-opponent
   * comparison, not a total. `countPermanents` with `scope: 'opponents'` cannot express this:
   * it pools every opponent's permanents into one number, so in a four-player game it answers
   * "do the three of them have more between them", which is true almost immediately and for
   * almost any threshold. The printed line asks whether ANY SINGLE opponent is ahead of you.
   */
  | { kind: 'opponentControlsMore'; selector: Selector }
  /** "you have two or more opponents" — counts players still in the game, not permanents. */
  | { kind: 'opponentCount'; cmp: '>=' | '<='; n: number }
  /** "you may pay 2 life" — a choice, not a fact. Only `resolveCondition` can answer it. */
  | { kind: 'mayPayLife'; n: number }
  /**
   * "you may pay {R}. If you do, ..." (Spit Flame) — a fixed-cost mana payment offered as a
   * choice, distinct from `mayPayLife`: this pays through the normal mana system (taps sources,
   * spends the pool), not straight from life total.
   */
  | { kind: 'mayPayMana'; cost: ParsedManaCost }
  /**
   * "you may reveal a Mountain or Forest card from your hand" (Game Trail and the other
   * "Snarl"/"slow land" cycles) — a choice, and only legal to offer at all when the hand
   * actually contains a qualifying card (CR 701.15a: revealing requires having the card).
   */
  | { kind: 'mayRevealCardFromHand'; subtypes: string[] }
  /**
   * "a creature or planeswalker an opponent controlled was dealt excess damage this turn"
   * (Rith, Liberated Primeval). `ctx.state.excessDamageControllerIds` is turn-scoped and
   * records CONTROLLERS, not permanents, so this only asks whether any of them is an opponent.
   */
  | { kind: 'excessDamageDealtTo'; scope: 'opponents' }
  /** "an opponent was dealt 7 or more damage this turn" (Spinerock Knoll). */
  | { kind: 'opponentDealtDamageThisTurn'; minDamage: number }
  /** "creatures you control have total power 10 or greater" (Mosswort Bridge). */
  | { kind: 'totalCreaturePower'; scope: 'you' | 'opponents' | 'all'; cmp: '>=' | '<='; n: number }
  | { kind: 'isUntapped' }
  | { kind: 'wasKicked' }
  | { kind: 'announcedXAtLeast'; n: number }
  | { kind: 'escaped' }
  | { kind: 'hasCounters'; selector: Selector; counter: string; cmp: '>=' | '<='; n: number }
  | { kind: 'enteredThisTurn' }
  | { kind: 'createdTokenThisTurn' }
  | { kind: 'hadToAttackThisCombat' }
  /** The object that fired this trigger had to attack (currently, because it was goaded). */
  | { kind: 'triggerObjectHadToAttackThisCombat' }
  /**
   * "if that land is a Mountain" (Akoum Hellkite), "if a creature is dealt damage this way"
   * (Provoke the Trolls) — CR 603.4's intervening-if, or a resolution-time branch, over
   * whichever object a `TriggerSubject`/`EffectRef` names, checked against an ordinary
   * `Selector`. Reuses the selector grammar rather than a bespoke predicate per shape of check.
   */
  | { kind: 'triggerObjectMatches'; selector: Selector }
  /**
   * "Khans — ..." / "Dragons — ..." (Frontier Siege): gates one of two static/triggered
   * clauses by the mode chosen as the permanent entered (`EnginePermanent.chosenOption`),
   * rather than the card needing two mutually-exclusive definitions.
   */
  | { kind: 'chosenOptionIs'; value: string }
  /**
   * "As long as you control your commander" (Tyrant's Familiar, Loyal Apprentice, Thunderfoot
   * Baloth, Convergence of Dominion) — a battlefield permanent that is the checking player's OWN
   * commander (CR 903.7) AND currently controlled by them; a stolen commander doesn't count.
   */
  | { kind: 'controlsYourCommander' }
  /**
   * "If you control a commander" (the Will cycle) — ANY player's commander you control counts,
   * a stolen one included (CR 903.3: a commander is a commander whoever controls it), unlike
   * `controlsYourCommander`'s own-commander lieutenant check.
   */
  | { kind: 'controlsACommander' }
  /** "if an opponent is the monarch" (Queen Marchesa). */
  | { kind: 'opponentIsMonarch' }
  /** A non-your-turn restriction, as on Force of Negation. */
  | { kind: 'notYourTurn' }
  /** "During your turn" — checked against the trigger source's controller. */
  | { kind: 'yourTurn' }
  /** Attack trigger condition: the defending player has more life than the attacker’s controller. */
  | { kind: 'attackingPlayerHasMoreLife' }
  | { kind: 'attackingPlayerHasMoreLifeThanYou' }
  /** The attack-trigger object is attacking an opponent of the ability's controller. */
  | { kind: 'triggerObjectAttackingOpponent' }
  | { kind: 'allOf'; of: Condition[] }
  | { kind: 'anyOf'; of: Condition[] }
  | { kind: 'eventPlayerDrawCount'; cmp: Comparison; n: number }
  /**
   * "except the first one they draw in each of their draw steps" (Orcish Bowmasters, Notion
   * Thief). NOT a count of draws this turn: the exemption is for exactly one draw, the one the
   * event player takes during their OWN draw step. Every other draw qualifies — including the
   * first one they take during somebody else's turn, which is the common Windfall line.
   */
  | { kind: 'notFirstDrawInOwnDrawStep' }
  /** "if you have seven or more cards in your graveyard" (Search for Azcanta, threshold cards). */
  | { kind: 'cardsInYourGraveyard'; cmp: Comparison; n: number }
  /**
   * "if it has no ice counters on it" (Thing in the Ice) — counters on the ability's OWN source.
   * Distinct from `hasCounters`, which counts permanents matching a selector: this asks about
   * one specific permanent and is false once that permanent has left the battlefield.
   */
  | { kind: 'sourceHasCounters'; counter: string; cmp: Comparison; n: number }
  /**
   * "if you've cast a noncreature spell this turn" — a per-turn, per-player cast tally kept by
   * `queueCastTriggers`, not a board read. `category` is how the printed line narrows it; the
   * counters reset for every player at untap, so "this turn" means the whole game turn.
   */
  | { kind: 'castSpellThisTurn'; category: 'any' | 'noncreature'; cmp: '>=' | '<='; n: number }
  | { kind: 'not'; of: Condition };

export const countPermanents = (
  selector: Selector,
  scope: 'you' | 'opponents' | 'all',
  cmp: '>=' | '<=',
  n: number,
): Condition => ({ kind: 'countPermanents', selector, scope, cmp, n });

export const allOfConditions = (...of: Condition[]): Condition => ({ kind: 'allOf', of });
export const anyOfConditions = (...of: Condition[]): Condition => ({ kind: 'anyOf', of });

/** True when answering `condition` requires asking a player (so it needs `resolveCondition`). */
export function isChoiceCondition(condition: Condition): boolean {
  switch (condition.kind) {
    case 'mayPayLife':
    case 'mayRevealCardFromHand':
    case 'mayPayMana':
      return true;
    case 'allOf':
    case 'anyOf':
      return condition.of.some(isChoiceCondition);
    case 'not':
      return isChoiceCondition(condition.of);
    case 'countPermanents':
    case 'opponentControlsMore':
    case 'opponentCount':
    case 'excessDamageDealtTo':
    case 'opponentDealtDamageThisTurn':
    case 'totalCreaturePower':
    case 'isUntapped':
    case 'wasKicked':
    case 'announcedXAtLeast':
    case 'escaped':
    case 'hasCounters':
    case 'enteredThisTurn':
    case 'createdTokenThisTurn':
    case 'hadToAttackThisCombat':
    case 'triggerObjectHadToAttackThisCombat':
    case 'triggerObjectMatches':
    case 'chosenOptionIs':
    case 'controlsYourCommander':
    case 'controlsACommander':
    case 'opponentIsMonarch':
    case 'notYourTurn':
    case 'yourTurn':
    case 'attackingPlayerHasMoreLife':
    case 'attackingPlayerHasMoreLifeThanYou':
    case 'triggerObjectAttackingOpponent':
    case 'eventPlayerDrawCount':
    case 'notFirstDrawInOwnDrawStep':
    case 'cardsInYourGraveyard':
    case 'sourceHasCounters':
    case 'castSpellThisTurn':
      return false;
    default:
      assertNever(condition, 'condition classification');
  }
}

function compare(actual: number, cmp: Comparison, n: number): boolean {
  switch (cmp) {
    case '>=':
      return actual >= n;
    case '<=':
      return actual <= n;
    case '==':
      return actual === n;
    default:
      return assertNever(cmp, 'Comparison');
  }
}

/**
 * Answer a state condition. Throws on a choice condition — see the module comment.
 *
 * `source` supplies the "you" and "self" that relative selectors resolve against, exactly as
 * it does for a continuous effect's affected set.
 */
export function evaluateCondition(
  ctx: GameContext,
  condition: Condition,
  source: SelectorSource,
): boolean {
  switch (condition.kind) {
    case 'castSpellThisTurn': {
      const player = ctx.state.players.find((candidate) => candidate.id === source.controllerId);
      if (player === undefined) return false;
      const cast =
        condition.category === 'noncreature'
          ? player.noncreatureSpellsCastThisTurn
          : player.spellsCastThisTurn;
      return compare(cast, condition.cmp, condition.n);
    }
    case 'cardsInYourGraveyard': {
      const player = ctx.state.players.find((candidate) => candidate.id === source.controllerId);
      return player !== undefined && compare(player.graveyard.length, condition.cmp, condition.n);
    }
    case 'sourceHasCounters': {
      const self = ctx.state.battlefield.find((perm) => perm.cardId === source.cardId);
      // A source that has left the battlefield has no counters, which is the right answer for
      // every printing of this shape ("if it has no ice counters on it" cannot fire on a
      // creature that is no longer there to transform).
      if (self === undefined) return false;
      return compare(counterCount(self.counters, condition.counter), condition.cmp, condition.n);
    }
    case 'notFirstDrawInOwnDrawStep': {
      const eventPlayer = source.eventPlayerId;
      if (eventPlayer === undefined) return false;
      const player = ctx.state.players.find((candidate) => candidate.id === eventPlayer);
      if (player === undefined) return false;
      // The draw has already been counted by the time the trigger is checked, so the draw being
      // exempted is the one that made the step counter 1.
      const isOwnDrawStep =
        ctx.state.step === 'draw' && ctx.state.currentTurnPlayer === eventPlayer;
      return !(isOwnDrawStep && player.cardsDrawnThisDrawStep === 1);
    }
    case 'eventPlayerDrawCount': {
      const eventPlayer =
        source.eventPlayerId === undefined
          ? undefined
          : ctx.state.players.find((player) => player.id === source.eventPlayerId);
      return (
        eventPlayer !== undefined &&
        compare(eventPlayer.cardsDrawnThisTurn, condition.cmp, condition.n)
      );
    }
    case 'countPermanents': {
      // `selectPermanents` judges on CURRENT characteristics (ADR 0007), so a land Blood Moon
      // turned into a Mountain counts as one here for the same reason it taps for {R}.
      const matched = selectPermanents(ctx, condition.selector, source);
      const opponentIds = new Set(opponentsOf(ctx, source.controllerId).map((p) => p.id));
      const inScope = matched.filter((perm) => {
        if (condition.scope === 'you') return perm.controllerId === source.controllerId;
        if (condition.scope === 'opponents') return opponentIds.has(perm.controllerId);
        return true;
      });
      return compare(inScope.length, condition.cmp, condition.n);
    }
    case 'opponentControlsMore': {
      // Counted per opponent and compared against yours, so "more lands than you" stays a
      // question about one opponent being ahead — see the type's comment for why the pooled
      // `countPermanents(…, 'opponents', …)` shape gets this wrong.
      const matched = selectPermanents(ctx, condition.selector, source);
      const yours = matched.filter((perm) => perm.controllerId === source.controllerId).length;
      return opponentsOf(ctx, source.controllerId).some(
        (opp) => matched.filter((perm) => perm.controllerId === opp.id).length > yours,
      );
    }
    case 'notYourTurn':
      return ctx.state.currentTurnPlayer !== source.controllerId;
    case 'yourTurn':
      return ctx.state.currentTurnPlayer === source.controllerId;
    case 'triggerObjectAttackingOpponent': {
      if (source.triggerObjectCardId === undefined) return false;
      const attacker = ctx.state.battlefield.find(
        (permanent) => permanent.cardId === source.triggerObjectCardId,
      );
      return (
        attacker !== undefined &&
        attacker.attacking !== null &&
        attacker.attacking !== source.controllerId
      );
    }
    case 'opponentCount':
      return compare(opponentsOf(ctx, source.controllerId).length, condition.cmp, condition.n);
    case 'excessDamageDealtTo': {
      const opponentIds = new Set(opponentsOf(ctx, source.controllerId).map((p) => p.id));
      return ctx.state.excessDamageControllerIds.some((id) => opponentIds.has(id));
    }
    case 'opponentDealtDamageThisTurn': {
      const opponentIds = new Set(opponentsOf(ctx, source.controllerId).map((p) => p.id));
      return Object.entries(ctx.state.damageDealtToPlayersThisTurn).some(
        ([playerId, amount]) =>
          opponentIds.has(playerId as PlayerId) && amount >= condition.minDamage,
      );
    }
    case 'totalCreaturePower': {
      const matched = selectPermanents(ctx, ofType('Creature'), source);
      const opponentIds = new Set(opponentsOf(ctx, source.controllerId).map((p) => p.id));
      const inScope = matched.filter((perm: EnginePermanent) => {
        if (condition.scope === 'you') return perm.controllerId === source.controllerId;
        if (condition.scope === 'opponents') return opponentIds.has(perm.controllerId);
        return true;
      });
      const totalPower = inScope.reduce((sum: number, p: EnginePermanent) => {
        const chars = computeCharacteristics(ctx, p);
        return sum + (chars.power ?? 0);
      }, 0);
      return compare(totalPower, condition.cmp, condition.n);
    }
    case 'isUntapped': {
      if (source?.cardId === undefined) return false;
      const perm = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
      return perm !== undefined && !perm.tapped;
    }
    case 'enteredThisTurn': {
      if (source?.cardId === undefined) return false;
      const perm = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
      return perm !== undefined && perm.enteredTurnNumber === ctx.state.turnNumber;
    }
    case 'hadToAttackThisCombat': {
      if (source?.cardId === undefined) return false;
      const perm = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
      return perm?.hadToAttackThisCombat === true;
    }
    case 'triggerObjectHadToAttackThisCombat': {
      if (source.triggerObjectCardId === undefined) return false;
      const perm = ctx.state.battlefield.find((p) => p.cardId === source.triggerObjectCardId);
      return perm?.hadToAttackThisCombat === true;
    }
    case 'triggerObjectMatches': {
      const facts = eventObjectFacts(ctx, {
        ...source,
        controllerId: source.controllerId as PlayerId,
      });
      return facts !== undefined && selectMatches(facts.candidate, condition.selector, source);
    }
    case 'chosenOptionIs': {
      if (source?.cardId === undefined) return false;
      const perm = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
      return perm !== undefined && perm.chosenOption === condition.value;
    }
    case 'controlsACommander':
      return ctx.state.battlefield.some(
        (p) => p.isCommander && p.controllerId === source.controllerId,
      );
    case 'controlsYourCommander':
      return ctx.state.battlefield.some(
        (p) =>
          p.isCommander &&
          p.ownerId === source.controllerId &&
          p.controllerId === source.controllerId,
      );
    case 'opponentIsMonarch':
      return (
        ctx.state.monarchPlayerId !== null &&
        opponentsOf(ctx, source.controllerId).some((p) => p.id === ctx.state.monarchPlayerId)
      );
    case 'attackingPlayerHasMoreLife': {
      // Printed dethrone: "attacks the player with the most life or tied for most life".
      const attacker =
        source.triggerObjectCardId === undefined
          ? ctx.state.battlefield.find((p) => p.cardId === source.cardId)
          : ctx.state.battlefield.find((p) => p.cardId === source.triggerObjectCardId);
      if (attacker?.attacking === null || attacker?.attacking === undefined) return false;
      const defender = ctx.state.players.find((p) => p.id === attacker.attacking);
      if (defender === undefined) return false;
      const lives = ctx.state.players
        .filter((player) => !player.hasLost)
        .map((player) => player.life);
      const mostLife = lives.length === 0 ? 0 : Math.max(...lives);
      return defender.life === mostLife;
    }
    case 'attackingPlayerHasMoreLifeThanYou': {
      const attacker = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
      if (attacker?.attacking === null || attacker?.attacking === undefined) return false;
      const defender = ctx.state.players.find((p) => p.id === attacker.attacking);
      const controller = ctx.state.players.find((p) => p.id === source.controllerId);
      return defender !== undefined && controller !== undefined && defender.life > controller.life;
    }
    case 'createdTokenThisTurn':
      return ctx.state.createdTokenThisTurn?.[source.controllerId] === true;
    case 'wasKicked': {
      if (source?.cardId === undefined) return false;
      const perm = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
      if (perm !== undefined) return perm.wasKicked === true || perm.kicked === true;
      const stackObj = ctx.state.stack.find(
        (s) => s.sourceCardId === source.cardId || s.card?.cardId === source.cardId,
      );
      return stackObj !== undefined && (stackObj.wasKicked === true || stackObj.kicked === true);
    }
    case 'announcedXAtLeast': {
      if (source.cardId === undefined) return false;
      const permanent = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
      if (permanent !== undefined) return (permanent.announcedX ?? 0) >= condition.n;
      const stackObject = ctx.state.stack.find(
        (candidate) =>
          candidate.sourceCardId === source.cardId || candidate.card?.cardId === source.cardId,
      );
      return (stackObject?.announcedX ?? 0) >= condition.n;
    }
    case 'escaped': {
      if (source.cardId === undefined) return false;
      const permanent = ctx.state.battlefield.find(
        (candidate) => candidate.cardId === source.cardId,
      );
      if (permanent !== undefined) return permanent.escaped === true;
      return ctx.state.stack.some(
        (candidate) =>
          (candidate.sourceCardId === source.cardId || candidate.card?.cardId === source.cardId) &&
          candidate.escaped === true,
      );
    }
    case 'hasCounters': {
      // SELF is used by Station's continuous threshold. Resolving it through selectPermanents
      // would recursively recompute the very characteristics whose condition is being checked.
      const matched =
        condition.selector.kind === 'self'
          ? ctx.state.battlefield.filter((perm) => perm.cardId === source?.cardId)
          : selectPermanents(ctx, condition.selector, source);
      return matched.some((perm) => {
        const count = condition.counter
          ? counterCount(perm.counters, condition.counter)
          : Object.values(perm.counters).reduce((a, b) => a + b, 0);
        return compare(count, condition.cmp, condition.n);
      });
    }
    case 'allOf':
      return condition.of.every((c) => evaluateCondition(ctx, c, source));
    case 'anyOf':
      return condition.of.some((c) => evaluateCondition(ctx, c, source));
    case 'not':
      return !evaluateCondition(ctx, condition.of, source);
    case 'mayPayLife':
      throw new Error(
        'engine bug: mayPayLife is a choice condition — use resolveCondition, not evaluateCondition',
      );
    case 'mayRevealCardFromHand':
      throw new Error(
        'engine bug: mayRevealCardFromHand is a choice condition — use resolveCondition, not evaluateCondition',
      );
    case 'mayPayMana':
      throw new Error(
        'engine bug: mayPayMana is a choice condition — use resolveCondition, not evaluateCondition',
      );

    default:
      assertNever(condition, 'condition');
  }
}

/**
 * Answer any condition, asking the controller when it is a choice. CR 119.4 permits
 * paying exactly the current life total, but never more than the player has.
 */
export function* resolveCondition(
  ctx: GameContext,
  condition: Condition,
  source: SelectorSource,
  sourceName: string,
): GameGen<boolean> {
  switch (condition.kind) {
    case 'mayPayLife': {
      // Looked up inline rather than via `state/objects.playerById`: `moveObject` calls into
      // this module, and importing back would close a runtime import cycle.
      const player = ctx.state.players.find((p) => p.id === source.controllerId);
      if (player === undefined) throw new Error(`unknown player ${source.controllerId}`);
      if (condition.n > player.life) return false;
      const outcome = yield {
        decisionType: 'general',
        player: player.id,
        prompt: `${sourceName} is entering. Pay ${condition.n} life to have it enter untapped?`,
        options: [
          {
            type: 'payLife',
            description: `Pay ${condition.n} life (enters untapped)`,
            data: { life: condition.n },
          },
          { type: 'decline', description: `Don't pay ${condition.n} life (enters tapped)` },
        ],
      };
      if (outcome.index !== 0) return false;
      loseLife(ctx, player, condition.n);
      emit(ctx, 'costPaid', { player: player.id, source: sourceName, life: condition.n });
      return true;
    }
    case 'mayRevealCardFromHand': {
      const player = ctx.state.players.find((p) => p.id === source.controllerId);
      if (player === undefined) throw new Error(`unknown player ${source.controllerId}`);
      const label = condition.subtypes.join(' or ');
      const hasQualifying = player.hand.some((c) => {
        const def = ctx.defs.get(c.oracleId);
        return def !== undefined && condition.subtypes.some((st) => def.subtypes.includes(st));
      });
      // CR 701.15a: revealing requires actually having a qualifying card — an empty hand (or
      // one with no Mountain/Forest) simply cannot take this option, not "declines" it.
      if (!hasQualifying) return false;
      const outcome = yield {
        decisionType: 'general',
        player: player.id,
        prompt: `${sourceName} is entering. Reveal a ${label} card from your hand to have it enter untapped?`,
        options: [
          { type: 'revealCard', description: `Reveal a ${label} card (enters untapped)` },
          { type: 'decline', description: "Don't reveal (enters tapped)" },
        ],
      };
      if (outcome.index !== 0) return false;
      emit(ctx, 'revealCard', { player: player.id, source: sourceName, reason: label });
      return true;
    }
    case 'mayPayMana': {
      const player = ctx.state.players.find((p) => p.id === source.controllerId);
      if (player === undefined) throw new Error(`unknown player ${source.controllerId}`);
      const sources = manaSourcesFor(ctx, player.id);
      const allows = allowanceFor(ctx, player.id, { kind: 'other' });
      if (!canPay(condition.cost, player.manaEntries, sources, allows, player.life)) return false;
      const outcome = yield {
        decisionType: 'general',
        player: player.id,
        prompt: `${sourceName}: may pay ${describeManaCost(condition.cost)}. Pay it?`,
        options: [
          { type: 'payMana', description: `Pay ${describeManaCost(condition.cost)}` },
          { type: 'decline', description: "Don't pay" },
        ],
      };
      if (outcome.index !== 0) return false;
      yield* payManaCost(ctx, player, condition.cost);
      return true;
    }
    case 'allOf': {
      for (const c of condition.of) {
        if (!(yield* resolveCondition(ctx, c, source, sourceName))) return false;
      }
      return true;
    }
    case 'anyOf': {
      for (const c of condition.of) {
        if (yield* resolveCondition(ctx, c, source, sourceName)) return true;
      }
      return false;
    }
    case 'not':
      return !(yield* resolveCondition(ctx, condition.of, source, sourceName));
    default:
      return evaluateCondition(ctx, condition, source);
  }
}

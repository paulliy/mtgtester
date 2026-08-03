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
import { computeCharacteristics, matchesSelector, selectPermanents } from '../effects/continuous';
import type { Selector, SelectorSource } from './selector';
import { ofType } from './selector';
import type { PlayerId } from '@mtg/shared';
import type { EnginePermanent } from '../state/types';

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
  /** "if an opponent is the monarch" (Queen Marchesa). */
  | { kind: 'opponentIsMonarch' }
  /** Attack trigger condition: the defending player has more life than the attacker’s controller. */
  | { kind: 'attackingPlayerHasMoreLife' }
  | { kind: 'allOf'; of: Condition[] }
  | { kind: 'anyOf'; of: Condition[] }
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
    default:
      return false;
  }
}

const compare = (actual: number, cmp: '>=' | '<=', n: number): boolean =>
  cmp === '>=' ? actual >= n : actual <= n;

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
    case 'opponentCount':
      return compare(opponentsOf(ctx, source.controllerId).length, condition.cmp, condition.n);
    case 'excessDamageDealtTo': {
      const opponentIds = new Set(opponentsOf(ctx, source.controllerId).map((p) => p.id));
      return ctx.state.excessDamageControllerIds.some((id) => opponentIds.has(id));
    }
    case 'opponentDealtDamageThisTurn': {
      const opponentIds = new Set(opponentsOf(ctx, source.controllerId).map((p) => p.id));
      return Object.entries(ctx.state.damageDealtToPlayersThisTurn).some(
        ([playerId, amount]) => opponentIds.has(playerId as PlayerId) && amount >= condition.minDamage,
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
      return perm !== undefined && perm.goadedThisTurn === true;
    }
    case 'triggerObjectHadToAttackThisCombat': {
      if (source.triggerObjectCardId === undefined) return false;
      const perm = ctx.state.battlefield.find((p) => p.cardId === source.triggerObjectCardId);
      return perm !== undefined && perm.goadedThisTurn === true;
    }
    case 'triggerObjectMatches': {
      if (source.triggerObjectCardId === undefined) return false;
      const perm = ctx.state.battlefield.find((p) => p.cardId === source.triggerObjectCardId);
      return perm !== undefined && matchesSelector(ctx, perm, condition.selector, source);
    }
    case 'chosenOptionIs': {
      if (source?.cardId === undefined) return false;
      const perm = ctx.state.battlefield.find((p) => p.cardId === source.cardId);
      return perm !== undefined && perm.chosenOption === condition.value;
    }
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
      const attacker = source.triggerObjectCardId === undefined
        ? ctx.state.battlefield.find((p) => p.cardId === source.cardId)
        : ctx.state.battlefield.find((p) => p.cardId === source.triggerObjectCardId);
      if (attacker?.attacking === null || attacker?.attacking === undefined) return false;
      const defender = ctx.state.players.find((p) => p.id === attacker.attacking);
      const attackerController = ctx.state.players.find((p) => p.id === attacker.controllerId);
      return defender !== undefined && attackerController !== undefined && defender.life > attackerController.life;
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
      return stackObj !== undefined && ((stackObj as any).wasKicked === true || (stackObj as any).kicked === true);
    }
    case 'hasCounters': {
      // SELF is used by Station's continuous threshold. Resolving it through selectPermanents
      // would recursively recompute the very characteristics whose condition is being checked.
      const matched = condition.selector.kind === 'self'
        ? ctx.state.battlefield.filter((perm) => perm.cardId === source?.cardId)
        : selectPermanents(ctx, condition.selector, source);
      return matched.some((perm) => {
        const count = condition.counter
          ? (perm.counters[condition.counter] ?? 0)
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
  }
}

/**
 * Answer any condition, asking the controller when it is a choice. Paying is *not* gated on
 * having the life to spare: CR 118.4 lets a player pay life they cannot afford down to 0, and
 * the resulting loss is a state-based action, not an illegal payment.
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
      if (!canPay(condition.cost, player.manaEntries, sources, allows)) return false;
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

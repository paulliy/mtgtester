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
import { loseLife } from '../effects/resolve';
import { emit } from '../log/log';
import { opponentsOf } from '../state/queries';
import type { GameContext } from '../state/types';
import { computeCharacteristics, selectPermanents } from '../effects/continuous';
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
  | { kind: 'enteredThisTurn' }
  | { kind: 'hadToAttackThisCombat' }
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
        prompt: `${sourceName} is entering. Pay ${condition.n} life?`,
        options: [
          { type: 'payLife', description: `Pay ${condition.n} life`, data: { life: condition.n } },
          { type: 'decline', description: `Don't pay ${condition.n} life` },
        ],
      };
      if (outcome.index !== 0) return false;
      loseLife(ctx, player, condition.n);
      emit(ctx, 'costPaid', { player: player.id, source: sourceName, life: condition.n });
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

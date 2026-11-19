import type { Step } from '@mtg/shared';
import { playerLifeLocked } from '../state/phasing';
import { counterCount } from '../state/counters';
import {
  eventObjectFacts,
  eventObjectState,
  sourceObjectFacts,
  sourceObjectState,
  type ObjectFacts,
} from './source-identity';
import { assertNever } from '../utils/assert-never';
import { evaluateValueIn } from '../effects/values';
import type { Value, ValueScope } from './value';
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
import { payLife, payManaCost } from '../effects/resolve';
import { emit } from '../log/log';
import {
  allowanceFor,
  attackedPlaneswalker,
  getDefByOracleId,
  manaSourcesFor,
  opponentsOf,
} from '../state/queries';
import type { GameContext } from '../state/types';
import { canPay, describeManaCost } from '../mana/cost';
import type { ParsedManaCost } from '../mana/cost';
import { computeCharacteristics, selectPermanents } from '../effects/continuous';
import type { Selector, SelectorSource } from './selector';
import { ofType, selectMatches, tappedState } from './selector';
import type { PlayerId } from '@mtg/shared';
import type { EnginePermanent } from '../state/types';

/**
 * How a counted condition compares. `'=='` is not decoration: "whenever you draw your **second**
 * card each turn" fires once, on the second draw, and `'>='` would keep firing on the third and
 * fourth. An "or more"/"or greater" phrasing is what asks for `'>='`.
 */
export type Comparison = '>=' | '<=' | '==';

export type Condition =
  | { kind: 'giftPromised' }
  | { kind: 'sourceClassLevel'; cmp: Comparison; n: number }
  | { kind: 'eventPlayerHandSize'; cmp: Comparison; n: number }
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
  /**
   * "you control three or more lands with the same name" (Endless Atlas, Sceptre of Eternal
   * Glory): some single name is shared by at least `n` lands you control.
   */
  | { kind: 'controlsLandsWithSameName'; n: number }
  /** "you have two or more opponents" — counts players still in the game, not permanents. */
  | { kind: 'opponentCount'; cmp: '>=' | '<='; n: number }
  /**
   * "unless a player has 13 or less life" (Razortrap Gorge): some player still in the game has
   * at most `n` life.
   */
  | { kind: 'anyPlayerLifeAtMost'; n: number }
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
  | { kind: 'opponentDiscardedThisTurn' }
  /** "creatures you control have total power 10 or greater" (Mosswort Bridge). */
  | { kind: 'totalCreaturePower'; scope: 'you' | 'opponents' | 'all'; cmp: '>=' | '<='; n: number }
  | { kind: 'isUntapped' }
  | { kind: 'wasKicked' }
  /**
   * "if you cast it" (Shard of the Nightbringer): the source permanent is the spell its
   * controller cast (CR 601.2), read from its cast record or, once it has left, its last-known
   * facts. A permanent put onto the battlefield without being cast, or a copy, has no record.
   */
  | { kind: 'sourceWasCast' }
  | { kind: 'announcedXAtLeast'; n: number }
  | { kind: 'escaped' }
  /** Addendum: "if you cast this spell during your main phase" (Unbreakable Formation). */
  | { kind: 'castDuringYourMainPhase' }
  | { kind: 'hasCounters'; selector: Selector; counter: string; cmp: '>=' | '<='; n: number }
  | { kind: 'enteredThisTurn' }
  | { kind: 'createdTokenThisTurn' }
  /** "if there are four or more creature cards exiled with this artifact" (Negative Zone Portal). */
  | { kind: 'exiledWithSourceAtLeast'; cardType: string; n: number }
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
   * "When this creature dies, if it had counters on it" (Iron Apprentice): the ability's own
   * source against a selector, read from its last-known facts once it has left (CR 603.10a).
   */
  | { kind: 'sourceMatches'; selector: Selector }
  /**
   * "if the amount of mana you spent is greater than this creature's power or toughness"
   * (Increment): two numeric values compared in the trigger's scope, so a cast trigger's mana
   * spent and the source's current power can be read together.
   */
  | { kind: 'compareValues'; left: Value; cmp: Comparison; right: Value }
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
  /** "Cast this spell only during the declare blockers step": the game is in that step now. */
  | { kind: 'duringStep'; step: Step }
  /**
   * "Cast this spell only before attackers are declared": this turn has not yet reached the
   * declare attackers step of its first combat phase (Siren's Call, Master Warcraft).
   */
  | { kind: 'beforeAttackersDeclared' }
  /** "If it's your main phase" (Moraug): your turn, during either main phase. */
  | { kind: 'duringYourMainPhase' }
  /** Dethrone: the defending player has the most life, or is tied for the most life. */
  | { kind: 'attackingPlayerHasMoreLife' }
  /** The defending player has more life than the ability's controller. */
  | { kind: 'attackingPlayerHasMoreLifeThanYou' }
  /** Breena: the attacked opponent has more life than another of your opponents. */
  | { kind: 'defendingOpponentHasMoreLifeThanAnother' }
  /** The attack-trigger object is attacking an opponent of the ability's controller. */
  | { kind: 'triggerObjectAttackingOpponent' }
  /**
   * `attackDeclared` firing: at least/most `n` creatures of the group are CURRENTLY attacking the
   * ability's controller, or (with `planeswalkers`) a planeswalker they control — a creature
   * removed from combat, or whose planeswalker was, no longer counts (Mangara, Tomik, Ever-Watching
   * Threshold: "attacking you and/or planeswalkers you control").
   */
  | { kind: 'attackGroupAttackingYou'; planeswalkers: boolean; cmp: Comparison; n: number }
  /** `attackDeclared` firing: none of the declared attackers attacked the ability's controller. */
  | { kind: 'attackWasNotAtYou' }
  /**
   * `attackDeclared` firing with `perDefender`: the attacked player has more life than at least
   * one other opponent of the ability's controller (Breena). A player who left the game is no one.
   */
  | { kind: 'attackedPlayerHasMoreLifeThanAnotherOpponent' }
  /**
   * "Whenever a creature an opponent controls attacks, **if you're the defending player**"
   * (Kazuul, Tyrant of the Cliffs): a genuine intervening-if over the trigger's exact original
   * event permanent (CR 603.4), checked when the attack triggers and again as the ability
   * resolves. The defending player is the player attacked, or the controller of the planeswalker
   * attacked (CMM release notes include the planeswalker's controller; battles stay unsupported
   * until PR11). The answer follows CR 508.5's retained information, not the current combat
   * assignment: if the attacker still attacks, its current defending player (`attacking` names
   * that player for a player and a planeswalker attack alike, CR 508.1b); once combat assignment
   * for it ended (removed from combat, controller change, phasing, player departure), the
   * `lastAttackingDefendingPlayerId` retained at that clear, or the captured event. A redirect
   * to another player keeps the recheck honest — the last-id field follows the redirect, never
   * the original event — while `SelectorCandidate.attackingDefendingPlayerId` stays strictly
   * current-combat and the `attackingYouOrYourPlaneswalker` selector keeps its semantics.
   */
  | { kind: 'eventObjectDefendingPlayerIsYou' }
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
  /** "If a modified creature died under your control this turn" (CR 700.9, Intermediate Chirography). */
  | { kind: 'modifiedCreatureDiedUnderYourControlThisTurn' }
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
    case 'anyPlayerLifeAtMost':
    case 'excessDamageDealtTo':
    case 'opponentDealtDamageThisTurn':
    case 'opponentDiscardedThisTurn':
    case 'totalCreaturePower':
    case 'isUntapped':
    case 'giftPromised':
    case 'sourceClassLevel':
    case 'eventPlayerHandSize':
    case 'wasKicked':
    case 'sourceWasCast':
    case 'announcedXAtLeast':
    case 'escaped':
    case 'castDuringYourMainPhase':
    case 'hasCounters':
    case 'enteredThisTurn':
    case 'createdTokenThisTurn':
    case 'exiledWithSourceAtLeast':
    case 'hadToAttackThisCombat':
    case 'triggerObjectHadToAttackThisCombat':
    case 'triggerObjectMatches':
    case 'sourceMatches':
    case 'compareValues':
    case 'chosenOptionIs':
    case 'controlsYourCommander':
    case 'controlsACommander':
    case 'opponentIsMonarch':
    case 'notYourTurn':
    case 'yourTurn':
    case 'duringStep':
    case 'beforeAttackersDeclared':
    case 'duringYourMainPhase':
    case 'attackingPlayerHasMoreLife':
    case 'attackingPlayerHasMoreLifeThanYou':
    case 'defendingOpponentHasMoreLifeThanAnother':
    case 'triggerObjectAttackingOpponent':
    case 'attackGroupAttackingYou':
    case 'attackWasNotAtYou':
    case 'attackedPlayerHasMoreLifeThanAnotherOpponent':
    case 'eventObjectDefendingPlayerIsYou':
    case 'eventPlayerDrawCount':
    case 'notFirstDrawInOwnDrawStep':
    case 'cardsInYourGraveyard':
    case 'sourceHasCounters':
    case 'castSpellThisTurn':
    case 'modifiedCreatureDiedUnderYourControlThisTurn':
    case 'controlsLandsWithSameName':
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
  const scope = {
    ...source,
    sourceCardId: source.cardId,
    ...(source.objectId === undefined ? {} : { sourceObjectId: source.objectId }),
    controllerId: source.controllerId as PlayerId,
  };
  const sourceState = () => sourceObjectState(ctx, scope);
  const defenderIdOf = (attacker: EnginePermanent | ObjectFacts | undefined) =>
    attacker === undefined
      ? undefined
      : 'candidate' in attacker
        ? (attacker.candidate.attackingDefenderId ?? undefined)
        : // The attacked PLAYER; an attack on their planeswalker attacks no player (CR 508.1b).
          attacker.attackingPlaneswalker === null
          ? (attacker.attacking ?? undefined)
          : undefined;
  switch (condition.kind) {
    case 'modifiedCreatureDiedUnderYourControlThisTurn':
      return ctx.state.modifiedCreatureDiedThisTurn?.[source.controllerId] === true;
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
      const self = sourceState();
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
    case 'controlsLandsWithSameName': {
      const byName = new Map<string, number>();
      for (const land of selectPermanents(ctx, ofType('Land'), source)) {
        if (land.controllerId !== source.controllerId) continue;
        byName.set(land.name, (byName.get(land.name) ?? 0) + 1);
      }
      return [...byName.values()].some((count) => count >= condition.n);
    }
    case 'notYourTurn':
      return ctx.state.currentTurnPlayer !== source.controllerId;
    case 'yourTurn':
      return ctx.state.currentTurnPlayer === source.controllerId;
    case 'duringStep':
      return ctx.state.step === condition.step;
    case 'beforeAttackersDeclared':
      return ctx.state.declareAttackersReachedThisTurn !== true;
    case 'duringYourMainPhase':
      return (
        ctx.state.currentTurnPlayer === source.controllerId &&
        (ctx.state.phase === 'precombatMain' || ctx.state.phase === 'postcombatMain')
      );
    case 'triggerObjectAttackingOpponent': {
      if (source.triggerObjectCardId === undefined) return false;
      const defenderId = defenderIdOf(eventObjectState(ctx, scope));
      return opponentsOf(ctx, source.controllerId).some((opponent) => opponent.id === defenderId);
    }
    case 'attackGroupAttackingYou': {
      let count = 0;
      for (const id of source.attackGroupIds ?? []) {
        const attacker = ctx.state.battlefield.find((p) => p.id === id);
        if (attacker === undefined || attacker.attacking !== source.controllerId) continue;
        if (attacker.attackingPlaneswalker === null) count++;
        else if (condition.planeswalkers && attackedPlaneswalker(ctx, attacker) !== null) count++;
      }
      return compare(count, condition.cmp, condition.n);
    }
    case 'attackWasNotAtYou':
      return source.attackedWatcher !== true;
    case 'attackedPlayerHasMoreLifeThanAnotherOpponent': {
      const attacked = ctx.state.players.find((p) => p.id === source.attackedPlayerId);
      if (attacked === undefined) return false;
      return opponentsOf(ctx, source.controllerId).some(
        (other) => other.id !== attacked.id && attacked.life > other.life,
      );
    }
    case 'eventObjectDefendingPlayerIsYou': {
      // Over the trigger's exact original event object only: no `triggerObjectCardId` fallback,
      // which is how a blinked new incarnation could answer for a departed attacker (CR 400.7,
      // 603.7). Unbound scope fails closed — an event it was never authored for is not "you".
      if ((scope.triggerObjectId ?? scope.eventObjectId) === undefined) return false;
      const eventObject = eventObjectState(ctx, scope);
      if (eventObject === undefined) return false;
      const retainedDefender =
        'candidate' in eventObject
          ? eventObject.lastAttackingDefendingPlayerId
          : (eventObject.attacking ?? eventObject.lastAttackingDefendingPlayerId);
      // The last resort IS the captured original event: the facts the trigger scope took at the
      // event (refreshed to departure LKI if the attacker left before the recheck, CR 608.2h).
      const defenderId =
        retainedDefender ?? scope.triggerObjectFacts?.lastAttackingDefendingPlayerId;
      return defenderId === source.controllerId;
    }
    case 'opponentCount':
      return compare(opponentsOf(ctx, source.controllerId).length, condition.cmp, condition.n);
    case 'anyPlayerLifeAtMost':
      return ctx.state.players.some((player) => !player.hasLost && player.life <= condition.n);
    case 'excessDamageDealtTo': {
      const opponentIds = new Set(opponentsOf(ctx, source.controllerId).map((p) => p.id));
      return ctx.state.excessDamageControllerIds.some((id) => opponentIds.has(id));
    }
    case 'opponentDiscardedThisTurn':
      return opponentsOf(ctx, source.controllerId).some(
        (player) => (player.discardedCardsThisTurn ?? 0) > 0,
      );
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
      const perm = sourceState();
      return perm !== undefined && !tappedState(perm);
    }
    case 'giftPromised':
      return source.giftPromised === true;
    case 'sourceClassLevel': {
      const state = sourceState();
      return state !== undefined && compare(state.classLevel ?? 1, condition.cmp, condition.n);
    }
    case 'eventPlayerHandSize': {
      if (scope.eventPlayerId === undefined)
        throw new Error('hand-size condition has no bound event player');
      const player = ctx.state.players.find((candidate) => candidate.id === scope.eventPlayerId);
      return (
        player !== undefined &&
        !player.hasLost &&
        compare(player.hand.length, condition.cmp, condition.n)
      );
    }
    case 'enteredThisTurn': {
      if (source?.cardId === undefined) return false;
      const perm = sourceState();
      return perm !== undefined && perm.enteredTurnNumber === ctx.state.turnNumber;
    }
    case 'hadToAttackThisCombat': {
      if (source?.cardId === undefined) return false;
      const perm = sourceState();
      return perm?.hadToAttackThisCombat === true;
    }
    case 'triggerObjectHadToAttackThisCombat': {
      if (source.triggerObjectCardId === undefined) return false;
      const perm = eventObjectState(ctx, scope);
      return perm?.hadToAttackThisCombat === true;
    }
    case 'compareValues': {
      const valueScope = scope as ValueScope;
      return compare(
        evaluateValueIn(ctx, condition.left, valueScope),
        condition.cmp,
        evaluateValueIn(ctx, condition.right, valueScope),
      );
    }
    case 'triggerObjectMatches': {
      const facts = eventObjectFacts(ctx, {
        ...source,
        controllerId: source.controllerId as PlayerId,
      });
      return facts !== undefined && selectMatches(facts.candidate, condition.selector, source);
    }
    case 'sourceMatches': {
      const facts = sourceObjectFacts(ctx, scope);
      return facts !== undefined && selectMatches(facts.candidate, condition.selector, source);
    }
    case 'chosenOptionIs': {
      if (source?.cardId === undefined) return false;
      const perm = sourceState();
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
        source.triggerObjectCardId === undefined ? sourceState() : eventObjectState(ctx, scope);
      const defenderId = defenderIdOf(attacker);
      const defender = ctx.state.players.find((p) => p.id === defenderId && !p.hasLost);
      if (defender === undefined) return false;
      const lives = ctx.state.players
        .filter((player) => !player.hasLost)
        .map((player) => player.life);
      const mostLife = lives.length === 0 ? 0 : Math.max(...lives);
      return defender.life === mostLife;
    }
    case 'defendingOpponentHasMoreLifeThanAnother': {
      // The attacked player is an event fact, not the attacker's current combat assignment.
      const defenderId = scope.triggerObjectFacts?.candidate.attackingDefenderId;
      const opponents = ctx.state.players.filter(
        (player) => !player.hasLost && player.id !== source.controllerId,
      );
      const defender = opponents.find((player) => player.id === defenderId);
      return (
        defender !== undefined &&
        opponents.some((player) => player.id !== defender.id && defender.life > player.life)
      );
    }
    case 'attackingPlayerHasMoreLifeThanYou': {
      const attacker =
        source.triggerObjectCardId === undefined ? sourceState() : eventObjectState(ctx, scope);
      const defenderId = defenderIdOf(attacker);
      const defender = ctx.state.players.find((p) => p.id === defenderId && !p.hasLost);
      const controller = ctx.state.players.find((p) => p.id === source.controllerId);
      return defender !== undefined && controller !== undefined && defender.life > controller.life;
    }
    case 'createdTokenThisTurn':
      return ctx.state.createdTokenThisTurn?.[source.controllerId] === true;
    case 'exiledWithSourceAtLeast': {
      // Only cards still in exile count: one that left is no longer "exiled with" it.
      const self = sourceState();
      const linked =
        self !== undefined && 'exiledWithIds' in self ? (self.exiledWithIds ?? []) : [];
      const count = linked.filter((objectId: string) => {
        const card = ctx.state.exile.find((entry) => entry.id === objectId);
        return (
          card !== undefined &&
          getDefByOracleId(ctx, card.oracleId, card.name).types.includes(condition.cardType)
        );
      }).length;
      return count >= condition.n;
    }
    case 'sourceWasCast': {
      const self = sourceState();
      if (self === undefined) return false;
      return self.castByPlayerId !== undefined && self.castByPlayerId === source.controllerId;
    }
    case 'wasKicked': {
      if (source?.cardId === undefined) return false;
      const perm = sourceState();
      if (perm !== undefined)
        return perm.wasKicked === true || ('kicked' in perm && perm.kicked === true);
      if (source.sourceCastState !== undefined) return source.sourceCastState.wasKicked;
      const stackObj = ctx.state.stack.find((s) =>
        source.objectId === undefined
          ? s.sourceCardId === source.cardId || s.card?.cardId === source.cardId
          : s.id === source.objectId,
      );
      return stackObj !== undefined && (stackObj.wasKicked === true || stackObj.kicked === true);
    }
    case 'announcedXAtLeast': {
      if (source.cardId === undefined) return false;
      const permanent = sourceState();
      if (permanent !== undefined) return (permanent.announcedX ?? 0) >= condition.n;
      if (source.sourceCastState !== undefined)
        return source.sourceCastState.announcedX >= condition.n;
      const stackObject = ctx.state.stack.find((candidate) =>
        source.objectId === undefined
          ? candidate.sourceCardId === source.cardId || candidate.card?.cardId === source.cardId
          : candidate.id === source.objectId,
      );
      return (stackObject?.announcedX ?? 0) >= condition.n;
    }
    case 'castDuringYourMainPhase':
      if (source.sourceCastState !== undefined)
        return source.sourceCastState.castDuringOwnMainPhase === true;
      return ctx.state.stack.some(
        (candidate) =>
          candidate.id === source.objectId && candidate.castDuringOwnMainPhase === true,
      );
    case 'escaped': {
      if (source.cardId === undefined) return false;
      const permanent = sourceState();
      if (permanent !== undefined) return permanent.escaped === true;
      if (source.sourceCastState !== undefined) return source.sourceCastState.escaped;
      return ctx.state.stack.some(
        (candidate) =>
          (source.objectId === undefined
            ? candidate.sourceCardId === source.cardId || candidate.card?.cardId === source.cardId
            : candidate.id === source.objectId) && candidate.escaped === true,
      );
    }
    case 'hasCounters': {
      // SELF is used by Station's continuous threshold. Resolving it through selectPermanents
      // would recursively recompute the very characteristics whose condition is being checked.
      const matched =
        condition.selector.kind === 'self'
          ? (() => {
              const self = sourceState();
              return self === undefined ? [] : [self];
            })()
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
      if (condition.n > player.life || (condition.n > 0 && playerLifeLocked(ctx, player.id)))
        return false;
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
      payLife(ctx, player, condition.n);
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
      if (
        !canPay(
          condition.cost,
          player.manaEntries,
          sources,
          allows,
          playerLifeLocked(ctx, player.id) ? 0 : player.life,
        )
      )
        return false;
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

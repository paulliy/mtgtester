/**
 * Yield-until-end-of-turn "stops" (brief/ADR — player-experience overhaul, Workstream 2).
 *
 * `passAndYieldTurn` is meant to behave like MTGO's F6: hold priority passed for the rest of
 * the turn UNLESS something worth stopping for happens. The naive version — clearing the flag
 * on every opponent cast/activation/trigger (the old `resetOpponentYields`) — breaks it within
 * a step on any developed board, since triggers fire constantly. This module decides, per new
 * stack object, which yielding players it is actually a stop for: it targets them, threatens
 * their board, or threatens their life/hand. Everything else — a ramp spell, a draw trigger, an
 * ETB that doesn't touch them — leaves the yield standing.
 */

import type { Effect } from '../cards/definition';
import type { Selector } from '../cards/selector';
import { selectPermanents } from '../effects/continuous';
import type { EngineStackObject, GameContext } from '../state/types';

/** Ops whose `selector` names the permanents they hit — a real threat if it hits your board. */
const BOARD_WIPE_OPS: ReadonlySet<string> = new Set([
  'destroyEach',
  'exileEach',
  'returnToHandEach',
  'damageEach',
  'tapEach',
  'removeCountersEach',
  'gainControl',
  'destroyEachNonlandMVFromDamagedControllers',
]);

/** Flatten conditional/modal branches so a mass effect nested inside one is still found. */
function flattenEffects(effects: readonly Effect[]): Effect[] {
  const out: Effect[] = [];
  for (const effect of effects) {
    out.push(effect);
    if (effect.op === 'conditionalEffect') {
      out.push(...flattenEffects(effect.then), ...flattenEffects(effect.else));
    } else if (effect.op === 'chooseOne') {
      for (const option of effect.options) out.push(...flattenEffects(option.effects));
    }
  }
  return out;
}

/** True if a chosen target is the player themselves, or a permanent they control. */
function targetsPlayer(ctx: GameContext, stackEntry: EngineStackObject, playerId: string): boolean {
  return stackEntry.targets.some((id) => {
    if (id === playerId) return true;
    const perm = ctx.state.battlefield.find((candidate) => candidate.id === id);
    return perm !== undefined && perm.controllerId === playerId;
  });
}

/** True if any (possibly nested) mass effect would hit a permanent this player controls. */
function threatensBoard(ctx: GameContext, stackEntry: EngineStackObject, playerId: string): boolean {
  const effects = stackEntry.ability?.effects;
  if (effects === undefined) return false;
  const source = { cardId: stackEntry.sourceCardId, controllerId: stackEntry.controllerId };

  for (const effect of flattenEffects(effects)) {
    if (effect.op === 'overloadBounceAllNonlandOpponents') {
      if (playerId !== stackEntry.controllerId) return true;
      continue;
    }
    if (!BOARD_WIPE_OPS.has(effect.op)) continue;
    const selector = (effect as { selector?: Selector }).selector;
    if (selector === undefined) continue;
    const matches = selectPermanents(ctx, selector, source);
    if (matches.some((perm) => perm.controllerId === playerId)) return true;
  }
  return false;
}

/** True if an unavoidable, untargeted effect reaches this player's life total or hand. */
function threatensLifeOrHand(stackEntry: EngineStackObject, playerId: string): boolean {
  const effects = stackEntry.ability?.effects;
  if (effects === undefined) return false;
  const isOpponent = playerId !== stackEntry.controllerId;

  for (const effect of flattenEffects(effects)) {
    // Hits every player, including the controller.
    if (effect.op === 'damageEachPlayer' || effect.op === 'eachPlayerDiscardHandThenDraw') return true;
    // Hits every opponent of the controller.
    if (isOpponent && (effect.op === 'eachOpponentDamage' || effect.op === 'eachOpponentLosesLife')) {
      return true;
    }
  }
  return false;
}

/**
 * Break `yieldUntilEndOfTurn` only for players this new stack object is a genuine stop for.
 * Replaces the old `resetOpponentYields`, called from the same sites (a spell is cast, an
 * ability is activated, a triggered ability goes on the stack).
 */
export function breakYieldsForStop(ctx: GameContext, stackEntry: EngineStackObject): void {
  for (const player of ctx.state.players) {
    if (player.id === stackEntry.controllerId) continue;
    if (player.yieldUntilEndOfTurn !== true) continue;
    if (
      targetsPlayer(ctx, stackEntry, player.id) ||
      threatensBoard(ctx, stackEntry, player.id) ||
      threatensLifeOrHand(stackEntry, player.id)
    ) {
      player.yieldUntilEndOfTurn = false;
    }
  }
}

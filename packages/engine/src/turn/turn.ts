/**
 * Turn structure (CR 500–514, brief §5.3): beginning (untap/upkeep/draw), precombat main,
 * combat, postcombat main, ending (end/cleanup). Multiplayer: the starting player DOES
 * draw on their first turn (brief §5.3 — no two-player skip rule).
 */

import type { Phase, Step } from '@mtg/shared';
import { runCombatPhase } from '../combat/combat';
import type { GameGen } from '../decisions';
import { drawCards, endUntilEotEffects } from '../effects/resolve';
import { emit, debug } from '../log/log';
import { priorityCheckpoint } from '../sba/sba';
import { moveObject, playerById } from '../state/objects';
import { triggersOf } from '../state/queries';
import type { EngineCardObject, GameContext } from '../state/types';
import { emptyManaPools, runPrioritySequence } from './priority';

function setPhase(ctx: GameContext, phase: Phase, step: Step | null): void {
  ctx.state.phase = phase;
  ctx.state.step = step;
  emit(ctx, 'phaseBegin', { phase, ...(step !== null ? { step } : {}) });
  debug(ctx, 'turn', `phase: ${phase}${step !== null ? `/${step}` : ''}`);
}

function setStep(ctx: GameContext, step: Step): void {
  ctx.state.step = step;
  emit(ctx, 'stepBegin', { step });
  debug(ctx, 'turn', `step: ${step}`);
}

/** Untap step (CR 502): turn-based actions only; NO priority (brief §5.3). */
function untapStep(ctx: GameContext): void {
  const ap = playerById(ctx, ctx.state.currentTurnPlayer);
  setPhase(ctx, 'beginning', 'untap');
  ap.landsPlayedThisTurn = 0;
  let untapped = 0;
  for (const perm of ctx.state.battlefield) {
    if (perm.controllerId !== ap.id) continue;
    // CR 302.6: controlled continuously since the turn began → no longer summoning sick.
    perm.summoningSick = false;
    if (perm.tapped) {
      perm.tapped = false;
      untapped += 1;
    }
  }
  emit(ctx, 'untap', { player: ap.id, count: untapped }, ap.id);
}

/** Queue "beginning of upkeep" triggers (CR 503) for the current active player's upkeep. */
function queueUpkeepTriggers(ctx: GameContext): void {
  const apId = ctx.state.currentTurnPlayer;
  for (const perm of ctx.state.battlefield) {
    for (const ability of triggersOf(ctx, perm)) {
      const fires =
        (ability.trigger === 'upkeepYours' && perm.controllerId === apId) ||
        ability.trigger === 'upkeepEach';
      if (fires) {
        ctx.state.pendingTriggers.push({
          controllerId: perm.controllerId,
          sourceCardId: perm.cardId,
          sourceOracleId: perm.oracleId,
          sourceName: perm.name,
          ability,
        });
        debug(ctx, 'stack', `upkeep trigger queued: ${perm.name}`);
      }
    }
  }
}

/** Cleanup step (CR 514), repeating while SBAs/triggers give players priority (514.3a). */
function* cleanupStep(ctx: GameContext): GameGen<void> {
  const ap = playerById(ctx, ctx.state.currentTurnPlayer);
  for (;;) {
    setStep(ctx, 'cleanup');

    // Discard to maximum hand size (CR 514.1) — which card is an AI decision.
    while (!ap.hasLost && ap.hand.length > 7) {
      const outcome = yield {
        decisionType: 'general',
        player: ap.id,
        prompt: `Discard down to seven cards (${ap.hand.length} in hand). Choose a card to discard.`,
        options: ap.hand.map((card) => ({
          type: 'discard',
          description: `Discard ${card.name}`,
          payload: card.id,
        })),
      };
      const card = ap.hand[outcome.index] as EngineCardObject;
      emit(ctx, 'discard', { player: ap.id, name: card.name, cardId: card.cardId }, ap.id);
      yield* moveObject(ctx, card, { zone: 'graveyard' });
    }

    // Simultaneously: remove all marked damage and end until-EOT effects (CR 514.2).
    for (const perm of ctx.state.battlefield) {
      perm.damageMarked = 0;
      perm.damagedByDeathtouch = false;
    }
    endUntilEotEffects(ctx);
    emptyManaPools(ctx);

    // Normally no priority in cleanup; but if SBAs act or triggers are waiting, players
    // get priority, then ANOTHER cleanup step happens (CR 514.3a).
    const acted = yield* priorityCheckpoint(ctx);
    if (!acted && ctx.state.pendingTriggers.length === 0 && ctx.state.stack.length === 0) {
      return;
    }
    yield* runPrioritySequence(ctx);
    emptyManaPools(ctx);
  }
}

/** One complete turn for `state.currentTurnPlayer`. */
export function* runTurn(ctx: GameContext): GameGen<void> {
  const s = ctx.state;
  const ap = playerById(ctx, s.currentTurnPlayer);
  emit(ctx, 'turnBegin', { turn: s.turnNumber, player: ap.id }, ap.id);
  debug(ctx, 'turn', `--- turn ${s.turnNumber}: ${ap.id} ---`);

  // Beginning phase.
  untapStep(ctx);

  setStep(ctx, 'upkeep');
  queueUpkeepTriggers(ctx);
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  setStep(ctx, 'draw');
  yield* drawCards(ctx, ap, 1); // multiplayer: first-turn draw included (brief §5.3)
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  // Precombat main.
  setPhase(ctx, 'precombatMain', null);
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  // Combat.
  setPhase(ctx, 'combat', null);
  yield* runCombatPhase(ctx);

  // Postcombat main.
  setPhase(ctx, 'postcombatMain', null);
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  // Ending phase.
  setPhase(ctx, 'ending', 'end');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  yield* cleanupStep(ctx);
  emit(ctx, 'turnEnd', { turn: s.turnNumber, player: ap.id }, ap.id);
}

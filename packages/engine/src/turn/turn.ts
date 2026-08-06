/**
 * Turn structure (CR 500–514, brief §5.3): beginning (untap/upkeep/draw), precombat main,
 * combat, postcombat main, ending (end/cleanup). Multiplayer: the starting player DOES
 * draw on their first turn (brief §5.3 — no two-player skip rule).
 */

import type { Phase, Step } from '@mtg/shared';
import { evaluateCondition } from '../cards/condition';
import { runCombatPhase } from '../combat/combat';
import type { GameGen } from '../decisions';
import { drawCards, endUntilEotEffects } from '../effects/resolve';
import { emit, debug } from '../log/log';
import { priorityCheckpoint } from '../sba/sba';
import { moveObject, playerById } from '../state/objects';
import { hasNoMaximumHandSize, triggersOf } from '../state/queries';
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
  ctx.state.excessDamageControllerIds = [];
  ctx.state.damageDealtToPlayersThisTurn = {};
  ctx.state.combatDamagePlayersBySource = {};
  ctx.state.creaturesDiedThisTurn = 0;
  ctx.state.combatDamagePrevention = { all: false, players: {} };
  ctx.state.lifeFloorPlayers = {};
  for (const p of ctx.state.players) {
    p.yieldUntilEndOfTurn = false;
  }
  // "Activate only once each turn" (CR 602.5f) is measured in turns, not in *your* turns, so
  // this clears for every permanent on the battlefield — not just the active player's.
  for (const perm of ctx.state.battlefield) {
    perm.activationsThisTurn = [];
    if (perm.attackedThisTurn === true) perm.attackedThisTurn = false;
    perm.mustBlockThisTurn = false;
    // CR 701.15a: a goad requirement lasts until the next turn of the player who caused it.
    // Requirements created during that player's current turn remain active until that turn ends.
    if (perm.goadedBy !== undefined) {
      const remainingGoads = perm.goadedBy.filter(
        (requirement) =>
          requirement.goaderId !== ap.id || requirement.appliedTurn >= ctx.state.turnNumber,
      );
      if (remainingGoads.length > 0) perm.goadedBy = remainingGoads;
      else delete perm.goadedBy;
    }
  }

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

/**
 * Queue "at the beginning of your/each `<step>`" triggers (CR 503 upkeep, CR 513 end step).
 *
 * One function for both because the only thing that differs is which step is beginning: the
 * `player === 'you'` filter, the intervening-if check and the queue entry are identical, and a
 * second copy is how the two drift apart.
 */
export function queueStepTriggers(
  ctx: GameContext,
  when: 'upkeep' | 'endStep' | 'untapStep' | 'drawStep' | 'mainPhase' | 'beginningOfCombat',
): void {
  const apId = ctx.state.currentTurnPlayer;
  for (const perm of [...ctx.state.battlefield]) {
    for (const ability of triggersOf(ctx, perm)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== when) continue;
      if (spec.player === 'you' && perm.controllerId !== apId) continue;
      const source = { cardId: perm.cardId, controllerId: perm.controllerId };
      // Intervening-if, first check (CR 603.4) — see `queueTriggersForEvent`.
      if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, source)) continue;
      ctx.state.pendingTriggers.push({
        controllerId: perm.controllerId,
        sourceCardId: perm.cardId,
        sourceOracleId: perm.oracleId,
        sourceName: perm.name,
        ability,
      });
      debug(ctx, 'stack', `${when} trigger queued: ${perm.name}`);
    }
  }

  for (const player of ctx.state.players) {
    for (const emblem of player.emblems) {
      for (const ability of emblem.abilities) {
        const spec = ability.trigger;
        if (spec === undefined || spec.when !== when || !('player' in spec)) continue;
        if (spec.player === 'you' && emblem.controllerId !== apId) continue;
        ctx.state.pendingTriggers.push({
          controllerId: emblem.controllerId,
          sourceCardId: emblem.id,
          sourceOracleId: '' as never,
          sourceName: emblem.name,
          ability,
        });
        debug(ctx, 'stack', `${when} emblem trigger queued: ${emblem.name}`);
      }
    }
  }
  const remainingDelayed = [];
  for (const delayed of ctx.state.delayedTriggers) {
    if (delayed.when === when) {
      ctx.state.pendingTriggers.push({
        controllerId: delayed.controllerId,
        sourceCardId: delayed.sourceCardId,
        sourceOracleId: delayed.sourceOracleId,
        sourceName: 'Delayed Trigger',
        ability: delayed.ability,
        ...(delayed.targetId !== undefined ? { triggerObjectCardId: delayed.targetId } : {}),
      });
      debug(ctx, 'stack', `delayed ${when} trigger queued: ${delayed.id}`);
      if (delayed.expiry === 'endStep') {
        continue;
      }
    }
    remainingDelayed.push(delayed);
  }
  ctx.state.delayedTriggers = remainingDelayed;
}

/** Cleanup step (CR 514), repeating while SBAs/triggers give players priority (514.3a). */
function* cleanupStep(ctx: GameContext): GameGen<void> {
  const ap = playerById(ctx, ctx.state.currentTurnPlayer);
  for (;;) {
    setStep(ctx, 'cleanup');

    // Discard to maximum hand size (CR 514.1) — which card is an AI decision.
    while (!ap.hasLost && !hasNoMaximumHandSize(ctx, ap.id) && ap.hand.length > 7) {
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
    ctx.state.delayedTriggers = ctx.state.delayedTriggers.filter((dt) => dt.expiry !== 'cleanup');
    // End of TURN: "you don't lose this mana as steps and phases end" runs out here too, so
    // cleanup drains persistent mana as well (Klauth's is explicitly "until end of turn").
    emptyManaPools(ctx, true);

    // Normally no priority in cleanup; but if SBAs act or triggers are waiting, players
    // get priority, then ANOTHER cleanup step happens (CR 514.3a).
    const acted = yield* priorityCheckpoint(ctx);
    if (!acted && ctx.state.pendingTriggers.length === 0 && ctx.state.stack.length === 0) {
      return;
    }
    yield* runPrioritySequence(ctx);
    emptyManaPools(ctx, true);
  }
}

/** One complete turn for `state.currentTurnPlayer`. */
export function* runTurn(ctx: GameContext): GameGen<void> {
  const s = ctx.state;
  const ap = playerById(ctx, s.currentTurnPlayer);
  emit(ctx, 'turnBegin', { turn: s.turnNumber, player: ap.id }, ap.id);
  debug(ctx, 'turn', `--- turn ${s.turnNumber}: ${ap.id} ---`);

  // Beginning phase.
  queueStepTriggers(ctx, 'untapStep');
  untapStep(ctx);

  if (ctx.state.createdTokenThisTurn) {
    for (const p of Object.keys(ctx.state.createdTokenThisTurn)) ctx.state.createdTokenThisTurn[p as any] = false;
  }
  setStep(ctx, 'upkeep');
  queueStepTriggers(ctx, 'upkeep');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  setStep(ctx, 'draw');
  queueStepTriggers(ctx, 'drawStep');
  yield* drawCards(ctx, ap, 1); // multiplayer: first-turn draw included (brief §5.3)
  if (ctx.state.monarchPlayerId === ap.id) {
    yield* drawCards(ctx, ap, 1);
    emit(ctx, 'draw', { name: 'a card (monarch)' }, ap.id);
  }
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  // Precombat main.
  setPhase(ctx, 'precombatMain', null);
  queueStepTriggers(ctx, 'mainPhase');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  // Combat.
  setPhase(ctx, 'combat', null);
  queueStepTriggers(ctx, 'beginningOfCombat');
  yield* runCombatPhase(ctx);
  while (ctx.state.extraCombatPhases > 0) {
    ctx.state.extraCombatPhases -= 1;
    queueStepTriggers(ctx, 'beginningOfCombat');
    yield* runCombatPhase(ctx);
  }

  // Postcombat main.
  setPhase(ctx, 'postcombatMain', null);
  queueStepTriggers(ctx, 'mainPhase');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  // Ending phase. "At the beginning of the end step" triggers are queued as the step begins
  // (CR 513.1), before anyone receives priority in it.
  setPhase(ctx, 'ending', 'end');
  queueStepTriggers(ctx, 'endStep');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  yield* cleanupStep(ctx);
  emit(ctx, 'turnEnd', { turn: s.turnNumber, player: ap.id }, ap.id);
}

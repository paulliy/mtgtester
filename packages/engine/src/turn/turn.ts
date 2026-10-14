import { phaseInAtUntap } from '../state/phasing';
import { assertTriggerEventFamily } from '../cards/trigger-contracts';
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
import {
  additionalTypedTriggerCopies,
  discardCard,
  expireRegenerationShields,
  moveObject,
  playerById,
} from '../state/objects';
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
  phaseInAtUntap(ctx, ap.id);
  ap.landsPlayedThisTurn = 0;
  for (const player of ctx.state.players) {
    player.cardsDrawnThisTurn = 0;
    player.cardsDrawnThisDrawStep = 0;
    player.spellsCastThisTurn = 0;
    player.noncreatureSpellsCastThisTurn = 0;
    player.discardedCardsThisTurn = 0;
    delete player.spellsCastThisTurnRecords;
    player.playFromZoneTypeUsesThisTurn = {};
  }
  ctx.state.excessDamageControllerIds = [];
  ctx.state.damageDealtToPlayersThisTurn = {};
  ctx.state.lifeLostThisTurn = {};
  ctx.state.combatDamagePlayersBySource = {};
  ctx.state.creaturesDiedThisTurn = 0;
  delete ctx.state.abilityResolutionsThisTurn;
  ctx.state.combatDamagePrevention = { all: false, players: {} };
  ctx.state.lifeFloorPlayers = {};
  ctx.state.creaturesCantBeBlockedThisTurn = false;
  for (const p of ctx.state.players) {
    p.yieldUntilEndOfTurn = false;
  }
  // "Activate only once each turn" (CR 602.5f) is measured in turns, not in *your* turns, so
  // this clears for every permanent on the battlefield — not just the active player's.
  for (const perm of ctx.state.battlefield) {
    perm.activationsThisTurn = [];
    if (perm.triggeredOnceThisTurn !== undefined) delete perm.triggeredOnceThisTurn;
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
  when:
    | 'upkeep'
    | 'endStep'
    | 'untapStep'
    | 'drawStep'
    | 'mainPhase'
    | 'precombatMain'
    | 'secondMainPhase'
    | 'beginningOfCombat',
): void {
  assertTriggerEventFamily(when, 'step');
  const apId = ctx.state.currentTurnPlayer;
  for (const perm of [...ctx.state.battlefield]) {
    for (const ability of triggersOf(ctx, perm)) {
      const spec = ability.trigger;
      if (spec === undefined || spec.when !== when) continue;
      if (spec.player === 'you' && perm.controllerId !== apId) continue;
      if (spec.player === 'opponent' && perm.controllerId === apId) continue;
      const source = {
        cardId: perm.cardId,
        controllerId: perm.controllerId,
        eventPlayerId: apId,
      };
      // Intervening-if, first check (CR 603.4) — see `queueTriggersForEvent`.
      if (spec.condition !== undefined && !evaluateCondition(ctx, spec.condition, source)) continue;
      const copies = 1 + additionalTypedTriggerCopies(ctx, perm);
      for (let copy = 0; copy < copies; copy++) {
        ctx.state.pendingTriggers.push({
          controllerId: perm.controllerId,
          sourceCardId: perm.cardId,
          sourceObjectId: perm.id,
          sourceOracleId: perm.oracleId,
          sourceName: perm.name,
          ability,
          scope: { eventPlayerId: apId },
        });
        debug(ctx, 'stack', `${when} trigger queued: ${perm.name}`);
      }
    }
  }

  for (const player of ctx.state.players) {
    for (const emblem of player.emblems) {
      for (const ability of emblem.abilities) {
        const spec = ability.trigger;
        if (spec === undefined || spec.when !== when || !('player' in spec)) continue;
        if (spec.player === 'you' && emblem.controllerId !== apId) continue;
        if (spec.player === 'opponent' && emblem.controllerId === apId) continue;
        ctx.state.pendingTriggers.push({
          controllerId: emblem.controllerId,
          sourceCardId: emblem.id,
          sourceOracleId: '' as never,
          sourceName: emblem.name,
          ability,
          scope: { eventPlayerId: apId },
        });
        debug(ctx, 'stack', `${when} emblem trigger queued: ${emblem.name}`);
      }
    }
  }
  const remainingDelayed = [];
  for (const delayed of ctx.state.delayedTriggers) {
    // "your next upkeep" is not "the next upkeep": a player-scoped delayed trigger waits for its
    // own controller's step, the same `player === 'you'` filter the permanent loop above applies.
    // Only that explicit `player` restriction gates WHEN a delayed trigger fires.
    // `affectedPlayerId` is a resolution-recipient scope (who `eventPlayer` means once the
    // ability resolves), never an implicit step restriction: Arcane Denial's two draws both say
    // "at the beginning of the next turn's upkeep", so they fire together at the first upkeep
    // that comes around, whoever the active player is — not at each recipient's own upkeep.
    const scoped = delayed.player === 'you' && delayed.controllerId !== apId;
    if (delayed.when === when && !scoped) {
      ctx.state.pendingTriggers.push({
        controllerId: delayed.controllerId,
        sourceCardId: delayed.sourceCardId,
        sourceOracleId: delayed.sourceOracleId,
        sourceName: 'Delayed Trigger',
        ability: delayed.ability,
        ...(delayed.targetId !== undefined ? { triggerObjectCardId: delayed.targetId } : {}),
        ...(delayed.affectedPlayerId !== undefined || delayed.targetObjectId !== undefined
          ? {
              scope: {
                ...(delayed.affectedPlayerId !== undefined
                  ? { eventPlayerId: delayed.affectedPlayerId }
                  : {}),
                ...(delayed.targetObjectId !== undefined
                  ? { triggerObjectId: delayed.targetObjectId }
                  : {}),
              },
            }
          : {}),
      });
      debug(ctx, 'stack', `delayed ${when} trigger queued: ${delayed.id}`);
      if (delayed.expiry === 'endStep' || delayed.expiry === 'onFire') {
        continue;
      }
    }
    remainingDelayed.push(delayed);
  }
  ctx.state.delayedTriggers = remainingDelayed;
}

/**
 * CR 725.2: the monarch designation carries an inherent triggered ability — "At the beginning of
 * the monarch's end step, that player draws a card." It uses the stack like any other trigger, so
 * it is queued alongside the step's other beginning-of-end-step triggers rather than drawn inline.
 */
function queueMonarchTrigger(ctx: GameContext): void {
  const monarchId = ctx.state.monarchPlayerId;
  if (monarchId === null || monarchId !== ctx.state.currentTurnPlayer) return;
  ctx.state.pendingTriggers.push({
    controllerId: monarchId,
    sourceCardId: 'monarch',
    sourceOracleId: '' as never,
    sourceName: 'The monarch',
    ability: {
      kind: 'triggered',
      targets: [],
      effects: [{ op: 'draw', count: { kind: 'const', n: 1 } }],
      description: 'At the beginning of your end step, draw a card',
    },
  });
  debug(ctx, 'stack', `monarch end-step trigger queued: ${monarchId}`);
}

/** Begin the postcombat main phase: the phase event, then "at the beginning of your main phase". */
export function beginPostcombatMain(ctx: GameContext): void {
  setPhase(ctx, 'postcombatMain', null);
  queueStepTriggers(ctx, 'mainPhase');
  ctx.state.mainPhasesStartedThisTurn = (ctx.state.mainPhasesStartedThisTurn ?? 1) + 1;
  if (ctx.state.mainPhasesStartedThisTurn === 2) queueStepTriggers(ctx, 'secondMainPhase');
}

/**
 * Begin the end step. "At the beginning of the end step" triggers, the monarch's draw included,
 * are queued as the step begins (CR 513.1), before anyone receives priority in it.
 */
export function beginEndStep(ctx: GameContext): void {
  setPhase(ctx, 'ending', 'end');
  queueStepTriggers(ctx, 'endStep');
  queueMonarchTrigger(ctx);
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
      yield* discardCard(ctx, card, ap.id, 'cleanup');
    }

    // Simultaneously: remove all marked damage and end until-EOT effects (CR 514.2).
    for (const perm of [...ctx.state.battlefield, ...(ctx.state.phasedOut ?? []).map(record => record.permanent)]) {
      perm.damageMarked = 0;
      perm.damagedByDeathtouch = false;
      delete perm.mustAttackThisTurn;
    }
    expireRegenerationShields(ctx);
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
/**
 * The combat phase (CR 506) plus any extra combat phases it created. Shared by `runTurn` and the
 * Card Test Lab's prepared-scenario continuation so both use one combat sequence.
 */
export function* runCombatAndExtraCombats(ctx: GameContext): GameGen<void> {
  setPhase(ctx, 'combat', null);
  queueStepTriggers(ctx, 'beginningOfCombat');
  yield* runCombatPhase(ctx);
  while (ctx.state.extraCombatPhases > 0) {
    ctx.state.extraCombatPhases -= 1;
    queueStepTriggers(ctx, 'beginningOfCombat');
    yield* runCombatPhase(ctx);
  }
}

/** The normal turn opening through the first main-phase priority window. */
export function* runBeginningAndPrecombatMain(ctx: GameContext): GameGen<void> {
  const s = ctx.state;
  const ap = playerById(ctx, s.currentTurnPlayer);
  emit(ctx, 'turnBegin', { turn: s.turnNumber, player: ap.id }, ap.id);
  debug(ctx, 'turn', `--- turn ${s.turnNumber}: ${ap.id} ---`);

  // Beginning phase.
  queueStepTriggers(ctx, 'untapStep');
  untapStep(ctx);

  if (ctx.state.createdTokenThisTurn) {
    for (const player of ctx.state.players) ctx.state.createdTokenThisTurn[player.id] = false;
  }
  setStep(ctx, 'upkeep');
  queueStepTriggers(ctx, 'upkeep');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  setStep(ctx, 'draw');
  // Reset before the turn-based draw, so the active player's own draw is the FIRST one counted
  // in their draw step. Only the active player has a draw step, so the others' counters are
  // reset here purely to keep the field meaningless rather than stale for them.
  for (const player of ctx.state.players) player.cardsDrawnThisDrawStep = 0;
  queueStepTriggers(ctx, 'drawStep');
  yield* drawCards(ctx, ap, 1); // multiplayer: first-turn draw included (brief §5.3)
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  // Precombat main.
  ctx.state.mainPhasesStartedThisTurn = 1;
  setPhase(ctx, 'precombatMain', null);
  queueStepTriggers(ctx, 'mainPhase');
  // "your first main phase" is the precombat one specifically, so it gets its own event
  // alongside the both-mains `mainPhase` above rather than replacing it.
  queueStepTriggers(ctx, 'precombatMain');
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

}

export function* runTurn(ctx: GameContext): GameGen<void> {
  yield* runBeginningAndPrecombatMain(ctx);

  yield* runCombatAndExtraCombats(ctx);

  // Postcombat main.
  beginPostcombatMain(ctx);
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);

  yield* runEndingPhase(ctx);
}

/** Production end step and cleanup, also used by finite multi-turn viewer scenarios. */
export function* runEndingPhase(ctx: GameContext): GameGen<void> {
  const player = ctx.state.currentTurnPlayer;
  beginEndStep(ctx);
  yield* runPrioritySequence(ctx);
  emptyManaPools(ctx);
  yield* cleanupStep(ctx);
  emit(ctx, 'turnEnd', { turn: ctx.state.turnNumber, player }, player);
}

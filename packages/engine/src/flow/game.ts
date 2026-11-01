/**
 * Top-level game flow (brief §4, §5.1): random starting player, opening hands and
 * mulligans, then turns rotating through surviving players until one remains — or a
 * halt state (draw, turn cap, unmodeled card), which is surfaced, never rerolled.
 */

import type { GameResult, PlayerId } from '@mtg/shared';
import type { GameGen } from '../decisions';
import { emit, debug } from '../log/log';
import { GameConcededSignal, GameOverSignal, TurnAbortedSignal } from '../signals';
import { playerById } from '../state/objects';
import type { GameContext } from '../state/types';
import { runOpeningHands } from '../turn/mulligan';
import { emptyManaPools, runPrioritySequence } from '../turn/priority';
import { priorityCheckpoint } from '../sba/sba';
import type { PreparedScenarioSpec } from '../testing/prepared-scenario';
import {
  beginEndStep,
  beginPostcombatMain,
  cleanupStep,
  expireDepartedPlayerEffects,
  queueStepTriggers,
  runCombatAndExtraCombats,
  runBeginningAndPrecombatMain,
  runTurn,
  runEndingPhase,
} from '../turn/turn';

function advanceToNextTurnPlayer(ctx: GameContext): void {
  const s = ctx.state;
  while ((s.extraTurns?.length ?? 0) > 0) {
    const candidate = s.extraTurns!.shift()!;
    if (s.players.some((player) => player.id === candidate && !player.hasLost)) {
      s.normalTurnResumeAfter ??= s.currentTurnPlayer;
      s.currentTurnPlayer = candidate;
      s.activePlayerIndex = Math.max(0, s.turnOrder.indexOf(candidate));
      return;
    }
  }
  const seating = s.seating;
  let i = seating.indexOf(s.normalTurnResumeAfter ?? s.currentTurnPlayer);
  delete s.normalTurnResumeAfter;
  const skippedPlayers: PlayerId[] = [];
  for (let hops = 0; hops < seating.length; hops++) {
    i = (i + 1) % seating.length;
    const candidate = seating[i] as PlayerId;
    const player = ctx.state.players.find((p) => p.id === candidate);
    if (player?.hasLost === true) skippedPlayers.push(candidate);
    if (player !== undefined && !player.hasLost) {
      for (const record of s.phasedOut ?? []) {
        if (skippedPlayers.includes(record.phaseInPlayerId)) record.phaseInPlayerId = candidate;
      }
      s.currentTurnPlayer = candidate;
      s.activePlayerIndex = Math.max(0, s.turnOrder.indexOf(candidate));
      return;
    }
  }
  throw new Error('engine bug: no surviving player to take a turn');
}

function buildResult(ctx: GameContext, signal: GameOverSignal): GameResult {
  const s = ctx.state;
  const finishingOrder: PlayerId[] = [...s.eliminatedPlayers];
  if (signal.winner !== null) finishingOrder.push(signal.winner);
  return {
    gameId: s.gameId,
    winnerSeat: signal.winner,
    finishingOrder,
    turnCount: s.turnNumber,
    halted: signal.haltReason !== null,
    haltReason: signal.haltReason,
  };
}

/** The complete game as one generator. The `Engine` class pumps it. */
export function* playGame(ctx: GameContext): GameGen<GameResult> {
  const s = ctx.state;
  emit(ctx, 'gameStart', { seed: s.seed, players: s.seating });

  // Starting player is determined at random (CR 103.1) — from the game PRNG (brief §5.9).
  const startIdx = ctx.rng.nextInt(s.turnOrder.length);
  s.activePlayerIndex = startIdx;
  s.currentTurnPlayer = s.turnOrder[startIdx] as PlayerId;
  emit(ctx, 'startingPlayer', { player: s.currentTurnPlayer });
  debug(ctx, 'engine', `starting player: ${s.currentTurnPlayer}`);

  try {
    yield* runOpeningHands(ctx);

    for (;;) {
      if (s.turnNumber >= s.turnCap) {
        throw new GameOverSignal(
          null,
          `turn cap of ${s.turnCap} exceeded — probable engine/rules bug (brief §4)`,
        );
      }
      s.turnNumber += 1;
      try {
        yield* runTurn(ctx);
      } catch (err) {
        if (err instanceof TurnAbortedSignal) {
          // The turn ends without a cleanup step; a departed player's turn may begin after it.
          expireDepartedPlayerEffects(ctx);
          debug(
            ctx,
            'turn',
            `turn ${s.turnNumber} ended early: active player ${s.currentTurnPlayer} left the game`,
          );
        } else {
          throw err;
        }
      }
      advanceToNextTurnPlayer(ctx);
    }
  } catch (err) {
    if (err instanceof GameConcededSignal) {
      // Emitted here, after the unwind, so a cast that was in progress has already rewound
      // through its checkpoint and cannot take this event with it; numbered after every event
      // emitted before the rewind, which may already have been recorded.
      s.nextEventSequence = Math.max(s.nextEventSequence, err.sequenceFloor);
      emit(ctx, 'conceded', { players: [...err.players], reason: err.reason });
      const result: GameResult = {
        gameId: s.gameId,
        winnerSeat: null,
        finishingOrder: [...s.eliminatedPlayers],
        turnCount: s.turnNumber,
        halted: false,
        haltReason: null,
        endReason: err.reason,
      };
      emit(ctx, 'gameOver', {
        winner: null,
        finishingOrder: result.finishingOrder,
        turns: result.turnCount,
        halted: false,
        haltReason: null,
        endReason: err.reason,
      });
      debug(ctx, 'engine', `game ended by agreement: ${err.reason}`);
      return result;
    }
    if (err instanceof GameOverSignal) {
      const result = buildResult(ctx, err);
      emit(ctx, 'gameOver', {
        winner: result.winnerSeat,
        finishingOrder: result.finishingOrder,
        turns: result.turnCount,
        halted: result.halted,
        haltReason: result.haltReason,
      });
      if (result.halted) {
        debug(ctx, 'engine', `GAME HALTED: ${result.haltReason ?? 'unknown'}`);
      }
      return result;
    }
    throw err;
  }
}

/**
 * A finite deterministic lab run from an already arranged priority window. It ends after every
 * player passes with an empty stack; all intervening actions still use production engine paths.
 */
export function* playPreparedScenario(
  ctx: GameContext,
  spec: PreparedScenarioSpec,
): GameGen<GameResult> {
  const state = ctx.state;
  if (
    spec.continueThroughNextTurn === true &&
    (spec.continueThroughCombat !== true ||
      spec.continueToPostcombatMain !== true ||
      spec.continueToEndStep !== true)
  )
    throw new Error(
      'continueThroughNextTurn requires combat, postcombat main, and end-step continuations',
    );
  emit(ctx, 'gameStart', { seed: state.seed, players: state.seating });
  emit(ctx, 'startingPlayer', { player: state.currentTurnPlayer });
  if (
    spec.continueThroughNextTurn === true &&
    (spec.continueToNextUpkeep === true ||
      (spec.continueThroughUpkeeps ?? 0) > 0 ||
      (spec.continueThroughPrecombatMains ?? 0) > 0 ||
      spec.continueThroughNextPrecombatMain === true ||
      spec.continueThroughNextCombat === true)
  )
    throw new Error('prepared scenario must choose one next-turn continuation');
  yield* runPrioritySequence(ctx);
  if (spec.continueThroughCombat === true) {
    emptyManaPools(ctx);
    yield* runCombatAndExtraCombats(ctx);
  }
  // The production phase transitions, so the phase event and every beginning-of-step trigger
  // (the monarch's end-step draw too) match a real turn.
  if (spec.continueToPostcombatMain === true) {
    emptyManaPools(ctx);
    beginPostcombatMain(ctx);
    yield* priorityCheckpoint(ctx);
    yield* runPrioritySequence(ctx);
  }
  if (spec.continueToEndStep === true) {
    emptyManaPools(ctx);
    beginEndStep(ctx);
    yield* priorityCheckpoint(ctx);
    yield* runPrioritySequence(ctx);
  }
  const upkeepCount = spec.continueThroughUpkeeps ?? (spec.continueToNextUpkeep === true ? 1 : 0);
  const mainCount = spec.continueThroughPrecombatMains ?? 0;
  if (!Number.isSafeInteger(mainCount) || mainCount < 0 || mainCount > 8)
    throw new Error('prepared continuation requires zero to eight production turn beginnings');
  if (mainCount > 0) {
    if (
      upkeepCount > 0 ||
      spec.continueThroughNextPrecombatMain === true ||
      spec.continueThroughNextCombat === true
    )
      throw new Error('prepared scenario must choose one next-turn continuation');
    for (let index = 0; index < mainCount; index++) {
      yield* runEndingPhase(ctx);
      emptyManaPools(ctx);
      advanceToNextTurnPlayer(ctx);
      state.turnNumber += 1;
      yield* runBeginningAndPrecombatMain(ctx);
    }
  }
  if (spec.continueThroughNextPrecombatMain === true || spec.continueThroughNextCombat === true) {
    if (upkeepCount > 0)
      throw new Error('prepared scenario must choose one next-turn continuation');
    emptyManaPools(ctx);
    advanceToNextTurnPlayer(ctx);
    state.turnNumber += 1;
    yield* runBeginningAndPrecombatMain(ctx);
    if (spec.continueThroughNextCombat === true) {
      emptyManaPools(ctx);
      yield* runCombatAndExtraCombats(ctx);
    }
  }
  if (!Number.isSafeInteger(upkeepCount) || upkeepCount < 0 || upkeepCount > state.players.length)
    throw new Error('prepared continuation requires zero to one rotation of upkeeps');
  for (let upkeepIndex = 0; upkeepIndex < upkeepCount; upkeepIndex++) {
    emptyManaPools(ctx);
    advanceToNextTurnPlayer(ctx);
    state.turnNumber += 1;
    state.phase = 'beginning';
    state.step = 'upkeep';
    queueStepTriggers(ctx, 'upkeep');
    yield* priorityCheckpoint(ctx);
    yield* runPrioritySequence(ctx);
  }
  if (spec.continueThroughNextTurn === true) {
    // Complete the active turn through the ordinary cleanup routine before advancing. This
    // preserves delayed cleanup effects, turn-based actions and production turn transitions.
    emptyManaPools(ctx);
    yield* cleanupStep(ctx);
    emit(
      ctx,
      'turnEnd',
      { turn: state.turnNumber, player: state.currentTurnPlayer },
      state.currentTurnPlayer,
    );
    advanceToNextTurnPlayer(ctx);
    state.turnNumber += 1;
    yield* runTurn(ctx);
  }
  const result: GameResult = {
    gameId: state.gameId,
    winnerSeat: null,
    finishingOrder: [],
    turnCount: state.turnNumber,
    halted: false,
    haltReason: null,
  };
  emit(ctx, 'gameOver', {
    winner: null,
    finishingOrder: [],
    turns: state.turnNumber,
    halted: false,
    haltReason: null,
  });
  return result;
}

export { playerById };

/**
 * Top-level game flow (brief §4, §5.1): random starting player, opening hands and
 * mulligans, then turns rotating through surviving players until one remains — or a
 * halt state (draw, turn cap, unmodeled card), which is surfaced, never rerolled.
 */

import type { GameResult, PlayerId } from '@mtg/shared';
import type { GameGen } from '../decisions';
import { emit, debug } from '../log/log';
import { GameOverSignal, TurnAbortedSignal } from '../signals';
import { playerById } from '../state/objects';
import type { GameContext } from '../state/types';
import { runOpeningHands } from '../turn/mulligan';
import { emptyManaPools, runPrioritySequence } from '../turn/priority';
import { priorityCheckpoint } from '../sba/sba';
import type { PreparedScenarioSpec } from '../testing/prepared-scenario';
import { queueStepTriggers, runCombatAndExtraCombats, runTurn } from '../turn/turn';

function advanceToNextTurnPlayer(ctx: GameContext): void {
  const s = ctx.state;
  const seating = s.seating;
  let i = seating.indexOf(s.currentTurnPlayer);
  for (let hops = 0; hops < seating.length; hops++) {
    i = (i + 1) % seating.length;
    const candidate = seating[i] as PlayerId;
    const player = ctx.state.players.find((p) => p.id === candidate);
    if (player !== undefined && !player.hasLost) {
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
  emit(ctx, 'gameStart', { seed: state.seed, players: state.seating });
  emit(ctx, 'startingPlayer', { player: state.currentTurnPlayer });
  yield* runPrioritySequence(ctx);
  if (spec.continueThroughCombat === true) {
    emptyManaPools(ctx);
    yield* runCombatAndExtraCombats(ctx);
  }
  if (spec.continueToPostcombatMain === true) {
    emptyManaPools(ctx);
    state.phase = 'postcombatMain';
    state.step = null;
    queueStepTriggers(ctx, 'mainPhase');
    yield* priorityCheckpoint(ctx);
    yield* runPrioritySequence(ctx);
  }
  if (spec.continueToEndStep === true) {
    emptyManaPools(ctx);
    state.phase = 'ending';
    state.step = 'end';
    queueStepTriggers(ctx, 'endStep');
    yield* priorityCheckpoint(ctx);
    yield* runPrioritySequence(ctx);
  }
  if (spec.continueToNextUpkeep === true) {
    advanceToNextTurnPlayer(ctx);
    state.turnNumber += 1;
    state.phase = 'beginning';
    state.step = 'upkeep';
    queueStepTriggers(ctx, 'upkeep');
    yield* priorityCheckpoint(ctx);
    yield* runPrioritySequence(ctx);
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

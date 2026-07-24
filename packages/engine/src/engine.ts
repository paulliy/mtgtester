/**
 * The `Engine` driver (brief §5.1): a thin pump over the `playGame` generator.
 *
 *   engine.advance() → { decision } → obtain a choice → engine.submit() → repeat
 *
 * Forced decisions — exactly one legal option with no real target choice — are resolved
 * internally and never surfaced (brief §5.1): no AI call is ever needed for them.
 * `submit` validates the response against the offered menu and throws
 * `IllegalDecisionError` (state unchanged) for anything not on it (brief §7.7).
 */

import type {
  DecisionRequest,
  DecisionResponse,
  EngineStep,
  GameResult,
  GameState,
  LegalAction,
  ObjectId,
  PlayerView,
} from '@mtg/shared';
import type { DecisionOutcome, GameGen, PendingDecision } from './decisions';
import { forcedOutcome, isForced } from './decisions';
import { EngineUsageError, IllegalDecisionError, UnmodeledCardError } from './errors';
import { playGame } from './flow/game';
import { debug, emit } from './log/log';
import { createGame } from './state/game';
import type { DebugEntry, GameConfig, GameContext } from './state/types';
import { buildPlayerView } from './view/view';

export interface EngineDriver {
  advance(): EngineStep;
  submit(decision: DecisionResponse): void;
}

export class Engine implements EngineDriver {
  private readonly ctx: GameContext;
  private readonly gen: GameGen<GameResult>;
  private started = false;
  private nextOutcome: DecisionOutcome | null = null;
  private pendingDecision: PendingDecision | null = null;
  private pendingRequest: DecisionRequest | null = null;
  private finished: GameResult | null = null;

  constructor(config: GameConfig) {
    this.ctx = createGame(config);
    this.gen = playGame(this.ctx);
  }

  advance(): EngineStep {
    if (this.finished !== null) return { kind: 'gameOver', result: this.finished };
    if (this.pendingRequest !== null) {
      return { kind: 'decision', request: this.pendingRequest };
    }

    try {
      for (;;) {
        const step =
          this.started && this.nextOutcome !== null
            ? this.gen.next(this.nextOutcome)
            : this.gen.next();
        this.started = true;
        this.nextOutcome = null;

        if (step.done === true) {
          this.finished = step.value;
          return { kind: 'gameOver', result: this.finished };
        }

        const decision = step.value;
        if (isForced(decision)) {
          // Single legal option — the engine resolves it itself (brief §5.1).
          debug(
            this.ctx,
            'decision',
            `auto-resolved for ${decision.player}: ${decision.options[0]?.description ?? ''}`,
            {
              decisionType: decision.decisionType,
            },
          );
          this.nextOutcome = forcedOutcome(decision);
          continue;
        }

        this.pendingDecision = decision;
        this.pendingRequest = this.buildRequest(decision);
        debug(
          this.ctx,
          'decision',
          `decision surfaced: ${this.pendingRequest.requestId} for ${decision.player}`,
          {
            decisionType: decision.decisionType,
            options: decision.options.map((o) => o.description),
          },
        );
        return { kind: 'decision', request: this.pendingRequest };
      }
    } catch (err) {
      if (err instanceof UnmodeledCardError) {
        // Halt loudly, never guess (brief §6.3).
        emit(this.ctx, 'engineHalt', { reason: err.message, card: err.cardName });
        debug(this.ctx, 'engine', `ENGINE HALT: ${err.message}`);
        this.finished = {
          gameId: this.ctx.state.gameId,
          winnerSeat: null,
          finishingOrder: [...this.ctx.state.eliminatedPlayers],
          turnCount: this.ctx.state.turnNumber,
          halted: true,
          haltReason: err.message,
        };
        return { kind: 'gameOver', result: this.finished };
      }
      throw err;
    }
  }

  submit(response: DecisionResponse): void {
    if (this.pendingRequest === null || this.pendingDecision === null) {
      throw new EngineUsageError('submit() called without a pending decision');
    }
    const request = this.pendingRequest;
    if (response.requestId !== request.requestId) {
      throw new IllegalDecisionError(
        `response is for ${response.requestId}, expected ${request.requestId}`,
      );
    }
    const action = request.legalActions.find((a) => a.id === response.actionId);
    if (action === undefined) {
      throw new IllegalDecisionError(
        `actionId ${response.actionId} is not on the legal action menu (0–${request.legalActions.length - 1})`,
      );
    }

    const targets = new Map<number, ObjectId>();
    for (const slot of action.targets ?? []) {
      const choice = (response.targets ?? []).find((t) => t.slot === slot.slot)?.choice;
      if (choice === undefined) {
        if (slot.options.length === 1) {
          targets.set(slot.slot, slot.options[0] as ObjectId);
          continue;
        }
        throw new IllegalDecisionError(`missing target choice for slot ${slot.slot}`);
      }
      if (!slot.options.includes(choice)) {
        throw new IllegalDecisionError(
          `target ${choice} is not a legal choice for slot ${slot.slot}`,
        );
      }
      targets.set(slot.slot, choice);
    }

    // Record the surfaced decision in the replay log (brief §4 — a game can be replayed
    // exactly from the log; forced decisions replay deterministically on their own).
    emit(
      this.ctx,
      'decision',
      {
        requestId: request.requestId,
        decisionType: request.decisionType,
        actionId: action.id,
        description: action.description,
        targets: [...targets.entries()].map(([slot, choice]) => ({ slot, choice })),
      },
      request.decidingPlayer,
    );

    this.nextOutcome = { index: action.id, targets };
    this.pendingDecision = null;
    this.pendingRequest = null;
  }

  /** The authoritative game state. NEVER hand this to an AI — use `view()` (brief §7.1). */
  getState(): GameState {
    return this.ctx.state;
  }

  /** The hidden-information-safe projection for one player (brief §7.1). */
  view(playerId: string): PlayerView {
    return buildPlayerView(this.ctx, playerId);
  }

  getDebugLog(): readonly DebugEntry[] {
    return this.ctx.debugLog;
  }

  getResult(): GameResult | null {
    return this.finished;
  }

  private buildRequest(decision: PendingDecision): DecisionRequest {
    const s = this.ctx.state;
    const legalActions: LegalAction[] = decision.options.map((opt, i) => {
      const action: LegalAction = { id: i, type: opt.type, description: opt.description };
      if (opt.targets !== undefined && opt.targets.length > 0) action.targets = opt.targets;
      return action;
    });
    return {
      requestId: `${s.gameId}-t${s.turnNumber}-d${s.nextDecisionNum++}`,
      gameId: s.gameId,
      turn: s.turnNumber,
      activePlayer: s.currentTurnPlayer,
      decidingPlayer: decision.player,
      phase: s.phase,
      step: s.step,
      decisionType: decision.decisionType,
      prompt: decision.prompt,
      legalActions,
    };
  }
}

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
  ActionInteraction,
  ActionPresentation,
  DecisionPresentation,
  DecisionRequest,
  DecisionResponse,
  EngineStep,
  GameEvent,
  GameResult,
  GameState,
  LegalAction,
  ObjectId,
  PlayerView,
  SpectatorState,
} from '@mtg/shared';
import { describeDamageSplit } from './combat/combat';
import type { DecisionOutcome, GameGen, PendingDecision } from './decisions';
import { forcedOutcome, isForced } from './decisions';
import {
  EngineBudgetError,
  EngineInvariantError,
  EngineUsageError,
  IllegalDecisionError,
  UnmodeledCardError,
} from './errors';
import { playGame, playPreparedScenario } from './flow/game';
import { GameConcededSignal } from './signals';
import { debug, emit, settleSpectatorSnapshot } from './log/log';
import { createGame } from './state/game';
import type { DebugEntry, GameConfig, GameContext } from './state/types';
import type { PreparedScenarioSpec } from './testing/prepared-scenario';
import { prepareScenario } from './testing/prepared-scenario';
import { buildSpectatorState } from './view/spectator';
import { buildPlayerBoardState } from './view/spectator';
import { buildPlayerView } from './view/view';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Ensure every surfaced option has a typed affordance, even uncommon card-specific choices.
 * Exported for tests: it is the single source of truth for whether the web UI can actually
 * reach an option (see `human-ui-reachability.test.ts`), so a reachability check that
 * re-implemented this logic instead of calling it could drift from what ships.
 */
export function interactionFor(option: PendingDecision['options'][number]): ActionInteraction {
  if (option.interaction !== undefined) return option.interaction;
  const payload = asRecord(option.payload);
  const sourceId = payload?.['objectId'];
  const targetSlots = option.targets;

  if (
    [
      'pass',
      'passAndYieldTurn',
      'yieldToAbility',
      'keep',
      'mulligan',
      'acceptTrigger',
      'decline',
      'declineTrigger',
      'companionToHand',
      'commanderToCommandZone',
      'findNothing',
      'keepMoving',
      'payCost',
      'payLife',
      'scryBottom',
      'scryKeep',
      'noAttackRest',
      'noBlockRest',
    ].includes(option.type)
  ) {
    return { kind: 'immediate' };
  }
  if (
    typeof sourceId === 'string' &&
    ['playLand', 'castSpell', 'activateAbility'].includes(option.type)
  ) {
    const sourceCardId = payload?.['cardId'];
    const abilityIndex = payload?.['index'];
    return {
      kind: 'source',
      sourceId,
      ...(typeof sourceCardId === 'string' ? { sourceCardId } : {}),
      ...(typeof abilityIndex === 'number' ? { abilityIndex } : {}),
      ...(targetSlots !== undefined && targetSlots.length > 0 ? { targetSlots } : {}),
    };
  }
  return {
    kind: 'choice',
    ...(typeof option.payload === 'string' ? { subjectId: option.payload } : {}),
    ...(targetSlots !== undefined && targetSlots.length > 0 ? { targetSlots } : {}),
  };
}

export interface EngineDriver {
  advance(): EngineStep;
  submit(decision: DecisionResponse): void;
  addDebug(category: DebugEntry['category'], message: string, data?: Record<string, unknown>): void;
}

export interface EngineOptions {
  /** Closed server/test fixture initialization; never populated from arbitrary client state. */
  preparedScenario?: PreparedScenarioSpec;
  /**
   * Events one `advance()` may emit before the game halts (ADR 0031 decision 9), which catches a
   * runaway inside a single generator step. Unlimited when absent, as for every tester game; set
   * for tables and stored with the game.
   */
  maxStepWork?: number;
  /** Objects the whole game may create before it halts. Unlimited when absent. */
  maxObjects?: number;
}

export class Engine implements EngineDriver {
  private readonly ctx: GameContext;
  private readonly gen: GameGen<GameResult>;
  private started = false;
  private nextOutcome: DecisionOutcome | null = null;
  private pendingDecision: PendingDecision | null = null;
  private pendingRequest: DecisionRequest | null = null;
  private finished: GameResult | null = null;
  private debugCursor = 0;

  constructor(config: GameConfig, options: EngineOptions = {}) {
    this.ctx = createGame(config);
    if (options.maxStepWork !== undefined || options.maxObjects !== undefined) {
      this.ctx.budget = {
        ...(options.maxStepWork !== undefined && { maxStepWork: options.maxStepWork }),
        ...(options.maxObjects !== undefined && { maxObjects: options.maxObjects }),
        stepWork: { count: 0 },
        objectsAtStart: this.ctx.state.nextObjectNum,
      };
    }
    if (options.preparedScenario !== undefined) {
      prepareScenario(this.ctx, options.preparedScenario);
      this.gen = playPreparedScenario(this.ctx, options.preparedScenario);
    } else {
      this.gen = playGame(this.ctx);
    }
  }

  advance(): EngineStep {
    if (this.finished !== null) return { kind: 'gameOver', result: this.finished };
    if (this.pendingRequest !== null) {
      return { kind: 'decision', request: this.pendingRequest };
    }

    if (this.ctx.budget !== undefined) this.ctx.budget.stepWork.count = 0;
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
      if (err instanceof EngineBudgetError) {
        // A work limit, not a rules outcome: halt with the limit named (ADR 0031 decision 9).
        emit(this.ctx, 'engineHalt', { reason: err.message, budget: err.budget });
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
      if (err instanceof EngineInvariantError && this.ctx.strictInvariants !== true) {
        // An authoring or engine bug: halt with the site so the record names it (ADR 0034).
        emit(this.ctx, 'engineHalt', { reason: err.message, site: err.site });
        debug(this.ctx, 'engine', `ENGINE HALT: ${err.message}`);
        this.finished = {
          gameId: this.ctx.state.gameId,
          winnerSeat: null,
          finishingOrder: [...this.ctx.state.eliminatedPlayers],
          turnCount: this.ctx.state.turnNumber,
          halted: true,
          haltReason: err.message,
          haltSite: err.site,
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
        ...(action.type === 'castFree' ? { actionType: 'castFree' } : {}),
        // A combat-damage division is answered by its split, not by the preset option the
        // `actionId` names ("All 3 damage to …"); describe what was actually submitted.
        description:
          request.combatDamageSplit !== undefined && response.combatDamageSplit !== undefined
            ? describeDamageSplit(
                this.ctx,
                request.combatDamageSplit.amount,
                response.combatDamageSplit,
              )
            : action.description,
        // What other players see of a hidden-information action (a face-down cast names its
        // card only to its caster): `formatPlayerLog` shows this to them instead.
        ...(typeof action.data?.['publicDescription'] === 'string'
          ? { publicDescription: action.data['publicDescription'] }
          : {}),
        targets: [...targets.entries()].map(([slot, choice]) => ({ slot, choice })),
        // Preserve the exact wire response as submitted. The targets field above is the
        // normalized engine outcome (including forced single-option slots); replay needs both.
        submittedResponse: {
          requestId: response.requestId,
          actionId: response.actionId,
          ...(response.targets !== undefined ? { targets: response.targets } : {}),
          ...(response.modes !== undefined ? { modes: response.modes } : {}),
          ...(response.xValue !== undefined ? { xValue: response.xValue } : {}),
          ...(response.manaSplit !== undefined ? { manaSplit: response.manaSplit } : {}),
          ...(response.combatDamageSplit !== undefined
            ? { combatDamageSplit: response.combatDamageSplit }
            : {}),
          ...(response.order !== undefined ? { order: response.order } : {}),
          ...(response.plannedActions !== undefined
            ? { plannedActions: response.plannedActions }
            : {}),
          ...(response.turnStrategy !== undefined ? { turnStrategy: response.turnStrategy } : {}),
          ...(response.note !== undefined ? { note: response.note } : {}),
        },
      },
      request.decidingPlayer,
    );

    this.nextOutcome = {
      index: action.id,
      targets,
      ...(response.manaSplit !== undefined ? { manaSplit: response.manaSplit } : {}),
      ...(response.combatDamageSplit !== undefined
        ? { combatDamageSplit: response.combatDamageSplit }
        : {}),
    };
    this.pendingDecision = null;
    this.pendingRequest = null;
  }

  /** The authoritative game state. NEVER hand this to an AI — use `view()` (brief §7.1). */
  getState(): GameState {
    return this.ctx.state;
  }

  /**
   * Cancel an active "pass and yield until end of turn" out-of-band — the player wants a
   * priority window back without waiting for a stop-list event to trigger it (brief —
   * player-experience overhaul, Workstream 2). Returns whether anything changed, so the caller
   * knows whether the yield banner and board need republishing.
   */
  /**
   * Offer `playerId` their mana abilities as priority actions from now on (ADR 0030). For an
   * engine built elsewhere (a Card Test Lab scenario); a fresh game sets it in its config.
   */
  enableManualMana(playerId: string): void {
    const player = this.ctx.state.players.find((p) => p.id === playerId);
    if (player !== undefined) player.manualMana = true;
  }

  /**
   * End the game by agreement (ADR 0031 decision 10): a table's time limit, or every human seat
   * gone. Only between steps, while a decision waits; the waiting decision is withdrawn and never
   * answered. The game generator unwinds from where it stands (a cast in progress rewinds
   * through its checkpoint), then records `conceded` and a draw for the players still in it.
   * Returns false when the game has already ended. Like `cancelYield`, the event is a replay
   * input: a replay applies it when the engine reaches its sequence.
   */
  concede(players: readonly string[], reason: 'timeLimit' | 'allAway'): boolean {
    if (this.finished !== null) return false;
    if (!this.started || this.pendingRequest === null) {
      throw new EngineUsageError('concede() needs a game waiting on a decision');
    }
    this.pendingDecision = null;
    this.pendingRequest = null;
    this.nextOutcome = null;
    const floor = this.ctx.state.nextEventSequence;
    const step = this.gen.throw(new GameConcededSignal(players, reason, floor));
    if (step.done !== true) {
      throw new EngineInvariantError(
        'engine.concede',
        'a conceded game kept running past the concession',
      );
    }
    this.finished = step.value;
    return true;
  }

  cancelYield(playerId: string): boolean {
    const player = this.ctx.state.players.find((p) => p.id === playerId);
    if (player === undefined || player.yieldUntilEndOfTurn !== true) return false;
    player.yieldUntilEndOfTurn = false;
    // The change is an input like a decision, so it is logged for replay (ADR 0031 decision 8).
    // Only a human seat cancels a yield, so games without one keep identical event streams.
    emit(this.ctx, 'yieldCancelled', { player: player.id }, player.id);
    return true;
  }

  /**
   * Hand over the board states recorded for each spectator log line since the last call, and
   * clear them from the game state.
   *
   * Draining rather than exposing the map is deliberate: these exist for the playback UI, they
   * are the largest thing the engine accumulates, and the server (which knows how far back the
   * viewer may seek) is the right owner of that retention policy.
   */
  drainSpectatorSnapshots(): Map<number, SpectatorState> {
    settleSpectatorSnapshot(this.ctx);
    const snapshots = this.ctx.state.sequenceSnapshots;
    if (snapshots === undefined || snapshots.size === 0) return new Map();
    this.ctx.state.sequenceSnapshots = new Map();
    return snapshots;
  }

  /** The hidden-information-safe projection for one player (brief §7.1). */
  view(playerId: string): PlayerView {
    return buildPlayerView(this.ctx, playerId);
  }

  /**
   * The spectator projection (brief §10.2). Unlike `view()` this hides nothing for anti-cheat
   * reasons — the human is watching, not playing — but it is still a projection, so the UI
   * never has to re-derive a rule the engine is authoritative on.
   */
  spectatorState(): SpectatorState {
    return buildSpectatorState(this.ctx);
  }

  /** Hidden-information-safe board projection for an interactive human seat. */
  playerState(playerId: string): import('@mtg/shared').PlayerBoardState {
    return buildPlayerBoardState(this.ctx, playerId);
  }

  /**
   * Events appended since `sequence`, for incremental log streaming. `GameEvent.sequence` is
   * monotonic per game, so the caller tracks one number rather than a cursor object.
   */
  eventsSince(sequence: number): GameEvent[] {
    const events = this.ctx.state.eventLog;
    let low = 0;
    let high = events.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (events[mid]!.sequence < sequence) low = mid + 1;
      else high = mid;
    }
    return events.slice(low);
  }

  getDebugLog(): readonly DebugEntry[] {
    return this.ctx.debugLog;
  }

  /** Drain newly-added internal diagnostics without exposing the mutable engine context. */
  drainDebugLog(): DebugEntry[] {
    const entries = this.ctx.debugLog.slice(this.debugCursor);
    this.debugCursor = this.ctx.debugLog.length;
    return entries;
  }

  addDebug(
    category: DebugEntry['category'],
    message: string,
    data?: Record<string, unknown>,
  ): void {
    debug(this.ctx, category, message, data);
  }

  getResult(): GameResult | null {
    return this.finished;
  }

  private buildRequest(decision: PendingDecision): DecisionRequest {
    const s = this.ctx.state;
    const presentedActions: Record<number, ActionPresentation> = {};
    const legalActions: LegalAction[] = decision.options.map((opt, i) => {
      const action: LegalAction = {
        id: i,
        type: opt.type,
        description: opt.description,
        interaction: interactionFor(opt),
      };
      if (opt.targets !== undefined && opt.targets.length > 0) action.targets = opt.targets;
      if (opt.data !== undefined) action.data = opt.data;
      if (opt.presentation !== undefined) presentedActions[i] = opt.presentation;
      return action;
    });

    const hasPresentation =
      decision.presentationSource !== undefined ||
      decision.presentationAttackDeclaration !== undefined ||
      decision.presentationBlockDeclaration !== undefined ||
      Object.keys(presentedActions).length > 0;
    const presentation: DecisionPresentation | undefined = hasPresentation
      ? {
          layout:
            decision.presentationAttackDeclaration !== undefined
              ? 'attackDeclaration'
              : decision.presentationBlockDeclaration !== undefined
                ? 'blockDeclaration'
                : Object.values(presentedActions).some((a) => a.subjects[0]?.kind === 'card')
                  ? 'cards'
                  : 'choices',
          ...(decision.presentationSource !== undefined
            ? { source: decision.presentationSource }
            : {}),
          ...(Object.keys(presentedActions).length > 0 ? { actions: presentedActions } : {}),
          ...(decision.presentationAttackDeclaration !== undefined
            ? { attackDeclaration: decision.presentationAttackDeclaration }
            : {}),
          ...(decision.presentationBlockDeclaration !== undefined
            ? { blockDeclaration: decision.presentationBlockDeclaration }
            : {}),
        }
      : undefined;

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
      ...(decision.manaSplit !== undefined ? { manaSplit: decision.manaSplit } : {}),
      ...(decision.combatDamageSplit !== undefined
        ? { combatDamageSplit: decision.combatDamageSplit }
        : {}),
      ...(presentation !== undefined ? { presentation } : {}),
    };
  }
}

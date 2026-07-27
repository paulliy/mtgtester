/**
 * `MatchRunner` — the incremental driver behind the playback model (brief §10.1).
 *
 * `runToCompletion`/`runToCompletionAsync` in the engine are blocking loops that return only a
 * finished `GameResult`; there is no point at which the caller regains control to ask "is the
 * viewer still five turns behind?" or "should I stop here?". This class drives
 * `engine.advance()` / `engine.submit()` itself so both questions can be answered between
 * every decision. See ADR 0012 §1.
 *
 * Two invariants it exists to enforce:
 *
 *   - **Compute-ahead cap.** Never compute past `viewTurn + lookaheadTurns`. This is an API
 *     cost guard, not a nicety: each turn beyond the viewer is real money.
 *   - **Hold-and-wait.** On any problematic state — an unmodeled card, an AI response that
 *     survived its retry, an engine error, a draw — stop immediately and compute nothing
 *     further (brief §7.7, §10.1). Nothing ambiguous is ever resolved without the user present.
 */

import type { AsyncDecisionProvider, Engine } from '@mtg/engine';
import { formatSpectatorLog } from '@mtg/engine';
import type {
  DecisionRequest,
  DecisionResponse,
  GameResult,
  HaltKind,
  PlayerId,
  SpectatorLogLine,
  SpectatorState,
  TargetChoice,
} from '@mtg/shared';
import type { GameRecorder, GameSeatRecord, GameStatus } from '../db/games';

/** Turns the engine may compute beyond the viewer's position (brief §10.1). */
export const LOOKAHEAD_TURNS = 5;

/** How long the user gets to answer an escalated decision before the fallback (brief §7.7). */
export const ESCALATION_TIMEOUT_MS = 5_000;

/**
 * Yield to the event loop every N engine steps. The engine is synchronous and a random-provider
 * game runs thousands of steps per second, which would starve the WebSocket of the very
 * `jumpToTurn` messages that let compute continue.
 */
const YIELD_EVERY_STEPS = 200;

export type MatchStatus =
  | 'idle'
  | 'running'
  /** Parked at the compute-ahead cap; resumes when the viewer moves forward. */
  | 'waitingForView'
  /** Escalated a decision to the human and is waiting for their pick (brief §7.7 step 2). */
  | 'awaitingHuman'
  | 'halted'
  | 'finished'
  | 'abandoned';

/** Thrown to stop compute-ahead dead rather than resolve something unsupervised (brief §7.7). */
export class ComputeHaltError extends Error {
  constructor(
    readonly kind: HaltKind,
    message: string,
    readonly cardName?: string,
  ) {
    super(message);
    this.name = 'ComputeHaltError';
  }
}

export interface HaltInfo {
  kind: HaltKind;
  reason: string;
  turn: number;
  cardName?: string;
}

/**
 * The §7.7 step-2 seam. `OpenAiDecisionProvider` calls this when the model failed twice;
 * returning `null` restores the safest-fallback behaviour, and throwing `ComputeHaltError`
 * stops the match.
 */
export interface DecisionEscalation {
  onModelFailed(request: DecisionRequest, detail: string): Promise<DecisionResponse | null>;
}

export interface MatchRunnerHooks {
  /** New spectator log lines, with the advancing compute frontier. */
  onEvents?(lines: SpectatorLogLine[], frontierTurn: number, snapshotTurns: number[]): void;
  onSnapshot?(turn: number, state: SpectatorState, atFrontier: boolean): void;
  onHalt?(info: HaltInfo): void;
  onGameOver?(result: GameResult): void;
  onDecisionPending?(request: DecisionRequest, invalidResponse: string, timeoutMs: number): void;
  onStatusChange?(status: MatchStatus): void;
  /** Fires after every submitted decision — the hook the AI cost counters ride on. */
  onDecision?(request: DecisionRequest, response: DecisionResponse): void;
}

export interface MatchRunnerOptions extends MatchRunnerHooks {
  engine: Engine;
  gameId: string;
  seed: string;
  seats: readonly GameSeatRecord[];
  providerFor: (playerId: PlayerId) => AsyncDecisionProvider;
  recorder?: GameRecorder | null;
  lookaheadTurns?: number;
  maxDecisions?: number;
  escalationTimeoutMs?: number;
}

/** Classify a halt reason string the engine produced into a protocol `HaltKind`. */
function classifyHalt(reason: string | null): HaltKind {
  if (reason === null) return 'engineError';
  if (/turn cap|exceeded \d+ turns/i.test(reason)) return 'turnCap';
  if (/cannot model|unmodeled|unsupported/i.test(reason)) return 'unmodeledCard';
  return 'engineError';
}

export class MatchRunner {
  private status: MatchStatus = 'idle';
  /**
   * Read through a method, not a direct `this.status === 'abandoned'` comparison.
   *
   * TypeScript's control-flow analysis narrows `this.status` at the first such check in a method
   * and — unsoundly — keeps that narrowing across `await`. Every later re-check inside the pump
   * loop then looks like a comparison against a type that has already been excluded. Those
   * re-checks are the point: `abandon()` can run while the loop is suspended.
   */
  private isAbandoned(): boolean {
    return this.status === 'abandoned';
  }
  /** The turn the human is currently looking at. Compute never passes this + lookahead. */
  private viewTurn = 0;
  /** Furthest turn computed. */
  private frontierTurn = 0;
  /** Cursor into `GameEvent.sequence` — everything below this has been flushed. */
  private eventCursor = 0;
  private lastSnapshotTurn = -1;
  private readonly snapshotTurnList: number[] = [];
  private readonly snapshots = new Map<number, SpectatorState>();
  private readonly sequenceSnapshots = new Map<number, SpectatorState>();
  private result: GameResult | null = null;
  private halt: HaltInfo | null = null;
  private decisions = 0;

  /** Resolves when something the compute gate cares about changes. */
  private wakeup: (() => void) | null = null;
  /** The escalation currently awaiting a human pick, if any (brief §7.7 step 2). */
  private heldDecision: {
    requestId: string;
    resolve: (response: DecisionResponse | null) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private readonly lookaheadTurns: number;
  private readonly escalationTimeoutMs: number;

  constructor(private readonly opts: MatchRunnerOptions) {
    this.lookaheadTurns = opts.lookaheadTurns ?? LOOKAHEAD_TURNS;
    this.escalationTimeoutMs = opts.escalationTimeoutMs ?? ESCALATION_TIMEOUT_MS;
  }

  // ── Public surface ────────────────────────────────────────────────────────────────────────

  getStatus(): MatchStatus {
    return this.status;
  }

  getFrontierTurn(): number {
    return this.frontierTurn;
  }

  getViewTurn(): number {
    return this.viewTurn;
  }

  getResult(): GameResult | null {
    return this.result;
  }

  getHalt(): HaltInfo | null {
    return this.halt;
  }

  getSnapshotTurns(): number[] {
    return [...this.snapshotTurnList];
  }

  /**
   * The board at an already-computed turn (or specific action sequence). Scrubbing backward is
   * always allowed; scrubbing *forward* past the frontier is not.
   */
  stateAt(turn: number, sequence?: number): SpectatorState | null {
    if (sequence !== undefined && this.sequenceSnapshots.has(sequence)) {
      return this.sequenceSnapshots.get(sequence)!;
    }
    return this.snapshots.get(turn) ?? this.opts.recorder?.loadTurnSnapshot(turn) ?? null;
  }

  /**
   * Move the viewer. Raising it past the current cap is what un-parks a `waitingForView`
   * match; that is the entire "jump-ahead" mode (brief §10.1), which needs no separate path.
   */
  setViewTurn(turn: number): void {
    this.viewTurn = Math.max(0, turn);
    this.wake();
  }

  /** The human's answer to an escalated decision (brief §7.7 step 2). */
  resolveHeldDecision(requestId: string, actionId: number, targets?: TargetChoice[]): boolean {
    const held = this.heldDecision;
    if (held === null || held.requestId !== requestId) return false;
    clearTimeout(held.timer);
    this.heldDecision = null;
    const response: DecisionResponse = { requestId, actionId };
    if (targets !== undefined && targets.length > 0) response.targets = targets;
    held.resolve(response);
    return true;
  }

  abandon(): void {
    if (this.status === 'finished' || this.status === 'halted') return;
    this.setStatus('abandoned');
    this.opts.recorder?.markStatus('abandoned');
    if (this.heldDecision !== null) {
      clearTimeout(this.heldDecision.timer);
      this.heldDecision.resolve(null);
      this.heldDecision = null;
    }
    this.wake();
  }

  /**
   * The escalation hook to hand to `OpenAiDecisionProvider`. Whether the human is consulted at
   * all turns on one question: is the viewer watching *this* decision, or is this compute-ahead
   * running past them? Brief §7.7 is explicit that the second case must never be resolved
   * unsupervised, so it halts instead of falling back.
   */
  escalation(): DecisionEscalation {
    return {
      onModelFailed: async (request, detail) => {
        if (this.viewTurn < this.frontierTurn) {
          console.warn(
            `  ⚠ Compute-ahead AI error for ${request.decidingPlayer}: ${detail} — using safest legal action fallback to keep sim going`,
          );
          return null;
        }
        return await this.askHuman(request, detail);
      },
    };
  }

  /** Drive the game. Resolves when the match finishes, halts, or is abandoned. */
  async run(): Promise<void> {
    if (this.status !== 'idle') return;
    this.setStatus('running');
    this.opts.recorder?.start(this.opts.seed, this.opts.seats);
    this.captureSnapshot();
    this.flushEvents();

    try {
      await this.loop();
    } catch (err) {
      this.recordHalt(
        err instanceof ComputeHaltError
          ? { kind: err.kind, reason: err.message, turn: this.frontierTurn, ...(err.cardName !== undefined && { cardName: err.cardName }) }
          : {
              kind: 'engineError',
              reason: err instanceof Error ? err.message : String(err),
              turn: this.frontierTurn,
            },
      );
    }
  }

  // ── The pump ──────────────────────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    const maxDecisions = this.opts.maxDecisions ?? 100_000;
    let stepsSinceYield = 0;

    for (;;) {
      if (this.isAbandoned()) return;

      await this.awaitComputeBudget();
      if (this.isAbandoned()) return;

      const step = this.opts.engine.advance();

      if (step.kind === 'gameOver') {
        this.onTurnAdvanced();
        this.flushEvents();
        this.finish(step.result);
        return;
      }

      if (step.kind === 'continue') {
        if (++stepsSinceYield >= YIELD_EVERY_STEPS) {
          stepsSinceYield = 0;
          await yieldToEventLoop();
        }
        continue;
      }

      if (++this.decisions > maxDecisions) {
        throw new ComputeHaltError(
          'engineError',
          `exceeded ${maxDecisions} surfaced decisions — runaway game?`,
        );
      }

      const request = step.request;
      const response = await this.opts.providerFor(request.decidingPlayer).decide(request);
      if (this.isAbandoned()) return;

      this.opts.engine.submit(response);
      this.opts.onDecision?.(request, response);

      this.onTurnAdvanced();
      this.flushEvents();

      if (++stepsSinceYield >= YIELD_EVERY_STEPS) {
        stepsSinceYield = 0;
        await yieldToEventLoop();
      }
    }
  }

  /**
   * Park while the frontier is more than `lookaheadTurns` past the viewer. Everything that can
   * change the answer — `setViewTurn`, `abandon` — calls `wake()`.
   */
  private async awaitComputeBudget(): Promise<void> {
    while (this.hasComputeBudget() === false && !this.isAbandoned()) {
      this.setStatus('waitingForView');
      await new Promise<void>((resolve) => {
        this.wakeup = resolve;
      });
      this.wakeup = null;
    }
    if (this.status === 'waitingForView') this.setStatus('running');
  }

  private hasComputeBudget(): boolean {
    return this.frontierTurn <= this.viewTurn + this.lookaheadTurns;
  }

  private wake(): void {
    this.wakeup?.();
  }

  // ── Escalation (brief §7.7 step 2) ────────────────────────────────────────────────────────

  private async askHuman(
    request: DecisionRequest,
    detail: string,
  ): Promise<DecisionResponse | null> {
    const previous = this.status;
    this.setStatus('awaitingHuman');
    this.opts.onDecisionPending?.(request, detail, this.escalationTimeoutMs);

    const response = await new Promise<DecisionResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.heldDecision = null;
        resolve(null);
      }, this.escalationTimeoutMs);
      this.heldDecision = { requestId: request.requestId, resolve, timer };
    });

    if (this.status === 'awaitingHuman') this.setStatus(previous === 'idle' ? 'running' : previous);
    return response;
  }

  // ── Bookkeeping ───────────────────────────────────────────────────────────────────────────

  /** Snapshot on every turn boundary — the scrubber's seekable positions (brief §10.1). */
  private onTurnAdvanced(): void {
    const turn = this.opts.engine.getState().turnNumber;
    if (turn <= this.lastSnapshotTurn) return;
    this.frontierTurn = turn;
    this.captureSnapshot();
  }

  private captureSnapshot(): void {
    const state = this.opts.engine.spectatorState();
    const turn = state.turnNumber;
    this.lastSnapshotTurn = turn;
    this.frontierTurn = Math.max(this.frontierTurn, turn);
    this.snapshots.set(turn, state);
    if (!this.snapshotTurnList.includes(turn)) this.snapshotTurnList.push(turn);
    this.opts.recorder?.saveTurnSnapshot(turn, state);
    this.opts.onSnapshot?.(turn, state, true);
  }

  private flushEvents(): void {
    const events = this.opts.engine.eventsSince(this.eventCursor);
    if (events.length === 0) return;

    const engineState = this.opts.engine.getEngineState();
    for (const e of events) {
      const snap = engineState.sequenceSnapshots?.get(e.sequence);
      if (snap !== undefined) {
        this.sequenceSnapshots.set(e.sequence, snap);
      }
    }

    this.eventCursor = (events[events.length - 1]?.sequence ?? this.eventCursor) + 1;
    this.opts.recorder?.appendEvents(events);
    const lines = formatSpectatorLog(events);
    if (lines.length > 0) {
      this.opts.onEvents?.(lines, this.frontierTurn, this.getSnapshotTurns());
    }
  }

  private finish(result: GameResult): void {
    this.result = result;

    if (result.halted) {
      this.recordHalt({
        kind: classifyHalt(result.haltReason),
        reason: result.haltReason ?? 'engine halted',
        turn: result.turnCount,
      });
      return;
    }

    // A game that ends with nobody standing is brief §4's draw: halt loudly as a probable
    // rules bug rather than record it as an outcome.
    if (result.winnerSeat === null) {
      this.recordHalt({
        kind: 'draw',
        reason: 'the game ended with no surviving player — probable rules bug (brief §4)',
        turn: result.turnCount,
      });
      return;
    }

    this.setStatus('finished');
    this.persistOutcome(result, 'finished');
    this.opts.onGameOver?.(result);
  }

  private recordHalt(info: HaltInfo): void {
    this.halt = info;
    this.setStatus('halted');
    // A halt reached without a `GameResult` — an escalation during compute-ahead, an engine
    // throw — still has to close the row; otherwise it reads `running` forever.
    if (this.result !== null) this.persistOutcome(this.result, 'halted');
    else this.opts.recorder?.markStatus('halted');
    this.opts.onHalt?.(info);
  }

  private persistOutcome(result: GameResult, status: GameStatus): void {
    const recorder = this.opts.recorder;
    if (recorder === null || recorder === undefined) return;
    const state = this.opts.engine.getState();
    recorder.finish(
      result,
      status,
      state.players.map((player) => ({
        seat: player.id,
        lossReason: player.lossReason,
        eliminatedOnTurn: player.hasLost ? result.turnCount : null,
        // TODO(phase-5): attributing the killing blow needs the damage events walked back;
        // the stats screen is what consumes it, so it lands with the rest of §9.1.
        eliminatedBySeat: null,
        mulligansTaken: mulligansOf(player),
        openingHandSize: 7,
      })),
    );
  }

  private setStatus(status: MatchStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatusChange?.(status);
  }
}

/** `mulligansTaken` is engine-internal; read it defensively so the shared type stays clean. */
function mulligansOf(player: unknown): number {
  const value = (player as { mulligansTaken?: unknown }).mulligansTaken;
  return typeof value === 'number' ? value : 0;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

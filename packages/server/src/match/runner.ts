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

import type { AsyncDecisionProvider, DebugEntry, Engine } from '@mtg/engine';
import { formatSpectatorLog } from '@mtg/engine';
import type {
  DecisionRequest,
  DecisionResponse,
  GameEvent,
  GameMode,
  GameResult,
  HaltKind,
  LossReason,
  PlayerId,
  SpectatorLogLine,
  SpectatorState,
  TargetChoice,
} from '@mtg/shared';
import { LOOKAHEAD_TURNS } from '@mtg/shared';
import type { GameRecorder, GameSeatRecord, GameStatus, ManaMetricRecord } from '../db/games';

export { LOOKAHEAD_TURNS } from '@mtg/shared';

/**
 * How many per-action board states to keep for seeking. The client keeps the last 4 000 log
 * lines, so anything older than that cannot be clicked anyway; a dropped sequence falls back to
 * its turn snapshot rather than failing the seek.
 */
export const MAX_SEQUENCE_SNAPSHOTS = 4_000;

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
  /** The engine site that raised an invariant halt, with the seed to reproduce it (ADR 0034). */
  site?: string;
  seed?: string;
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
  /**
   * New log lines, with the advancing compute frontier. `seat` names the viewer the lines were
   * formatted for when the runner has `seatEvents`; otherwise there is one stream and it is absent.
   */
  onEvents?(
    lines: SpectatorLogLine[],
    frontierTurn: number,
    snapshotTurns: number[],
    seat?: PlayerId,
  ): void;
  onSnapshot?(turn: number, state: SpectatorState, atFrontier: boolean): void;
  onHalt?(info: HaltInfo): void;
  onGameOver?(result: GameResult): void;
  onDecisionPending?(request: DecisionRequest, invalidResponse: string, timeoutMs: number): void;
  onStatusChange?(status: MatchStatus): void;
  /**
   * Fires after every submitted decision — the hook the AI cost counters ride on.
   *
   * `anchorSequence` is where this decision's events begin: it fires after `engine.submit()` but
   * before `flushEvents()`, so the cursor has not yet moved past what the submit just produced.
   * Nothing before it belongs to this decision, and it is the exact first sequence for every
   * decision after the opening one — at the very start the cursor still sits at its initial 0
   * while engine sequences begin at 1. ADR 0022's annotations snap forward to the first visible
   * log line at or after it, which resolves that one-off gap to the same place.
   */
  onDecision?(request: DecisionRequest, response: DecisionResponse, anchorSequence: number): void;
  /** Newly-created internal diagnostics; persistence happens regardless of this live hook. */
  onDebug?(entries: DebugEntry[]): void;
  /** Fires whenever engine events were flushed, even if none produce a visible log line. */
  onProgress?(frontierTurn: number): void;
  /**
   * Fires once per turn boundary, with the seat about to become active. The seam for an
   * ahead-of-time strategist prefetch: everything between here and that seat's first real
   * decision (end step, untap, upkeep, draw, every other seat's tactical calls) is overlap the
   * synchronous decision path never had before.
   */
  onTurnBoundary?(turn: number, activePlayer: PlayerId): void;
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
  gameMode?: GameMode;
  formatEvents?: (events: readonly GameEvent[]) => SpectatorLogLine[];
  /**
   * One log stream per viewing seat (a table's human seats): `format` is called once per seat per
   * batch, and each seat's lines reach `onEvents` with that seat. Replaces the single stream.
   */
  seatEvents?: {
    seats: readonly PlayerId[];
    format: (events: readonly GameEvent[], seat: PlayerId) => SpectatorLogLine[];
  };
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
  private readonly landsDrawn = new Map<PlayerId, number>();
  private readonly cardsDrawn = new Map<PlayerId, number>();
  private readonly eliminators = new Map<PlayerId, PlayerId>();
  /** The turn each player's `playerEliminated` event fired on — not the game's final turn. */
  private readonly eliminationTurns = new Map<PlayerId, number>();
  private readonly indexedMetricEventSequences = new Set<number>();

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
   * The sequence the next flushed event will carry. An ADR 0022 annotation with no decision of
   * its own — the strategist's turn intent, which lands asynchronously — anchors here, so it
   * appears at the point in the log where it actually started steering play.
   */
  nextSequence(): number {
    return this.eventCursor;
  }

  /**
   * The board at an already-computed turn, or — when a log line's `sequence` is given — the
   * board immediately *after* that action. Scrubbing backward is always allowed; scrubbing
   * forward past the frontier is not.
   *
   * The returned `sequence` is what the caller must report to the client: it is `null` when the
   * per-action state was not retained and the turn snapshot was served instead, and the client
   * needs to know that so it does not highlight a log line the board does not match.
   */
  stateAt(
    turn: number,
    sequence?: number,
  ): { state: SpectatorState; sequence: number | null } | null {
    if (sequence !== undefined) {
      const exact = this.sequenceSnapshots.get(sequence);
      if (exact !== undefined) return { state: exact, sequence };
    }
    const state = this.snapshots.get(turn) ?? this.opts.recorder?.loadTurnSnapshot(turn) ?? null;
    return state === null ? null : { state, sequence: null };
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
    this.opts.recorder?.start(this.opts.seed, this.opts.seats, this.opts.gameMode ?? 'spectator');
    // A prepared-scenario engine (Card Test Lab) starts mid-game: its first snapshot is already
    // past turn 0, so a viewer anchored at turn 0 would park compute before the first decision.
    this.viewTurn = this.opts.engine.getState().turnNumber;
    this.captureSnapshot();
    this.flushEvents();
    this.flushDebug();

    try {
      await this.loop();
    } catch (err) {
      this.recordHalt(
        err instanceof ComputeHaltError
          ? {
              kind: err.kind,
              reason: err.message,
              turn: this.frontierTurn,
              ...(err.cardName !== undefined && { cardName: err.cardName }),
            }
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
        this.flushDebug();
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
      // Bookkeep and flush *before* the provider, not after it. `advance()` has already run this
      // decision's whole forced tail — payments, forced passes, resolutions, draws — and the
      // board it surfaced the request against is settled. Flushing afterwards held those outcome
      // events behind the cursor for as long as the provider took, which on a human seat is
      // indefinitely: the player was asked to act on a board whose log did not explain it.
      // Bookkeeping leads so the frontier, snapshot and mana metrics the flush reports belong to
      // that same settled board rather than to the turn before it.
      this.onTurnAdvanced();
      this.flushEvents();
      this.flushDebug();
      // Those hooks are synchronous and reach the socket, so a disconnect can `abandon()` the
      // match from inside them. The post-await guard below still covers the provider itself.
      if (this.isAbandoned()) return;

      const response = await this.opts.providerFor(request.decidingPlayer).decide(request);
      if (this.isAbandoned()) return;

      this.opts.engine.submit(response);
      // `eventCursor` still points at the first event the submit above produced — `flushEvents()`
      // below is what advances it. That makes this the decision's exact anchor sequence.
      this.opts.onDecision?.(request, response, this.eventCursor);

      this.onTurnAdvanced();
      this.flushEvents();
      this.flushDebug();

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
    const state = this.opts.engine.getState();
    const turn = state.turnNumber;
    if (turn <= this.lastSnapshotTurn) return;
    this.frontierTurn = turn;
    this.captureSnapshot();
    this.captureManaMetrics(turn);
    const activePlayer = state.turnOrder[state.activePlayerIndex];
    if (activePlayer !== undefined) this.opts.onTurnBoundary?.(turn, activePlayer);
  }

  /** `terminal` re-snapshots a turn already captured, for the end-of-game board. */
  private captureSnapshot(terminal = false): void {
    const state = this.opts.engine.spectatorState();
    const turn = state.turnNumber;
    if (!terminal && this.snapshots.has(turn)) return;
    this.lastSnapshotTurn = turn;
    this.frontierTurn = Math.max(this.frontierTurn, turn);
    this.snapshots.set(turn, state);
    if (!this.snapshotTurnList.includes(turn)) this.snapshotTurnList.push(turn);
    this.opts.recorder?.saveTurnSnapshot(turn, state);
    this.opts.onSnapshot?.(turn, state, true);
  }

  private flushEvents(): void {
    // Drain first, and unconditionally: the newest line's board is only settled at the moment
    // the engine hands control back, which is right now.
    this.takeSequenceSnapshots();

    const events = this.opts.engine.eventsSince(this.eventCursor);
    if (events.length === 0) return;

    this.eventCursor = (events[events.length - 1]?.sequence ?? this.eventCursor) + 1;
    this.opts.recorder?.appendEvents(events);
    this.indexMetricEvents(events);
    const { seatEvents } = this.opts;
    if (seatEvents !== undefined) {
      for (const seat of seatEvents.seats) {
        const seatLines = seatEvents.format(events, seat);
        if (seatLines.length > 0) {
          this.opts.onEvents?.(seatLines, this.frontierTurn, this.getSnapshotTurns(), seat);
        }
      }
    } else {
      const lines = this.opts.formatEvents?.(events) ?? formatSpectatorLog(events);
      if (lines.length > 0) {
        this.opts.onEvents?.(lines, this.frontierTurn, this.getSnapshotTurns());
      }
    }
    this.opts.onProgress?.(this.frontierTurn);
  }

  /** Persist the engine's separate diagnostic stream with the same incremental cadence as events. */
  private flushDebug(): void {
    const entries = this.opts.engine.drainDebugLog();
    this.opts.recorder?.appendDebug?.(entries);
    if (entries.length > 0) this.opts.onDebug?.(entries);
  }

  private indexMetricEvents(events: readonly import('@mtg/shared').GameEvent[]): void {
    for (const event of events) {
      if (this.indexedMetricEventSequences.has(event.sequence)) continue;
      this.indexedMetricEventSequences.add(event.sequence);
      if (event.type === 'draw' && typeof event.payload['player'] === 'string') {
        const seat = event.payload['player'];
        this.cardsDrawn.set(seat, (this.cardsDrawn.get(seat) ?? 0) + 1);
        if (event.payload['isLand'] !== true) continue;
        this.landsDrawn.set(seat, (this.landsDrawn.get(seat) ?? 0) + 1);
      }
      if (
        event.type === 'damage' &&
        typeof event.payload['target'] === 'string' &&
        typeof event.payload['controller'] === 'string'
      ) {
        this.eliminators.set(event.payload['target'], event.payload['controller']);
      }
      if (
        event.type === 'playerEliminated' &&
        typeof event.payload['player'] === 'string' &&
        !this.eliminationTurns.has(event.payload['player'])
      ) {
        this.eliminationTurns.set(event.payload['player'], event.turn);
      }
    }
  }

  /** Raw, replay-independent inputs for the tunable flood/drought heuristic. */
  private captureManaMetrics(turn: number): void {
    // Turn advancement occurs just before the normal event flush; account for those new events
    // now so the saved observation belongs to the state it describes, not the next decision.
    this.indexMetricEvents(this.opts.engine.eventsSince(this.eventCursor));
    const records: ManaMetricRecord[] = this.opts.engine.getState().players.map((player) => {
      const view = this.opts.engine.view(player.id);
      const landsInHand = view.hand.filter(
        (card) => card.typeLine?.includes('Land') === true,
      ).length;
      const spellsCastable = view.hand.filter(
        (card) => card.typeLine?.includes('Land') !== true && card.manaCost !== undefined,
      ).length;
      const unspentMana = Object.values(view.availableMana).reduce(
        (total, amount) => total + amount,
        0,
      );
      return {
        seat: player.id,
        turn,
        landsInHand,
        landsDrawnCumulative: this.landsDrawn.get(player.id) ?? 0,
        cardsDrawnCumulative: this.cardsDrawn.get(player.id) ?? 0,
        spellsCastable,
        unspentMana,
        onCurve: player.landsPlayedThisTurn > 0,
      };
    });
    this.opts.recorder?.saveManaMetrics?.(records);
  }

  /**
   * Move the engine's per-action boards into the runner and cap what is retained. `Map`
   * iterates in insertion order and sequences only ever increase, so dropping from the front
   * drops the oldest.
   */
  private takeSequenceSnapshots(): void {
    for (const [sequence, state] of this.opts.engine.drainSpectatorSnapshots()) {
      this.sequenceSnapshots.set(sequence, state);
    }
    while (this.sequenceSnapshots.size > MAX_SEQUENCE_SNAPSHOTS) {
      const oldest = this.sequenceSnapshots.keys().next();
      if (oldest.done === true) break;
      this.sequenceSnapshots.delete(oldest.value);
    }
  }

  private finish(result: GameResult): void {
    this.result = result;
    // Re-snapshot the final turn. Turn snapshots are taken at a turn's *start*, so without this
    // the last board a viewer can scrub to predates everything that ended the game — the winner
    // is announced over a board where nobody has died yet.
    this.captureSnapshot(true);

    if (result.halted) {
      this.recordHalt({
        kind: classifyHalt(result.haltReason),
        reason: result.haltReason ?? 'engine halted',
        turn: result.turnCount,
        ...(result.haltSite !== undefined && { site: result.haltSite, seed: this.opts.seed }),
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
    // Same reason as `finish`: the user is told to scrub to the halt point and resolve it
    // (brief §10.1), so the board there must be the board as it actually stopped.
    this.captureSnapshot(true);
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
    // The game-ending elimination can still be unflushed here; indexing is idempotent per sequence.
    this.indexMetricEvents(this.opts.engine.eventsSince(this.eventCursor));
    const state = this.opts.engine.getState();
    recorder.finish(
      result,
      status,
      state.players.map((player) => ({
        seat: player.id,
        lossReason: player.lossReason,
        eliminatedOnTurn: player.hasLost
          ? (this.eliminationTurns.get(player.id) ?? result.turnCount)
          : null,
        eliminatedBySeat: eliminatorFor(player, this.eliminators.get(player.id) ?? null),
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

/**
 * Who to credit with a player's elimination in statistics ("Who beats me"). The runner only knows
 * the last seat that dealt each player damage, so credit it only where that can be the cause: the
 * player actually lost, by something other than drawing from an empty library, to another seat.
 * Recording it for every seat credited winners and survivors with a "loss", and players with
 * beating themselves. Still a heuristic: a life-loss effect after the last damage is not seen.
 */
export function eliminatorFor(
  player: { id: PlayerId; hasLost: boolean; lossReason: LossReason | null },
  lastDamagedBy: PlayerId | null,
): PlayerId | null {
  if (!player.hasLost || player.lossReason === null || player.lossReason === 'emptyLibraryDraw') {
    return null;
  }
  return lastDamagedBy === player.id ? null : lastDamagedBy;
}

/** `mulligansTaken` is engine-internal; read it defensively so the shared type stays clean. */
function mulligansOf(player: unknown): number {
  const value = (player as { mulligansTaken?: unknown }).mulligansTaken;
  return typeof value === 'number' ? value : 0;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

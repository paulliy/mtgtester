/**
 * A `MatchSession` is one game plus everything around it: the engine, the per-seat decision
 * providers, the `MatchRunner`, the recorder, and the outbound message stream. The WebSocket
 * layer owns sessions and does nothing else — it translates frames to method calls and
 * broadcasts what comes back.
 */

import {
  Engine,
  formatPlayerLog,
  formatSpectatorLog,
  RandomDecisionProvider,
} from '@mtg/engine';
import type { AsyncDecisionProvider, DecisionProvider } from '@mtg/engine';
import type {
  AiAnnotation,
  AiReflection,
  DecisionRequest,
  DecisionResponse,
  DebugFlags,
  GameEvent,
  GameMode,
  IgnoredPlayerAbility,
  PlaybackMode,
  PlayerId,
  ProviderKind,
  ServerToClientMessage,
  SpectatorLogLine,
  TargetChoice,
  SubmitPlayerActionPayload,
  YieldPlayerAbilityPayload,
} from '@mtg/shared';
import {
  AiCallLogger,
  condenseSeatLog,
  configForRole,
  loadAiConfig,
  OpenAiCompatibleClient,
  OpenAiDecisionProvider,
  publishReflections,
  RequestQueue,
  runReflection,
  StrategyCoordinator,
  type AiClient,
  type AiConfig,
  type ReflectionContext,
} from '../ai';
import type { GameStore } from '../db';
import { finishingPositions, type GameRecorder } from '../db/games';
import { releaseAnnotations } from './annotations';
import { MatchRunner } from './runner';
import {
  HumanDecisionProvider,
  PersistentAbilityYieldProvider,
  PlayerConnectionGate,
} from './human-provider';
import type { SeatSetup } from './setup';

/** The engine's `RandomDecisionProvider` is synchronous; the runner awaits every provider. */
class AsyncAdapter implements AsyncDecisionProvider {
  constructor(private readonly inner: DecisionProvider) {}
  decide(request: DecisionRequest): Promise<DecisionResponse> {
    return Promise.resolve(this.inner.decide(request));
  }
}

/**
 * Wall-clock time one live turn is shown for, at 1× speed. Live mode is otherwise unwatchable:
 * a random-provider game computes 60+ turns in about two seconds, so without a pace the viewer
 * sees the setup screen and then the final board.
 */
export const LIVE_PACE_MS = 1_200;

const DEFAULT_DEBUG_FLAGS: DebugFlags = {
  showAIRequests: false,
  showAIResponses: false,
  showLegalActions: false,
  showSBAChecks: false,
  showPriorityPasses: false,
  showTokenUsage: true,
  verboseEngine: false,
};

export interface MatchSessionOptions {
  gameId: string;
  seed: string;
  seats: readonly SeatSetup[];
  providerKind: ProviderKind;
  gameMode?: GameMode;
  humanSeat?: PlayerId;
  store?: GameStore | undefined;
  playbackMode?: PlaybackMode;
  turnCap?: number;
  /** Overrides `LIVE_PACE_MS`; 0 presents as fast as the engine computes. Tests pass 0. */
  livePaceMs?: number;
  /**
   * Per-game override for post-game AI commentary (ADR 0022 §7), chosen on the setup screen.
   * Omit to fall back to `AI_REFLECTION_ENABLED`, which is off.
   */
  reflectionEnabled?: boolean;
  send(message: ServerToClientMessage): void;
}

export class MatchSession {
  readonly engine: Engine;
  readonly runner: MatchRunner;
  private readonly logger: AiCallLogger | null;
  private readonly recorder: GameRecorder | null;
  private readonly providers = new Map<PlayerId, AsyncDecisionProvider>();
  private playbackMode: PlaybackMode;
  private running: Promise<void> | null = null;
  /** One client and one queue per session: the RPM ceiling is an account property, not a seat's. */
  private aiConfig: AiConfig | null = null;
  private aiStrategistClient: OpenAiCompatibleClient | null = null;
  private aiTacticianClient: OpenAiCompatibleClient | null = null;
  private aiQueue: RequestQueue | null = null;
  /** The strategist's own queue lane — see `AiConfig.strategistConcurrency`. */
  private aiStrategistQueue: RequestQueue | null = null;
  private aiCoordinator: StrategyCoordinator | null = null;
  private aiReflectionClient: AiClient | null = null;
  private debugFlags: DebugFlags = { ...DEFAULT_DEBUG_FLAGS };
  private readonly gameMode: GameMode;
  private readonly humanSeat: PlayerId | null;
  private readonly humanProvider: HumanDecisionProvider | null;
  private readonly connectionGate = new PlayerConnectionGate();
  private readonly ignoredAbilities = new Map<string, IgnoredPlayerAbility>();
  private playerRevision = 0;

  // ── Live presentation (brief §10.1) ───────────────────────────────────────────────────────
  //
  // Compute and presentation are separate clocks. The engine runs ahead as fast as its budget
  // allows; the viewer is walked forward one turn per `livePaceMs`, and *that* position is what
  // the runner's compute-ahead cap is measured against. Before this the session pushed each
  // turn the instant it was computed and set the view turn to it, which made `frontierTurn <=
  // viewTurn + 5` permanently true — the cap could never bind and there was nothing to watch.
  private livePaceMs: number;
  private presentedTurn = 0;
  /** False until the opening board has gone out — turn 0 is a position, not "nothing yet". */
  private hasPresented = false;
  private presentTimer: ReturnType<typeof setInterval> | null = null;
  /** Log lines computed but not yet reached by the presentation clock. */
  private pendingLines: SpectatorLogLine[] = [];
  /** ADR 0022 reasoning notes awaiting a log line to attach to. */
  private pendingAnnotations: AiAnnotation[] = [];
  /** Every note produced this game — the single-player end-of-game release reads this. */
  private readonly allAnnotations: AiAnnotation[] = [];
  /** Post-game reviews that have landed so far (ADR 0022 §7). */
  private readonly reflections: AiReflection[] = [];
  /** Seats already written to `game_reflections`; progress fires repeatedly with a growing list. */
  private readonly persistedReflections = new Set<PlayerId>();
  /** Reflection is fired once per game; `publishGameOver` can run twice (a player resync). */
  private reflectionsStarted = false;
  private reflectionsComplete = false;
  private reflectionRun: Promise<void> | null = null;

  constructor(private readonly opts: MatchSessionOptions) {
    this.gameMode = opts.gameMode ?? 'spectator';
    this.humanSeat = this.gameMode === 'singlePlayer' ? (opts.humanSeat ?? null) : null;
    if (this.gameMode === 'singlePlayer' && this.humanSeat === null) {
      throw new Error('single-player session requires a human seat');
    }
    this.playbackMode = opts.playbackMode ?? 'live';
    this.livePaceMs = opts.livePaceMs ?? LIVE_PACE_MS;
    this.engine = new Engine({
      gameId: opts.gameId,
      seed: opts.seed,
      players: opts.seats.map((s) => s.config),
      ...(opts.turnCap !== undefined && { turnCap: opts.turnCap }),
    });
    this.recorder = opts.store?.recorderFor(opts.gameId) ?? null;
    this.logger =
      opts.providerKind === 'ai' ? new AiCallLogger(opts.store?.raw ?? null, opts.gameId) : null;
    this.humanProvider =
      this.humanSeat === null
        ? null
        : new HumanDecisionProvider(
            () => ++this.playerRevision,
            ({ request, revision }) => {
              this.sendPlayerActionRequired(request, revision);
            },
          );

    this.runner = new MatchRunner({
      engine: this.engine,
      gameId: opts.gameId,
      seed: opts.seed,
      seats: opts.seats.map((s) => ({
        seat: s.seat,
        // `game_players.deck_snapshot_id` is a foreign key, so this must be a real snapshot.
        // Setup always writes one when a store exists — including for generated decks — and
        // when no store exists there is no recorder to insert the row at all.
        deckSnapshotId: s.deckSnapshotId ?? s.config.deckId,
        controllerKind: s.seat === this.humanSeat ? 'human' : opts.providerKind,
      })),
      providerFor: (playerId) => this.providerFor(playerId),
      recorder: this.recorder,
      gameMode: this.gameMode,
      ...(this.humanSeat !== null
        ? {
            lookaheadTurns: 0,
            formatEvents: (events) => formatPlayerLog(events, this.humanSeat as PlayerId),
          }
        : {}),
      onEvents: (lines, frontierTurn, snapshotTurns) => {
        if (this.gameMode === 'singlePlayer') {
          opts.send({
            type: 'eventBatch',
            payload: { gameId: opts.gameId, lines, frontierTurn, snapshotTurns: [] },
          });
          return;
        }
        // In live mode the log is released in step with the board. Sending every line the
        // instant it is computed is how the action log ends up describing a turn the board has
        // not reached — the same desync from the other side.
        if (this.playbackMode === 'live' && this.livePaceMs > 0) {
          this.pendingLines.push(...lines);
          this.releaseLines();
          return;
        }
        opts.send({
          type: 'eventBatch',
          payload: {
            gameId: opts.gameId,
            lines,
            frontierTurn,
            snapshotTurns,
            ...this.annotationField(lines),
          },
        });
      },
      onSnapshot: () => {
        // A newly computed turn is not a newly *presented* turn. In live mode the presentation
        // clock decides when the viewer moves; in manual mode the viewer's position is theirs
        // and pushing anything would yank them.
        if (this.gameMode === 'spectator' && this.playbackMode === 'live') this.startPresenting();
      },
      onProgress: (frontierTurn) => {
        if (this.gameMode === 'singlePlayer') {
          // Player mode has one clock: every authoritative advance is immediately presented.
          this.runner.setViewTurn(frontierTurn);
          this.publishPlayerState(true);
        }
      },
      onDecisionPending: (request, invalidResponse, timeoutMs) => {
        if (this.gameMode === 'spectator') {
          opts.send({ type: 'decisionPending', payload: { request, invalidResponse, timeoutMs } });
        }
      },
      onHalt: (info) => {
        opts.send({
          type: 'computeHalted',
          payload: {
            gameId: opts.gameId,
            kind: info.kind,
            reason:
              this.gameMode === 'singlePlayer'
                ? 'The rules engine could not continue this game.'
                : info.reason,
            turn: info.turn,
            ...(this.gameMode === 'spectator' && info.cardName !== undefined
              ? { cardName: info.cardName }
              : {}),
          },
        });
      },
      onGameOver: (result) => {
        this.publishGameOver(result);
      },
      onDecision: (request, response, anchorSequence) => {
        if (request.decidingPlayer === this.humanSeat && this.opts.providerKind === 'ai') {
          this.ensureAiCoordinator().recordDecision(request, response, 'human');
        }
        this.logger?.recordAnchor(request.requestId, anchorSequence);
        // The note is the gate, not the provider kind: a random provider never writes one, and
        // the human seat's own choices are theirs rather than reasoning to be explained back.
        if (request.decidingPlayer !== this.humanSeat && response.note !== undefined) {
          this.recordAnnotation({
            sequence: anchorSequence,
            turn: request.turn,
            seat: request.decidingPlayer,
            kind: 'decision',
            text: response.note,
            source: this.logger?.sourceFor(request.requestId) ?? 'primary',
          });
        }
        this.reportAiCost();
      },
      onTurnBoundary: (turn, activePlayer) => {
        if (this.opts.providerKind === 'ai') {
          this.ensureAiCoordinator().prefetch(this.opts.gameId, turn, activePlayer);
        }
      },
      onDebug: (entries) => {
        if (this.gameMode === 'singlePlayer' || !this.debugFlags.verboseEngine) return;
        opts.send({
          type: 'debugEvents',
          payload: { gameId: opts.gameId, entries },
        });
      },
    });
  }

  start(): void {
    if (this.running !== null) return;
    this.running = this.runner
      .run()
      .catch((err: unknown) => {
        this.opts.send({
          type: 'error',
          payload: {
            message:
              this.gameMode === 'singlePlayer'
                ? 'The game runner stopped unexpectedly.'
                : err instanceof Error
                  ? err.message
                  : String(err),
          },
        });
      })
      .finally(() => {
        // Compute is done; anything still queued behind the presentation clock is now all
        // there will ever be, so let the clock drain it and stop.
        if (this.gameMode === 'spectator') this.startPresenting();
      });
    if (this.gameMode === 'singlePlayer') this.publishPlayerState(true);
    else if (this.playbackMode === 'live') this.startPresenting();
  }

  /** Wait for the match to stop computing — used by tests and by clean shutdown. */
  async settled(): Promise<void> {
    await this.running;
  }

  /**
   * `paceMs` rides on `setPlaybackMode` rather than adding a message type — the same rule ADR
   * 0012 applied to the compute frontier. 0 means "as fast as it computes".
   */
  setPlaybackMode(mode: PlaybackMode, paceMs?: number): void {
    if (this.gameMode === 'singlePlayer') {
      this.playbackMode = 'live';
      if (paceMs !== undefined) this.livePaceMs = Math.max(0, paceMs);
      return;
    }
    const previous = this.playbackMode;
    this.playbackMode = mode;
    if (paceMs !== undefined) this.livePaceMs = Math.max(0, paceMs);

    if (mode !== 'live') {
      // Leaving live: the user is driving now, so hand them the whole log and stop presenting.
      this.stopPresenting();
      this.flushPendingLines();
      return;
    }

    // Entering live: resume from wherever the user was looking rather than teleporting them to
    // the frontier — the presentation clock will catch up on its own.
    if (previous !== 'live') this.presentedTurn = this.runner.getViewTurn();
    this.present(this.presentedTurn);
    this.startPresenting();
  }

  getPlaybackMode(): PlaybackMode {
    return this.playbackMode;
  }

  getGameMode(): GameMode {
    return this.gameMode;
  }

  getHumanSeat(): PlayerId | null {
    return this.humanSeat;
  }

  getLivePaceMs(): number {
    return this.livePaceMs;
  }

  setDebugFlags(flags: DebugFlags): void {
    if (this.gameMode === 'singlePlayer') return;
    this.debugFlags = { ...flags };
  }

  // ── The presentation clock ────────────────────────────────────────────────────────────────

  private startPresenting(): void {
    if (this.playbackMode !== 'live') return;

    // The opening board is turn 0, and `presentedTurn` starts there, so "catch up to the
    // frontier" alone would never send it.
    if (!this.hasPresented) this.present(this.presentedTurn);

    // Pace 0 is "present everything as it computes" — no timer, just keep up.
    if (this.livePaceMs === 0) {
      for (;;) {
        const next = this.nextPresentableTurn();
        if (next === null) return;
        this.present(next);
      }
    }

    if (this.presentTimer !== null) return;
    this.presentTimer = setInterval(() => {
      this.tickPresentation();
    }, this.livePaceMs);
    this.presentTimer.unref?.();
  }

  private stopPresenting(): void {
    if (this.presentTimer === null) return;
    clearInterval(this.presentTimer);
    this.presentTimer = null;
  }

  /**
   * The next turn actually worth showing after `presentedTurn`, or `null` if nothing beyond it
   * has been computed yet. Turn numbers are not guaranteed contiguous: a turn that surfaces no
   * decision at all — e.g. its active player decks out on an uneventful draw step, aborting the
   * turn before any priority window needs a real choice — never gets a snapshot of its own from
   * `MatchRunner`. Stepping by `presentedTurn + 1` and stopping cold when that exact turn is
   * missing is what used to hang the presentation clock forever (an infinite loop at
   * `livePaceMs: 0`, a `setInterval` that never clears otherwise) even though the game had
   * already finished computing. Walking the runner's own snapshot list instead skips straight to
   * whatever turn actually exists next.
   */
  private nextPresentableTurn(): number | null {
    for (const turn of this.runner.getSnapshotTurns()) {
      if (turn > this.presentedTurn) return turn;
    }
    return null;
  }

  private tickPresentation(): void {
    if (this.playbackMode !== 'live') {
      this.stopPresenting();
      return;
    }
    const next = this.nextPresentableTurn();
    if (next === null) {
      // Caught up to everything computed so far. Keep the timer only while there is more to come.
      const status = this.runner.getStatus();
      if (status === 'finished' || status === 'halted' || status === 'abandoned') {
        this.flushPendingLines();
        this.stopPresenting();
      }
      return;
    }
    this.present(next);
  }

  /** Show turn `turn` and move the viewer there — which is what un-parks compute. */
  private present(turn: number): void {
    const found = this.runner.stateAt(turn);
    if (found === null) return;
    this.presentedTurn = turn;
    this.hasPresented = true;
    this.runner.setViewTurn(turn);
    const frontierTurn = this.runner.getFrontierTurn();
    this.opts.send({
      type: 'stateSnapshot',
      payload: {
        turn,
        state: found.state,
        frontierTurn,
        atFrontier: turn >= frontierTurn,
        sequence: null,
      },
    });
    this.releaseLines();
  }

  /** Release the log lines the presented board has now reached. */
  private releaseLines(): void {
    if (this.pendingLines.length === 0) return;
    const due = this.pendingLines.filter((line) => line.turn <= this.presentedTurn);
    if (due.length === 0) return;
    this.pendingLines = this.pendingLines.filter((line) => line.turn > this.presentedTurn);
    this.sendLines(due);
  }

  private flushPendingLines(): void {
    if (this.pendingLines.length === 0) return;
    const lines = this.pendingLines;
    this.pendingLines = [];
    this.sendLines(lines);
  }

  private sendLines(lines: SpectatorLogLine[]): void {
    this.opts.send({
      type: 'eventBatch',
      payload: {
        gameId: this.opts.gameId,
        lines,
        frontierTurn: this.runner.getFrontierTurn(),
        snapshotTurns: this.runner.getSnapshotTurns(),
        ...this.annotationField(lines),
      },
    });
  }

  // ── AI reasoning annotations (ADR 0022) ───────────────────────────────────────────────────

  /**
   * Record one reasoning note against the sequence its decision will produce. Always collected —
   * the list is short and the single-player release and the REST history both need it — but only
   * queued for live delivery when the viewer has actually asked to see reasoning.
   */
  private recordAnnotation(annotation: AiAnnotation): void {
    if (annotation.text.trim().length === 0) return;
    this.allAnnotations.push(annotation);
    if (this.debugFlags.showAIResponses) this.pendingAnnotations.push(annotation);
  }

  /**
   * Annotations to ship with a batch of log lines, spread as `...this.annotationField(lines)` so
   * the field is *absent* rather than empty when there is nothing to say — the flag being off
   * must not grow the payload at all.
   *
   * Riding on the same batch as the lines is what keeps reasoning in step with the board: the
   * live presentation clock paces `sendLines`, so annotations inherit that pacing for free
   * instead of racing ahead of the turn the viewer is watching.
   */
  private annotationField(lines: readonly SpectatorLogLine[]): { annotations?: AiAnnotation[] } {
    const due = this.takeAnnotationsFor(lines);
    return due === undefined ? {} : { annotations: due };
  }

  private takeAnnotationsFor(lines: readonly SpectatorLogLine[]): AiAnnotation[] | undefined {
    const { due, held } = releaseAnnotations({
      gameMode: this.gameMode,
      showReasoning: this.debugFlags.showAIResponses,
      pending: this.pendingAnnotations,
      lines,
    });
    this.pendingAnnotations = held;
    return due.length > 0 ? due : undefined;
  }

  /**
   * Move the viewer and send them that board. Backward is always allowed; forward past the
   * frontier unparks compute up to lookahead turns ahead (brief §10.1).
   */
  jumpToTurn(requestedTurn: number, requestedSequence?: number): void {
    if (this.gameMode === 'singlePlayer' && this.runner.getStatus() !== 'finished') {
      this.opts.send({
        type: 'error',
        payload: { message: 'Timeline seeking unlocks after a single-player game ends.' },
      });
      return;
    }
    const turn = Math.max(0, requestedTurn);
    this.runner.setViewTurn(turn);
    // A seek during live playback rewinds the presentation rather than being overwritten by it
    // on the next tick. (The client also drops to manual on a deliberate seek.)
    if (this.playbackMode === 'live') {
      this.presentedTurn = turn;
      this.flushPendingLines();
    }
    const found = this.runner.stateAt(turn, requestedSequence);
    if (found === null) {
      const status = this.runner.getStatus();
      if (status === 'finished' || status === 'halted' || status === 'abandoned') {
        this.opts.send({
          type: 'error',
          payload: { message: `Turn ${turn} has not been computed yet.` },
        });
      }
      return;
    }
    this.opts.send({
      type: 'stateSnapshot',
      payload: {
        turn,
        state: found.state,
        frontierTurn: this.runner.getFrontierTurn(),
        atFrontier: turn >= this.runner.getFrontierTurn(),
        sequence: found.sequence,
      },
    });
  }

  resolveHeldDecision(requestId: string, actionId: number, targets?: TargetChoice[]): void {
    const accepted = this.runner.resolveHeldDecision(requestId, actionId, targets);
    if (!accepted) {
      this.opts.send({
        type: 'error',
        payload: { message: `No decision is being held for ${requestId}.` },
      });
    }
  }

  submitPlayerAction(payload: SubmitPlayerActionPayload): void {
    if (this.humanProvider === null) {
      this.opts.send({ type: 'error', payload: { message: 'This is not a single-player game.' } });
      return;
    }
    const error = this.humanProvider.submit(payload);
    if (error !== null) this.opts.send({ type: 'error', payload: { message: error } });
  }

  yieldPlayerAbility(payload: YieldPlayerAbilityPayload): void {
    const pending = this.humanProvider?.current();
    if (pending === null || pending === undefined) {
      this.opts.send({ type: 'error', payload: { message: 'No player action is currently required.' } });
      return;
    }
    if (payload.requestId !== pending.request.requestId || payload.revision !== pending.revision) {
      this.opts.send({ type: 'error', payload: { message: 'That ability choice is stale.' } });
      return;
    }
    const action = pending.request.legalActions.find((candidate) => candidate.id === payload.actionId);
    const interaction = action?.interaction;
    if (
      action?.type !== 'activateAbility' ||
      interaction?.kind !== 'source' ||
      interaction.sourceCardId === undefined ||
      interaction.abilityIndex === undefined
    ) {
      this.opts.send({ type: 'error', payload: { message: 'Only an optional activated ability can be yielded.' } });
      return;
    }
    const key = `${interaction.sourceCardId}:${interaction.abilityIndex}`;
    this.ignoredAbilities.set(key, { key, label: action.description });
    this.sendPlayerActionRequired(pending.request, pending.revision);
  }

  resumePlayerAbility(key: string): void {
    if (!this.ignoredAbilities.delete(key)) {
      this.opts.send({ type: 'error', payload: { message: 'That yielded ability is no longer available.' } });
      return;
    }
    const pending = this.humanProvider?.current();
    if (pending !== null && pending !== undefined) {
      this.sendPlayerActionRequired(pending.request, pending.revision);
    }
    this.publishPlayerState(false);
  }

  /**
   * Out-of-band cancel of an active "pass and yield until end of turn" (Workstream 2). While
   * yielding, the engine auto-passes and never surfaces a decision, so this cannot ride on the
   * usual request/revision submission path — it mutates engine state directly and republishes
   * the board so the yield banner clears.
   */
  cancelYield(): void {
    if (this.humanSeat === null) {
      this.opts.send({ type: 'error', payload: { message: 'This is not a single-player game.' } });
      return;
    }
    if (this.engine.cancelYield(this.humanSeat)) this.publishPlayerState(false);
  }

  setPlayerConnected(connected: boolean): void {
    if (this.gameMode !== 'singlePlayer') return;
    this.connectionGate.setConnected(connected);
    if (connected) this.resyncPlayer();
  }

  resyncPlayer(): void {
    if (this.humanSeat === null) return;
    this.opts.send({
      type: 'eventBatch',
      payload: {
        gameId: this.opts.gameId,
        lines: formatPlayerLog(this.engine.eventsSince(0), this.humanSeat),
        frontierTurn: this.engine.getState().turnNumber,
        snapshotTurns: [],
      },
    });
    this.publishPlayerState(false);
    const result = this.runner.getResult();
    if (result !== null) {
      this.publishGameOver(result);
      return;
    }
    const pending = this.humanProvider?.current();
    if (pending !== null && pending !== undefined) {
      this.sendPlayerActionRequired(pending.request, pending.revision);
    }
  }

  abandon(): void {
    this.stopPresenting();
    this.runner.abandon();
    this.humanProvider?.releaseForAbandon();
    this.connectionGate.release();
  }

  private publishPlayerState(bump: boolean): void {
    if (this.humanSeat === null) return;
    if (bump) this.playerRevision += 1;
    this.opts.send({
      type: 'playerStateSnapshot',
      payload: {
        gameId: this.opts.gameId,
        state: this.engine.playerState(this.humanSeat),
        revision: this.playerRevision,
        connected: this.connectionGate.isConnected(),
        ignoredAbilities: this.ignoredAbilityList(),
      },
    });
  }

  private sendPlayerActionRequired(request: DecisionRequest, revision: number): void {
    if (this.humanSeat === null) return;
    this.opts.send({
      type: 'playerActionRequired',
      payload: {
        request: {
          ...request,
          legalActions: request.legalActions.filter((action) => !this.isIgnoredAbility(action)),
        },
        revision,
        state: this.engine.playerState(this.humanSeat),
        ignoredAbilities: this.ignoredAbilityList(),
      },
    });
  }

  private isIgnoredAbility(action: DecisionRequest['legalActions'][number]): boolean {
    const interaction = action.interaction;
    return (
      action.type === 'activateAbility' &&
      interaction?.kind === 'source' &&
      interaction.sourceCardId !== undefined &&
      interaction.abilityIndex !== undefined &&
      this.ignoredAbilities.has(`${interaction.sourceCardId}:${interaction.abilityIndex}`)
    );
  }

  private ignoredAbilityList(): IgnoredPlayerAbility[] {
    return [...this.ignoredAbilities.values()];
  }

  private publishGameOver(result: NonNullable<ReturnType<Engine['getResult']>>): void {
    if (this.gameMode === 'singlePlayer') {
      this.opts.send({
        type: 'replayUnlocked',
        payload: {
          state: this.engine.spectatorState(),
          lines: formatSpectatorLog(this.engine.eventsSince(0)),
          snapshotTurns: this.runner.getSnapshotTurns(),
          frontierTurn: result.turnCount,
          // The game is over, so the reasoning withheld all game is safe to release in full
          // (ADR 0022 §3) — this is the only path by which a player ever sees it.
          ...(this.debugFlags.showAIResponses && this.allAnnotations.length > 0
            ? { annotations: [...this.allAnnotations] }
            : {}),
        },
      });
    }
    const reflectingSeats = this.reflectionSeats();
    this.opts.send({
      type: 'gameOver',
      payload: {
        result,
        standings: this.standings(),
        ...(reflectingSeats.length > 0 ? { reflectingSeats } : {}),
      },
    });

    // Deliberately not awaited, and deliberately after the send above: a reflection is a model
    // call, and the results screen is the one thing in this system that must never wait on one
    // (ADR 0022 §7). On a resync the game is long over and the reviews already exist, so they are
    // simply re-sent.
    if (this.reflections.length > 0) this.sendReflections(this.reflections, this.reflectionsComplete);
    this.reflectionRun = this.startReflections(result);
  }

  /** Test/shutdown hook: resolves once every post-game review has settled. */
  async reflectionsSettled(): Promise<void> {
    await this.reflectionRun;
  }

  // ── Post-game reflection (ADR 0022 §7) ────────────────────────────────────────────────────

  /**
   * Seats that will review this game: every AI seat, never the human's own. The per-game setup
   * choice wins over the env default so the toggle on the new-game screen actually decides it.
   */
  private reflectionSeats(): PlayerId[] {
    if (this.opts.providerKind !== 'ai') return [];
    const config = (this.aiConfig ??= loadAiConfig(process.env));
    if (!(this.opts.reflectionEnabled ?? config.reflectionEnabled)) return [];
    return this.opts.seats
      .map((seat) => seat.seat)
      .filter((seat) => seat !== this.humanSeat);
  }

  private sendReflections(reflections: readonly AiReflection[], complete: boolean): void {
    this.opts.send({
      type: 'gameReflections',
      payload: { gameId: this.opts.gameId, reflections: [...reflections], complete },
    });
  }

  /** Everything one seat is allowed to know about the game, assembled from its own projections. */
  private reflectionContextFor(
    seat: PlayerId,
    result: NonNullable<ReturnType<Engine['getResult']>>,
    standings: ReadonlyMap<PlayerId, { position: number; lossReason: string | null }>,
    events: readonly GameEvent[],
  ): ReflectionContext {
    const outcome = standings.get(seat);
    const archetype = this.opts.seats.find((s) => s.seat === seat)?.summary.archetypeTag;
    return {
      seat,
      position: outcome?.position ?? 0,
      seatCount: this.opts.seats.length,
      lossReason: outcome?.lossReason ?? null,
      turnCount: result.turnCount,
      winnerSeat: result.winnerSeat,
      // `view(seat)` and `formatPlayerLog(events, seat)` are the same two anti-cheat boundaries
      // the seat played behind. The game ending does not widen them.
      view: this.engine.view(seat),
      decisions: this.aiCoordinator?.digestFor(seat) ?? [],
      publicLog: condenseSeatLog(formatPlayerLog([...events], seat), seat),
      ...(archetype !== undefined && archetype.length > 0 ? { archetypeTag: archetype } : {}),
    };
  }

  private async startReflections(
    result: NonNullable<ReturnType<Engine['getResult']>>,
  ): Promise<void> {
    if (this.reflectionsStarted) return;
    const seats = this.reflectionSeats();
    if (seats.length === 0) return;
    this.reflectionsStarted = true;

    const config = this.aiConfig as AiConfig;
    this.aiReflectionClient ??= new OpenAiCompatibleClient(configForRole(config, 'reflection'));
    // The strategist lane, reused: no tactical decision can exist any more, so there is nothing
    // left for these to block.
    const queue = (this.aiStrategistQueue ??= new RequestQueue({
      rpmLimit: config.rpmLimit,
      concurrency: config.strategistConcurrency,
    }));

    const standings = new Map(this.standings().map((entry) => [entry.seat, entry]));
    const events = this.engine.eventsSince(0);

    await publishReflections(
      seats.map((seat) => this.reflectionContextFor(seat, result, standings, events)),
      (context) =>
        runReflection(this.aiReflectionClient, queue, context, {
          gameId: this.opts.gameId,
          logger: this.logger ?? undefined,
        }),
      (reflections, complete) => {
        this.reflections.length = 0;
        this.reflections.push(...reflections);
        this.reflectionsComplete = complete;
        for (const reflection of reflections) {
          if (this.persistedReflections.has(reflection.seat)) continue;
          this.persistedReflections.add(reflection.seat);
          try {
            this.recorder?.saveReflection(reflection);
          } catch {
            // Commentary that failed to persist is still worth showing to the person watching.
          }
        }
        this.sendReflections(reflections, complete);
      },
    );
  }

  /**
   * Finishing positions for the `gameOver` payload, from the same ranking the database records
   * so the screen and the stored row can never disagree. A seat absent from `finishingOrder`
   * did not finish — only possible on a halt — and is reported as position 0.
   */
  private standings(): Array<{ seat: PlayerId; position: number; lossReason: string | null }> {
    const positions = finishingPositions(
      this.runner.getResult()?.finishingOrder ?? [],
      this.opts.seats.length,
    );
    const state = this.engine.getState();
    return this.opts.seats.map((seat) => ({
      seat: seat.seat,
      position: positions.get(seat.seat) ?? 0,
      lossReason: state.players.find((p) => p.id === seat.seat)?.lossReason ?? null,
    }));
  }

  /**
   * Push the running cost counters (brief §7.4 — "track and display per-game API call count and
   * token usage… so cost regressions are visible immediately"). Only meaningful for AI matches.
   */
  private reportAiCost(): void {
    if (this.logger === null) return;
    const stats = this.logger.summary();
    this.opts.send({
      type: 'apiWaiting',
      payload: {
        queueDepth: 0,
        waitingMs: 0,
        reason: 'inFlight',
        calls: stats.totalCalls,
        skippedCalls: stats.skippedCalls,
        promptTokens: stats.totalPromptTokens,
        responseTokens: stats.totalResponseTokens,
      },
    });
  }

  private providerFor(playerId: PlayerId): AsyncDecisionProvider {
    const existing = this.providers.get(playerId);
    if (existing !== undefined) return existing;

    if (playerId === this.humanSeat && this.humanProvider !== null) {
      this.providers.set(playerId, this.humanProvider);
      return this.humanProvider;
    }

    const inner: AsyncDecisionProvider =
      this.opts.providerKind === 'ai'
        ? this.buildAiProvider()
        : new AsyncAdapter(new RandomDecisionProvider(`${this.opts.seed}-${playerId}`));
    const pacedProvider: AsyncDecisionProvider =
      this.gameMode === 'singlePlayer'
        ? {
            decide: async (request) => {
              await this.connectionGate.wait();
              const response = await inner.decide(request);
              await this.connectionGate.wait();
              const delayMs = Math.min(500, Math.floor(this.livePaceMs / 3));
              if (delayMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
              }
              return response;
            },
          }
        : inner;

    // Bots retain an explicit decline of a sacrifice-style optional activation across turns in
    // both spectator and player games, avoiding a new model call for the same non-plan each turn.
    const provider: AsyncDecisionProvider = new PersistentAbilityYieldProvider(pacedProvider);

    this.providers.set(playerId, provider);
    return provider;
  }

  private buildAiProvider(): AsyncDecisionProvider {
    const coordinator = this.ensureAiCoordinator();
    const config = this.aiConfig as AiConfig;
    const tactician = this.aiTacticianClient as OpenAiCompatibleClient;
    const queue = this.aiQueue as RequestQueue;
    return new OpenAiDecisionProvider(
      tactician,
      queue,
      this.engine,
      config,
      this.logger ?? undefined,
      // Never surface an opponent's failed legal menu to the active player.
      this.gameMode === 'singlePlayer' ? undefined : this.runner.escalation(),
      coordinator,
    );
  }

  private ensureAiCoordinator(): StrategyCoordinator {
    const config = (this.aiConfig ??= loadAiConfig(process.env));
    this.aiStrategistClient ??= new OpenAiCompatibleClient(configForRole(config, 'strategist'));
    this.aiTacticianClient ??= new OpenAiCompatibleClient(configForRole(config, 'tactician'));
    this.aiQueue ??= new RequestQueue(config);
    // A separate queue instance, not just a separate call: a strategist call must never queue
    // behind a tactical one (or vice versa), which sharing `aiQueue` would force under its
    // concurrency-1 default.
    this.aiStrategistQueue ??= new RequestQueue({
      rpmLimit: config.rpmLimit,
      concurrency: config.strategistConcurrency,
    });
    if (this.aiCoordinator === null) {
      this.aiCoordinator = new StrategyCoordinator(
        this.aiStrategistClient,
        this.aiStrategistQueue,
        this.engine,
        config,
        this.logger ?? undefined,
        this.humanSeat,
        // Each bot is told what its *own* deck is built to do (ADR 0022 §5). The map is keyed by
        // seat and read only for the seat being planned, so no seat ever sees another's.
        new Map(this.opts.seats.map((seat) => [seat.seat, seat.summary.archetypeTag])),
      );
      // A strategist plan has no decision of its own and lands asynchronously, so it anchors to
      // wherever the log has reached — which is the point it actually started steering play.
      this.aiCoordinator.onStrategy = (turn, activePlayer, intent, model) => {
        this.recordAnnotation({
          sequence: this.runner.nextSequence(),
          turn,
          seat: activePlayer,
          kind: 'strategy',
          text: intent,
          source: 'strategist',
          model,
        });
      };
    }
    return this.aiCoordinator;
  }
}

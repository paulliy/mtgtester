/**
 * A `MatchSession` is one game plus everything around it: the engine, the per-seat decision
 * providers, the `MatchRunner`, the recorder, and the outbound message stream. The WebSocket
 * layer owns sessions and does nothing else — it translates frames to method calls and
 * broadcasts what comes back.
 */

import { Engine, formatPlayerLog, formatSpectatorLog } from '@mtg/engine';
import type { AsyncDecisionProvider, DecisionProvider } from '@mtg/engine';
import {
  describeMessage,
  DiplomacyTable,
  HeuristicDecisionProvider,
  withDiplomacy,
  withDiplomacyAsync,
  type OfferOutcome,
} from '@mtg/bot';
import type {
  AiAnnotation,
  AiReflection,
  AnswerDealPayload,
  DealOutcomeNotice,
  DraftDealPayload,
  ProposeDealPayload,
  DecisionRequest,
  DecisionResponse,
  DebugFlags,
  GameEvent,
  GameMode,
  GameReport,
  GameReportBuild,
  GameReportCardData,
  IgnoredPlayerAbility,
  PlaybackMode,
  PlayerId,
  ProviderKind,
  ServerToClientMessage,
  SpectatorLogLine,
  TableTalkLine,
  TargetChoice,
  SubmitPlayerActionPayload,
  YieldPlayerAbilityPayload,
} from '@mtg/shared';
import {
  AiCallLogger,
  condenseSeatLog,
  configForRole,
  createConfiguredJevPolicy,
  loadAiConfig,
  OpenAiCompatibleClient,
  OpenAiDecisionProvider,
  publishReflections,
  RequestQueue,
  runDealDraft,
  runReflection,
  StrategyCoordinator,
  type AiClient,
  type AiConfig,
  type JevPolicyBinding,
  type ReflectionContext,
} from '../ai';
import type { GameStore } from '../db';
import { finishingPositions, type GameRecorder } from '../db/games';
import { releaseAnchored, releaseAnnotations } from './annotations';
import { MatchRunner } from './runner';
import {
  HumanDecisionProvider,
  PersistentAbilityYieldProvider,
  PlayerConnectionGate,
} from './human-provider';
import {
  describeSubmittedSplit,
  mayRevealSeat,
  orderedDecklist,
  publicNames,
  REPORT_LOG_LINES,
  reportDeckSource,
  reportLogLine,
  type ReportSeatSource,
} from './report';
import type { SeatSetup } from './setup';
import { SmartYieldMemory, playerYieldKey } from './player-yield';

/** `HeuristicDecisionProvider` (like the engine's `RandomDecisionProvider` before it) is
 * synchronous; the runner awaits every provider. */
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
  /**
   * Let the seats make deals and talk at the table (ADR 0035): heuristic bots, and in a
   * single-player game the player too (phase 3). Ignored for a game of model-driven seats, so an
   * AI game is unaffected.
   */
  diplomacy?: boolean;
  /** Pre-arranged deterministic lab engine; omitted for every ordinary match. */
  engine?: Engine;
  /** Deterministic non-human decisions for Card Test Lab evidence; omitted for ordinary matches. */
  decisionProviderOverrides?: Partial<Record<PlayerId, DecisionProvider>>;
  send(message: ServerToClientMessage): void;
}

export class MatchSession {
  private abandoned = false;
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
  /** Undefined until configured, null when explicitly disabled, otherwise the session's Jev lane. */
  private aiJev: JevPolicyBinding | null | undefined;
  private aiReflectionClient: AiClient | null = null;
  /** The cheap lane that reads a player's free-text deal (ADR 0035 phase 4); null without a key. */
  private aiDraftClient: AiClient | null | undefined;
  private aiDraftQueue: RequestQueue | null = null;
  private draftLogger: AiCallLogger | null = null;
  private debugFlags: DebugFlags = { ...DEFAULT_DEBUG_FLAGS };
  private readonly gameMode: GameMode;
  private readonly humanSeat: PlayerId | null;
  private readonly humanProvider: HumanDecisionProvider | null;
  private readonly connectionGate = new PlayerConnectionGate();
  private readonly ignoredAbilities = new Map<string, IgnoredPlayerAbility>();
  private readonly smartYieldMemory = new SmartYieldMemory();
  private playerRevision = 0;
  /** The human's most recent surfaced decision and answer, for "Copy game report". */
  private lastHumanDecision: {
    request: DecisionRequest;
    response: DecisionResponse;
    /** Target names as of the decision, before the targets can die or resolve. */
    names: Record<string, string>;
  } | null = null;

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
  /** The table's deals and talk (ADR 0035), when this game has diplomacy on. */
  private readonly diplomacy: DiplomacyTable | null;
  /** Table talk awaiting a log line to attach to, released with the lines like annotations. */
  private pendingTalk: TableTalkLine[] = [];
  /** Every line of table talk so far, for a reconnecting viewer. */
  private readonly allTalk: TableTalkLine[] = [];
  /** Engine repairs of attack declarations seen so far, counted incrementally. */
  private repairedAttacks = 0;
  private repairCursor = 0;
  /** Post-game reviews that have landed so far (ADR 0022 §7). */
  private readonly reflections: AiReflection[] = [];
  /** Seats already written to `game_reflections`; progress fires repeatedly with a growing list. */
  private readonly persistedReflections = new Set<PlayerId>();
  /** Reflection is fired once per game; `publishGameOver` can run twice (a player resync). */
  private reflectionsStarted = false;
  private reflectionsComplete = false;
  private reflectionRun: Promise<void> | null = null;

  constructor(private readonly opts: MatchSessionOptions) {
    if (opts.decisionProviderOverrides !== undefined && opts.engine === undefined) {
      throw new Error('decision provider overrides require a prepared Card Test Lab engine');
    }
    this.gameMode = opts.gameMode ?? 'spectator';
    this.humanSeat = this.gameMode === 'singlePlayer' ? (opts.humanSeat ?? null) : null;
    if (this.gameMode === 'singlePlayer' && this.humanSeat === null) {
      throw new Error('single-player session requires a human seat');
    }
    this.playbackMode = opts.playbackMode ?? 'live';
    this.livePaceMs = opts.livePaceMs ?? LIVE_PACE_MS;
    this.engine =
      opts.engine ??
      new Engine({
        gameId: opts.gameId,
        seed: opts.seed,
        // The human taps lands by hand if they like (ADR 0030); bots leave payment to the engine.
        players: opts.seats.map((s) =>
          s.seat === this.humanSeat ? { ...s.config, manualMana: true } : s.config,
        ),
        ...(opts.turnCap !== undefined && { turnCap: opts.turnCap }),
      });
    if (this.humanSeat !== null) this.engine.enableManualMana(this.humanSeat);
    this.recorder = opts.store?.recorderFor(opts.gameId) ?? null;
    const humanSeat = this.humanSeat;
    this.diplomacy =
      opts.diplomacy === true &&
      opts.providerKind !== 'ai' &&
      opts.decisionProviderOverrides === undefined
        ? new DiplomacyTable({
            seed: opts.seed,
            seats: opts.seats.map((s) => s.seat),
            viewOf: (seat) => this.engine.view(seat),
            negotiates: () => true,
            // The player answers offers in their own time, and the table never speaks for them.
            answersLater: (seat) => seat === humanSeat,
            repairedAttacks: () => this.countRepairedAttacks(),
          })
        : null;
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
            ...this.talkField(lines),
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
        // A strategist call fired ahead-of-time for a turn boundary reached during compute-ahead
        // is otherwise unstoppable once started — it would keep running (and billing) against a
        // game that just stopped. Reflections deliberately reuse this lane after game-over, so
        // this must only stop the coordinator's own in-flight/queued calls, not the queue itself.
        this.aiCoordinator?.cancel();
        this.aiJev?.cancel?.();
        this.publishFinalState();
        this.finishTalk();
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
        if (request.decidingPlayer === this.humanSeat) {
          this.lastHumanDecision = {
            request,
            response,
            names: publicNames(this.engine.getState(), [
              ...(response.targets ?? []).map((target) => target.choice),
              ...Object.keys(response.combatDamageSplit ?? {}),
            ]),
          };
        }
        this.aiCoordinator?.recordAcceptedDecision(request, response);
        if (request.decidingPlayer === this.humanSeat && this.opts.providerKind === 'ai') {
          this.ensureAiCoordinator().recordDecision(request, response, 'human');
        }
        this.logger?.recordAnchor(request.requestId, anchorSequence);
        this.collectTalk(anchorSequence);
        if (this.gameMode === 'singlePlayer') this.sendTalkNow();
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

  /** The game can no longer change: it finished, halted, or was abandoned. */
  isOver(): boolean {
    const status = this.runner.getStatus();
    return status === 'finished' || status === 'halted' || status === 'abandoned';
  }

  getHumanSeat(): PlayerId | null {
    return this.humanSeat;
  }

  getLivePaceMs(): number {
    return this.livePaceMs;
  }

  /**
   * "Copy game report" (`GameReport`): everything needed to file and recreate this game, seen
   * from the human seat. Only single-player sessions have one. Opponents' decklists and deck
   * sources stay hidden until the game is over; the log and pending choice are the player's own.
   */
  gameReport(context: {
    build: GameReportBuild;
    cardData: GameReportCardData;
    startedAt: string | null;
    sources: readonly ReportSeatSource[];
    cardTestScenarioId: string | null;
  }): GameReport {
    const humanSeat = this.humanSeat;
    if (humanSeat === null) throw new Error('only a single-player session has a game report');
    const over = this.isOver();
    const board = this.engine.playerState(humanSeat);
    const halt = this.runner.getHalt();
    const result = this.runner.getResult();
    const pending = this.humanProvider?.current() ?? null;
    const last = this.lastHumanDecision;
    const lastAction =
      last === null
        ? undefined
        : last.request.legalActions.find((action) => action.id === last.response.actionId);
    const nameOf = (id: string): string => last?.names[id] ?? id;

    return {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      build: context.build,
      cardData: context.cardData,
      game: {
        id: this.opts.gameId,
        seed: this.opts.seed,
        gameMode: this.gameMode,
        humanSeat,
        providerKind: this.opts.providerKind,
        playbackMode: this.playbackMode,
        paceMs: this.livePaceMs,
        startedAt: context.startedAt,
        cardTestScenarioId: context.cardTestScenarioId,
      },
      status: {
        runner: this.runner.getStatus(),
        over,
        winnerSeat: result?.winnerSeat ?? null,
        halt: halt === null ? null : { kind: halt.kind, turn: halt.turn },
      },
      position: {
        turn: board.turnNumber,
        phase: board.phase,
        step: board.step,
        activePlayer: board.activePlayer,
        priorityPlayer: board.priorityPlayer,
      },
      seats: this.opts.seats.map((setup, index) => {
        const reveal = mayRevealSeat(setup.seat, humanSeat, over);
        const seat = board.seats.find((candidate) => candidate.seat === setup.seat);
        return {
          seat: setup.seat,
          controller: setup.seat === humanSeat ? 'human' : this.opts.providerKind,
          label: setup.summary.label,
          commanderNames: [...setup.summary.commanderNames],
          colorIdentity: [...setup.summary.colorIdentity],
          archetypeTag: setup.summary.archetypeTag,
          deckSnapshotId: setup.deckSnapshotId,
          source: reportDeckSource(context.sources[index], index, this.opts.seed, reveal),
          decklist: reveal ? orderedDecklist(setup.config) : null,
          life: seat?.life ?? 0,
          poisonCounters: seat?.poisonCounters ?? 0,
          handSize: seat?.handSize ?? 0,
          librarySize: seat?.librarySize ?? 0,
          hasLost: seat?.hasLost ?? false,
          lossReason: seat?.lossReason ?? null,
        };
      }),
      pendingChoice:
        pending === null
          ? null
          : {
              requestId: pending.request.requestId,
              decisionType: pending.request.decisionType,
              prompt: pending.request.prompt,
              options: pending.request.legalActions
                .filter((action) => !this.isIgnoredAbility(action))
                .map((action) => action.description),
            },
      lastSubmittedAction:
        last === null
          ? null
          : {
              requestId: last.request.requestId,
              turn: last.request.turn,
              decisionType: last.request.decisionType,
              // A combat-damage division is answered by its split, not the preset option the
              // `actionId` names ("All 3 damage to …") — the same mismatch the engine log had.
              description:
                last.response.combatDamageSplit !== undefined
                  ? describeSubmittedSplit(
                      last.request.combatDamageSplit?.amount,
                      last.response.combatDamageSplit,
                      nameOf,
                    )
                  : (lastAction?.description ?? `action ${last.response.actionId}`),
              targets: (last.response.targets ?? []).map((target) => nameOf(target.choice)),
            },
      recentLog: formatPlayerLog(this.engine.eventsSince(0), humanSeat)
        .slice(-REPORT_LOG_LINES)
        .map(reportLogLine),
    };
  }

  setDebugFlags(flags: DebugFlags): void {
    if (this.gameMode === 'singlePlayer') return;
    this.debugFlags = { ...flags };
  }

  // ── The presentation clock ────────────────────────────────────────────────────────────────

  private startPresenting(): void {
    if (this.abandoned || this.playbackMode !== 'live') return;

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
        ...this.talkField(lines),
      },
    });
  }

  // ── Table talk (ADR 0035) ─────────────────────────────────────────────────────────────────

  private countRepairedAttacks(): number {
    for (const event of this.engine.eventsSince(this.repairCursor)) {
      if (event.type === 'attackDeclarationRepaired') this.repairedAttacks++;
      this.repairCursor = event.sequence + 1;
    }
    return this.repairedAttacks;
  }

  /**
   * Take whatever the table said since the last decision and anchor it to `sequence`, the first
   * event of the decision just made: talk from a turn's negotiation window and judgments of the
   * previous decision both land beside the play that follows them.
   */
  private collectTalk(sequence: number): void {
    if (this.diplomacy === null) return;
    const lines = this.diplomacy.drain().map((message) => ({
      sequence,
      turn: message.turn,
      message,
      text: describeMessage(message),
    }));
    this.pendingTalk.push(...lines);
  }

  /**
   * Keep and store talk as it is released, with the anchor viewers were sent: history and the live
   * stream then agree on every line's sequence, so a reload finds each line beside its log line.
   */
  private recordTalk(lines: readonly TableTalkLine[]): void {
    if (lines.length === 0) return;
    this.allTalk.push(...lines);
    this.recorder?.saveTableTalk(lines);
  }

  /** Talk to ship with a batch of lines, absent when there is none (so the payload never grows). */
  private talkField(lines: readonly SpectatorLogLine[]): { tableTalk?: TableTalkLine[] } {
    if (this.pendingTalk.length === 0) return {};
    const { due, held } = releaseAnchored(this.pendingTalk, lines);
    this.pendingTalk = held;
    this.recordTalk(due);
    return due.length > 0 ? { tableTalk: due } : {};
  }

  /**
   * Close the table at game end: judge a held attack, then send what is left at once, since no
   * later log line will carry it.
   */
  private finishTalk(): void {
    if (this.diplomacy === null) return;
    this.diplomacy.flush();
    const last = this.engine.eventsSince(0).at(-1)?.sequence ?? 0;
    this.collectTalk(last);
    if (this.pendingTalk.length === 0) return;
    const tableTalk = this.pendingTalk;
    this.pendingTalk = [];
    this.recordTalk(tableTalk);
    this.opts.send({
      type: 'eventBatch',
      payload: {
        gameId: this.opts.gameId,
        lines: [],
        frontierTurn: this.runner.getFrontierTurn(),
        snapshotTurns: this.runner.getSnapshotTurns(),
        tableTalk,
      },
    });
  }

  /**
   * Player mode has no presentation clock, so talk goes out as soon as it is said, on a batch of
   * its own. Talk is public; the player sees every line, whoever said it.
   */
  private sendTalkNow(): void {
    if (this.pendingTalk.length === 0) return;
    const tableTalk = this.pendingTalk;
    this.pendingTalk = [];
    this.recordTalk(tableTalk);
    this.opts.send({
      type: 'eventBatch',
      payload: {
        gameId: this.opts.gameId,
        lines: [],
        frontierTurn: this.runner.getFrontierTurn(),
        snapshotTurns: [],
        tableTalk,
      },
    });
  }

  /** The player's seat state at the table, after anything that may have changed it. */
  private sendDiplomacyState(outcome?: DealOutcomeNotice): void {
    if (this.diplomacy === null || this.humanSeat === null) return;
    this.opts.send({
      type: 'diplomacyState',
      payload: {
        gameId: this.opts.gameId,
        state: this.diplomacy.seatState(this.humanSeat),
        ...(outcome !== undefined ? { outcome } : {}),
      },
    });
  }

  /** Anchor talk the player started to the last event so far, and send it with the new state. */
  private afterPlayerDeal(outcome: OfferOutcome): void {
    const last = this.runner.nextSequence() - 1;
    this.collectTalk(Math.max(0, last));
    this.sendTalkNow();
    this.sendDiplomacyState(noticeOf(outcome));
  }

  /** The player offers a deal (ADR 0035 phase 3). The table checks it like any other offer. */
  proposeDeal(payload: ProposeDealPayload): void {
    if (this.diplomacy === null || this.humanSeat === null || this.isOver()) {
      this.opts.send({ type: 'error', payload: { message: 'Deals are off in this game.' } });
      return;
    }
    this.afterPlayerDeal(this.diplomacy.offer({ proposer: this.humanSeat, ...payload }));
  }

  /** The player answers an offer waiting on them, optionally with terms of their own. */
  answerDeal(payload: AnswerDealPayload): void {
    if (this.diplomacy === null || this.humanSeat === null || this.isOver()) {
      this.opts.send({ type: 'error', payload: { message: 'Deals are off in this game.' } });
      return;
    }
    this.afterPlayerDeal(
      this.diplomacy.answer(this.humanSeat, payload.dealId, payload.answer, payload.counter),
    );
  }

  /**
   * Read the player's free text as deal terms with one cheap call (ADR 0035 phase 4) and send the
   * reading back for the deal panel. Nothing is offered: the player checks the terms and sends
   * them, and they go through `offer` like any other proposal.
   */
  async draftDeal(payload: DraftDealPayload): Promise<void> {
    if (this.diplomacy === null || this.humanSeat === null || this.isOver()) {
      this.opts.send({ type: 'error', payload: { message: 'Deals are off in this game.' } });
      return;
    }
    const seat = this.humanSeat;
    const state = this.diplomacy.seatState(seat);
    const config = (this.aiConfig ??= loadAiConfig(process.env));
    if (this.aiDraftClient === undefined) {
      this.aiDraftClient =
        config.apiKey === ''
          ? null
          : new OpenAiCompatibleClient(configForRole(config, 'tactician'));
      this.draftLogger =
        this.logger ?? new AiCallLogger(this.opts.store?.raw ?? null, this.opts.gameId);
      this.aiDraftClient?.setAttemptObserver?.(this.draftLogger.attemptObserver());
    }
    // Its own lane, so a draft never waits behind a model seat's tactical decision.
    const queue = (this.aiDraftQueue ??= new RequestQueue({
      rpmLimit: config.rpmLimit,
      concurrency: 1,
    }));
    const draft = await runDealDraft(
      this.aiDraftClient,
      queue,
      payload.text,
      {
        gameId: this.opts.gameId,
        turn: state.turn,
        seat,
        opponents: this.engine.view(seat).opponents.map((o) => o.seat),
        maxRounds: state.maxRounds,
        maxObligationsPerSide: state.maxObligationsPerSide,
      },
      { logger: this.draftLogger ?? undefined },
    );
    if (this.abandoned) return;
    this.opts.send({ type: 'dealDraft', payload: draft });
  }

  /** Every line of table talk released so far, for a viewer who reconnects or reloads. */
  tableTalk(): readonly TableTalkLine[] {
    return this.allTalk;
  }

  /** Whether the bots at this table negotiate (ADR 0035). */
  hasDiplomacy(): boolean {
    return this.diplomacy !== null;
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

  /**
   * Every rejection here echoes the submission's `requestId`/`revision` (`ErrorPayload`), because
   * these are the only errors that say anything about an in-flight player action. A client cannot
   * tell a rejection from an unrelated server error by message text, and guessing either drops the
   * decision or resubmits it.
   */
  submitPlayerAction(payload: SubmitPlayerActionPayload): void {
    const rejected = (message: string): void => {
      this.opts.send({
        type: 'error',
        payload: { message, requestId: payload.requestId, revision: payload.revision },
      });
    };
    if (this.humanProvider === null) {
      rejected('This is not a single-player game.');
      return;
    }
    const pending = this.humanProvider.current();
    const error = this.humanProvider.submit(payload);
    if (error !== null) {
      rejected(error);
      return;
    }
    // Record only an accepted pass, before the runner advances the board. A stale or
    // invalid response must never silence a future opportunity.
    if (
      pending?.request.decisionType === 'priority' &&
      ['pass', 'passAndYieldTurn', 'yieldToAbility'].includes(
        pending.request.legalActions.find((action) => action.id === payload.actionId)?.type ?? '',
      )
    ) {
      this.smartYieldMemory.dismiss(
        pending.request.legalActions,
        this.ignoredAbilities,
        this.engine.playerState(this.humanSeat!),
      );
    }
  }

  yieldPlayerAbility(payload: YieldPlayerAbilityPayload): void {
    const pending = this.humanProvider?.current();
    if (pending === null || pending === undefined) {
      this.opts.send({
        type: 'error',
        payload: { message: 'No player action is currently required.' },
      });
      return;
    }
    if (payload.requestId !== pending.request.requestId || payload.revision !== pending.revision) {
      this.opts.send({ type: 'error', payload: { message: 'That ability choice is stale.' } });
      return;
    }
    const action = pending.request.legalActions.find(
      (candidate) => candidate.id === payload.actionId,
    );
    const interaction = action?.interaction;
    if (
      pending.request.decisionType !== 'priority' ||
      action === undefined ||
      interaction?.kind !== 'source' ||
      playerYieldKey(action) === null ||
      (action.type === 'castSpell' && payload.mode !== 'smart')
    ) {
      this.opts.send({
        type: 'error',
        payload: { message: 'Yield an optional activation, or smart yield an optional spell.' },
      });
      return;
    }
    const key = playerYieldKey(action)!;
    this.ignoredAbilities.set(key, {
      key,
      label: action.description,
      mode: payload.mode ?? 'always',
    });
    // Choosing yield also declines the current opportunity, including every mode/X
    // value sharing this preference. It must not immediately reoffer the same choice.
    this.smartYieldMemory.dismiss(
      pending.request.legalActions.filter((candidate) => playerYieldKey(candidate) === key),
      this.ignoredAbilities,
      this.engine.playerState(this.humanSeat!),
    );
    this.sendPlayerActionRequired(pending.request, pending.revision);
  }

  resumePlayerAbility(key: string): void {
    if (!this.ignoredAbilities.delete(key)) {
      this.opts.send({
        type: 'error',
        payload: { message: 'That yielded ability is no longer available.' },
      });
      return;
    }
    this.smartYieldMemory.resume(key);
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
        ...(this.allTalk.length > 0 ? { tableTalk: [...this.allTalk] } : {}),
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
    this.abandoned = true;
    this.stopPresenting();
    this.pendingLines = [];
    this.aiCoordinator?.cancel();
    this.aiJev?.cancel?.();
    this.runner.abandon();
    this.humanProvider?.releaseForAbandon();
    this.connectionGate.release();
  }

  private publishPlayerState(bump: boolean): void {
    if (this.humanSeat === null) return;
    if (bump) this.playerRevision += 1;
    this.sendDiplomacyState();
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
    const state = this.engine.playerState(this.humanSeat);
    const legalActions =
      request.decisionType === 'priority'
        ? request.legalActions.filter(
            (action) => !this.smartYieldMemory.isYielded(action, this.ignoredAbilities, state),
          )
        : request.legalActions;
    const pass = legalActions.find((action) => action.type === 'pass');
    if (
      request.decisionType === 'priority' &&
      pass !== undefined &&
      legalActions.length < request.legalActions.length &&
      // Making mana by hand alone is no reason to stop, as the engine's own quiet-window rule
      // says (ADR 0030).
      legalActions.every((action) =>
        ['pass', 'passAndYieldTurn', 'yieldToAbility', 'activateManaAbility'].includes(action.type),
      )
    ) {
      // Only the player's explicit preference removes optional choices. Keep costs, targeting,
      // combat declarations and every unyielded action in the ordinary human decision flow.
      this.publishPlayerState(false);
      this.humanProvider?.submit({ requestId: request.requestId, revision, actionId: pass.id });
      return;
    }
    this.opts.send({
      type: 'playerActionRequired',
      payload: {
        request: {
          ...request,
          legalActions,
        },
        revision,
        state,
        ignoredAbilities: this.ignoredAbilityList(),
      },
    });
  }

  private isIgnoredAbility(action: DecisionRequest['legalActions'][number]): boolean {
    if (this.humanSeat === null || this.ignoredAbilities.size === 0) return false;
    return this.smartYieldMemory.isYielded(
      action,
      this.ignoredAbilities,
      this.engine.playerState(this.humanSeat),
    );
  }

  private ignoredAbilityList(): IgnoredPlayerAbility[] {
    return [...this.ignoredAbilities.values()];
  }

  /**
   * Push the true final board to spectators before announcing the result.
   *
   * Turn snapshots are taken at a turn's *start* (`MatchRunner.onTurnAdvanced`); the terminal
   * re-snapshot the runner takes in `finish()`/`recordHalt()` corrects that same turn number in
   * place. The presentation clock only ever re-presents a turn it hasn't shown yet
   * (`nextPresentableTurn`), so that correction otherwise never reaches the client — a spectator's
   * board freezes on the board as it stood *before* the game-ending elimination, with the loser
   * still sitting at their old life total under a "Game Over" banner. Single-player mode is
   * unaffected: it gets a full `replayUnlocked` state separately.
   */
  private publishFinalState(): void {
    if (this.gameMode !== 'spectator') return;
    this.stopPresenting();
    this.flushPendingLines();
    const turn = this.engine.getState().turnNumber;
    this.presentedTurn = turn;
    this.runner.setViewTurn(turn);
    this.opts.send({
      type: 'stateSnapshot',
      payload: {
        turn,
        state: this.engine.spectatorState(),
        frontierTurn: turn,
        atFrontier: true,
        sequence: null,
      },
    });
  }

  private publishGameOver(result: NonNullable<ReturnType<Engine['getResult']>>): void {
    this.publishFinalState();
    this.finishTalk();
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
    if (this.reflections.length > 0)
      this.sendReflections(this.reflections, this.reflectionsComplete);
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
    return this.opts.seats.map((seat) => seat.seat).filter((seat) => seat !== this.humanSeat);
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
    this.aiReflectionClient.setAttemptObserver?.(this.logger?.attemptObserver());
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
      // The player's decisions open negotiation windows and are judged for compliance like any
      // seat's; offers to the player wait for their answer rather than this decision.
      const human: AsyncDecisionProvider =
        this.diplomacy === null
          ? this.humanProvider
          : withDiplomacyAsync(this.diplomacy, this.humanProvider);
      this.providers.set(playerId, human);
      return human;
    }

    const decisionProviderOverride = this.opts.decisionProviderOverrides?.[playerId];
    if (decisionProviderOverride !== undefined) {
      const provider = new AsyncAdapter(decisionProviderOverride);
      this.providers.set(playerId, provider);
      return provider;
    }

    const table = this.diplomacy;
    const heuristic = (): DecisionProvider => {
      const bot = new HeuristicDecisionProvider(
        `${this.opts.seed}-${playerId}`,
        () => this.engine.view(playerId),
        table === null ? {} : { diplomacy: table.playFor(playerId) },
      );
      return table === null ? bot : withDiplomacy(table, bot);
    };
    const inner: AsyncDecisionProvider =
      this.opts.providerKind === 'ai' ? this.buildAiProvider() : new AsyncAdapter(heuristic());
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
      this.aiJev ?? undefined,
    );
  }

  private ensureAiCoordinator(): StrategyCoordinator {
    const config = (this.aiConfig ??= loadAiConfig(process.env));
    this.aiStrategistClient ??= new OpenAiCompatibleClient(configForRole(config, 'strategist'));
    this.aiTacticianClient ??= new OpenAiCompatibleClient(configForRole(config, 'tactician'));
    this.aiStrategistClient.setAttemptObserver(this.logger?.attemptObserver());
    this.aiTacticianClient.setAttemptObserver(this.logger?.attemptObserver());
    if (this.aiJev === undefined) {
      this.aiJev =
        createConfiguredJevPolicy(
          config,
          process.env,
          this.logger?.attemptObserver(),
          this.logger?.jevTraceObserver(),
        ) ?? null;
    }
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
        new Map(
          this.opts.seats.flatMap((seat) => {
            const snapshotId = seat.deckSnapshotId;
            const profile =
              snapshotId === null || snapshotId === undefined
                ? null
                : (this.opts.store?.strategyProfile(snapshotId) ?? null);
            return profile === null ? [] : [[seat.seat, profile]];
          }),
        ),
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

function noticeOf(outcome: OfferOutcome): DealOutcomeNotice {
  switch (outcome.kind) {
    case 'accepted':
    case 'pending':
    case 'withdrawn':
      return { kind: outcome.kind, dealId: outcome.deal.id };
    case 'declined':
      return {
        kind: 'declined',
        ...(outcome.counter !== undefined ? { dealId: outcome.counter.id } : {}),
        ...(outcome.counterPending === true ? { counterPending: true } : {}),
      };
    case 'refused':
      return { kind: 'refused', reason: outcome.reason };
  }
}

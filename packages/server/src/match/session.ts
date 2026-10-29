/**
 * A `MatchSession` is one game plus everything around it: the engine, the per-seat decision
 * providers, the `MatchRunner`, the recorder, and the outbound message stream. The WebSocket
 * layer owns sessions and does nothing else — it translates frames to method calls and
 * broadcasts what comes back.
 */

import { assertNever } from '@mtg/shared';
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
  ComputeHaltedPayload,
  DealOutcomeNotice,
  DraftDealPayload,
  ProposeDealPayload,
  DecisionRequest,
  DecisionResponse,
  DebugFlags,
  GameEvent,
  GameMode,
  GameReport,
  GameOverPayload,
  GameResult,
  GameReportBuild,
  GameReportCardData,
  IgnoredPlayerAbility,
  PlaybackMode,
  PlayerBoardState,
  PlayerId,
  ProviderKind,
  SeatControllers,
  ServerToClientMessage,
  StartGameMode,
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
  readStrategistProposal,
  runDealDraft,
  runReflection,
  seatDiplomacyContext,
  StrategyCoordinator,
  type AiClient,
  type AiConfig,
  type JevPolicyBinding,
  type ReflectionContext,
} from '../ai';
import type { GameStore } from '../db';
import { finishingPositions, type DecisionSource, type GameRecorder } from '../db/games';
import { releaseAnchored, releaseAnnotations } from './annotations';
import {
  checkOutbound,
  mayShowArchetypeTag,
  mayShowDecklists,
  seedLabel,
  type DisclosurePolicy,
} from './disclosure';
import {
  MatchRunner,
  type DecisionEscalation,
  type HaltInfo,
  type MatchRunnerOptions,
} from './runner';
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
import { buildReplayRecord, type ReplayIdentity } from './replay-config';
import { botRandomSource, resolveRngKey, seatIndex } from './rng-streams';
import type { SeatSetup } from './setup';
import { lossReasonLabel } from './loss-reasons';
import { SmartYieldMemory, playerYieldKey } from './player-yield';
import { enrichPresentation, gameOverSummary, playerFacingEvents } from './presentation';

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

/** What a reader without raw error text is told when the engine stops. */
const HALT_NOTICE = 'The rules engine could not continue this game.';

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
  /**
   * The game's random generator (ADR 0031 decision 4). Omitted is `'legacy'`, seeded from `seed`,
   * which every tester game keeps. `'chacha20'` needs `rngKey`, 32 bytes as 64 hex digits: the
   * engine, each bot seat and each generated deck read their own stream of it, and it reaches no
   * frame, event or snapshot before the game ends. `seed` is then only a public label.
   */
  rng?: 'legacy' | 'chacha20';
  rngKey?: string;
  /**
   * What this game's frames may carry (ADR 0031 decision 3). Required: each entry point decides,
   * and none inherits another's. `GameServer` passes `testerPolicy(gameMode)`.
   */
  disclosure: DisclosurePolicy;
  /**
   * What `games.config_json` and the build columns record so the game can be replayed from its
   * stored inputs (ADR 0031 decision 8). Omit for a game that starts from a prepared engine
   * (Card Test Lab), which stores none.
   */
  replay?: ReplayIdentity;
  /** The one human seat of a `'singlePlayer'` game. */
  humanSeat?: PlayerId;
  /**
   * Who answers each seat of a `'table'` game (ADR 0031 decision 2): at least one `human`, and
   * every other seat the session's `providerKind`. Not accepted for other modes, which derive
   * theirs from `humanSeat`.
   */
  seatControllers?: SeatControllers;
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
   * Let the seats make deals and talk at the table (ADR 0035): heuristic bots, model-driven seats
   * (phase 4, proposing through their strategist), and in a single-player game the player too
   * (phase 3).
   */
  diplomacy?: boolean;
  /** Pre-arranged deterministic lab engine; omitted for every ordinary match. */
  engine?: Engine;
  /** Deterministic non-human decisions for Card Test Lab evidence; omitted for ordinary matches. */
  decisionProviderOverrides?: Partial<Record<PlayerId, DecisionProvider>>;
  /**
   * Frames every viewer of the game may see. A single-player game's one stream is the player's,
   * so everything it sends, public or seat-scoped, arrives here.
   */
  send(message: ServerToClientMessage): void;
  /**
   * Frames for one human seat of a `'table'` game. Required there, and never called for another
   * mode; the table server routes each frame to that seat's own sockets only.
   */
  sendToSeat?(seat: PlayerId, message: ServerToClientMessage): void;
}

/** Free-text deal readings (ADR 0035 phase 4) one game may ask for: each is a paid call. */
const MAX_DEAL_DRAFTS_PER_GAME = 20;

/** What the human's last surfaced decision and answer were, for "Copy game report". */
interface LastHumanDecision {
  request: DecisionRequest;
  response: DecisionResponse;
  /** Target names as of the decision, before the targets can die or resolve. */
  names: Record<string, string>;
}

/** Everything the session keeps for one human seat; a table has one per human. */
class HumanSeatState {
  readonly provider: HumanDecisionProvider;
  readonly connectionGate = new PlayerConnectionGate();
  readonly ignoredAbilities = new Map<string, IgnoredPlayerAbility>();
  readonly smartYieldMemory = new SmartYieldMemory();
  playerRevision = 0;
  lastHumanDecision: LastHumanDecision | null = null;

  constructor(onRequired: (request: DecisionRequest, revision: number) => void) {
    this.provider = new HumanDecisionProvider(
      () => ++this.playerRevision,
      ({ request, revision }) => {
        onRequired(request, revision);
      },
    );
  }
}

export class MatchSession {
  private abandoned = false;
  readonly engine: Engine;
  readonly runner: MatchRunner;
  private readonly logger: AiCallLogger | null;
  private readonly recorder: GameRecorder | null;
  private readonly providers = new Map<PlayerId, AsyncDecisionProvider>();
  /** The `chacha20` key, or null for a legacy game. Held here and in the engine's stream only. */
  private readonly rngKey: string | null;
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
  /** Free-text readings asked for this game, and whether one is running: each is a paid call. */
  private draftsUsed = 0;
  private draftInFlight = false;
  private debugFlags: DebugFlags = { ...DEFAULT_DEBUG_FLAGS };
  private readonly gameMode: GameMode;
  /** What this game's frames may carry; every fence below reads it. */
  private readonly policy: DisclosurePolicy;
  /**
   * Who answered each request, tagged before `onDecision` fires. A request with no tag was
   * answered by its seat's own provider: the person at a human seat, the bot elsewhere.
   */
  private readonly decisionSources = new Map<string, DecisionSource>();
  /** Who answers each seat; a seat is `human` exactly when it is in `humanSeats`. */
  private readonly seatControllers: SeatControllers;
  private readonly humanSeats: ReadonlySet<PlayerId>;
  /** Per-human-seat state, keyed by the same seats as `humanSeats`. */
  private readonly humanStates = new Map<PlayerId, HumanSeatState>();

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
  /** Strategist proposals made ahead of the turn they are for (ADR 0035 phase 4). */
  private deferredProposals: Array<{ turn: number; seat: PlayerId; raw: unknown }> = [];
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
    this.rngKey = resolveRngKey(opts);
    if (this.rngKey !== null && opts.engine !== undefined) {
      throw new Error('a prepared engine brings its own random source');
    }
    this.gameMode = opts.gameMode ?? 'spectator';
    this.policy = opts.disclosure;
    this.seatControllers = resolveSeatControllers(opts, this.gameMode);
    this.humanSeats = new Set(
      opts.seats.map((s) => s.seat).filter((seat) => this.seatControllers[seat] === 'human'),
    );
    for (const seat of this.humanSeats) {
      this.humanStates.set(
        seat,
        new HumanSeatState((request, revision) => {
          this.sendPlayerActionRequired(seat, request, revision);
        }),
      );
    }
    this.playbackMode = opts.playbackMode ?? 'live';
    this.livePaceMs = opts.livePaceMs ?? LIVE_PACE_MS;
    this.engine =
      opts.engine ??
      new Engine({
        gameId: opts.gameId,
        seed: opts.seed,
        ...(this.rngKey !== null && { rng: 'chacha20' as const, rngKey: this.rngKey }),
        // The human taps lands by hand if they like (ADR 0030); bots leave payment to the engine.
        players: opts.seats.map((s) =>
          this.humanSeats.has(s.seat) ? { ...s.config, manualMana: true } : s.config,
        ),
        ...(opts.turnCap !== undefined && { turnCap: opts.turnCap }),
      });
    for (const seat of this.humanSeats) this.engine.enableManualMana(seat);
    this.recorder = opts.store?.recorderFor(opts.gameId) ?? null;
    const humanSeats = this.humanSeats;
    this.diplomacy =
      opts.diplomacy === true && opts.decisionProviderOverrides === undefined
        ? new DiplomacyTable({
            seed: opts.seed,
            seats: opts.seats.map((s) => s.seat),
            viewOf: (seat) => this.engine.view(seat),
            negotiates: () => true,
            // The player answers offers in their own time, and the table never speaks for them.
            answersLater: (seat) => humanSeats.has(seat),
            // A model seat proposes through its strategist (phase 4), not the heuristic proposer;
            // it still answers offers at once with the same evaluator, with no model call.
            proposesOnItsOwn: (seat) => !humanSeats.has(seat) && opts.providerKind !== 'ai',
            repairedAttacks: () => this.countRepairedAttacks(),
          })
        : null;
    this.logger =
      opts.providerKind === 'ai' ? new AiCallLogger(opts.store?.raw ?? null, opts.gameId) : null;

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
        controllerKind: this.seatControllers[s.seat] ?? opts.providerKind,
      })),
      providerFor: (playerId) => this.providerFor(playerId),
      recorder: this.recorder,
      ...this.replayRecord(),
      gameMode: this.gameMode,
      // Every human decision is untimed, so the engine never computes ahead of what they have seen.
      ...(this.humanSeats.size > 0 ? { lookaheadTurns: 0 } : {}),
      ...this.eventFormatting(),
      onEvents: (lines, frontierTurn, snapshotTurns, seat) => {
        switch (this.gameMode) {
          // flow: event batches go to the player, formatted for that seat (m1 row 300). A table
          // gets one batch per human seat from the runner's per-seat formatter.
          case 'singlePlayer':
            this.sendToSeat(this.soleHumanSeat(), {
              type: 'eventBatch',
              payload: { gameId: opts.gameId, lines, frontierTurn, snapshotTurns: [] },
            });
            return;
          case 'table':
            if (seat === undefined) throw new Error('a table event batch names its seat');
            this.sendToSeat(seat, {
              type: 'eventBatch',
              payload: { gameId: opts.gameId, lines, frontierTurn, snapshotTurns: [] },
            });
            return;
          case 'spectator':
            break;
          default:
            assertNever(this.gameMode, 'event batch game mode');
        }
        // In live mode the log is released in step with the board. Sending every line the
        // instant it is computed is how the action log ends up describing a turn the board has
        // not reached — the same desync from the other side.
        if (this.playbackMode === 'live' && this.livePaceMs > 0) {
          this.pendingLines.push(...lines);
          this.releaseLines();
          return;
        }
        this.sendPublic({
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
        switch (this.gameMode) {
          // flow: live spectator presentation after events (m1 row 331). A player has no
          // presentation clock, and a table never starts one: it would send `spectatorState`.
          case 'spectator':
            if (this.playbackMode === 'live') this.startPresenting();
            return;
          case 'singlePlayer':
          case 'table':
            return;
          default:
            assertNever(this.gameMode, 'snapshot presentation');
        }
      },
      onProgress: (frontierTurn) => {
        switch (this.gameMode) {
          // flow: player mode has one clock: every authoritative advance is immediately presented
          // to each human seat (m1 row 334).
          case 'singlePlayer':
          case 'table':
            this.runner.setViewTurn(frontierTurn);
            for (const seat of this.humanSeats) this.publishPlayerState(seat, true);
            return;
          case 'spectator':
            return;
          default:
            assertNever(this.gameMode, 'progress presentation');
        }
      },
      onDecisionPending: (request, invalidResponse, timeoutMs) => {
        switch (this.gameMode) {
          // fence: `decisionPending` carries the request and the failed model's raw detail, so
          // only a policy that shows raw error text sends one (m1 row 341).
          case 'spectator':
          case 'singlePlayer':
          case 'table':
            if (!this.policy.rawErrorText) return;
            this.sendPublic({
              type: 'decisionPending',
              payload: { request, invalidResponse, timeoutMs },
            });
            return;
          default:
            assertNever(this.gameMode, 'decision pending');
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
        this.sendPublic({
          type: 'computeHalted',
          payload: this.haltPayload(info),
        });
        // A halt is the end of the game for the policy's post-game unlock (ADR 0031 decision 3),
        // when it says so. The runner has no result when the loop itself threw.
        if (this.policy.haltIsTerminal) {
          this.publishGameOver(this.runner.getResult() ?? this.haltResult(info));
        }
      },
      onGameOver: (result) => {
        this.publishGameOver(result);
      },
      onDecision: (request, response, anchorSequence) => {
        const decidingHuman = this.humanStates.get(request.decidingPlayer);
        if (decidingHuman !== undefined) {
          decidingHuman.lastHumanDecision = {
            request,
            response,
            names: publicNames(this.engine.getState(), [
              ...(response.targets ?? []).map((target) => target.choice),
              ...Object.keys(response.combatDamageSplit ?? {}),
            ]),
          };
        }
        this.recordDecisionSource(request);
        this.aiCoordinator?.recordAcceptedDecision(request, response);
        if (decidingHuman !== undefined && this.opts.providerKind === 'ai') {
          this.ensureAiCoordinator().recordDecision(request, response, 'human');
        }
        this.logger?.recordAnchor(request.requestId, anchorSequence);
        this.offerDeferredProposals();
        this.collectTalk(anchorSequence);
        switch (this.gameMode) {
          // flow: table talk goes out at once, to each human seat (m1 row 391). A spectator's
          // talk rides the presentation clock with the log lines instead.
          case 'singlePlayer':
          case 'table':
            this.sendTalkNow();
            break;
          case 'spectator':
            break;
          default:
            assertNever(this.gameMode, 'table talk delivery');
        }
        // The note is the gate, not the provider kind: a random provider never writes one, and
        // a human seat's own choices are theirs rather than reasoning to be explained back
        // (m1 row 394: a seat test, not a mode branch).
        if (!this.humanSeats.has(request.decidingPlayer) && response.note !== undefined) {
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
        switch (this.gameMode) {
          // fence: debug events can show a hidden zone, so only a policy that allows them sends
          // any (m1 row 412).
          case 'spectator':
          case 'singlePlayer':
          case 'table':
            if (!this.policy.debugEvents) return;
            break;
          default:
            assertNever(this.gameMode, 'debug events');
        }
        if (!this.debugFlags.verboseEngine) return;
        this.sendPublic({
          type: 'debugEvents',
          payload: { gameId: opts.gameId, entries },
        });
      },
    });
  }

  /**
   * How the runner formats the log for the people who play.
   *
   * flow: event formatting by mode (m1 row 300's formatter). A single player gets one stream; a
   * table gets one per human seat, each through that seat's own `formatPlayerLog`.
   */
  private eventFormatting(): Pick<MatchRunnerOptions, 'formatEvents' | 'seatEvents'> {
    switch (this.gameMode) {
      case 'spectator':
        return { formatEvents: (events) => formatSpectatorLog(playerFacingEvents(events)) };
      case 'singlePlayer':
        return {
          formatEvents: (events) =>
            formatPlayerLog(playerFacingEvents(events), this.soleHumanSeat()),
        };
      case 'table':
        return {
          seatEvents: {
            seats: [...this.humanSeats],
            format: (events, seat) => formatPlayerLog(playerFacingEvents(events), seat),
          },
        };
      default:
        return assertNever(this.gameMode, 'event formatting');
    }
  }

  /**
   * The halt notice. Unless the policy shows raw error text, the reader is told one fixed line
   * and never the card, since both can name hidden information (m1 rows 360, 364).
   *
   * fence: the policy's `rawErrorText`.
   */
  private haltPayload(info: HaltInfo): ComputeHaltedPayload {
    switch (this.gameMode) {
      case 'spectator':
      case 'singlePlayer':
      case 'table':
        if (!this.policy.rawErrorText) {
          return {
            gameId: this.opts.gameId,
            kind: info.kind,
            reason: HALT_NOTICE,
            turn: info.turn,
          };
        }
        return {
          gameId: this.opts.gameId,
          kind: info.kind,
          reason: info.reason,
          turn: info.turn,
          ...(info.cardName !== undefined ? { cardName: info.cardName } : {}),
        };
      default:
        return assertNever(this.gameMode, 'halt notice');
    }
  }

  /** The result of a game that halted before the engine produced one: nobody won, nothing raw. */
  private haltResult(info: HaltInfo): GameResult {
    return {
      gameId: this.opts.gameId,
      winnerSeat: null,
      finishingOrder: [...this.engine.getState().eliminatedPlayers],
      turnCount: info.turn,
      halted: true,
      haltReason: this.policy.rawErrorText ? info.reason : HALT_NOTICE,
    };
  }

  /**
   * A result as the policy lets it out. A halted result carries the engine's raw reason and the
   * code site that raised it, which a policy without raw error text must not send.
   */
  private disclosedResult(result: GameResult): GameResult {
    if (this.policy.rawErrorText || !result.halted) return result;
    const { haltSite: _site, ...rest } = result;
    return { ...rest, haltReason: HALT_NOTICE };
  }

  /**
   * The replay inputs for the `games` row (ADR 0031 decision 8), or nothing for a game that does
   * not store them: no recorder, a prepared Card Test Lab engine, or an entry point that named no
   * build.
   */
  private replayRecord(): Pick<MatchRunnerOptions, 'replay'> {
    const identity = this.opts.replay;
    if (identity === undefined || this.recorder === null || this.opts.engine !== undefined) {
      return {};
    }
    return {
      replay: buildReplayRecord({
        identity,
        // The same fallback the runner's seat records use: setup always writes a real snapshot
        // when a store exists, and without a store there is no recorder to get here.
        seats: this.opts.seats.map((s) => ({
          seat: s.seat,
          deckSnapshotId: s.deckSnapshotId ?? s.config.deckId,
        })),
        manualMana: this.humanSeats,
        turnCap: engineTurnCap(this.engine),
        rng: { kind: this.rngKey === null ? 'legacy' : 'chacha20', key: this.rngKey ?? '' },
      }),
    };
  }

  /** Tag the answer to a request, before the runner reports it (`onDecision`). First tag wins. */
  private tagDecisionSource(requestId: string, source: DecisionSource): void {
    if (!this.decisionSources.has(requestId)) this.decisionSources.set(requestId, source);
  }

  /**
   * Write who answered a request. Only games with a human seat record it: it is attribution for
   * the people at the table, and a no-human game would add one row per bot decision for nothing.
   */
  private recordDecisionSource(request: DecisionRequest): void {
    const tagged = this.decisionSources.get(request.requestId);
    this.decisionSources.delete(request.requestId);
    if (this.humanSeats.size === 0) return;
    const source: DecisionSource =
      tagged ?? (this.humanSeats.has(request.decidingPlayer) ? 'human' : 'bot');
    try {
      this.recorder?.saveDecisionSource(request.requestId, request.decidingPlayer, source);
    } catch {
      // Attribution must never stop a game.
    }
  }

  start(): void {
    if (this.running !== null) return;
    this.running = this.runner
      .run()
      .catch((err: unknown) => {
        this.sendPublic({
          type: 'error',
          payload: { message: this.runnerErrorMessage(err) },
        });
      })
      .finally(() => {
        // Compute is done; anything still queued behind the presentation clock is now all
        // there will ever be, so let the clock drain it and stop.
        switch (this.gameMode) {
          // flow: presentation when compute ends (m1 row 441).
          case 'spectator':
            this.startPresenting();
            return;
          case 'singlePlayer':
          case 'table':
            return;
          default:
            assertNever(this.gameMode, 'compute end presentation');
        }
      });
    switch (this.gameMode) {
      // flow: the player's first board, per human seat, and no presentation clock (m1 row 443).
      case 'singlePlayer':
      case 'table':
        for (const seat of this.humanSeats) this.publishPlayerState(seat, true);
        return;
      case 'spectator':
        if (this.playbackMode === 'live') this.startPresenting();
        return;
      default:
        assertNever(this.gameMode, 'start presentation');
    }
  }

  /**
   * A runner error's message. Unless the policy shows raw error text, the reader is told one
   * fixed line and never the raw error (m1 row 430).
   *
   * fence: the policy's `rawErrorText`.
   */
  private runnerErrorMessage(err: unknown): string {
    switch (this.gameMode) {
      case 'spectator':
      case 'singlePlayer':
      case 'table':
        if (!this.policy.rawErrorText) return 'The game runner stopped unexpectedly.';
        return err instanceof Error ? err.message : String(err);
      default:
        return assertNever(this.gameMode, 'runner error');
    }
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
    switch (this.gameMode) {
      // flow: a player game is live only, whatever the client asks (m1 row 457). A table is too.
      case 'singlePlayer':
      case 'table':
        this.playbackMode = 'live';
        if (paceMs !== undefined) this.livePaceMs = Math.max(0, paceMs);
        return;
      case 'spectator':
        break;
      default:
        assertNever(this.gameMode, 'playback mode');
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

  getDisclosurePolicy(): DisclosurePolicy {
    return this.policy;
  }

  getHumanSeats(): ReadonlySet<PlayerId> {
    return this.humanSeats;
  }

  // ── Output routing (ADR 0031 decision 3) ──────────────────────────────────────────────────

  /**
   * The game can no longer change the answer to "what may be shown": it finished or halted. An
   * abandoned game is not terminal here, because nothing is sent to it again.
   */
  private isTerminal(): boolean {
    const status = this.runner.getStatus();
    return status === 'finished' || status === 'halted';
  }

  /** Whether a full-state frame may go out now under the policy's `fullState`. */
  private fullStateAvailable(): boolean {
    switch (this.policy.fullState) {
      case 'always':
        return true;
      case 'afterGame':
        // A halted game is not a finished one: a halt unlocks only through `haltIsTerminal`.
        return this.runner.getStatus() === 'finished';
      case 'never':
        return false;
      default:
        return assertNever(this.policy.fullState, 'full state release');
    }
  }

  /** Whether every seat's notes (and the reviews built on them) may go out once the game ends. */
  private mayReleaseAnnotationsAfterGame(): boolean {
    return this.policy.annotations === 'afterGame' || this.policy.annotations === 'live';
  }

  /** The last hop: a message the policy does not allow is never sent. */
  private mayLeave(message: ServerToClientMessage): boolean {
    return checkOutbound(this.policy, message.type, { terminal: this.isTerminal() });
  }

  /** A frame any viewer of the game may see. Nothing seat-private goes through here. */
  private sendPublic(message: ServerToClientMessage): void {
    if (!this.mayLeave(message)) return;
    this.opts.send(message);
  }

  /**
   * A frame for one human seat only. Anything but a human seat throws: a frame addressed to a bot
   * or an unknown seat is a bug, and dropping it silently would hide a leak.
   */
  private sendToSeat(seat: PlayerId, message: ServerToClientMessage): void {
    if (!this.humanSeats.has(seat)) throw new Error(`cannot send to ${seat}: not a human seat`);
    if (!this.mayLeave(message)) return;
    switch (this.gameMode) {
      // flow: output routing (m1 task 4). A single-player game has one stream, and it is the
      // player's; a table routes each frame to its seat.
      case 'singlePlayer':
        this.opts.send(message);
        return;
      case 'table': {
        const out = this.opts.sendToSeat;
        if (out === undefined) throw new Error('a table session requires sendToSeat');
        out(seat, message);
        return;
      }
      case 'spectator':
        throw new Error('a spectator game has no seats to send to');
      default:
        assertNever(this.gameMode, 'seat output');
    }
  }

  /** The same frame to every human seat (table talk, which is public to the players). */
  private sendToHumans(message: ServerToClientMessage): void {
    for (const seat of this.humanSeats) this.sendToSeat(seat, message);
  }

  /** An answer to a seat's request: to the seat when it is one, else to everyone (a fixed line). */
  private reply(seat: PlayerId, message: ServerToClientMessage): void {
    if (this.humanSeats.has(seat)) this.sendToSeat(seat, message);
    else this.sendPublic(message);
  }

  /** A post-game frame for everyone, or for one seat resyncing. */
  private emit(only: PlayerId | undefined, message: ServerToClientMessage): void {
    if (only === undefined) this.sendPublic(message);
    else this.sendToSeat(only, message);
  }

  /** The board a seat is shown. A policy that hides the seed blanks it (ADR 0031 decision 4). */
  private playerStateFor(seat: PlayerId): PlayerBoardState {
    const state = this.engine.playerState(seat);
    switch (this.gameMode) {
      // fence: the policy's `showSeed`; the tester's wire output is unchanged.
      case 'table':
      case 'singlePlayer':
      case 'spectator':
        return this.policy.showSeed ? state : { ...state, seed: '' };
      default:
        return assertNever(this.gameMode, 'player state');
    }
  }

  /**
   * The seat of a game with exactly one human, for the surfaces that only exist for one: the
   * single-player event log and "Copy game report". A table with several humans has none.
   */
  private soleHumanSeat(): PlayerId {
    const [seat] = this.humanSeats;
    if (seat === undefined || this.humanSeats.size !== 1) {
      throw new Error('this surface needs a game with exactly one human seat');
    }
    return seat;
  }

  private humanState(seat: PlayerId): HumanSeatState | undefined {
    return this.humanStates.get(seat);
  }

  /**
   * How a bot is paced against the humans.
   *
   * flow: bots wait on the human's connection gate (m1 row 1562, task 6). A single-player bot
   * waits on the one human's gate and pauses briefly so the player can follow; at a table a bot
   * waits on no gate and never delays (ADR 0031 decision 2): a disconnected human must not stall
   * the others, and the table's clocks (M4) decide what a missing human does.
   */
  private pacedBot(inner: AsyncDecisionProvider): AsyncDecisionProvider {
    switch (this.gameMode) {
      case 'singlePlayer':
        return {
          decide: async (request) => {
            await this.soleGate().wait();
            const response = await inner.decide(request);
            await this.soleGate().wait();
            const delayMs = Math.min(500, Math.floor(this.livePaceMs / 3));
            if (delayMs > 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            }
            return response;
          },
        };
      case 'spectator':
      case 'table':
        return inner;
      default:
        return assertNever(this.gameMode, 'bot pacing');
    }
  }

  /** The connection gate bots wait on in a single-player game. */
  private soleGate(): PlayerConnectionGate {
    return (this.humanStates.get(this.soleHumanSeat()) as HumanSeatState).connectionGate;
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
    const reportMode = reportableMode(this.gameMode);
    if (this.humanSeats.size !== 1) {
      throw new Error('only a single-player session has a game report');
    }
    const humanSeat = this.soleHumanSeat();
    const human = this.humanStates.get(humanSeat) as HumanSeatState;
    const over = this.isOver();
    const board = this.engine.playerState(humanSeat);
    const halt = this.runner.getHalt();
    const result = this.runner.getResult();
    const pending = human.provider.current();
    const last = human.lastHumanDecision;
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
        seed: seedLabel(this.policy, this.opts.seed),
        gameMode: reportMode,
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
        const reveal = mayRevealSeat(setup.seat, humanSeat, mayShowDecklists(this.policy, over));
        const seat = board.seats.find((candidate) => candidate.seat === setup.seat);
        const source = reportDeckSource(context.sources[index], index, this.opts.seed, reveal);
        return {
          seat: setup.seat,
          controller: this.seatControllers[setup.seat] ?? this.opts.providerKind,
          label: setup.summary.label,
          commanderNames: [...setup.summary.commanderNames],
          colorIdentity: [...setup.summary.colorIdentity],
          archetypeTag: mayShowArchetypeTag(this.policy, {
            owner: setup.seat,
            viewer: humanSeat,
            ownerIsHuman: this.humanSeats.has(setup.seat),
            gameOver: over,
          })
            ? setup.summary.archetypeTag
            : '',
          deckSnapshotId: setup.deckSnapshotId,
          // A pool deck's default seed is derived from the game's, so it hides with it. A keyed
          // game drew the deck from a stream, so no seed names it.
          source:
            source.kind === 'pool' && (!this.policy.showSeed || this.rngKey !== null)
              ? { kind: 'pool', seed: '' }
              : source,
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
                .filter((action) => !this.isIgnoredAbility(humanSeat, action))
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
    switch (this.gameMode) {
      // fence: reasoning and debug show hidden information, so only a policy that allows debug
      // can turn them on (m1 row 615). Otherwise the flags are ignored.
      case 'spectator':
      case 'singlePlayer':
      case 'table':
        if (this.policy.debugEvents) this.debugFlags = { ...flags };
        return;
      default:
        assertNever(this.gameMode, 'debug flags');
    }
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
    this.sendPublic({
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
    this.sendPublic({
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
    const batch: ServerToClientMessage = {
      type: 'eventBatch',
      payload: {
        gameId: this.opts.gameId,
        lines: [],
        frontierTurn: this.runner.getFrontierTurn(),
        snapshotTurns: this.runner.getSnapshotTurns(),
        tableTalk,
      },
    };
    switch (this.gameMode) {
      // flow: the last of the talk goes to the viewers the game has (m1 rows 391, 871).
      case 'spectator':
        this.sendPublic(batch);
        return;
      case 'singlePlayer':
      case 'table':
        this.sendToHumans(batch);
        return;
      default:
        assertNever(this.gameMode, 'closing table talk');
    }
  }

  /**
   * Player mode has no presentation clock, so talk goes out as soon as it is said, on a batch of
   * its own, to every human seat. Talk is public; a player sees every line, whoever said it.
   */
  private sendTalkNow(): void {
    if (this.pendingTalk.length === 0) return;
    const tableTalk = this.pendingTalk;
    this.pendingTalk = [];
    this.recordTalk(tableTalk);
    this.sendToHumans({
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
  private sendDiplomacyState(seat: PlayerId, outcome?: DealOutcomeNotice): void {
    if (this.diplomacy === null || !this.humanSeats.has(seat)) return;
    this.sendToSeat(seat, {
      type: 'diplomacyState',
      payload: {
        gameId: this.opts.gameId,
        state: this.diplomacy.seatState(seat),
        ...(outcome !== undefined ? { outcome } : {}),
      },
    });
  }

  /** Anchor talk the player started to the last event so far, and send it with the new state. */
  private afterPlayerDeal(seat: PlayerId, outcome: OfferOutcome): void {
    const last = this.runner.nextSequence() - 1;
    this.collectTalk(Math.max(0, last));
    this.sendTalkNow();
    this.sendDiplomacyState(seat, noticeOf(outcome));
  }

  /**
   * A strategist's `dealProposal` (phase 4), offered through the table like any other proposal.
   * A plan made ahead of its turn waits until the table has opened that turn; one for a turn
   * already past is dropped.
   */
  private offerFromStrategist(turn: number, seat: PlayerId, raw: unknown): void {
    const table = this.diplomacy;
    if (table === null || this.isOver()) return;
    const state = table.seatState(seat);
    if (turn < state.turn) return;
    if (turn > state.turn) {
      this.deferredProposals.push({ turn, seat, raw });
      return;
    }
    const terms = readStrategistProposal(
      raw,
      seat,
      this.engine.view(seat).opponents.map((o) => o.seat),
      state,
    );
    if (terms === null) return;
    table.offer({ proposer: seat, ...terms });
    switch (this.gameMode) {
      // flow: a proposal's talk and deal state go out at once, to each human seat (m1 row 871).
      case 'singlePlayer':
      case 'table':
        this.collectTalk(Math.max(0, this.runner.nextSequence() - 1));
        this.sendTalkNow();
        for (const humanSeat of this.humanSeats) this.sendDiplomacyState(humanSeat);
        return;
      case 'spectator':
        return;
      default:
        assertNever(this.gameMode, 'strategist proposal delivery');
    }
  }

  private offerDeferredProposals(): void {
    if (this.deferredProposals.length === 0) return;
    const waiting = this.deferredProposals;
    this.deferredProposals = [];
    for (const p of waiting) this.offerFromStrategist(p.turn, p.seat, p.raw);
  }

  /** The player offers a deal (ADR 0035 phase 3). The table checks it like any other offer. */
  proposeDeal(seat: PlayerId, payload: ProposeDealPayload): void {
    if (this.diplomacy === null || !this.humanSeats.has(seat) || this.isOver()) {
      this.reply(seat, { type: 'error', payload: { message: 'Deals are off in this game.' } });
      return;
    }
    this.afterPlayerDeal(seat, this.diplomacy.offer({ proposer: seat, ...payload }));
  }

  /** The player answers an offer waiting on them, optionally with terms of their own. */
  answerDeal(seat: PlayerId, payload: AnswerDealPayload): void {
    if (this.diplomacy === null || !this.humanSeats.has(seat) || this.isOver()) {
      this.reply(seat, { type: 'error', payload: { message: 'Deals are off in this game.' } });
      return;
    }
    this.afterPlayerDeal(
      seat,
      this.diplomacy.answer(seat, payload.dealId, payload.answer, payload.counter),
    );
  }

  /**
   * Read the player's free text as deal terms with one cheap call (ADR 0035 phase 4) and send the
   * reading back for the deal panel. Nothing is offered: the player checks the terms and sends
   * them, and they go through `offer` like any other proposal.
   */
  async draftDeal(seat: PlayerId, payload: DraftDealPayload): Promise<void> {
    if (this.diplomacy === null || !this.humanSeats.has(seat) || this.isOver()) {
      this.reply(seat, { type: 'error', payload: { message: 'Deals are off in this game.' } });
      return;
    }
    const busy = this.draftInFlight
      ? 'A reading is already in progress.'
      : this.draftsUsed >= MAX_DEAL_DRAFTS_PER_GAME
        ? 'No free-text readings left this game. Use the deal panel.'
        : null;
    if (busy !== null) {
      this.sendToSeat(seat, {
        type: 'dealDraft',
        payload: { text: payload.text, terms: null, message: busy },
      });
      return;
    }
    this.draftsUsed++;
    this.draftInFlight = true;
    try {
      await this.runDraft(seat, payload);
    } finally {
      this.draftInFlight = false;
    }
  }

  private async runDraft(seat: PlayerId, payload: DraftDealPayload): Promise<void> {
    const table = this.diplomacy;
    if (table === null) return;
    const state = table.seatState(seat);
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
    this.sendToSeat(seat, { type: 'dealDraft', payload: draft });
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
      policy: this.policy,
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
    const refusal: ServerToClientMessage = {
      type: 'error',
      payload: { message: 'Timeline seeking unlocks after a single-player game ends.' },
    };
    switch (this.gameMode) {
      // fence: timeline seeking serves full boards, so it follows the policy's `fullState`
      // (m1 row 1027). A table is refused with the same fixed message even after the game: its
      // post-game replay is served from the table database (multiplayer M3), never from a live
      // session.
      case 'spectator':
      case 'singlePlayer':
        if (!this.fullStateAvailable()) {
          this.sendPublic(refusal);
          return;
        }
        break;
      case 'table':
        this.sendPublic(refusal);
        return;
      default:
        assertNever(this.gameMode, 'timeline seeking');
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
        this.sendPublic({
          type: 'error',
          payload: { message: `Turn ${turn} has not been computed yet.` },
        });
      }
      return;
    }
    this.sendPublic({
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
      this.sendPublic({
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
  submitPlayerAction(seat: PlayerId, payload: SubmitPlayerActionPayload): void {
    const rejected = (message: string): void => {
      this.reply(seat, {
        type: 'error',
        payload: { message, requestId: payload.requestId, revision: payload.revision },
      });
    };
    const human = this.humanState(seat);
    if (human === undefined) {
      rejected('This is not a single-player game.');
      return;
    }
    const pending = human.provider.current();
    const error = human.provider.submit(payload);
    if (error !== null) {
      rejected(error);
      return;
    }
    this.tagDecisionSource(payload.requestId, 'human');
    // Record only an accepted pass, before the runner advances the board. A stale or
    // invalid response must never silence a future opportunity.
    if (
      pending?.request.decisionType === 'priority' &&
      ['pass', 'passAndYieldTurn', 'yieldToAbility'].includes(
        pending.request.legalActions.find((action) => action.id === payload.actionId)?.type ?? '',
      )
    ) {
      human.smartYieldMemory.dismiss(
        pending.request.legalActions,
        human.ignoredAbilities,
        this.engine.playerState(seat),
      );
    }
  }

  yieldPlayerAbility(seat: PlayerId, payload: YieldPlayerAbilityPayload): void {
    const human = this.humanState(seat);
    const pending = human?.provider.current();
    if (human === undefined || pending === null || pending === undefined) {
      this.reply(seat, {
        type: 'error',
        payload: { message: 'No player action is currently required.' },
      });
      return;
    }
    if (payload.requestId !== pending.request.requestId || payload.revision !== pending.revision) {
      this.reply(seat, { type: 'error', payload: { message: 'That ability choice is stale.' } });
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
      this.reply(seat, {
        type: 'error',
        payload: { message: 'Yield an optional activation, or smart yield an optional spell.' },
      });
      return;
    }
    const key = playerYieldKey(action)!;
    human.ignoredAbilities.set(key, {
      key,
      label: action.description,
      mode: payload.mode ?? 'always',
    });
    // Choosing yield also declines the current opportunity, including every mode/X
    // value sharing this preference. It must not immediately reoffer the same choice.
    human.smartYieldMemory.dismiss(
      pending.request.legalActions.filter((candidate) => playerYieldKey(candidate) === key),
      human.ignoredAbilities,
      this.engine.playerState(seat),
    );
    this.sendPlayerActionRequired(seat, pending.request, pending.revision);
  }

  resumePlayerAbility(seat: PlayerId, key: string): void {
    const human = this.humanState(seat);
    if (human === undefined || !human.ignoredAbilities.delete(key)) {
      this.reply(seat, {
        type: 'error',
        payload: { message: 'That yielded ability is no longer available.' },
      });
      return;
    }
    human.smartYieldMemory.resume(key);
    const pending = human.provider.current();
    if (pending !== null) {
      this.sendPlayerActionRequired(seat, pending.request, pending.revision);
    }
    this.publishPlayerState(seat, false);
  }

  /**
   * Out-of-band cancel of an active "pass and yield until end of turn" (Workstream 2). While
   * yielding, the engine auto-passes and never surfaces a decision, so this cannot ride on the
   * usual request/revision submission path — it mutates engine state directly and republishes
   * the board so the yield banner clears.
   */
  cancelYield(seat: PlayerId): void {
    if (!this.humanSeats.has(seat)) {
      this.reply(seat, {
        type: 'error',
        payload: { message: 'This is not a single-player game.' },
      });
      return;
    }
    if (this.engine.cancelYield(seat)) this.publishPlayerState(seat, false);
  }

  setPlayerConnected(seat: PlayerId, connected: boolean): void {
    switch (this.gameMode) {
      // flow: the player connection gate, per human seat (m1 row 1191).
      case 'singlePlayer':
      case 'table':
        break;
      case 'spectator':
        return;
      default:
        assertNever(this.gameMode, 'player connection');
    }
    const human = this.humanState(seat);
    if (human === undefined) return;
    human.connectionGate.setConnected(connected);
    if (connected) this.resyncPlayer(seat);
  }

  resyncPlayer(seat: PlayerId): void {
    const human = this.humanState(seat);
    if (human === undefined) return;
    this.sendToSeat(seat, {
      type: 'eventBatch',
      payload: {
        gameId: this.opts.gameId,
        lines: formatPlayerLog(playerFacingEvents(this.engine.eventsSince(0)), seat),
        frontierTurn: this.engine.getState().turnNumber,
        snapshotTurns: [],
        ...(this.allTalk.length > 0 ? { tableTalk: [...this.allTalk] } : {}),
      },
    });
    this.publishPlayerState(seat, false);
    const result = this.runner.getResult();
    if (result !== null) {
      this.publishGameOver(result, seat);
      return;
    }
    const pending = human.provider.current();
    if (pending !== null) {
      this.sendPlayerActionRequired(seat, pending.request, pending.revision);
    }
  }

  abandon(): void {
    this.abandoned = true;
    this.stopPresenting();
    this.pendingLines = [];
    this.aiCoordinator?.cancel();
    this.aiJev?.cancel?.();
    this.runner.abandon();
    for (const human of this.humanStates.values()) {
      human.provider.releaseForAbandon();
      human.connectionGate.release();
    }
  }

  private publishPlayerState(seat: PlayerId, bump: boolean): void {
    const human = this.humanState(seat);
    if (human === undefined) return;
    if (bump) human.playerRevision += 1;
    if (this.diplomacy !== null) {
      // What the table said since the last decision (an offer made to the player as a turn
      // opened) goes out with the state that shows it, not after the player's next decision.
      this.collectTalk(Math.max(0, this.runner.nextSequence() - 1));
      this.sendTalkNow();
    }
    this.sendDiplomacyState(seat);
    this.sendToSeat(seat, {
      type: 'playerStateSnapshot',
      payload: {
        gameId: this.opts.gameId,
        state: this.playerStateFor(seat),
        revision: human.playerRevision,
        connected: human.connectionGate.isConnected(),
        ignoredAbilities: this.ignoredAbilityList(seat),
      },
    });
  }

  private sendPlayerActionRequired(
    seat: PlayerId,
    request: DecisionRequest,
    revision: number,
  ): void {
    const human = this.humanState(seat);
    if (human === undefined) return;
    const state = this.playerStateFor(seat);
    const legalActions =
      request.decisionType === 'priority'
        ? request.legalActions.filter(
            (action) => !human.smartYieldMemory.isYielded(action, human.ignoredAbilities, state),
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
      this.publishPlayerState(seat, false);
      // Tagged before the submit, which resolves the provider; the runner reads the tag after.
      this.tagDecisionSource(request.requestId, 'auto');
      const refused = human.provider.submit({
        requestId: request.requestId,
        revision,
        actionId: pass.id,
      });
      if (refused !== null) this.decisionSources.delete(request.requestId);
      return;
    }
    this.sendToSeat(seat, {
      type: 'playerActionRequired',
      payload: {
        // After smart-yield filtering: the presentation is built from the menu the seat is sent
        // and its own board, never from the engine's state (ADR 0032 decision 3).
        request: enrichPresentation({ ...request, legalActions }, state),
        revision,
        state,
        ignoredAbilities: this.ignoredAbilityList(seat),
      },
    });
  }

  private isIgnoredAbility(
    seat: PlayerId,
    action: DecisionRequest['legalActions'][number],
  ): boolean {
    const human = this.humanState(seat);
    if (human === undefined || human.ignoredAbilities.size === 0) return false;
    return human.smartYieldMemory.isYielded(
      action,
      human.ignoredAbilities,
      this.engine.playerState(seat),
    );
  }

  private ignoredAbilityList(seat: PlayerId): IgnoredPlayerAbility[] {
    return [...(this.humanState(seat)?.ignoredAbilities.values() ?? [])];
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
    switch (this.gameMode) {
      // flow: spectator final state (m1 row 1318). A player has `replayUnlocked`, and a table
      // would be sent `spectatorState`, which no live player frame may carry.
      case 'spectator':
        break;
      case 'singlePlayer':
      case 'table':
        return;
      default:
        assertNever(this.gameMode, 'final state');
    }
    this.stopPresenting();
    this.flushPendingLines();
    const turn = this.engine.getState().turnNumber;
    this.presentedTurn = turn;
    this.runner.setViewTurn(turn);
    this.sendPublic({
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

  /**
   * Announce the result. `only` addresses a seat that is resyncing; otherwise it is for everyone.
   */
  private publishGameOver(
    result: NonNullable<ReturnType<Engine['getResult']>>,
    only?: PlayerId,
  ): void {
    this.publishFinalState();
    this.finishTalk();
    switch (this.gameMode) {
      // fence: `replayUnlocked` carries the full state and the whole log, so it follows the
      // policy's `fullState` (m1 row 1339). A table's post-game replay is served from the table
      // database (multiplayer M3), never from a live session.
      case 'singlePlayer':
        if (this.policy.fullState === 'never') break;
        this.sendToSeat(only ?? this.soleHumanSeat(), {
          type: 'replayUnlocked',
          payload: {
            state: this.engine.spectatorState(),
            lines: formatSpectatorLog(playerFacingEvents(this.engine.eventsSince(0))),
            snapshotTurns: this.runner.getSnapshotTurns(),
            frontierTurn: result.turnCount,
            // The game is over, so the reasoning withheld all game is safe to release in full
            // (ADR 0022 §3) — this is the only path by which a player ever sees it.
            ...(this.debugFlags.showAIResponses &&
            this.allAnnotations.length > 0 &&
            this.mayReleaseAnnotationsAfterGame()
              ? { annotations: [...this.allAnnotations] }
              : {}),
          },
        });
        break;
      case 'spectator':
      case 'table':
        break;
      default:
        assertNever(this.gameMode, 'replay unlock');
    }
    const reflectingSeats = this.reflectionSeats();
    this.emit(only, {
      type: 'gameOver',
      payload: {
        result: this.disclosedResult(result),
        summary: gameOverSummary(result),
        standings: this.standings(),
        ...(reflectingSeats.length > 0 ? { reflectingSeats } : {}),
      },
    });

    // Deliberately not awaited, and deliberately after the send above: a reflection is a model
    // call, and the results screen is the one thing in this system that must never wait on one
    // (ADR 0022 §7). On a resync the game is long over and the reviews already exist, so they are
    // simply re-sent.
    if (this.reflections.length > 0)
      this.sendReflections(this.reflections, this.reflectionsComplete, only);
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
    // fence: post-game commentary is model reasoning about hidden hands, so it follows the
    // policy's `annotations`: only a policy that releases every seat's notes has any.
    switch (this.gameMode) {
      case 'spectator':
      case 'singlePlayer':
      case 'table':
        if (!this.mayReleaseAnnotationsAfterGame()) return [];
        break;
      default:
        return assertNever(this.gameMode, 'reflection seats');
    }
    if (this.opts.providerKind !== 'ai') return [];
    const config = (this.aiConfig ??= loadAiConfig(process.env));
    if (!(this.opts.reflectionEnabled ?? config.reflectionEnabled)) return [];
    return this.opts.seats.map((seat) => seat.seat).filter((seat) => !this.humanSeats.has(seat));
  }

  private sendReflections(
    reflections: readonly AiReflection[],
    complete: boolean,
    only?: PlayerId,
  ): void {
    this.emit(only, {
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
  private standings(): GameOverPayload['standings'] {
    const positions = finishingPositions(
      this.runner.getResult()?.finishingOrder ?? [],
      this.opts.seats.length,
    );
    const state = this.engine.getState();
    return this.opts.seats.map((seat) => {
      const lossReason = state.players.find((p) => p.id === seat.seat)?.lossReason ?? null;
      return {
        seat: seat.seat,
        position: positions.get(seat.seat) ?? 0,
        lossReason,
        ...(lossReason === null ? {} : { lossLabel: lossReasonLabel(lossReason) }),
      };
    });
  }

  /**
   * Push the running cost counters (brief §7.4 — "track and display per-game API call count and
   * token usage… so cost regressions are visible immediately"). Only meaningful for AI matches.
   */
  private reportAiCost(): void {
    if (this.logger === null) return;
    switch (this.gameMode) {
      // fence: token counts track a bot's hand, so only a policy with AI cost reports sends
      // `apiWaiting` (ADR 0031 decision 3).
      case 'spectator':
      case 'singlePlayer':
      case 'table':
        if (!this.policy.aiCostReports) return;
        break;
      default:
        assertNever(this.gameMode, 'AI cost report');
    }
    const stats = this.logger.summary();
    this.sendPublic({
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

    const humanState = this.humanState(playerId);
    if (humanState !== undefined) {
      // The player's decisions open negotiation windows and are judged for compliance like any
      // seat's; offers to the player wait for their answer rather than this decision.
      const table = this.diplomacy;
      const humanProvider = humanState.provider;
      const human: AsyncDecisionProvider =
        table === null
          ? humanProvider
          : {
              decide: async (request) => {
                table.beforeDecision(request);
                // Opening a turn's window or the after-attackers slot changes what the player may
                // do at the table; the board already went out, so send the table's state (and
                // any talk) before waiting on them.
                this.collectTalk(Math.max(0, this.runner.nextSequence() - 1));
                this.sendTalkNow();
                this.sendDiplomacyState(playerId);
                const response = await humanProvider.decide(request);
                table.afterDecision(request, response);
                return response;
              },
            };
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
        // A keyed game gives each bot seat its own stream; a legacy one seeds from the label.
        this.rngKey === null
          ? `${this.opts.seed}-${playerId}`
          : botRandomSource(this.rngKey, seatIndex(playerId)),
        () => this.engine.view(playerId),
        table === null ? {} : { diplomacy: table.playFor(playerId) },
      );
      return table === null ? bot : withDiplomacy(table, bot);
    };
    const inner: AsyncDecisionProvider =
      this.opts.providerKind !== 'ai'
        ? new AsyncAdapter(heuristic())
        : table === null
          ? this.buildAiProvider()
          : withDiplomacyAsync(table, this.buildAiProvider());
    const pacedProvider = this.pacedBot(inner);

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
      this.escalation(),
      coordinator,
      this.aiJev ?? undefined,
    );
  }

  /**
   * The hook that shows a failed legal menu to a person to pick from.
   *
   * fence: never surface an opponent's failed legal menu to a player (m1 row 1597). The menu
   * and the model's raw failure detail go out as `decisionPending`, so only a policy that shows
   * raw error text consults anyone.
   */
  private escalation(): DecisionEscalation | undefined {
    switch (this.gameMode) {
      case 'spectator':
      case 'singlePlayer':
      case 'table':
        return this.policy.rawErrorText ? this.runner.escalation() : undefined;
      default:
        return assertNever(this.gameMode, 'legal-menu escalation');
    }
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
        this.humanSeats,
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
      const table = this.diplomacy;
      if (table !== null) {
        this.aiCoordinator.diplomacyFor = (seat, role) => {
          const state = table.seatState(seat);
          return seatDiplomacyContext(
            seat,
            {
              deals: state.deals,
              records: state.trust,
              canPropose: state.canPropose,
              maxRounds: state.maxRounds,
              maxObligationsPerSide: state.maxObligationsPerSide,
            },
            role,
          );
        };
        this.aiCoordinator.onDealProposal = (turn, seat, raw) => {
          this.offerFromStrategist(turn, seat, raw);
        };
      }
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

/** The cap the engine is running with. `turnCap` is engine-internal, so read it defensively. */
function engineTurnCap(engine: Engine): number {
  const cap = (engine.getState() as { turnCap?: unknown }).turnCap;
  if (typeof cap !== 'number') throw new Error('the engine reports no turn cap');
  return cap;
}

/**
 * Who answers each seat.
 *
 * flow: who the human seats are. A spectator game has none; a single-player game has the one the
 * start request named; a table has every seat whose controller is `human`, and at least one.
 */
function resolveSeatControllers(
  opts: Pick<MatchSessionOptions, 'seats' | 'providerKind' | 'humanSeat' | 'seatControllers'>,
  gameMode: GameMode,
): SeatControllers {
  const seats = opts.seats.map((s) => s.seat);
  const bots = (human: ReadonlySet<PlayerId>): SeatControllers =>
    Object.fromEntries(
      seats.map((seat) => [seat, human.has(seat) ? 'human' : opts.providerKind] as const),
    );
  switch (gameMode) {
    case 'spectator':
      return bots(new Set());
    case 'singlePlayer': {
      if (opts.seatControllers !== undefined) {
        throw new Error(
          'seatControllers apply to table games; a single-player game names humanSeat',
        );
      }
      if (opts.humanSeat === undefined || !seats.includes(opts.humanSeat)) {
        throw new Error('single-player session requires a human seat');
      }
      return bots(new Set([opts.humanSeat]));
    }
    case 'table': {
      const given = opts.seatControllers;
      if (given === undefined) throw new Error('a table session requires seatControllers');
      const human = new Set(seats.filter((seat) => given[seat] === 'human'));
      if (human.size === 0) throw new Error('a table session requires at least one human seat');
      for (const seat of seats) {
        // Mixed bot kinds in one session are not supported yet: one provider kind drives every bot.
        if (!human.has(seat) && given[seat] !== opts.providerKind) {
          throw new Error(`table seat ${seat} must be human or ${opts.providerKind}`);
        }
      }
      return bots(human);
    }
    default:
      return assertNever(gameMode, 'session game mode');
  }
}

/**
 * The mode a "Copy game report" can name: the tester's own.
 *
 * fence: a table has no report from the tester (m1 report consumer); asking for one throws.
 */
function reportableMode(gameMode: GameMode): StartGameMode {
  switch (gameMode) {
    case 'spectator':
    case 'singlePlayer':
      return gameMode;
    case 'table':
      throw new Error('a table game has no tester game report');
    default:
      return assertNever(gameMode, 'game report mode');
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
        ...(outcome.counterRefused !== undefined ? { reason: outcome.counterRefused } : {}),
      };
    case 'refused':
      return { kind: 'refused', reason: outcome.reason };
  }
}

/**
 * WebSocket protocol between server and web client (brief §11). The server owns the engine
 * and the AI calls; the frontend is a view and receives pushed updates. Payloads are flat and
 * serializable — the frontend needs no engine code to interpret them.
 *
 * The message names are exactly §11's. Where Phase 4 needed to convey something the list did
 * not name, it rides on an existing payload rather than widening the set (ADR 0012): the
 * compute frontier travels on `eventBatch`/`stateSnapshot`, and AI call counters on
 * `apiWaiting`.
 */

import type { DecisionRequest, TargetChoice } from './engine';
import type { GameId, ObjectId, PlayerId } from './ids';
import type { GameResult } from './state';
import type { PlayerBoardState } from './player';
import type { AiAnnotation, AiReflection, SpectatorLogLine, SpectatorState } from './spectator';
import type { ValidationIssue } from './decks';
import type {
  DealObligation,
  DealTerms,
  DiplomacySeatState,
  OfferRefusal,
  TableTalkLine,
} from './diplomacy';

/** Server → client message types (brief §11). */
export const SERVER_TO_CLIENT_TYPES = [
  'gameStarted',
  'stateSnapshot',
  'eventBatch',
  'decisionPending',
  'computeHalted',
  'apiWaiting',
  'debugEvents',
  'playerStateSnapshot',
  'playerActionRequired',
  'sessionPaused',
  'replayUnlocked',
  'gameOver',
  'gameReflections',
  'diplomacyState',
  'dealDraft',
  'error',
] as const;
export type ServerToClientType = (typeof SERVER_TO_CLIENT_TYPES)[number];

/** Client → server message types (brief §11). */
export const CLIENT_TO_SERVER_TYPES = [
  'startGame',
  'startCardTestScenario',
  'jumpToTurn',
  'setPlaybackMode',
  'resolveHeldDecision',
  'abandonGame',
  'setDebugFlags',
  'submitPlayerAction',
  'yieldPlayerAbility',
  'resumePlayerAbility',
  'cancelYield',
  'resumeGame',
  'proposeDeal',
  'answerDeal',
  'draftDeal',
] as const;
export type ClientToServerType = (typeof CLIENT_TO_SERVER_TYPES)[number];

// ── Shared vocabulary ───────────────────────────────────────────────────────────────────────

/**
 * Who answers decisions. `random` is free and deterministic given the seed; `ai` spends real
 * budget on every non-local decision (ADR 0010, ADR 0011). See ADR 0012 §4.
 */
export type ProviderKind = 'random' | 'ai';
/**
 * How a game is presented and who may see what. `'table'` is a multi-human game run by the table
 * server (ADR 0031); the tester's `StartGamePayload` never carries it, and `GameServer` refuses it.
 */
export type GameMode = 'spectator' | 'singlePlayer' | 'table';
export type SeatControllerKind = ProviderKind | 'human';
/** The modes a `startGame` request may name. `'table'` is started only by the table server. */
export type StartGameMode = Exclude<GameMode, 'table'>;
/** Who answers each seat's decisions. A session takes this instead of a single human seat. */
export type SeatControllers = Readonly<Record<PlayerId, SeatControllerKind>>;

/** Live-ish compute-ahead vs. the user stepping it forward (brief §10.1). */
export type PlaybackMode = 'live' | 'manual';

/**
 * Turns the engine may compute beyond the viewer's position (brief §10.1). Shared because both
 * ends need it: the server enforces it, and the UI explains the pause it causes. It lived only
 * on the server with the web app carrying its own hardcoded 5.
 */
export const LOOKAHEAD_TURNS = 5;

/**
 * How long a single-player game survives with its player disconnected. Long enough to come back
 * from a closed tab or a break; short enough that a game whose browser is gone for good (a closed
 * private window, cleared storage) stops refusing every new start. Shared so the UI can say when
 * a refused start will clear.
 */
export const PLAYER_IDLE_GRACE_MS = 30 * 60_000;

/** How the four seats get their decks. */
export type SeatSource =
  | { kind: 'pool'; seed?: string }
  | { kind: 'snapshot'; snapshotId: string }
  | { kind: 'url'; url: string; archetypeTag?: string }
  | { kind: 'plaintext'; text: string; name?: string; archetypeTag?: string };

/** Why the runner stopped computing (brief §10.1 hold-and-wait). */
export type HaltKind =
  'unmodeledCard' | 'invalidAiResponse' | 'engineError' | 'draw' | 'aiBudgetExhausted' | 'turnCap';

export interface SeatSummary {
  seat: PlayerId;
  deckId: string;
  label: string;
  commanderNames: string[];
  colorIdentity: string[];
  archetypeTag: string;
}

/**
 * How a card stands in the rules engine, the three states a preview names (ADR 0053).
 * `unsupported`: the engine cannot play it and halts if it is drawn. `provisional`: a
 * machine-checked definition that no person has reviewed (ADR 0050), playable only when the
 * server admitted the provisional catalog. `implemented-unreviewed`: modeled, but not yet audited
 * against the completion standard.
 */
export type CardModelStatus = 'unsupported' | 'implemented-unreviewed' | 'provisional';

/** One card of a previewed deck that the engine does not model on its own. */
export interface UnmodeledCard {
  name: string;
  /** SHA-256 of the card's canonical Oracle record: what the Card Test Lab pins scenarios to. */
  oracleSha256?: string;
  status: CardModelStatus;
}

/**
 * Public setup metadata. No decklist or private card data crosses this boundary, with one
 * exception (ADR 0053): `unmodeledCards` names the cards of a user-supplied deck (a URL, pasted or
 * saved list picked at setup) that the engine does not model, so a refused import can say what
 * needs work. A deck that is fully modeled sends no card names at all.
 */
export interface SetupPreviewSeat {
  seat: PlayerId;
  commanderNames: string[];
  colorIdentity: string[];
  archetypeTag: string;
  controller: SeatControllerKind;
  modeled: boolean;
  /** Present only for a URL, plaintext or saved seat with at least one unmodeled card. */
  unmodeledCards?: UnmodeledCard[];
}

export interface SetupPreview {
  previewId: string;
  seed: string;
  seats: SetupPreviewSeat[];
  blockers: string[];
}

/** How far a card has come, from `docs/plans/card-catalog-audit.json` and the engine (ADR 0053). */
export type CardReportStatus = CardModelStatus | 'implemented-reviewed';

/**
 * The audit ledger's evidence for one card, copied only where the ledger has it. A field the
 * ledger does not record is absent here, never filled with a default: no field means "unknown".
 */
export interface CardReportEvidence {
  engine?: string;
  viewer?: string;
  gameplayAi?: string;
  note?: string;
  engineTestIds?: string[];
  viewerScenarioId?: string;
  /**
   * Whether the ledger's Oracle hash equals the card the server holds now. Absent when the ledger
   * recorded no hash for the card, so nothing can be said either way.
   */
  oracleMatchesAudit?: boolean;
}

/** A Card Test Lab scenario that pins this card's Oracle hash. */
export interface CardReportScenario {
  id: string;
  title: string;
  clauseIds: string[];
}

/** One card of `GET /api/card-report`. */
export interface CardReportEntry {
  name: string;
  oracleId: string;
  typeLine: string;
  manaCost: string | null;
  oracleText: string;
  oracleSha256: string;
  status: CardReportStatus;
  /** Why the engine cannot model the card, verbatim from the interpreter, when it cannot. */
  unmodeledReasons: string[];
  /** The ledger's reason when it records the card as unsupported. */
  unsupportedReason?: string;
  /** Present only when the ledger has an entry for the card that agrees with the engine today. */
  evidence?: CardReportEvidence;
  /**
   * Set when the ledger and the engine disagree (a ledger entry from before a fix, say). The
   * ledger's evidence is then left out, because it describes a different state of the card.
   */
  auditConflict?: string;
  /** Lab scenarios for the card, or null when this server has no Card Test Lab catalog. */
  scenarios: CardReportScenario[] | null;
}

/** The `GET /api/card-report` reply: asked names in order, with the ones that did not resolve. */
export interface CardReport {
  cards: CardReportEntry[];
  unresolved: string[];
  /** False when the audit ledger could not be read, so no card has evidence here. */
  auditAvailable: boolean;
  /** True when this server runs the Card Test Lab, so `scenarios` is a list rather than null. */
  labAvailable: boolean;
}

export interface SavedDeckOption {
  snapshotId: string;
  name: string;
  commanderNames: string[];
  colorIdentity: string[];
  archetypeTag: string;
}

// ── Server → client ─────────────────────────────────────────────────────────────────────────

/** A game has begun; carries the seating and the seed (brief §4 — the seed is displayed). */
export interface GameStartedPayload {
  gameId: GameId;
  seed: string;
  seats: SeatSummary[];
  providerKind: ProviderKind;
  gameMode?: GameMode;
  controllers?: Array<{ seat: PlayerId; kind: SeatControllerKind }>;
  humanSeat?: PlayerId;
  /** Opaque reconnect credential. Present only for single-player games. */
  sessionToken?: string;
  /** Current bot presentation pace, retained across a player-session reconnect. */
  paceMs?: number;
  startedAt: string;
  cardTestScenario?: CardTestScenarioMetadata;
  /** True when the bots negotiate and talk at this table (ADR 0035). */
  diplomacy?: boolean;
}

export interface CardTestScenarioMetadata {
  id: string;
  version: number;
  title: string;
  instructions: string[];
  expectedOutcome: string;
  oracleSha256: string;
  clauseIds: string[];
}

/**
 * One Card Test Lab card as `GET /api/card-test-lab/cards` reports it, keyed by the Oracle hash its
 * scenarios pin. Every field is copied from the verification manifest or the audit ledger and is
 * absent when neither holds it; nothing is defaulted to "complete".
 */
export interface CardTestLabClause {
  /** The manifest clause id, when the manifest gives one. */
  id?: string;
  oracleText: string;
  implementation: string[];
  engineTestIds: string[];
  /** The viewer scenarios the manifest requires for this clause. */
  viewerScenarioIds: string[];
  /** The lab scenarios of this card tied to the clause, by its id or its viewer scenario ids. */
  scenarioIds: string[];
}

export type CardTestLabAuditState = 'current' | 'stale' | 'unpinned' | 'absent';

export interface CardTestLabLedgerEvidence {
  engine?: string;
  viewer?: string;
  gameplayAi?: string;
  note?: string;
  engineTestIds?: string[];
  viewerScenarioId?: string;
}

export interface CardTestLabCard {
  oracleSha256: string;
  name?: string;
  oracleId?: string;
  implementationStatus?: string;
  unsupportedReason?: string;
  /** Whether the verification manifest pins this exact hash. False: no clause list is known. */
  manifestPinned: boolean;
  clauses: CardTestLabClause[];
  /** Lab scenarios of the card that no manifest clause names. */
  unmappedScenarioIds: string[];
  gameplayAiScenarioIds: string[];
  /**
   * `current`: the ledger entry pins this very hash and its evidence is in `ledger`. `stale`: it
   * pins another hash, so its evidence is left out. `unpinned`: the entry has no hash, so it
   * cannot be tied to this Oracle text and is left out. `absent`: the ledger has no entry.
   */
  audit: CardTestLabAuditState;
  ledger?: CardTestLabLedgerEvidence;
}

/** The board at one turn. Sent on start, on jump, and whenever the viewer's position moves. */
export interface StateSnapshotPayload {
  turn: number;
  state: SpectatorState;
  /** The furthest turn computed so far — the scrubber's upper bound (brief §10.1). */
  frontierTurn: number;
  /** True when this snapshot is the live edge rather than a replayed past turn. */
  atFrontier: boolean;
  /**
   * The action-log `sequence` this board is the result of, when the client asked to seek to one
   * and the server had that exact board. Null for a plain turn snapshot — the client uses it to
   * decide which log line (if any) it may legitimately highlight as "you are here".
   */
  sequence?: number | null;
}

/** Newly computed log lines, plus the advancing frontier they came from. */
export interface EventBatchPayload {
  gameId: GameId;
  lines: SpectatorLogLine[];
  frontierTurn: number;
  /** Turns for which a snapshot exists, so the scrubber knows where it may seek. */
  snapshotTurns: number[];
  /**
   * AI reasoning for the decisions behind these lines (ADR 0022). Absent unless
   * `DebugFlags.showAIResponses` is on, so the default payload does not grow. In single-player
   * this never carries another seat's reasoning — see `MatchSession` for that gate.
   */
  annotations?: AiAnnotation[];
  /**
   * Table talk anchored to these lines (ADR 0035): deals, answers, breaches and threat calls.
   * Absent unless the game was started with `diplomacy`, so the default payload does not grow.
   */
  tableTalk?: TableTalkLine[];
  /**
   * What these lines did to the board, for animation (ADR 0032 decision 8): who damaged what, and
   * whose life changed. Built on the server, so the browser no longer diffs boards to guess.
   * Absent when the lines changed neither.
   */
  cues?: PresentationCue[];
}

/** A damage or life cue's target: a permanent by its object id, or a player. */
export type CueTarget = { kind: 'object'; id: ObjectId } | { kind: 'player'; id: PlayerId };

/**
 * One board change to animate. `sequence` is the log line it belongs to (a viewer's own sequence
 * at a table). Cues name objects by object id only, never by card id.
 */
export type PresentationCue =
  | {
      kind: 'damage';
      sequence: number;
      /** Null when the source is on neither board (it left before the batch was flushed). */
      sourceId: ObjectId | null;
      target: CueTarget;
      amount: number;
      combat: boolean;
      /** Damage dealt together shares a group: one per combat damage step, then one per event. */
      group: number;
    }
  | {
      kind: 'lifeChange';
      sequence: number;
      player: PlayerId;
      /** The real change in the life total, which damage alone does not always give. */
      delta: number;
    };

/**
 * The AI failed twice on a decision the user is currently watching (brief §7.7 step 2). The
 * user has `timeoutMs` to pick, after which the server applies the safest legal action.
 */
export interface DecisionPendingPayload {
  request: DecisionRequest;
  /** The raw thing the model returned, for the user to see what went wrong. */
  invalidResponse: string;
  timeoutMs: number;
}

/** Compute stopped and will not continue until the user resolves it (brief §10.1). */
export interface ComputeHaltedPayload {
  gameId: GameId;
  kind: HaltKind;
  reason: string;
  turn: number;
  /** The offending card, when the halt was an unmodeled one (brief §6.3). */
  cardName?: string;
}

/** Why playback paused (brief §7.5 — queue depth and wait state must be visible). */
export interface ApiWaitingPayload {
  queueDepth: number;
  /** How long the current request has been waiting, in ms. */
  waitingMs: number;
  reason: 'rateLimit' | 'inFlight' | 'backoff';
  /** Running per-game cost counters (brief §7.4). */
  calls: number;
  skippedCalls: number;
  promptTokens: number;
  responseTokens: number;
}

/** Runtime display controls for the Phase 5 debug suite. Persistence is never disabled. */
export interface DebugFlags {
  showAIRequests: boolean;
  showAIResponses: boolean;
  showLegalActions: boolean;
  showSBAChecks: boolean;
  showPriorityPasses: boolean;
  showTokenUsage: boolean;
  verboseEngine: boolean;
}

export interface DebugEventsPayload {
  gameId: GameId;
  entries: Array<{
    turn: number;
    category: string;
    message: string;
    data?: Record<string, unknown>;
  }>;
}

/** Current hidden-information-safe board for the active human player. */
export interface PlayerStateSnapshotPayload {
  gameId: GameId;
  state: PlayerBoardState;
  revision: number;
  connected: boolean;
  ignoredAbilities: IgnoredPlayerAbility[];
}

/** A player preference for an optional spell or activated ability; never changes legality. */
export interface IgnoredPlayerAbility {
  key: string;
  label: string;
  mode?: 'always' | 'smart';
}

/** A real, untimed engine decision that only the selected human seat may answer. */
export interface PlayerActionRequiredPayload {
  request: DecisionRequest;
  state: PlayerBoardState;
  revision: number;
  ignoredAbilities: IgnoredPlayerAbility[];
}

export interface SessionPausedPayload {
  gameId: GameId;
  reason: 'playerDisconnected' | 'waitingForPlayer';
}

/** Full-information replay becomes available only after a single-player game is over. */
export interface ReplayUnlockedPayload {
  state: SpectatorState;
  lines: SpectatorLogLine[];
  snapshotTurns: number[];
  frontierTurn: number;
  /**
   * Every seat's reasoning for the whole game, released here because the game is over and there
   * is no longer anything to protect (ADR 0022 §3). Absent unless `showAIResponses` is on.
   */
  annotations?: AiAnnotation[];
}

export interface GameOverPayload {
  result: GameResult;
  /** The "game over" line in player terms, written by the server (ADR 0032 decision 5). */
  summary: string;
  /** Finishing positions, 1st through 4th. */
  standings: Array<{
    seat: PlayerId;
    position: number;
    lossReason: string | null;
    /** `lossReason` in player terms, written by the server; absent when there is no reason. */
    lossLabel?: string;
  }>;
  /**
   * Seats whose post-game reflection has been started (ADR 0022 §7). Absent when the feature is
   * off. This ships with `gameOver` — which never waits on a model — so the results screen can
   * show a placeholder per seat instead of guessing whether commentary is coming.
   */
  reflectingSeats?: PlayerId[];
}

/**
 * Post-game commentary, arriving after `gameOver` rather than on it: a reflection is a model call
 * and the results screen must not wait for one. Sent again as each further seat lands, carrying
 * every reflection produced so far, so a client that missed a frame is still whole.
 */
export interface GameReflectionsPayload {
  gameId: GameId;
  reflections: AiReflection[];
  /**
   * True on the final message, once every seat has either answered or failed. Without it a seat
   * whose call failed is indistinguishable from one still thinking, and a misconfigured provider
   * leaves the results screen showing "writing…" forever.
   */
  complete: boolean;
}

export interface ErrorPayload {
  message: string;
  /** Per-deck validation problems, when the error came from deck setup (brief §8.3). */
  deckIssues?: Array<{ seat: PlayerId; issues: ValidationIssue[] }>;
  /** Cards the engine cannot model, when setup pre-flight rejected a deck (ADR 0009/0012). */
  unmodeledCards?: Array<{ seat: PlayerId; cards: string[] }>;
  /**
   * The rejected `submitPlayerAction`, echoed back so a client knows *which* submission failed.
   * Rides on this payload rather than a new message type (ADR 0012). Present together and only
   * when the error is that submission's rejection: an error carrying neither is uncorrelated and
   * says nothing about any in-flight action. A client that clears its in-flight guard on an
   * uncorrelated error either duplicates a submission or waits forever for a decision the server
   * never re-asked.
   */
  requestId?: string;
  revision?: number;
}

export type ServerToClientMessage =
  | { type: 'gameStarted'; payload: GameStartedPayload }
  | { type: 'stateSnapshot'; payload: StateSnapshotPayload }
  | { type: 'eventBatch'; payload: EventBatchPayload }
  | { type: 'decisionPending'; payload: DecisionPendingPayload }
  | { type: 'computeHalted'; payload: ComputeHaltedPayload }
  | { type: 'apiWaiting'; payload: ApiWaitingPayload }
  | { type: 'debugEvents'; payload: DebugEventsPayload }
  | { type: 'playerStateSnapshot'; payload: PlayerStateSnapshotPayload }
  | { type: 'playerActionRequired'; payload: PlayerActionRequiredPayload }
  | { type: 'sessionPaused'; payload: SessionPausedPayload }
  | { type: 'replayUnlocked'; payload: ReplayUnlockedPayload }
  | { type: 'gameOver'; payload: GameOverPayload }
  | { type: 'gameReflections'; payload: GameReflectionsPayload }
  | { type: 'diplomacyState'; payload: DiplomacyStatePayload }
  | { type: 'dealDraft'; payload: DealDraftPayload }
  | { type: 'error'; payload: ErrorPayload };

/** What became of the player's last proposal or answer (ADR 0035 phase 3). */
export interface DealOutcomeNotice {
  kind: 'accepted' | 'declined' | 'pending' | 'withdrawn' | 'refused';
  dealId?: string;
  /**
   * Why it was refused: `noSuchOffer` when the offer answered had already lapsed. On `declined`,
   * why the counter sent with the decline was refused (the decline itself stands).
   */
  reason?: OfferRefusal | 'noSuchOffer';
  /** The other side declined and its counter now waits on the player. */
  counterPending?: boolean;
}

/**
 * The table as the human seat sees it, sent in a single-player game with deals on whenever it may
 * have changed: on every board update, and after each proposal or answer the player makes.
 */
export interface DiplomacyStatePayload {
  gameId: GameId;
  state: DiplomacySeatState;
  /** Present only in the reply to the player's own proposal or answer. */
  outcome?: DealOutcomeNotice;
}

/**
 * The reply to `draftDeal` (ADR 0035 phase 4): the player's free text read as typed terms, for the
 * deal panel to show before anything is offered. `terms` is null when the text could not be read
 * or the reading is not a valid deal; the panel is the fallback either way.
 */
export interface DealDraftPayload {
  text: string;
  terms: DealTerms | null;
  message?: string;
}

/** Narrow a server message to one variant, e.g. `ServerMessageOf<'eventBatch'>`. */
export type ServerMessageOf<T extends ServerToClientType> = Extract<
  ServerToClientMessage,
  { type: T }
>;

// ── Client → server ─────────────────────────────────────────────────────────────────────────

/**
 * What a player connection asks the server to include (ADR 0032 decision 7). Declared in the
 * first player message (`startGame`, `startCardTestScenario`) and again in every `resumeGame`,
 * because a resumed connection is a new one. Absent or empty means the default: no raw
 * `LegalAction.data`. Only the JSON agent client asks for `rawActionData`; the browser never does.
 */
export interface ClientCapabilities {
  /** Keep `LegalAction.data` on the legal actions sent to this player. */
  rawActionData?: boolean;
}

/** Whether `value` is a well-formed `ClientCapabilities`, or absent. Unknown keys are refused. */
function isOptionalCapabilities(value: unknown): value is ClientCapabilities | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const caps = value as Record<string, unknown>;
  return (
    Object.keys(caps).every((key) => key === 'rawActionData') &&
    (caps['rawActionData'] === undefined || typeof caps['rawActionData'] === 'boolean')
  );
}

interface StartGameCommon {
  /** What this connection wants in its frames; see `ClientCapabilities`. */
  capabilities?: ClientCapabilities;
  /** Four seats in v1 (brief §15). */
  seats: SeatSource[];
  providerKind: ProviderKind;
  /** Omit to have the server generate a fresh one (brief §4 — reruns use a new seed). */
  seed?: string;
  /** Token from the read-only setup preview. Required by the player-first flow. */
  previewId?: string;
  playbackMode?: PlaybackMode;
  paceMs?: number;
  /**
   * Turn on post-game AI commentary for this game (ADR 0022 §7). Chosen on the setup screen, so
   * it is a per-game decision rather than a server-wide one; omit to fall back to
   * `AI_REFLECTION_ENABLED`, which is off. Costs one extra model call per AI seat, once, after
   * the game has already ended.
   */
  reflectionEnabled?: boolean;
  /**
   * Let the seats make deals and talk at the table (ADR 0035): bots, model-driven seats and, in a
   * single-player game, the player. Off when omitted, and an off game is byte-identical to one
   * from before diplomacy existed.
   */
  diplomacy?: boolean;
}

/** The selected human seat is part of the single-player discriminant, never ambient state. */
export type StartGamePayload = StartGameCommon &
  (
    | { gameMode?: 'spectator'; humanSeat?: never }
    | { gameMode: 'singlePlayer'; humanSeat: PlayerId }
  );

export interface StartCardTestScenarioPayload {
  scenarioId: string;
  /** What this connection wants in its frames; see `ClientCapabilities`. */
  capabilities?: ClientCapabilities;
}

export interface JumpToTurnPayload {
  turn: number;
  sequence?: number;
}

export interface SetPlaybackModePayload {
  mode: PlaybackMode;
  /**
   * Wall-clock ms one turn is shown for in live mode; 0 presents as fast as the engine
   * computes. Rides here rather than adding a message type (ADR 0012).
   */
  paceMs?: number;
}

/** The human's answer to a `decisionPending` (brief §7.7 step 2). */
export interface ResolveHeldDecisionPayload {
  requestId: string;
  actionId: number;
  targets?: TargetChoice[];
}

export interface SetDebugFlagsPayload {
  flags: DebugFlags;
}

export interface SubmitPlayerActionPayload {
  requestId: string;
  actionId: number;
  revision: number;
  targets?: TargetChoice[];
}

/** Yield an optional activation, or smart-yield a spell, across future turns. */
export interface YieldPlayerAbilityPayload {
  requestId: string;
  actionId: number;
  revision: number;
  mode?: 'always' | 'smart';
}

/** Restore an ability previously hidden with `yieldPlayerAbility`. */
export interface ResumePlayerAbilityPayload {
  key: string;
}

export interface ResumeGamePayload {
  sessionToken: string;
  /** Declared again on every resume: the new connection's own capabilities. */
  capabilities?: ClientCapabilities;
}

/** The player's proposal: the table checks it like any other (ADR 0035 decision 15). */
export type ProposeDealPayload = DealTerms;

/** The player's answer to an offer waiting on it, optionally with terms of its own. */
export interface AnswerDealPayload {
  dealId: string;
  answer: 'accept' | 'decline';
  counter?: { obligations: DealObligation[]; rounds: number };
}

/** Free text to read as deal terms with one cheap model call (phase 4). Never offered as is. */
export interface DraftDealPayload {
  text: string;
}

/** Longest free text `draftDeal` accepts. */
export const DEAL_DRAFT_MAX_CHARS = 500;

export type ClientToServerMessage =
  | { type: 'startGame'; payload: StartGamePayload }
  | { type: 'startCardTestScenario'; payload: StartCardTestScenarioPayload }
  | { type: 'jumpToTurn'; payload: JumpToTurnPayload }
  | { type: 'setPlaybackMode'; payload: SetPlaybackModePayload }
  | { type: 'resolveHeldDecision'; payload: ResolveHeldDecisionPayload }
  | { type: 'abandonGame'; payload: Record<string, never> }
  | { type: 'setDebugFlags'; payload: SetDebugFlagsPayload }
  | { type: 'submitPlayerAction'; payload: SubmitPlayerActionPayload }
  | { type: 'yieldPlayerAbility'; payload: YieldPlayerAbilityPayload }
  | { type: 'resumePlayerAbility'; payload: ResumePlayerAbilityPayload }
  | { type: 'cancelYield'; payload: Record<string, never> }
  | { type: 'resumeGame'; payload: ResumeGamePayload }
  | { type: 'proposeDeal'; payload: ProposeDealPayload }
  | { type: 'answerDeal'; payload: AnswerDealPayload }
  | { type: 'draftDeal'; payload: DraftDealPayload };

/** Narrow a client message to one variant, e.g. `ClientMessageOf<'startGame'>`. */
export type ClientMessageOf<T extends ClientToServerType> = Extract<
  ClientToServerMessage,
  { type: T }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isTargets(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (target) =>
          isRecord(target) &&
          Number.isInteger(target['slot']) &&
          (target['slot'] as number) >= 0 &&
          typeof target['choice'] === 'string',
      ))
  );
}

function isObligation(value: unknown): value is DealObligation {
  if (!isRecord(value) || !isPlayerSeatId(value['by'])) return false;
  switch (value['kind']) {
    case 'noAttack':
    case 'noTarget':
    case 'noCounter':
      return Object.keys(value).length === 3 && isPlayerSeatId(value['against']);
    case 'attackPlayer':
      return Object.keys(value).length === 3 && isPlayerSeatId(value['target']);
    default:
      return false;
  }
}

/** Obligations and a length, shaped right; whether they make a valid deal is the table's call. */
function isTermsBody(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value['obligations']) &&
    value['obligations'].length <= 8 &&
    value['obligations'].every(isObligation) &&
    Number.isInteger(value['rounds'])
  );
}

function isSeatSource(value: unknown): value is SeatSource {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'pool':
      return isOptionalString(value['seed']);
    case 'snapshot':
      return typeof value['snapshotId'] === 'string' && value['snapshotId'].length > 0;
    case 'url':
      return typeof value['url'] === 'string' && isOptionalString(value['archetypeTag']);
    case 'plaintext':
      return (
        typeof value['text'] === 'string' &&
        isOptionalString(value['name']) &&
        isOptionalString(value['archetypeTag'])
      );
    default:
      return false;
  }
}

function isDebugFlags(value: unknown): value is DebugFlags {
  if (!isRecord(value)) return false;
  return (
    typeof value['showAIRequests'] === 'boolean' &&
    typeof value['showAIResponses'] === 'boolean' &&
    typeof value['showLegalActions'] === 'boolean' &&
    typeof value['showSBAChecks'] === 'boolean' &&
    typeof value['showPriorityPasses'] === 'boolean' &&
    typeof value['showTokenUsage'] === 'boolean' &&
    typeof value['verboseEngine'] === 'boolean'
  );
}

/** The four seats of a v1 game, as runtime values. */
export const PLAYER_SEAT_IDS = ['P1', 'P2', 'P3', 'P4'] as const;

/**
 * True only for an actual seat string.
 *
 * This is the single-player authorization identity — the server decides whose deck diagnostics a
 * requester may see by comparing against it — so it is checked, never coerced. `String(value)`
 * would accept `['P1']` and any object with a matching `toString`, handing a caller a seat it
 * never named.
 */
export function isPlayerSeatId(value: unknown): value is PlayerId {
  return typeof value === 'string' && (PLAYER_SEAT_IDS as readonly string[]).includes(value);
}

/**
 * Runtime guard for the client→server direction. The server must never trust a socket frame,
 * and the union above is erased at runtime, so the `type` discriminant is checked here.
 */
export function isClientToServerMessage(value: unknown): value is ClientToServerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; payload?: unknown };
  if (typeof candidate.type !== 'string') return false;
  if (!(CLIENT_TO_SERVER_TYPES as readonly string[]).includes(candidate.type)) return false;
  if (typeof candidate.payload !== 'object' || candidate.payload === null) return false;
  const payload = candidate.payload as Record<string, unknown>;
  switch (candidate.type) {
    case 'startGame':
      return (
        Array.isArray(payload['seats']) &&
        payload['seats'].every(isSeatSource) &&
        (payload['providerKind'] === 'random' || payload['providerKind'] === 'ai') &&
        (payload['gameMode'] === undefined ||
          payload['gameMode'] === 'spectator' ||
          payload['gameMode'] === 'singlePlayer') &&
        (payload['gameMode'] === 'singlePlayer'
          ? isPlayerSeatId(payload['humanSeat'])
          : payload['humanSeat'] === undefined) &&
        isOptionalString(payload['seed']) &&
        isOptionalString(payload['previewId']) &&
        (payload['playbackMode'] === undefined ||
          payload['playbackMode'] === 'live' ||
          payload['playbackMode'] === 'manual') &&
        (payload['paceMs'] === undefined ||
          (isFiniteNumber(payload['paceMs']) && payload['paceMs'] >= 0)) &&
        (payload['reflectionEnabled'] === undefined ||
          typeof payload['reflectionEnabled'] === 'boolean') &&
        (payload['diplomacy'] === undefined || typeof payload['diplomacy'] === 'boolean') &&
        isOptionalCapabilities(payload['capabilities'])
      );
    case 'startCardTestScenario':
      return (
        typeof payload['scenarioId'] === 'string' &&
        payload['scenarioId'].length > 0 &&
        isOptionalCapabilities(payload['capabilities'])
      );
    case 'jumpToTurn':
      return (
        Number.isInteger(payload['turn']) &&
        (payload['turn'] as number) >= 0 &&
        (payload['sequence'] === undefined ||
          (Number.isInteger(payload['sequence']) && (payload['sequence'] as number) >= 0))
      );
    case 'setPlaybackMode':
      return (
        (payload['mode'] === 'live' || payload['mode'] === 'manual') &&
        (payload['paceMs'] === undefined ||
          (isFiniteNumber(payload['paceMs']) && payload['paceMs'] >= 0))
      );
    case 'resolveHeldDecision':
      return (
        typeof payload['requestId'] === 'string' &&
        payload['requestId'].length > 0 &&
        Number.isInteger(payload['actionId']) &&
        (payload['actionId'] as number) >= 0 &&
        isTargets(payload['targets'])
      );
    case 'submitPlayerAction':
      return (
        Object.keys(payload).every((key) =>
          ['requestId', 'revision', 'actionId', 'targets'].includes(key),
        ) &&
        typeof payload['requestId'] === 'string' &&
        payload['requestId'].length > 0 &&
        Number.isInteger(payload['actionId']) &&
        (payload['actionId'] as number) >= 0 &&
        Number.isInteger(payload['revision']) &&
        (payload['revision'] as number) >= 0 &&
        isTargets(payload['targets']) &&
        (payload['targets'] === undefined ||
          (Array.isArray(payload['targets']) &&
            payload['targets'].every((target) =>
              Object.keys(target).every((key) => ['slot', 'choice'].includes(key)),
            )))
      );
    case 'yieldPlayerAbility':
      return (
        Object.keys(payload).every((key) =>
          ['requestId', 'revision', 'actionId', 'mode'].includes(key),
        ) &&
        (payload['mode'] === undefined ||
          payload['mode'] === 'always' ||
          payload['mode'] === 'smart') &&
        typeof payload['requestId'] === 'string' &&
        payload['requestId'].length > 0 &&
        Number.isInteger(payload['actionId']) &&
        (payload['actionId'] as number) >= 0 &&
        Number.isInteger(payload['revision']) &&
        (payload['revision'] as number) >= 0
      );
    case 'resumePlayerAbility':
      return typeof payload['key'] === 'string' && payload['key'].length > 0;
    case 'cancelYield':
      return Object.keys(payload).length === 0;
    case 'resumeGame':
      return (
        typeof payload['sessionToken'] === 'string' &&
        payload['sessionToken'].length > 0 &&
        isOptionalCapabilities(payload['capabilities'])
      );
    case 'proposeDeal':
      return (
        Object.keys(payload).every((key) => ['to', 'obligations', 'rounds'].includes(key)) &&
        isPlayerSeatId(payload['to']) &&
        isTermsBody(payload)
      );
    case 'answerDeal':
      return (
        Object.keys(payload).every((key) => ['dealId', 'answer', 'counter'].includes(key)) &&
        typeof payload['dealId'] === 'string' &&
        payload['dealId'].length > 0 &&
        (payload['answer'] === 'accept' || payload['answer'] === 'decline') &&
        (payload['counter'] === undefined ||
          (payload['answer'] === 'decline' &&
            isRecord(payload['counter']) &&
            Object.keys(payload['counter']).every((key) =>
              ['obligations', 'rounds'].includes(key),
            ) &&
            isTermsBody(payload['counter'])))
      );
    case 'draftDeal':
      return (
        Object.keys(payload).length === 1 &&
        typeof payload['text'] === 'string' &&
        payload['text'].trim().length > 0 &&
        payload['text'].length <= DEAL_DRAFT_MAX_CHARS
      );
    case 'setDebugFlags':
      return isDebugFlags(payload['flags']);
    case 'abandonGame':
      return Object.keys(payload).length === 0;
  }
  return false;
}

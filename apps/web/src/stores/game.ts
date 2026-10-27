/**
 * The spectator store: connection, current board, log, and playback position.
 *
 * The server is authoritative about everything (brief §11) — this store never derives a rule,
 * a legal action, or a board state. It holds what the server pushed and remembers where the
 * user is looking.
 */

import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type {
  AiAnnotation,
  AiReflection,
  CardTestScenarioMetadata,
  ComputeHaltedPayload,
  DebugFlags,
  DecisionPendingPayload,
  GameMode,
  GameOverPayload,
  IgnoredPlayerAbility,
  PlayerActionRequiredPayload,
  PlayerBoardState,
  PlayerId,
  PlaybackMode,
  ProviderKind,
  SeatSource,
  SeatSummary,
  ServerToClientMessage,
  SpectatorLogLine,
  SpectatorState,
  TableTalkLine,
  TargetChoice,
} from '@mtg/shared';
import { GameSocket, type ConnectionState } from '../lib/socket';
import { resetBoardAnchors } from '../composables/useBoardAnchors';
import { resetCombatStrikes } from '../composables/useCombatStrikes';
import { pushRecentId, readRecentIds, saveRecentIds } from '../lib/recentSetup';
import { dealsInForce, mergeTalk } from '../lib/tableTalk';

/** Log lines kept in memory. A long game emits thousands; the scroller only shows the tail. */
const MAX_LOG_LINES = 4_000;

/** Default live-mode pace, in ms per turn. Mirrors the server's `LIVE_PACE_MS`. */
export const DEFAULT_PACE_MS = 1_200;

export interface ApiCost {
  calls: number;
  skippedCalls: number;
  promptTokens: number;
  responseTokens: number;
}

const DEFAULT_DEBUG_FLAGS: DebugFlags = {
  showAIRequests: false,
  showAIResponses: false,
  showLegalActions: false,
  showSBAChecks: false,
  showPriorityPasses: false,
  showTokenUsage: true,
  verboseEngine: false,
};

export const useGameStore = defineStore('game', () => {
  const connection = ref<ConnectionState>('closed');
  const gameId = ref<string | null>(null);
  const seed = ref<string | null>(null);
  const seats = ref<SeatSummary[]>([]);
  const providerKind = ref<ProviderKind>('random');
  const sessionToken = ref<string | null>(
    typeof localStorage === 'undefined' ? null : localStorage.getItem('mtg-player-session'),
  );
  const gameMode = ref<GameMode>(sessionToken.value === null ? 'spectator' : 'singlePlayer');
  const humanSeat = ref<string | null>(null);
  const cardTestScenario = ref<CardTestScenarioMetadata | null>(null);

  /** `shallowRef`: the board is replaced wholesale on every push, never mutated in place. */
  const state = shallowRef<SpectatorState | null>(null);
  const playerState = shallowRef<PlayerBoardState | null>(null);
  const playerAction = shallowRef<PlayerActionRequiredPayload | null>(null);
  const playerRevision = ref(0);
  const ignoredAbilities = ref<IgnoredPlayerAbility[]>([]);
  const log = ref<SpectatorLogLine[]>([]);
  /**
   * The newest log sequence the player had seen when they last made a choice other than passing,
   * so the board can summarise what the bots did since. Passing does not count: a player with an
   * always-available ability stops at nearly every priority window, and resetting on each pass
   * would leave only the latest bot action. Null until the player first acts.
   */
  const lastPlayerActionSequence = ref<number | null>(null);

  const viewTurn = ref(0);
  const frontierTurn = ref(0);
  const snapshotTurns = ref<number[]>([]);
  const playbackMode = ref<PlaybackMode>('live');
  /** Live-mode presentation speed, in ms per turn. 0 is "as fast as it computes". */
  const paceMs = ref(DEFAULT_PACE_MS);
  /** Routine land plays and passes are one-click by default; this restores the safer all-confirm mode. */
  const confirmRoutineActions = ref(
    typeof localStorage !== 'undefined' &&
      localStorage.getItem('mtg-player-confirm-routine') === 'true',
  );
  /** Ask once per turn before passing a main phase with a playable land still in hand. */
  const remindUnplayedLand = ref(
    typeof localStorage === 'undefined' ||
      localStorage.getItem('mtg-player-remind-land') !== 'false',
  );
  /** Opt-in: skip the manual "Confirm" click on the tray once every target slot is filled. */
  const autoConfirmActions = ref(
    typeof localStorage !== 'undefined' &&
      localStorage.getItem('mtg-player-auto-confirm') === 'true',
  );
  /**
   * Suppresses combat-overlay lines, drag ghost/cursor line, and (via a global CSS override)
   * every CSS animation/transition — defaulted from the OS setting, player-overridable. `null`
   * stored means "never explicitly set"; an explicit choice always wins over the OS query.
   */
  const storedReducedMotion =
    typeof localStorage !== 'undefined' ? localStorage.getItem('mtg-player-reduced-motion') : null;
  const reducedMotion = ref(
    storedReducedMotion !== null
      ? storedReducedMotion === 'true'
      : typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  );

  /**
   * The action-log line the board on screen belongs to, as confirmed by the server. Never set
   * optimistically: if the server served a turn snapshot instead of the exact per-action board
   * it clears this, so the log highlight can never claim a position the board is not at.
   */
  const activeSequence = ref<number | null>(null);

  const halt = ref<ComputeHaltedPayload | null>(null);
  const heldDecision = ref<DecisionPendingPayload | null>(null);
  const gameOver = ref<GameOverPayload | null>(null);
  const errors = ref<string[]>([]);
  const apiCost = ref<ApiCost | null>(null);
  const debugFlags = ref<DebugFlags>({ ...DEFAULT_DEBUG_FLAGS });
  const liveDebug = ref<Array<{ turn: number; category: string; message: string }>>([]);

  /**
   * AI reasoning grouped by the log line it explains (ADR 0022). A line can carry more than one:
   * the turn's strategist intent and a tactical note can land on the same sequence.
   */
  const annotations = ref<Map<number, AiAnnotation[]>>(new Map());

  function addAnnotations(incoming: AiAnnotation[] | undefined): void {
    if (incoming === undefined || incoming.length === 0) return;
    const next = new Map(annotations.value);
    for (const annotation of incoming) {
      const existing = next.get(annotation.sequence) ?? [];
      // The same note can arrive twice — live, then again from the history endpoint after a
      // reload — and duplicating it in the log would read as the model repeating itself.
      if (existing.some((item) => item.kind === annotation.kind && item.text === annotation.text)) {
        continue;
      }
      next.set(annotation.sequence, [...existing, annotation]);
    }
    annotations.value = next;
  }

  /**
   * Table talk and deals (ADR 0035): on only for a game started with them. Kept in the order it
   * was said, since a deal's lines must be read in order; `talkBySequence` groups it for the log.
   */
  const diplomacy = ref(false);
  const tableTalk = ref<TableTalkLine[]>([]);
  const showTableTalk = ref(true);

  function addTableTalk(incoming: TableTalkLine[] | undefined): void {
    if (incoming === undefined || incoming.length === 0) return;
    tableTalk.value = mergeTalk(tableTalk.value, incoming);
  }

  const talkBySequence = computed(() => {
    const grouped = new Map<number, TableTalkLine[]>();
    for (const line of tableTalk.value) {
      grouped.set(line.sequence, [...(grouped.get(line.sequence) ?? []), line]);
    }
    return grouped;
  });

  /**
   * Deals in force at the action the viewer stands on, or at the latest one shown. Talk past the
   * last line shown counts only once the game is over: before then it belongs to plays not
   * presented yet.
   */
  const dealsNow = computed(() =>
    dealsInForce(
      tableTalk.value,
      activeSequence.value ?? (gameOver.value !== null ? null : (log.value.at(-1)?.sequence ?? -1)),
    ),
  );

  /** Backfill table talk for a game already in progress or finished (survives a reload). */
  async function loadTableTalk(): Promise<void> {
    const id = gameId.value;
    if (id === null) return;
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(id)}/table-talk`);
      if (!response.ok) return;
      const history = (await response.json()).tableTalk as TableTalkLine[];
      if (gameId.value !== id) return;
      // Live lines may have arrived while this was in flight. History goes first: it holds every
      // line said before them, and any it shares with them are dropped as duplicates.
      tableTalk.value = mergeTalk(history, tableTalk.value);
    } catch {
      // History is a nicety; the live stream is the source of truth.
    }
  }

  /**
   * Post-game commentary (ADR 0022 §7). `reflectingSeats` arrives on `gameOver` and says which
   * seats are *going* to review; `reflections` fills in as each one lands. Two refs rather than
   * one because "waiting on P3" and "P3 had nothing to say" must look different on screen.
   */
  const reflections = ref<AiReflection[]>([]);
  const reflectingSeats = ref<PlayerId[]>([]);
  /** True once every seat has answered or failed — a seat with no review is done, not thinking. */
  const reflectionsComplete = ref(false);

  /** Backfill commentary for a finished game (a reload loses the live `gameReflections`). */
  async function loadReflections(): Promise<void> {
    if (gameId.value === null) return;
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(gameId.value)}/reflections`);
      if (!response.ok) return;
      const loaded = (await response.json()).reflections as AiReflection[];
      if (loaded.length > 0) {
        reflections.value = loaded;
        // Anything stored is finished by definition — reflections are only written after a game.
        reflectionsComplete.value = true;
      }
    } catch {
      // Commentary is a nicety; the result itself is already on screen.
    }
  }

  /** Backfill reasoning for a game already in progress or finished (survives a page reload). */
  async function loadAnnotations(): Promise<void> {
    if (gameId.value === null) return;
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(gameId.value)}/annotations`);
      if (!response.ok) return;
      addAnnotations((await response.json()).annotations as AiAnnotation[]);
    } catch {
      // History is a nicety; the live stream is the source of truth.
    }
  }

  /** Scrubbing backward is free; forward past the frontier is not offered (brief §10.1). */
  const atFrontier = computed(() => viewTurn.value >= frontierTurn.value);
  const isRunning = computed(
    () => gameId.value !== null && gameOver.value === null && halt.value === null,
  );

  let socket: GameSocket | null = null;
  let pendingRecentDeckSeat: PlayerId | null = null;
  /**
   * The named bot pod a start was requested with, held until the server confirms that start.
   * Recents must describe games the player actually played, so this is written on `gameStarted`
   * for the same reason an imported deck is written from the snapshot ID that answer returns
   * rather than from what the setup form asked for. A rejected or dropped start clears it, so a
   * failure can never write a pod into the history later.
   */
  let pendingRecentPodId: string | null = null;

  /**
   * A `resumeGame` sent on connect that the server has not answered yet. The server answers in
   * order, so the next `gameStarted` or `error` is its reply. Without this, a stale token's
   * refusal read as the answer to a `startGame` queued behind it: Setup stopped waiting, ignored
   * the `gameStarted` that followed, and the new game ran with nobody on the board.
   */
  let resumePending = false;

  /** Drop a player session the server no longer has, so it is not offered again on reconnect. */
  function forgetSession(): void {
    sessionToken.value = null;
    if (typeof localStorage !== 'undefined') localStorage.removeItem('mtg-player-session');
  }

  /** Forget an unconfirmed start's recents, so a failed or superseded one can never write. */
  function clearPendingRecents(): void {
    pendingRecentDeckSeat = null;
    pendingRecentPodId = null;
  }

  /** Put a confirmed ID at the head of one local recents list. */
  function rememberRecentId(key: string, id: string): void {
    if (typeof localStorage === 'undefined') return;
    saveRecentIds(key, pushRecentId(readRecentIds(key), id));
  }

  function handle(message: ServerToClientMessage): void {
    if (message.type !== 'gameStarted') {
      const payload = message.payload;
      const incomingGameId =
        'gameId' in payload
          ? payload.gameId
          : 'state' in payload
            ? payload.state.gameId
            : 'result' in payload
              ? payload.result.gameId
              : 'request' in payload
                ? payload.request.gameId
                : undefined;
      if (gameId.value !== null && incomingGameId !== undefined && incomingGameId !== gameId.value)
        return;
    }
    switch (message.type) {
      case 'gameStarted': {
        resumePending = false;
        if (pendingRecentDeckSeat !== null) {
          const selected = message.payload.seats.find(
            (seat) => seat.seat === pendingRecentDeckSeat,
          );
          if (selected) rememberRecentId('mtg-recent-deck-ids', selected.deckId);
        }
        if (pendingRecentPodId !== null) {
          rememberRecentId('mtg-recent-pod-ids', pendingRecentPodId);
        }
        clearPendingRecents();
        const resuming = gameId.value === message.payload.gameId;
        gameId.value = message.payload.gameId;
        seed.value = message.payload.seed;
        seats.value = message.payload.seats;
        providerKind.value = message.payload.providerKind;
        gameMode.value = message.payload.gameMode ?? 'spectator';
        humanSeat.value = message.payload.humanSeat ?? null;
        cardTestScenario.value = message.payload.cardTestScenario ?? null;
        diplomacy.value = message.payload.diplomacy === true;
        if (message.payload.paceMs !== undefined) paceMs.value = message.payload.paceMs;
        if (message.payload.sessionToken !== undefined) {
          sessionToken.value = message.payload.sessionToken;
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem('mtg-player-session', message.payload.sessionToken);
          }
        } else {
          sessionToken.value = null;
          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem('mtg-player-session');
          }
        }
        // A viewer who reconnects or reloads missed whatever was said meanwhile; the endpoint has
        // all of it. It resolves after the reset below, and duplicates are dropped on arrival.
        if (diplomacy.value) void loadTableTalk();
        if (resuming) break;
        log.value = [];
        lastPlayerActionSequence.value = null;
        halt.value = null;
        gameOver.value = null;
        errors.value = [];
        viewTurn.value = 0;
        frontierTurn.value = 0;
        snapshotTurns.value = [];
        // Everything below is per-game and was previously left standing. Sequence numbers
        // restart at 0 in a new game, so a leftover `activeSequence` matched an unrelated
        // action in the new log and threw the viewer to wherever that landed.
        activeSequence.value = null;
        heldDecision.value = null;
        annotations.value = new Map();
        tableTalk.value = [];
        reflections.value = [];
        reflectingSeats.value = [];
        reflectionsComplete.value = false;
        apiCost.value = null;
        // These two live outside Pinia (module-level registries shared by every board component
        // — see their own doc comments), so they need an explicit reset here rather than picking
        // it up for free the way everything above does.
        resetBoardAnchors();
        resetCombatStrikes();
        state.value = null;
        playerState.value = null;
        playerAction.value = null;
        playerRevision.value = 0;
        ignoredAbilities.value = [];
        break;
      }

      case 'stateSnapshot':
        state.value = message.payload.state;
        viewTurn.value = message.payload.turn;
        frontierTurn.value = Math.max(frontierTurn.value, message.payload.frontierTurn);
        // `undefined` means a server that did not report one; `null` means "this is a turn
        // snapshot, not a per-action board". Both clear the highlight.
        activeSequence.value = message.payload.sequence ?? null;
        break;

      case 'eventBatch':
        log.value = [
          ...new Map(
            [...log.value, ...message.payload.lines].map((line) => [line.sequence, line]),
          ).values(),
        ]
          .sort((a, b) => a.sequence - b.sequence)
          .slice(-MAX_LOG_LINES);
        frontierTurn.value = Math.max(frontierTurn.value, message.payload.frontierTurn);
        snapshotTurns.value = message.payload.snapshotTurns;
        addAnnotations(message.payload.annotations);
        addTableTalk(message.payload.tableTalk);
        break;

      case 'decisionPending':
        heldDecision.value = message.payload;
        break;

      case 'computeHalted':
        halt.value = message.payload;
        heldDecision.value = null;
        break;

      case 'apiWaiting':
        apiCost.value = {
          calls: message.payload.calls,
          skippedCalls: message.payload.skippedCalls,
          promptTokens: message.payload.promptTokens,
          responseTokens: message.payload.responseTokens,
        };
        break;

      case 'debugEvents':
        liveDebug.value = [...liveDebug.value, ...message.payload.entries].slice(-2_000);
        break;

      case 'playerStateSnapshot':
        playerState.value = message.payload.state;
        playerRevision.value = message.payload.revision;
        ignoredAbilities.value = message.payload.ignoredAbilities;
        if (playerAction.value !== null && message.payload.revision > playerAction.value.revision) {
          playerAction.value = null;
        }
        viewTurn.value = message.payload.state.turnNumber;
        frontierTurn.value = message.payload.state.turnNumber;
        break;

      case 'playerActionRequired':
        playerState.value = message.payload.state;
        playerAction.value = message.payload;
        playerRevision.value = message.payload.revision;
        ignoredAbilities.value = message.payload.ignoredAbilities;
        viewTurn.value = message.payload.state.turnNumber;
        frontierTurn.value = message.payload.state.turnNumber;
        break;

      case 'sessionPaused':
        break;

      case 'replayUnlocked':
        state.value = message.payload.state;
        log.value = message.payload.lines.slice(-MAX_LOG_LINES);
        snapshotTurns.value = message.payload.snapshotTurns;
        frontierTurn.value = message.payload.frontierTurn;
        viewTurn.value = message.payload.state.turnNumber;
        activeSequence.value = null;
        // The whole game's AI reasoning arrives at once here — a player game withholds it until
        // the result is settled, so this is the first moment any of it is legal to show.
        addAnnotations(message.payload.annotations);
        break;

      case 'gameOver':
        gameOver.value = message.payload;
        reflectingSeats.value = message.payload.reflectingSeats ?? [];
        heldDecision.value = null;
        playerAction.value = null;
        break;

      case 'gameReflections':
        // The server re-sends everything it has each time, so this is a replace, not an append.
        reflections.value = message.payload.reflections;
        reflectionsComplete.value = message.payload.complete;
        break;

      case 'error': {
        if (resumePending) {
          // The stored session is gone (the game ended, or the server restarted). That is not a
          // failure of anything the player asked for, and a start queued behind the resume is
          // still waiting for its own answer.
          resumePending = false;
          forgetSession();
          break;
        }
        // A rejected start never happened, so nothing it asked to be remembered may be written.
        clearPendingRecents();
        const detail = [
          message.payload.message,
          ...(message.payload.unmodeledCards ?? []).map(
            (entry) => `${entry.seat} cannot be played — unmodeled: ${entry.cards.join(', ')}`,
          ),
          ...(message.payload.deckIssues ?? []).flatMap((entry) =>
            entry.issues.map((issue) => `${entry.seat}: ${issue.message}`),
          ),
        ];
        errors.value = detail;
        const pending = playerAction.value;
        if (
          pending !== null &&
          message.payload.requestId === pending.request.requestId &&
          message.payload.revision === pending.revision
        ) {
          playerAction.value = { ...pending, request: { ...pending.request } };
        }
        break;
      }
    }
  }

  function connect(): void {
    socket ??= new GameSocket(handle, (next) => {
      connection.value = next;
      // A start whose answer never arrived is not a start either.
      if (next === 'closed') {
        clearPendingRecents();
        resumePending = false;
      }
      if (next === 'open' && sessionToken.value !== null && gameMode.value === 'singlePlayer') {
        resumePending = true;
        socket?.send({
          type: 'resumeGame',
          payload: { sessionToken: sessionToken.value },
        });
      }
    });
    socket.connect();
  }

  function startGame(
    sources: SeatSource[],
    kind: ProviderKind,
    requestedSeed?: string,
    mode: GameMode = 'spectator',
    selectedHumanSeat?: PlayerId,
    reflectionEnabled = false,
    previewId?: string,
    /** A named bot pod to remember, but only once the server confirms this start. */
    recentPodId?: string,
    options: { diplomacy?: boolean } = {},
  ): void {
    connect();
    errors.value = [];
    const chosenSeat = selectedHumanSeat ?? 'P1';
    pendingRecentDeckSeat =
      mode === 'singlePlayer' && sources[Number(chosenSeat.slice(1)) - 1]?.kind !== 'pool'
        ? chosenSeat
        : null;
    pendingRecentPodId =
      mode === 'singlePlayer' && recentPodId !== undefined && recentPodId !== ''
        ? recentPodId
        : null;
    // A player game should run to the next meaningful human decision by default, rather than
    // making a new player watch a 1.2s delay for every bot choice.
    if (mode === 'singlePlayer' && paceMs.value === DEFAULT_PACE_MS) paceMs.value = 0;
    const common = {
      seats: sources,
      providerKind: kind,
      playbackMode: playbackMode.value,
      paceMs: paceMs.value,
      // Only sent when asked for, so a game that does not want commentary leaves the server's own
      // `AI_REFLECTION_ENABLED` default in charge.
      ...(reflectionEnabled && kind === 'ai' && { reflectionEnabled: true }),
      // Deals and table talk are for spectator games of rule-based bots (ADR 0035 phase 2).
      ...(options.diplomacy === true &&
        mode === 'spectator' &&
        kind === 'random' && { diplomacy: true }),
      ...(requestedSeed !== undefined && requestedSeed !== '' && { seed: requestedSeed }),
      ...(previewId !== undefined && { previewId }),
    };
    socket?.send({
      type: 'startGame',
      payload:
        mode === 'singlePlayer'
          ? { ...common, gameMode: mode, humanSeat: selectedHumanSeat ?? 'P1' }
          : { ...common, gameMode: mode },
    });
  }

  function startCardTestScenario(scenarioId: string): void {
    connect();
    errors.value = [];
    socket?.send({
      type: 'startCardTestScenario',
      payload: { scenarioId },
    });
  }

  /**
   * Move the viewer. This is also what un-parks compute: the server computes at most five turns
   * past this position (brief §10.1), so watching is what pays for the next turns.
   */
  function jumpToTurn(turn: number, sequence?: number): void {
    socket?.send({
      type: 'jumpToTurn',
      payload: sequence !== undefined ? { turn, sequence } : { turn },
    });
  }

  function stepBack(): void {
    if (viewTurn.value > 0) seek(viewTurn.value - 1);
  }

  function stepForward(): void {
    if (viewTurn.value < frontierTurn.value || isRunning.value) {
      seek(viewTurn.value + 1);
    }
  }

  /**
   * Where the viewer sits in the action log.
   *
   * Two distinct positions, and conflating them is what broke stepping. Either the board is a
   * specific action's board (`onLine`, at `index`), or it is a turn snapshot — the board at the
   * *start* of a turn, which is a gap between two log lines, with `index` naming the line just
   * after it. The old version answered by turn instead: it returned the *last* line of the
   * current turn, so "back one action" from a turn boundary moved you forwards into that turn,
   * and it fell back to index 0 whenever nothing matched, which is how one click threw the
   * viewer to the first action of the game.
   */
  function position(): { index: number; onLine: boolean } {
    if (activeSequence.value !== null) {
      const exact = log.value.findIndex((line) => line.sequence === activeSequence.value);
      if (exact !== -1) return { index: exact, onLine: true };
    }
    const firstOfTurn = log.value.findIndex((line) => line.turn >= viewTurn.value);
    return { index: firstOfTurn === -1 ? log.value.length : firstOfTurn, onLine: false };
  }

  /** The log index one step away, or -1 when there is nothing there. */
  function targetIndex(delta: number): number {
    const { index, onLine } = position();
    // From a gap, forward is the line the gap sits before and back is the one before that.
    const target = onLine ? index + delta : delta > 0 ? index : index - 1;
    return target >= 0 && target < log.value.length ? target : -1;
  }

  /** True when there is a log line to step to in that direction. */
  function canStepAction(delta: number): boolean {
    return targetIndex(delta) !== -1;
  }

  function stepAction(delta: number): void {
    const line = log.value[targetIndex(delta)];
    if (line === undefined) return;
    jumpToSequence(line.sequence, line.turn);
  }

  function jumpToSequence(seq: number, turn?: number): void {
    // `activeSequence` is not set here — the server confirms it on the snapshot it sends back,
    // so the highlighted line and the rendered board cannot drift apart.
    seek(turn ?? viewTurn.value, seq);
  }

  /**
   * Any deliberate move by the user. Live mode has a presentation clock that keeps walking the
   * viewer forward, so seeking while live means fighting it — drop to manual first. This is
   * what made scrubbing and log clicks appear to do nothing: the position was reclaimed a
   * fraction of a second later.
   */
  function seek(turn: number, sequence?: number): void {
    if (playbackMode.value === 'live') setPlaybackMode('manual');
    jumpToTurn(turn, sequence);
  }

  function setPlaybackMode(mode: PlaybackMode): void {
    playbackMode.value = mode;
    socket?.send({ type: 'setPlaybackMode', payload: { mode, paceMs: paceMs.value } });
  }

  function setPace(ms: number): void {
    paceMs.value = Math.max(0, ms);
    socket?.send({
      type: 'setPlaybackMode',
      payload: { mode: playbackMode.value, paceMs: paceMs.value },
    });
  }

  function setConfirmRoutineActions(value: boolean): void {
    confirmRoutineActions.value = value;
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('mtg-player-confirm-routine', String(value));
  }

  function setRemindUnplayedLand(value: boolean): void {
    remindUnplayedLand.value = value;
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('mtg-player-remind-land', String(value));
  }

  function setAutoConfirmActions(value: boolean): void {
    autoConfirmActions.value = value;
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('mtg-player-auto-confirm', String(value));
  }

  function setReducedMotion(value: boolean): void {
    reducedMotion.value = value;
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('mtg-player-reduced-motion', String(value));
  }

  function resolveHeldDecision(actionId: number): void {
    const held = heldDecision.value;
    if (held === null) return;
    socket?.send({
      type: 'resolveHeldDecision',
      payload: { requestId: held.request.requestId, actionId },
    });
    heldDecision.value = null;
  }

  function submitPlayerAction(actionId: number, targets?: TargetChoice[]): void {
    const pending = playerAction.value;
    if (pending === null) return;
    const type = pending.request.legalActions.find((action) => action.id === actionId)?.type;
    if (type !== 'pass' && type !== 'passAndYieldTurn') {
      lastPlayerActionSequence.value = log.value.at(-1)?.sequence ?? null;
    }
    socket?.send({
      type: 'submitPlayerAction',
      payload: {
        requestId: pending.request.requestId,
        actionId,
        revision: pending.revision,
        ...(targets !== undefined && targets.length > 0 ? { targets } : {}),
      },
    });
  }

  function yieldPlayerAbility(actionId: number, mode: 'always' | 'smart' = 'always'): void {
    const pending = playerAction.value;
    if (pending === null) return;
    socket?.send({
      type: 'yieldPlayerAbility',
      payload: {
        requestId: pending.request.requestId,
        actionId,
        revision: pending.revision,
        mode,
      },
    });
  }

  function resumePlayerAbility(key: string): void {
    socket?.send({ type: 'resumePlayerAbility', payload: { key } });
  }

  /** Out-of-band: cancel an active "pass and yield until end of turn" before it lapses on its own. */
  function cancelYield(): void {
    socket?.send({ type: 'cancelYield', payload: {} });
  }

  function setDebugFlags(next: DebugFlags): void {
    const wasShowingReasoning = debugFlags.value.showAIResponses;
    debugFlags.value = { ...next };
    socket?.send({ type: 'setDebugFlags', payload: { flags: debugFlags.value } });
    // The live stream only carries notes recorded while the flag was on, so switching it on
    // mid-game would otherwise show reasoning starting from now with no history behind it.
    if (!wasShowingReasoning && next.showAIResponses) void loadAnnotations();
  }

  function abandonGame(): void {
    socket?.send({ type: 'abandonGame', payload: {} });
    gameId.value = null;
    state.value = null;
    playerState.value = null;
    playerAction.value = null;
    activeSequence.value = null;
    heldDecision.value = null;
    cardTestScenario.value = null;
    forgetSession();
  }

  return {
    connection,
    gameId,
    seed,
    seats,
    providerKind,
    gameMode,
    humanSeat,
    cardTestScenario,
    sessionToken,
    state,
    playerState,
    playerAction,
    playerRevision,
    ignoredAbilities,
    log,
    lastPlayerActionSequence,
    viewTurn,
    frontierTurn,
    snapshotTurns,
    playbackMode,
    paceMs,
    confirmRoutineActions,
    remindUnplayedLand,
    autoConfirmActions,
    reducedMotion,
    halt,
    heldDecision,
    gameOver,
    errors,
    apiCost,
    debugFlags,
    liveDebug,
    annotations,
    loadAnnotations,
    diplomacy,
    tableTalk,
    talkBySequence,
    showTableTalk,
    dealsNow,
    loadTableTalk,
    reflections,
    reflectingSeats,
    reflectionsComplete,
    loadReflections,
    activeSequence,
    atFrontier,
    isRunning,
    connect,
    startGame,
    startCardTestScenario,
    jumpToTurn,
    seek,
    stepBack,
    stepForward,
    stepAction,
    canStepAction,
    jumpToSequence,
    setPlaybackMode,
    setPace,
    setConfirmRoutineActions,
    setRemindUnplayedLand,
    setAutoConfirmActions,
    setReducedMotion,
    resolveHeldDecision,
    submitPlayerAction,
    yieldPlayerAbility,
    resumePlayerAbility,
    cancelYield,
    setDebugFlags,
    abandonGame,
  };
});

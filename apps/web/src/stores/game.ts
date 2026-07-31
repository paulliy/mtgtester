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
  TargetChoice,
} from '@mtg/shared';
import { GameSocket, type ConnectionState } from '../lib/socket';

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

  /** `shallowRef`: the board is replaced wholesale on every push, never mutated in place. */
  const state = shallowRef<SpectatorState | null>(null);
  const playerState = shallowRef<PlayerBoardState | null>(null);
  const playerAction = shallowRef<PlayerActionRequiredPayload | null>(null);
  const playerRevision = ref(0);
  const ignoredAbilities = ref<IgnoredPlayerAbility[]>([]);
  const log = ref<SpectatorLogLine[]>([]);

  const viewTurn = ref(0);
  const frontierTurn = ref(0);
  const snapshotTurns = ref<number[]>([]);
  const playbackMode = ref<PlaybackMode>('live');
  /** Live-mode presentation speed, in ms per turn. 0 is "as fast as it computes". */
  const paceMs = ref(DEFAULT_PACE_MS);
  /** Routine land plays and passes are one-click by default; this restores the safer all-confirm mode. */
  const confirmRoutineActions = ref(
    typeof localStorage !== 'undefined' && localStorage.getItem('mtg-player-confirm-routine') === 'true',
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

  /** Scrubbing backward is free; forward past the frontier is not offered (brief §10.1). */
  const atFrontier = computed(() => viewTurn.value >= frontierTurn.value);
  const isRunning = computed(
    () => gameId.value !== null && gameOver.value === null && halt.value === null,
  );

  let socket: GameSocket | null = null;

  function handle(message: ServerToClientMessage): void {
    switch (message.type) {
      case 'gameStarted': {
        const resuming = gameId.value === message.payload.gameId;
        gameId.value = message.payload.gameId;
        seed.value = message.payload.seed;
        seats.value = message.payload.seats;
        providerKind.value = message.payload.providerKind;
        gameMode.value = message.payload.gameMode ?? 'spectator';
        humanSeat.value = message.payload.humanSeat ?? null;
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
        if (resuming) break;
        log.value = [];
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
        apiCost.value = null;
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
        if (
          playerAction.value !== null &&
          message.payload.revision > playerAction.value.revision
        ) {
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
        break;

      case 'gameOver':
        gameOver.value = message.payload;
        heldDecision.value = null;
        playerAction.value = null;
        break;

      case 'error': {
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
        break;
      }
    }
  }

  function connect(): void {
    socket ??= new GameSocket(handle, (next) => {
      connection.value = next;
      if (next === 'open' && sessionToken.value !== null && gameMode.value === 'singlePlayer') {
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
  ): void {
    connect();
    errors.value = [];
    // A player game should run to the next meaningful human decision by default, rather than
    // making a new player watch a 1.2s delay for every bot choice.
    if (mode === 'singlePlayer' && paceMs.value === DEFAULT_PACE_MS) paceMs.value = 0;
    const common = {
      seats: sources,
      providerKind: kind,
      playbackMode: playbackMode.value,
      paceMs: paceMs.value,
      ...(requestedSeed !== undefined && requestedSeed !== '' && { seed: requestedSeed }),
    };
    socket?.send({
      type: 'startGame',
      payload:
        mode === 'singlePlayer'
          ? { ...common, gameMode: mode, humanSeat: selectedHumanSeat ?? 'P1' }
          : { ...common, gameMode: mode },
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
    if (typeof localStorage !== 'undefined') localStorage.setItem('mtg-player-confirm-routine', String(value));
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

  function yieldPlayerAbility(actionId: number): void {
    const pending = playerAction.value;
    if (pending === null) return;
    socket?.send({
      type: 'yieldPlayerAbility',
      payload: {
        requestId: pending.request.requestId,
        actionId,
        revision: pending.revision,
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
    debugFlags.value = { ...next };
    socket?.send({ type: 'setDebugFlags', payload: { flags: debugFlags.value } });
  }

  function abandonGame(): void {
    socket?.send({ type: 'abandonGame', payload: {} });
    gameId.value = null;
    state.value = null;
    playerState.value = null;
    playerAction.value = null;
    activeSequence.value = null;
    heldDecision.value = null;
    sessionToken.value = null;
    if (typeof localStorage !== 'undefined') localStorage.removeItem('mtg-player-session');
  }

  return {
    connection,
    gameId,
    seed,
    seats,
    providerKind,
    gameMode,
    humanSeat,
    sessionToken,
    state,
    playerState,
    playerAction,
    playerRevision,
    ignoredAbilities,
    log,
    viewTurn,
    frontierTurn,
    snapshotTurns,
    playbackMode,
    paceMs,
    confirmRoutineActions,
    halt,
    heldDecision,
    gameOver,
    errors,
    apiCost,
    debugFlags,
    liveDebug,
    activeSequence,
    atFrontier,
    isRunning,
    connect,
    startGame,
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
    resolveHeldDecision,
    submitPlayerAction,
    yieldPlayerAbility,
    resumePlayerAbility,
    cancelYield,
    setDebugFlags,
    abandonGame,
  };
});

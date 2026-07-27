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
  DecisionPendingPayload,
  GameOverPayload,
  PlaybackMode,
  ProviderKind,
  SeatSource,
  SeatSummary,
  ServerToClientMessage,
  SpectatorLogLine,
  SpectatorState,
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

export const useGameStore = defineStore('game', () => {
  const connection = ref<ConnectionState>('closed');
  const gameId = ref<string | null>(null);
  const seed = ref<string | null>(null);
  const seats = ref<SeatSummary[]>([]);
  const providerKind = ref<ProviderKind>('random');

  /** `shallowRef`: the board is replaced wholesale on every push, never mutated in place. */
  const state = shallowRef<SpectatorState | null>(null);
  const log = ref<SpectatorLogLine[]>([]);

  const viewTurn = ref(0);
  const frontierTurn = ref(0);
  const snapshotTurns = ref<number[]>([]);
  const playbackMode = ref<PlaybackMode>('live');
  /** Live-mode presentation speed, in ms per turn. 0 is "as fast as it computes". */
  const paceMs = ref(DEFAULT_PACE_MS);

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

  /** Scrubbing backward is free; forward past the frontier is not offered (brief §10.1). */
  const atFrontier = computed(() => viewTurn.value >= frontierTurn.value);
  const isRunning = computed(
    () => gameId.value !== null && gameOver.value === null && halt.value === null,
  );

  let socket: GameSocket | null = null;

  function handle(message: ServerToClientMessage): void {
    switch (message.type) {
      case 'gameStarted':
        gameId.value = message.payload.gameId;
        seed.value = message.payload.seed;
        seats.value = message.payload.seats;
        providerKind.value = message.payload.providerKind;
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
        break;

      case 'stateSnapshot':
        state.value = message.payload.state;
        viewTurn.value = message.payload.turn;
        frontierTurn.value = Math.max(frontierTurn.value, message.payload.frontierTurn);
        // `undefined` means a server that did not report one; `null` means "this is a turn
        // snapshot, not a per-action board". Both clear the highlight.
        activeSequence.value = message.payload.sequence ?? null;
        break;

      case 'eventBatch':
        log.value = [...log.value, ...message.payload.lines].slice(-MAX_LOG_LINES);
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

      case 'gameOver':
        gameOver.value = message.payload;
        heldDecision.value = null;
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
    });
    socket.connect();
  }

  function startGame(
    sources: SeatSource[],
    kind: ProviderKind,
    requestedSeed?: string,
  ): void {
    connect();
    errors.value = [];
    socket?.send({
      type: 'startGame',
      payload: {
        seats: sources,
        providerKind: kind,
        playbackMode: playbackMode.value,
        ...(requestedSeed !== undefined && requestedSeed !== '' && { seed: requestedSeed }),
      },
    });
    // The pace is not part of `startGame`; send it alongside so the first turn is already
    // presented at the speed the user chose.
    socket?.send({
      type: 'setPlaybackMode',
      payload: { mode: playbackMode.value, paceMs: paceMs.value },
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

  function resolveHeldDecision(actionId: number): void {
    const held = heldDecision.value;
    if (held === null) return;
    socket?.send({
      type: 'resolveHeldDecision',
      payload: { requestId: held.request.requestId, actionId },
    });
    heldDecision.value = null;
  }

  function abandonGame(): void {
    socket?.send({ type: 'abandonGame', payload: {} });
    gameId.value = null;
    state.value = null;
    activeSequence.value = null;
    heldDecision.value = null;
  }

  return {
    connection,
    gameId,
    seed,
    seats,
    providerKind,
    state,
    log,
    viewTurn,
    frontierTurn,
    snapshotTurns,
    playbackMode,
    paceMs,
    halt,
    heldDecision,
    gameOver,
    errors,
    apiCost,
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
    resolveHeldDecision,
    abandonGame,
  };
});

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
        break;

      case 'stateSnapshot':
        state.value = message.payload.state;
        viewTurn.value = message.payload.turn;
        frontierTurn.value = Math.max(frontierTurn.value, message.payload.frontierTurn);
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
    if (viewTurn.value > 0) jumpToTurn(viewTurn.value - 1);
  }

  function stepForward(): void {
    if (viewTurn.value < frontierTurn.value || isRunning.value) {
      jumpToTurn(viewTurn.value + 1);
    }
  }

  const activeSequence = ref<number | null>(null);

  function getCurrentActionIndex(): number {
    if (log.value.length === 0) return -1;

    // 1. If user explicitly selected an action before, check if it exists in current log
    if (activeSequence.value !== null) {
      const idx = log.value.findIndex((l) => l.sequence === activeSequence.value);
      if (idx !== -1) return idx;
    }

    // 2. Find log lines matching current viewTurn
    const exactTurnIndices: number[] = [];
    for (let i = 0; i < log.value.length; i++) {
      if (log.value[i]!.turn === viewTurn.value) {
        exactTurnIndices.push(i);
      }
    }

    if (exactTurnIndices.length > 0) {
      return exactTurnIndices[exactTurnIndices.length - 1]!;
    }

    // 3. Find the last log line at or before current viewTurn
    for (let i = log.value.length - 1; i >= 0; i--) {
      if (log.value[i]!.turn <= viewTurn.value) {
        return i;
      }
    }

    // 4. Fallback to 0
    return 0;
  }

  function stepAction(delta: number): void {
    if (log.value.length === 0) return;

    const currentIndex = getCurrentActionIndex();
    if (currentIndex === -1) return;

    const targetIndex = Math.max(0, Math.min(log.value.length - 1, currentIndex + delta));
    const targetLine = log.value[targetIndex];
    if (targetLine) {
      activeSequence.value = targetLine.sequence;
      jumpToTurn(targetLine.turn, targetLine.sequence);
    }
  }

  function jumpToSequence(seq: number, turn?: number): void {
    activeSequence.value = seq;
    jumpToTurn(turn ?? viewTurn.value, seq);
  }

  function setPlaybackMode(mode: PlaybackMode): void {
    playbackMode.value = mode;
    socket?.send({ type: 'setPlaybackMode', payload: { mode } });
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
    stepBack,
    stepForward,
    stepAction,
    jumpToSequence,
    setPlaybackMode,
    resolveHeldDecision,
    abandonGame,
  };
});

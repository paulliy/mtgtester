/**
 * A `MatchSession` is one game plus everything around it: the engine, the per-seat decision
 * providers, the `MatchRunner`, the recorder, and the outbound message stream. The WebSocket
 * layer owns sessions and does nothing else — it translates frames to method calls and
 * broadcasts what comes back.
 */

import { Engine, RandomDecisionProvider } from '@mtg/engine';
import type { AsyncDecisionProvider, DecisionProvider } from '@mtg/engine';
import type {
  DecisionRequest,
  DecisionResponse,
  PlaybackMode,
  PlayerId,
  ProviderKind,
  ServerToClientMessage,
  TargetChoice,
} from '@mtg/shared';
import {
  AiCallLogger,
  loadAiConfig,
  OpenAiCompatibleClient,
  OpenAiDecisionProvider,
  RequestQueue,
} from '../ai';
import type { GameStore } from '../db';
import { finishingPositions, type GameRecorder } from '../db/games';
import { MatchRunner } from './runner';
import type { SeatSetup } from './setup';

/** The engine's `RandomDecisionProvider` is synchronous; the runner awaits every provider. */
class AsyncAdapter implements AsyncDecisionProvider {
  constructor(private readonly inner: DecisionProvider) {}
  decide(request: DecisionRequest): Promise<DecisionResponse> {
    return Promise.resolve(this.inner.decide(request));
  }
}

export interface MatchSessionOptions {
  gameId: string;
  seed: string;
  seats: readonly SeatSetup[];
  providerKind: ProviderKind;
  store?: GameStore | undefined;
  playbackMode?: PlaybackMode;
  turnCap?: number;
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
  private aiClient: OpenAiCompatibleClient | null = null;
  private aiQueue: RequestQueue | null = null;

  constructor(private readonly opts: MatchSessionOptions) {
    this.playbackMode = opts.playbackMode ?? 'live';
    this.engine = new Engine({
      gameId: opts.gameId,
      seed: opts.seed,
      players: opts.seats.map((s) => s.config),
      ...(opts.turnCap !== undefined && { turnCap: opts.turnCap }),
    });
    this.recorder = opts.store?.recorderFor(opts.gameId) ?? null;
    this.logger =
      opts.providerKind === 'ai'
        ? new AiCallLogger(opts.store?.raw ?? null, opts.gameId)
        : null;

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
      })),
      providerFor: (playerId) => this.providerFor(playerId),
      recorder: this.recorder,
      onEvents: (lines, frontierTurn, snapshotTurns) => {
        opts.send({
          type: 'eventBatch',
          payload: { gameId: opts.gameId, lines, frontierTurn, snapshotTurns },
        });
      },
      onSnapshot: (turn, state, atFrontier) => {
        // In live mode the viewer follows the frontier, so a new turn is pushed as it lands.
        // In manual mode the viewer's position is theirs to move, and pushing would yank them.
        if (this.playbackMode !== 'live') return;
        opts.send({
          type: 'stateSnapshot',
          payload: { turn, state, frontierTurn: this.runner.getFrontierTurn(), atFrontier },
        });
      },
      onDecisionPending: (request, invalidResponse, timeoutMs) => {
        opts.send({ type: 'decisionPending', payload: { request, invalidResponse, timeoutMs } });
      },
      onHalt: (info) => {
        opts.send({
          type: 'computeHalted',
          payload: {
            gameId: opts.gameId,
            kind: info.kind,
            reason: info.reason,
            turn: info.turn,
            ...(info.cardName !== undefined && { cardName: info.cardName }),
          },
        });
      },
      onGameOver: (result) => {
        opts.send({
          type: 'gameOver',
          payload: {
            result,
            standings: this.standings(),
          },
        });
      },
      onDecision: () => {
        this.reportAiCost();
      },
    });
  }

  start(): void {
    if (this.running !== null) return;
    this.running = this.runner.run().catch((err: unknown) => {
      this.opts.send({
        type: 'error',
        payload: { message: err instanceof Error ? err.message : String(err) },
      });
    });
  }

  /** Wait for the match to stop computing — used by tests and by clean shutdown. */
  async settled(): Promise<void> {
    await this.running;
  }

  setPlaybackMode(mode: PlaybackMode): void {
    this.playbackMode = mode;
  }

  getPlaybackMode(): PlaybackMode {
    return this.playbackMode;
  }

  /**
   * Move the viewer and send them that board. Backward is always allowed; forward past the
   * frontier is refused rather than computed on demand (brief §10.1).
   */
  jumpToTurn(turn: number): void {
    const clamped = Math.max(0, Math.min(turn, this.runner.getFrontierTurn()));
    this.runner.setViewTurn(clamped);
    const state = this.runner.stateAt(clamped);
    if (state === null) {
      this.opts.send({
        type: 'error',
        payload: { message: `Turn ${clamped} has not been computed yet.` },
      });
      return;
    }
    this.opts.send({
      type: 'stateSnapshot',
      payload: {
        turn: clamped,
        state,
        frontierTurn: this.runner.getFrontierTurn(),
        atFrontier: clamped >= this.runner.getFrontierTurn(),
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

  abandon(): void {
    this.runner.abandon();
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

    const provider: AsyncDecisionProvider =
      this.opts.providerKind === 'ai'
        ? this.buildAiProvider()
        : new AsyncAdapter(new RandomDecisionProvider(`${this.opts.seed}-${playerId}`));

    this.providers.set(playerId, provider);
    return provider;
  }

  private buildAiProvider(): AsyncDecisionProvider {
    const config = loadAiConfig(process.env);
    this.aiClient ??= new OpenAiCompatibleClient(config);
    this.aiQueue ??= new RequestQueue(config);
    return new OpenAiDecisionProvider(
      this.aiClient,
      this.aiQueue,
      this.engine,
      config,
      this.logger ?? undefined,
      // The §7.7 human-override seam. Only AI matches can escalate; a random provider never
      // produces an invalid response, because it picks from the menu the engine handed it.
      this.runner.escalation(),
    );
  }
}

/**
 * `TableSessionPort` run in the caller's own thread (ADR 0031 decision 6, plan M3 task 3). Tests
 * use it to drive a table without a worker; `serve:table` always uses the worker implementation,
 * which wraps the same preparation and session code behind a message channel.
 *
 * One port is one start attempt: it prepares the seats, runs one `MatchSession`, and reports
 * exactly one terminal output (`gameOver`, `setupProblems` or `failed`). `emit` is the only place
 * an output leaves, so "nothing after the terminal output" and "every output carries this
 * generation" hold in one spot rather than at every call site.
 */

import type {
  GameResult,
  GameStartedPayload,
  PlayerId,
  SeatControllers,
  SeatSource,
  ServerToClientMessage,
  TableDeckProblem,
} from '@mtg/shared';
import type { OracleIndex } from '../cards/oracle-index';
import type { SupportedPool } from '../cards/pool';
import type { GameStore } from '../db';
import type { BannedList } from '../decks/banned';
import { scaledSettings } from '../match/decision-clock';
import { disclosedSeatSummaries, seedLabel, tablePolicy } from '../match/disclosure';
import type { ReplayIdentity } from '../match/replay-config';
import { MatchSession, type MatchSessionOptions } from '../match/session';
import type { SessionAi } from '../match/session-ai';
import { setupSeats, type SeatProblem } from '../match/setup';
import type {
  TableSessionConfig,
  TableSessionInput,
  TableSessionOutput,
  TableSessionPort,
  TableSetupProblems,
} from './session-port';

export interface InProcessSessionDeps {
  pool: SupportedPool;
  index: OracleIndex;
  banned: BannedList;
  store: GameStore;
  /** What the `games` row records for replay (ADR 0031 decision 8). Omit to record none. */
  replay?: ReplayIdentity;
  /**
   * The model-backed services and the Anthropic key, for a game with model seats (ADR 0055).
   * The worker passes `sessionAi` and its own environment's key; omitted, a model seat fails the
   * start rather than playing without a cap.
   */
  ai?: { services: SessionAi; apiKey: string };
}

export interface InProcessSessionPortOptions {
  generation: number;
  deps: InProcessSessionDeps;
}

/** A failure detail is read by the host, so it stays short and never carries the key. */
const MAX_DETAIL_CHARS = 200;

type FailedOutput = Extract<TableSessionOutput, { type: 'failed' }>;

export class InProcessSessionPort implements TableSessionPort {
  readonly generation: number;
  private readonly deps: InProcessSessionDeps;
  private readonly listeners = new Set<(output: TableSessionOutput) => void>();
  private session: MatchSession | null = null;
  private startCalled = false;
  /** Set when the one terminal output has gone out. Nothing is emitted after it. */
  private terminal = false;
  /** Set by `terminate`, so a setup still in flight does not go on to create a game. */
  private stopped = false;
  private rngKey = '';
  /** Each human seat's `gameStarted`, built once at start and re-sent on a resync. */
  private readonly startedFrames = new Map<PlayerId, ServerToClientMessage>();
  /** Why the model seats switched to the built-in bot, once they have; re-sent on a resync. */
  private aiBudgetReason: 'cap' | 'key' | null = null;

  constructor(options: InProcessSessionPortOptions) {
    this.generation = options.generation;
    this.deps = options.deps;
  }

  onOutput(listener: (output: TableSessionOutput) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(config: TableSessionConfig): Promise<void> {
    if (this.startCalled) throw new Error('a session port starts once');
    this.startCalled = true;
    this.rngKey = config.rngKey;
    try {
      await this.prepareAndRun(config);
    } catch (err) {
      this.fail('setupFailed', this.safeDetail(err));
    }
  }

  send(input: TableSessionInput): Promise<void> {
    const session = this.session;
    if (session === null || this.terminal) return Promise.resolve();
    try {
      switch (input.type) {
        case 'submitPlayerAction':
          session.submitPlayerAction(input.seat, input.payload);
          break;
        case 'yieldPlayerAbility':
          session.yieldPlayerAbility(input.seat, input.payload);
          break;
        case 'resumePlayerAbility':
          session.resumePlayerAbility(input.seat, input.key);
          break;
        case 'cancelYield':
          session.cancelYield(input.seat);
          break;
        case 'setPlayerConnected':
          session.setPlayerConnected(input.seat, input.connected);
          break;
        case 'setRawActionData':
          session.setRawActionData(input.seat, input.enabled);
          break;
        case 'resumeControl':
          session.resumeControl(input.seat);
          break;
        case 'hostResolve':
          session.hostResolve(input.seat);
          break;
        case 'resyncPlayer': {
          const started = this.startedFrames.get(input.seat);
          if (started !== undefined) {
            this.emit({
              type: 'seatFrame',
              generation: this.generation,
              seat: input.seat,
              message: started,
            });
          }
          session.resyncPlayer(input.seat);
          // A player who reloads after the switch still learns of it. The table frame goes to
          // every bound seat; setting the same reason again changes nothing for the others.
          if (this.aiBudgetReason !== null) this.emitAiBudget(this.aiBudgetReason);
          break;
        }
        default: {
          const unknown: never = input;
          throw new Error(`unknown session input: ${JSON.stringify(unknown)}`);
        }
      }
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.resolve();
  }

  /** Answered at once: the in-process game shares the caller's thread, so it is never unreachable. */
  ping(): Promise<void> {
    return Promise.resolve();
  }

  async terminate(reason: 'workerFailure' | 'hostAbandoned'): Promise<void> {
    this.stopped = true;
    // Report first: `abandon` may release waiting providers, and whatever they send after the
    // terminal output is dropped by `emit`.
    this.fail(reason);
    const session = this.session;
    if (session === null) return;
    session.abandon();
    try {
      await session.settled();
    } catch {
      // The run's own error was already reported or dropped; termination only waits for it to end.
    }
  }

  // ── Start ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The model-seat setup for `config` (ADR 0055): null for a game without model seats, or
   * `unavailable` when one has them but this port has no AI services or key. When the game's
   * budget stops, every seated player gets one `aiBudget` frame.
   */
  private tableAiFor(
    config: TableSessionConfig,
  ):
    | { services: SessionAi; options: NonNullable<MatchSessionOptions['tableAi']> }
    | null
    | 'unavailable' {
    if (config.ai === undefined) return null;
    const ai = this.deps.ai;
    if (ai === undefined || ai.apiKey.trim() === '') return 'unavailable';
    const deadlines = ai.services.DEFAULT_TABLE_AI_LIMITS;
    const limits = {
      maxUsdPerGame: config.ai.maxUsdPerGame,
      tacticianDeadlineMs: deadlines.tacticianDeadlineMs,
      strategistDeadlineMs: deadlines.strategistDeadlineMs,
    };
    let aiConfig;
    try {
      aiConfig = ai.services.tableAiConfig(ai.apiKey, limits);
    } catch {
      return 'unavailable';
    }
    return {
      services: ai.services,
      options: {
        config: aiConfig,
        limits,
        onBudgetStop: (reason) => {
          this.aiBudgetReason = reason;
          this.emitAiBudget(reason);
        },
      },
    };
  }

  private emitAiBudget(reason: 'cap' | 'key'): void {
    this.emit({
      type: 'tableFrame',
      generation: this.generation,
      message: { type: 'aiBudget', payload: { reason } },
    });
  }

  private async prepareAndRun(config: TableSessionConfig): Promise<void> {
    const seats = [...config.seats].sort((a, b) => a.seat.localeCompare(b.seat));
    seats.forEach((entry, index) => {
      if (entry.seat !== `P${index + 1}`) {
        throw new Error('table seats must be P1 up to the last seat, with none missing');
      }
    });
    const sources: SeatSource[] = seats.map((entry) =>
      entry.controller === 'human'
        ? { kind: 'plaintext', text: entry.decklist, name: entry.displayName }
        : { kind: 'pool' },
    );

    const setup = await setupSeats(
      sources,
      {
        pool: this.deps.pool,
        index: this.deps.index,
        banned: this.deps.banned,
        store: this.deps.store,
      },
      config.seed,
      { rng: 'chacha20', rngKey: config.rngKey },
    );
    if (this.stopped || this.terminal) return;

    if (!setup.ok) {
      const botSeats = new Set(seats.filter((s) => s.controller !== 'human').map((s) => s.seat));
      const botProblem = setup.problems.find((p) => botSeats.has(p.seat));
      if (botProblem !== undefined) {
        // A bot deck comes from the server's own pool: a failure there is the server's, not a
        // player's, and no player can fix it by resubmitting.
        this.fail('setupFailed', this.clip(`${botProblem.seat}: ${botProblem.message}`));
        return;
      }
      const problems: TableSetupProblems = {};
      for (const problem of setup.problems) problems[problem.seat] = toDeckProblems(problem);
      this.emit({ type: 'setupProblems', generation: this.generation, problems });
      return;
    }

    const kindOf = (controller: 'human' | 'bot' | 'model'): 'human' | 'random' | 'ai' =>
      controller === 'human' ? 'human' : controller === 'model' ? 'ai' : 'random';
    const seatControllers: SeatControllers = Object.fromEntries(
      seats.map((entry) => [entry.seat, kindOf(entry.controller)] as const),
    );
    const tableAi = this.tableAiFor(config);
    if (tableAi === 'unavailable') {
      this.fail('setupFailed', 'This server cannot run AI bots right now.');
      return;
    }
    const session = new MatchSession({
      gameId: config.gameId,
      seed: config.seed,
      seats: setup.seats,
      providerKind: 'random',
      gameMode: 'table',
      seatControllers,
      disclosure: tablePolicy(),
      ...(tableAi !== null && { ai: tableAi.services, tableAi: tableAi.options }),
      rng: 'chacha20',
      rngKey: config.rngKey,
      engineLimits: { maxStepWork: config.maxStepWork, maxObjects: config.maxObjects },
      store: this.deps.store,
      ...(this.deps.replay !== undefined && { replay: this.deps.replay }),
      ...(config.turnCap !== undefined && { turnCap: config.turnCap }),
      ...(config.livePaceMs !== undefined && { livePaceMs: config.livePaceMs }),
      send: (message) => {
        this.onPublicFrame(message);
      },
      sendToSeat: (seat, message) => {
        this.emit({ type: 'seatFrame', generation: this.generation, seat, message });
      },
      ...(config.clock !== 'off' && {
        clock: { settings: scaledSettings(config.clock, config.clockScale ?? 1) },
      }),
      sendTable: (message) => {
        this.emit({ type: 'tableFrame', generation: this.generation, message });
      },
    });
    this.session = session;

    // What `GameServer` sends a single player before the first board, per seat and through the
    // table policy: no seed, and another seat's archetype tag withheld.
    const policy = tablePolicy();
    const startedAt = new Date().toISOString();
    for (const entry of seats) {
      if (entry.controller !== 'human') continue;
      const payload: GameStartedPayload = {
        gameId: config.gameId,
        seed: seedLabel(policy, config.seed),
        seats: disclosedSeatSummaries(
          policy,
          setup.seats.map((seat) => seat.summary),
          entry.seat,
        ),
        providerKind: 'random',
        gameMode: 'table',
        controllers: seats.map((seat) => ({ seat: seat.seat, kind: kindOf(seat.controller) })),
        humanSeat: entry.seat,
        paceMs: session.getLivePaceMs(),
        startedAt,
      };
      this.startedFrames.set(entry.seat, { type: 'gameStarted', payload });
    }

    this.emit({ type: 'started', generation: this.generation });
    session.start();
    // A run that ends without a `gameOver` frame (the runner itself failed) still owes the table
    // a terminal output; `emit` drops this one when a result or `terminate` got there first.
    void session.settled().then(
      () => {
        this.fail('workerFailure', 'The game stopped without a result.');
      },
      () => {
        this.fail('workerFailure', 'The game stopped without a result.');
      },
    );
  }

  /**
   * The session's public stream. Its `gameOver` frame is the game-end hook: `publishGameOver`
   * sends it once to everyone, for a win, a turn cap and a halt alike (the table policy makes a
   * halt terminal), and only after the runner has persisted the outcome. The result in the frame
   * is the one the policy lets out, so a halt carries the fixed notice and no raw engine error.
   * A seat that resyncs after the game gets its own copy through `sendToSeat`, which is not this.
   */
  private onPublicFrame(message: ServerToClientMessage): void {
    this.emit({ type: 'publicFrame', generation: this.generation, message });
    if (message.type === 'gameOver') this.finish(message.payload.result);
  }

  private finish(result: GameResult): void {
    this.emit({ type: 'gameOver', generation: this.generation, result });
  }

  private fail(reason: FailedOutput['reason'], detail?: string): void {
    this.emit({
      type: 'failed',
      generation: this.generation,
      reason,
      ...(detail !== undefined && { detail }),
    });
  }

  // ── Output ─────────────────────────────────────────────────────────────────────────────────

  /** The only way out: it enforces one terminal output and silence after it. */
  private emit(output: TableSessionOutput): void {
    if (this.terminal) return;
    if (output.type === 'gameOver' || output.type === 'setupProblems' || output.type === 'failed') {
      this.terminal = true;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(output);
      } catch {
        // A listener's fault must not reach the game that is producing the output.
      }
    }
  }

  private safeDetail(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return this.clip(raw);
  }

  private clip(text: string): string {
    const clean = this.rngKey === '' ? text : text.split(this.rngKey).join('[redacted]');
    return clean.length > MAX_DETAIL_CHARS ? `${clean.slice(0, MAX_DETAIL_CHARS - 3)}...` : clean;
  }
}

/**
 * One seat's setup problem as the typed list its owner sees. A problem with none of the three
 * detail lists (an import error, a deck that could not be loaded) is reported as `parse`.
 * `TableDeckProblemCode` has no code for "the simulator cannot play this card yet", and the wire
 * set stays closed, so an unmodeled card is reported as `unresolved` with its name.
 */
export function toDeckProblems(problem: SeatProblem): TableDeckProblem[] {
  const out: TableDeckProblem[] = [];
  for (const issue of problem.issues) {
    out.push({
      code: issue.code,
      message: issue.message,
      ...(issue.cardName !== undefined && { cardName: issue.cardName }),
    });
  }
  for (const name of problem.unresolvedNames) {
    out.push({
      code: 'unresolved',
      message: `"${name}" is not a card this server knows.`,
      cardName: name,
    });
  }
  for (const name of problem.unmodeledCards) {
    out.push({
      code: 'unresolved',
      message: `"${name}" is not a card this simulator can play yet.`,
      cardName: name,
    });
  }
  if (out.length === 0) out.push({ code: 'parse', message: problem.message });
  return out;
}

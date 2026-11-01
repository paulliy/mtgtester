/**
 * `TableSessionPort` backed by a worker thread (ADR 0031 decision 6, plan M3 task 3). This is the
 * implementation `serve:table` always uses: each start attempt gets its own worker, which runs
 * the same preparation and session code as `InProcessSessionPort`, behind `postMessage`.
 *
 * The port keeps the contract the in-process one keeps, here at the thread boundary:
 *
 * - Every output carries this port's generation. Anything the worker posts with another
 *   generation, and anything after the one terminal output, is dropped.
 * - A worker that exits or errors before its terminal output is reported once, as `setupFailed`
 *   when the game had not started and as `workerFailure` when it had.
 * - `terminate` asks the worker to stop its run, waits a bounded time for it to say so, and then
 *   stops the thread whatever it is doing. A worker stuck in a synchronous computation cannot
 *   answer, and is stopped all the same.
 *
 * Health probes (`ping`) are answered by the worker's message loop, never by the game, so a game
 * that waits on a human for an hour still answers them, and a worker blocked in a step does not.
 */

import type { ReplayIdentity } from '../match/replay-config';
import type {
  TableSessionConfig,
  TableSessionInput,
  TableSessionOutput,
  TableSessionPort,
} from './session-port';
import type { MainToWorker, TableWorkerCards, WorkerToMain } from './worker-protocol';

/** The part of a `Worker` the port uses; tests supply a fake. */
export interface WorkerLike {
  postMessage(message: MainToWorker): void;
  onMessage(listener: (message: WorkerToMain) => void): void;
  /** The thread ended, by itself, by an uncaught error, or after `terminate`. Called once. */
  onExit(listener: () => void): void;
  /** Stop the thread now. */
  terminate(): void;
}

export interface WorkerSessionPortOptions {
  generation: number;
  spawn: () => WorkerLike;
  /** The card data for this attempt's worker (`table/worker-cards.ts`). */
  cardsFor: (config: TableSessionConfig) => TableWorkerCards;
  replay: ReplayIdentity;
  /** SQLite `busy_timeout` for the worker's connection. Default 5 seconds. */
  busyTimeoutMs?: number;
  /** How long `terminate` waits for a cooperative stop before stopping the thread. Default 2 s. */
  stopGraceMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_GRACE_MS = 2_000;

type FailedReason = Extract<TableSessionOutput, { type: 'failed' }>['reason'];

export class WorkerSessionPort implements TableSessionPort {
  readonly generation: number;
  private readonly opts: WorkerSessionPortOptions;
  private readonly listeners = new Set<(output: TableSessionOutput) => void>();
  private worker: WorkerLike | null = null;
  private startCalled = false;
  private started = false;
  private terminal = false;
  private exited = false;
  private readonly exitWaiters: Array<() => void> = [];
  private readonly stopWaiters: Array<() => void> = [];
  private nextPing = 0;
  private readonly pings = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

  constructor(options: WorkerSessionPortOptions) {
    this.generation = options.generation;
    this.opts = options;
  }

  onOutput(listener: (output: TableSessionOutput) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(config: TableSessionConfig): Promise<void> {
    if (this.startCalled) return Promise.reject(new Error('a session port starts once'));
    this.startCalled = true;
    if (this.terminal) return Promise.resolve();
    const cards = this.opts.cardsFor(config);
    const worker = this.opts.spawn();
    this.worker = worker;
    worker.onMessage((message) => {
      this.onWorkerMessage(message);
    });
    worker.onExit(() => {
      this.onWorkerExit();
    });
    worker.postMessage({
      type: 'boot',
      boot: {
        config,
        cards,
        replay: this.opts.replay,
        generation: this.generation,
        busyTimeoutMs: this.opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      },
    });
    return Promise.resolve();
  }

  send(input: TableSessionInput): Promise<void> {
    const worker = this.worker;
    if (worker === null || this.terminal || this.exited) return Promise.resolve();
    worker.postMessage({ type: 'input', input });
    return Promise.resolve();
  }

  ping(): Promise<void> {
    const worker = this.worker;
    if (this.exited) return Promise.reject(new Error('the worker has exited'));
    // Before `start` there is no thread to be unhealthy.
    if (worker === null) return Promise.resolve();
    this.nextPing += 1;
    const id = this.nextPing;
    return new Promise<void>((resolve, reject) => {
      this.pings.set(id, { resolve, reject });
      worker.postMessage({ type: 'ping', id });
    });
  }

  async terminate(reason: 'workerFailure' | 'hostAbandoned'): Promise<void> {
    // Report first, as the in-process port does: whatever the worker posts after this is dropped.
    this.fail(reason);
    const worker = this.worker;
    if (worker === null || this.exited) return;
    try {
      worker.postMessage({ type: 'terminate', reason });
    } catch {
      // The thread is already going away.
    }
    await this.waitFor(this.stopWaiters, this.opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    if (!this.exited) {
      try {
        worker.terminate();
      } catch {
        // Already stopped.
      }
      await this.waitFor(this.exitWaiters, this.opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
      // A thread that reports no exit after being stopped is treated as gone: nothing it posts
      // can reach a player, because the port is terminal.
      this.markExited();
    }
  }

  // ── Worker traffic ─────────────────────────────────────────────────────────────────────────

  private onWorkerMessage(message: WorkerToMain): void {
    switch (message.type) {
      case 'output':
        this.relay(message.output);
        return;
      case 'pong': {
        const waiter = this.pings.get(message.id);
        this.pings.delete(message.id);
        waiter?.resolve();
        return;
      }
      case 'terminated':
        for (const wake of this.stopWaiters.splice(0)) wake();
        return;
      default: {
        const unknown: never = message;
        void unknown;
      }
    }
  }

  private onWorkerExit(): void {
    if (this.exited) return;
    this.markExited();
    this.fail(this.started ? 'workerFailure' : 'setupFailed', 'The game worker stopped.');
  }

  private markExited(): void {
    this.exited = true;
    for (const wake of this.stopWaiters.splice(0)) wake();
    for (const wake of this.exitWaiters.splice(0)) wake();
    for (const waiter of this.pings.values()) waiter.reject(new Error('the worker has exited'));
    this.pings.clear();
  }

  private relay(output: TableSessionOutput): void {
    if (output.generation !== this.generation) return;
    if (output.type === 'started') this.started = true;
    this.emit(output);
  }

  private fail(reason: FailedReason, detail?: string): void {
    this.emit({
      type: 'failed',
      generation: this.generation,
      reason,
      ...(detail !== undefined && { detail }),
    });
  }

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
        // A listener's fault must not reach the worker relay.
      }
    }
  }

  private waitFor(waiters: Array<() => void>, ms: number): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** A `WorkerLike` over a real worker thread running `table-worker.ts`. Bun runtime only. */
export function spawnTableWorker(): WorkerLike {
  const worker = new Worker(new URL('./table-worker.ts', import.meta.url).href);
  let exited = false;
  const exitListeners: Array<() => void> = [];
  const exit = (): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener();
  };
  worker.addEventListener('error', exit);
  worker.addEventListener('close', exit);
  return {
    postMessage: (message) => {
      worker.postMessage(message);
    },
    onMessage: (listener) => {
      worker.addEventListener('message', (event: MessageEvent<WorkerToMain>) => {
        listener(event.data);
      });
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
    terminate: () => {
      worker.terminate();
    },
  };
}

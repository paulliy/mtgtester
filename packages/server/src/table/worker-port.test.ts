/**
 * `WorkerSessionPort` against a fake thread (plan M3 task 3). The real thread is exercised by the
 * scripted run (`scripted-run.test.ts`); here each contract of the boundary is driven by hand:
 * generation fencing, one terminal output, exits before and after start, probes, and a stop that
 * escalates from asking to killing.
 */

import { describe, expect, it } from 'vitest';
import type { TableSessionConfig, TableSessionOutput } from './session-port';
import { WorkerSessionPort, type WorkerLike } from './worker-port';
import type { MainToWorker, WorkerToMain } from './worker-protocol';

class FakeWorker implements WorkerLike {
  readonly posted: MainToWorker[] = [];
  killed = false;
  /** Answer `terminate` with `terminated` (a cooperative stop). */
  cooperative = true;
  private messageListener: ((message: WorkerToMain) => void) | null = null;
  private exitListener: (() => void) | null = null;

  postMessage(message: MainToWorker): void {
    this.posted.push(message);
    if (message.type === 'terminate' && this.cooperative) {
      queueMicrotask(() => {
        this.reply({ type: 'terminated' });
        this.exit();
      });
    }
  }
  onMessage(listener: (message: WorkerToMain) => void): void {
    this.messageListener = listener;
  }
  onExit(listener: () => void): void {
    this.exitListener = listener;
  }
  terminate(): void {
    this.killed = true;
    queueMicrotask(() => this.exit());
  }
  reply(message: WorkerToMain): void {
    this.messageListener?.(message);
  }
  output(output: TableSessionOutput): void {
    this.reply({ type: 'output', output });
  }
  exit(): void {
    const listener = this.exitListener;
    this.exitListener = null;
    listener?.();
  }
}

const CONFIG = {
  tableId: 't',
  attemptId: 'a',
  gameId: 'g',
  seed: 'label',
  rngKey: 'ab'.repeat(32),
  seats: [],
  maxStepWork: 10,
  maxObjects: 10,
  dbPath: ':memory:',
} satisfies TableSessionConfig;

function makePort(generation = 3) {
  const worker = new FakeWorker();
  const outputs: TableSessionOutput[] = [];
  const port = new WorkerSessionPort({
    generation,
    spawn: () => worker,
    cardsFor: () => ({ poolCards: [], deckCards: [], bannedNames: [] }),
    replay: { cardDataSha256: null, build: { commit: null, branch: null, dirty: null } },
    stopGraceMs: 20,
  });
  port.onOutput((output) => outputs.push(output));
  return { port, worker, outputs };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('WorkerSessionPort', () => {
  it('boots the worker with the config, its cards, the replay identity and its generation', async () => {
    const { port, worker } = makePort(5);
    await port.start(CONFIG);
    const boot = worker.posted[0];
    expect(boot?.type).toBe('boot');
    if (boot?.type !== 'boot') return;
    expect(boot.boot.config).toEqual(CONFIG);
    expect(boot.boot.generation).toBe(5);
    expect(boot.boot.busyTimeoutMs).toBe(5_000);
    await expect(port.start(CONFIG)).rejects.toThrow('starts once');
  });

  it('relays outputs of its own generation only, and nothing after the terminal one', async () => {
    const { port, worker, outputs } = makePort(3);
    await port.start(CONFIG);
    worker.output({ type: 'started', generation: 2 });
    worker.output({ type: 'started', generation: 3 });
    worker.output({ type: 'gameOver', generation: 3, result: {} as never });
    worker.output({ type: 'failed', generation: 3, reason: 'workerFailure' });
    expect(outputs.map((output) => output.type)).toEqual(['started', 'gameOver']);
  });

  it('reports a worker that exits before the game started as setupFailed', async () => {
    const { port, worker, outputs } = makePort();
    await port.start(CONFIG);
    worker.exit();
    expect(outputs).toEqual([
      { type: 'failed', generation: 3, reason: 'setupFailed', detail: 'The game worker stopped.' },
    ]);
  });

  it('reports a worker that exits mid-game as workerFailure, once', async () => {
    const { port, worker, outputs } = makePort();
    await port.start(CONFIG);
    worker.output({ type: 'started', generation: 3 });
    worker.exit();
    worker.exit();
    expect(outputs.map((output) => output.type)).toEqual(['started', 'failed']);
    expect(outputs[1]).toMatchObject({ reason: 'workerFailure' });
  });

  it('answers probes through the worker loop and rejects them once the worker is gone', async () => {
    const { port, worker } = makePort();
    await port.ping(); // before start there is no thread to be unhealthy
    await port.start(CONFIG);
    const answered = port.ping();
    const probe = worker.posted.find((message) => message.type === 'ping');
    expect(probe).toBeDefined();
    if (probe?.type === 'ping') worker.reply({ type: 'pong', id: probe.id });
    await expect(answered).resolves.toBeUndefined();
    const lost = port.ping();
    worker.exit();
    await expect(lost).rejects.toThrow('exited');
    await expect(port.ping()).rejects.toThrow('exited');
  });

  it('asks the worker to stop and does not kill one that stops by itself', async () => {
    const { port, worker, outputs } = makePort();
    await port.start(CONFIG);
    worker.output({ type: 'started', generation: 3 });
    await port.terminate('hostAbandoned');
    expect(worker.posted.at(-1)).toEqual({ type: 'terminate', reason: 'hostAbandoned' });
    expect(worker.killed).toBe(false);
    expect(outputs.at(-1)).toEqual({ type: 'failed', generation: 3, reason: 'hostAbandoned' });
  });

  it('kills a worker that does not stop within the grace period', async () => {
    const { port, worker } = makePort();
    await port.start(CONFIG);
    worker.cooperative = false;
    await port.terminate('workerFailure');
    expect(worker.killed).toBe(true);
    // Idempotent.
    await port.terminate('workerFailure');
    await flush();
  });

  it('drops inputs after the terminal output', async () => {
    const { port, worker } = makePort();
    await port.start(CONFIG);
    worker.output({ type: 'gameOver', generation: 3, result: {} as never });
    const before = worker.posted.length;
    await port.send({ type: 'cancelYield', seat: 'P1' });
    expect(worker.posted.length).toBe(before);
  });
});

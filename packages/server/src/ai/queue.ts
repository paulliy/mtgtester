/**
 * Request Queue & Token Bucket Rate Limiter (brief §7.5).
 * Enforces client-side RPM ceiling and single-request concurrency.
 */

import type { AiConfig } from './config';
import { RequestCancelledError } from './errors';

/**
 * A plain function call, not inlined at each call site: TS's control-flow narrowing otherwise
 * treats `signal.aborted` as permanently `false` after the first `if (!aborted) …` check in a
 * function, even across an `await` where the signal legitimately flips to `true` in between.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export class RequestQueue {
  private readonly rpmLimit: number;
  private readonly concurrency: number;
  private recentTimestamps: number[] = [];
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(config: Pick<AiConfig, 'rpmLimit' | 'concurrency'>) {
    this.rpmLimit = Math.max(1, config.rpmLimit);
    this.concurrency = Math.max(1, config.concurrency);
  }

  get depth(): number {
    return this.waiters.length;
  }

  get isWaiting(): boolean {
    return this.depth > 0 || this.activeCount >= this.concurrency;
  }

  /**
   * Enqueue an async API call, pacing execution to adhere to concurrency and RPM bounds.
   *
   * `signal`, when given, lets a caller that no longer wants the answer (a halted or abandoned
   * match) pull a call back out of the queue before `fn` ever runs — the whole point being that a
   * strategist prefetch sitting behind the RPM/concurrency gate never reaches the network at all
   * once nobody is going to read its result.
   */
  async enqueue<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (isAborted(signal)) throw new RequestCancelledError();

    while (this.activeCount >= this.concurrency) {
      await this.waitForTurn(signal);
    }
    if (isAborted(signal)) throw new RequestCancelledError();
    this.activeCount++;

    try {
      const now = Date.now();
      this.recentTimestamps = this.recentTimestamps.filter((t) => now - t < 60_000);
      if (this.rpmLimit < 10000 && this.recentTimestamps.length >= this.rpmLimit) {
        const oldest = this.recentTimestamps[0]!;
        const waitTime = Math.max(0, 60_000 - (now - oldest));
        if (waitTime > 0) {
          await this.sleep(waitTime, signal);
        }
      }
      if (isAborted(signal)) throw new RequestCancelledError();
      this.recentTimestamps.push(Date.now());

      return await fn();
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      const next = this.waiters.shift();
      if (next !== undefined) {
        next();
      }
    }
  }

  /** Waits for a concurrency slot, or rejects the moment `signal` aborts — whichever is first. */
  private waitForTurn(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onTurn = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(onTurn);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new RequestCancelledError());
      };
      this.waiters.push(onTurn);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new RequestCancelledError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

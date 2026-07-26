/**
 * Request Queue & Token Bucket Rate Limiter (brief §7.5).
 * Enforces client-side RPM ceiling and single-request concurrency.
 */

import type { AiConfig } from './config';

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
   */
  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    while (this.activeCount >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeCount++;

    try {
      const now = Date.now();
      this.recentTimestamps = this.recentTimestamps.filter((t) => now - t < 60_000);
      if (this.rpmLimit < 10000 && this.recentTimestamps.length >= this.rpmLimit) {
        const oldest = this.recentTimestamps[0]!;
        const waitTime = Math.max(0, 60_000 - (now - oldest));
        if (waitTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
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
}

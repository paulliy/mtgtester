import { describe, expect, it, vi } from 'vitest';
import { RequestQueue } from './queue';
import { RequestCancelledError } from './errors';

describe('RequestQueue', () => {
  it('executes tasks within RPM and concurrency limits', async () => {
    const queue = new RequestQueue({ rpmLimit: 600, concurrency: 2 });
    const results: number[] = [];

    const p1 = queue.enqueue(async () => {
      results.push(1);
      return 1;
    });
    const p2 = queue.enqueue(async () => {
      results.push(2);
      return 2;
    });

    const res = await Promise.all([p1, p2]);
    expect(res).toEqual([1, 2]);
    expect(results).toHaveLength(2);
    expect(queue.depth).toBe(0);
  });

  it('tracks queue depth and active status', async () => {
    const queue = new RequestQueue({ rpmLimit: 60, concurrency: 1 });
    let releaseFirst: () => void = () => {};

    const first = queue.enqueue(() => new Promise((resolve) => { releaseFirst = resolve as () => void; }));
    const second = queue.enqueue(async () => 'second');

    expect(queue.depth).toBe(1);
    expect(queue.isWaiting).toBe(true);

    releaseFirst();
    await first;
    const res2 = await second;

    expect(res2).toBe('second');
    expect(queue.depth).toBe(0);
  });

  it('rejects immediately without calling fn when the signal is already aborted', async () => {
    const queue = new RequestQueue({ rpmLimit: 60, concurrency: 1 });
    const fn = vi.fn().mockResolvedValue('should never happen');
    const controller = new AbortController();
    controller.abort();

    await expect(queue.enqueue(fn, controller.signal)).rejects.toThrow(RequestCancelledError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('pulls a queued (not-yet-started) call back out when its signal aborts, without ever calling fn', async () => {
    const queue = new RequestQueue({ rpmLimit: 60, concurrency: 1 });
    let releaseFirst: () => void = () => {};
    const first = queue.enqueue(
      () => new Promise((resolve) => { releaseFirst = resolve as () => void; }),
    );

    const controller = new AbortController();
    const second = queue.enqueue(vi.fn().mockResolvedValue('should never happen'), controller.signal);

    expect(queue.depth).toBe(1);
    controller.abort();
    await expect(second).rejects.toThrow(RequestCancelledError);
    expect(queue.depth).toBe(0);

    releaseFirst();
    await first;
  });

  it('aborting a settled call is a no-op — the result already returned', async () => {
    const queue = new RequestQueue({ rpmLimit: 60, concurrency: 1 });
    const controller = new AbortController();

    const result = await queue.enqueue(async () => 'done', controller.signal);
    expect(result).toBe('done');

    expect(() => controller.abort()).not.toThrow();
  });
});

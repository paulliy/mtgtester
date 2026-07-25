import { describe, expect, it } from 'vitest';
import { RequestQueue } from './queue';

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
});

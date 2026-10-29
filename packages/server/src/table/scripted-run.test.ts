/**
 * The M3 and M4 exits, run for real on loopback with worker threads: two scripted agent clients
 * and two bots finish a game; four scripted clients finish one at a timed table while one of
 * them drops past its grace and rejoins. Every frame the players received passes the scan.
 * Spawned under Bun, since it needs `bun:sqlite`, `Bun.serve` and worker threads.
 */

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ScriptedRunReport } from './scripted-run';

describe('a scripted table game in workers', () => {
  it('finishes with two scripted clients and two bots, and the frame scan is clean', () => {
    const run = spawnSync('bun', ['run', 'packages/server/src/cli/table-scripted-run.ts'], {
      encoding: 'utf8',
      timeout: 280_000,
    });
    expect(run.error).toBeUndefined();
    const last = run.stdout.trim().split('\n').at(-1) ?? '{}';
    const report = JSON.parse(last) as ScriptedRunReport;
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(run.status).toBe(0);
    expect(report.scan.framesScanned).toBeGreaterThan(50);
    expect(report.scan.handIdsTracked).toBeGreaterThan(0);
    expect(report.attemptStatus).toBe('finished');
    for (const seat of report.seats) {
      expect(seat.resultsKeyMatches).toBe(true);
      expect(seat.replayTurnServed).toBe(true);
    }
  }, 300_000);

  it('finishes with four scripted clients when one disconnects past its grace and rejoins', () => {
    const run = spawnSync(
      'bun',
      ['run', 'packages/server/src/cli/table-scripted-run.ts', '--scenario', 'disconnect'],
      { encoding: 'utf8', timeout: 280_000 },
    );
    expect(run.error).toBeUndefined();
    const last = run.stdout.trim().split('\n').at(-1) ?? '{}';
    const report = JSON.parse(last) as ScriptedRunReport;
    expect(report.problems).toEqual([]);
    expect(run.status).toBe(0);
    expect(report.seats).toHaveLength(4);
    expect(report.disconnect).toMatchObject({ fallbackSeen: true, reconnected: true });
    expect(report.disconnect?.decisionsAfterResume).toBeGreaterThan(0);
    expect(report.scan.violations).toEqual([]);
  }, 300_000);
});

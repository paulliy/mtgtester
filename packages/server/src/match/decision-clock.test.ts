/**
 * Table clocks (plan M4 task 1) under an injected clock: allowance, bank, grace, budget, the
 * game cap, and reconnects that renew nothing.
 */

import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@mtg/shared';
import {
  CLOCK_PRESETS,
  DecisionClock,
  scaledSettings,
  type ClockSettings,
  type ClockTimers,
  type SeatClockView,
} from './decision-clock';

/** Timers the test advances by hand. */
function manual() {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: ClockTimers = {
    now: () => now,
    setTimeout: (callback, ms) => {
      nextId += 1;
      pending.set(nextId, { at: now + ms, callback });
      return nextId;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = end;
  };
  return { timers, advance, pendingCount: () => pending.size };
}

const SETTINGS: ClockSettings = {
  allowanceMs: 10_000,
  bankMs: 60_000,
  graceMs: 60_000,
  disconnectBudgetMs: 300_000,
  gameCapMs: 3_600_000,
};

function rig(settings: ClockSettings = SETTINGS) {
  const time = manual();
  const log: string[] = [];
  const views: SeatClockView[] = [];
  const clock = new DecisionClock(settings, ['P1', 'P2'] as PlayerId[], time.timers, {
    decisionExpired: (seat) => log.push(`expired ${seat}`),
    graceExpired: (seat) => log.push(`grace ${seat}`),
    budgetExhausted: (seat) => log.push(`budget ${seat}`),
    gameCapReached: () => log.push('cap'),
    changed: (view) => views.push(view),
  });
  return { clock, log, views, ...time };
}

describe('DecisionClock budget timer', () => {
  it('reports the budget as spent even when its timer fires a millisecond early', () => {
    let now = 0;
    const callbacks: Array<() => void> = [];
    const timers: ClockTimers = {
      now: () => now,
      setTimeout: (callback) => callbacks.push(callback),
      clearTimeout: () => undefined,
    };
    const spent: boolean[] = [];
    const clock: DecisionClock = new DecisionClock(
      { ...SETTINGS, graceMs: 500, disconnectBudgetMs: 1_000 },
      ['P1'] as PlayerId[],
      timers,
      {
        decisionExpired: () => undefined,
        graceExpired: () => undefined,
        budgetExhausted: (seat) => spent.push(clock.budgetSpent(seat)),
        gameCapReached: () => undefined,
        changed: () => undefined,
      },
    );
    clock.startGame();
    clock.disconnected('P1');
    now = 999;
    callbacks.at(-1)!(); // the budget timer, 1 ms before the budget is gone
    expect(spent).toEqual([true]);
  });
});

describe('DecisionClock', () => {
  it('has the plan presets', () => {
    expect(CLOCK_PRESETS.relaxed).toMatchObject({ bankMs: 1_200_000, gameCapMs: 14_400_000 });
    expect(CLOCK_PRESETS.standard).toMatchObject({ bankMs: 600_000, gameCapMs: 10_800_000 });
    expect(scaledSettings('relaxed', 60).bankMs).toBe(20_000);
  });

  it('spends the free allowance before the bank', () => {
    const r = rig();
    r.clock.startDecision('P1');
    r.advance(8_000);
    r.clock.endDecision('P1');
    expect(r.clock.viewOf('P1')).toMatchObject({ bankMs: 60_000, running: false });
    r.clock.startDecision('P1');
    r.advance(25_000);
    r.clock.endDecision('P1');
    expect(r.clock.viewOf('P1')?.bankMs).toBe(45_000);
    expect(r.log).toEqual([]);
  });

  it('expires a decision when the allowance and the bank are gone', () => {
    const r = rig();
    r.clock.startDecision('P1');
    r.advance(69_999);
    expect(r.log).toEqual([]);
    r.advance(1);
    expect(r.log).toEqual(['expired P1']);
    expect(r.clock.viewOf('P1')?.bankMs).toBe(0);
    // An empty bank leaves the next decision only its allowance.
    r.clock.endDecision('P1');
    r.clock.startDecision('P1');
    r.advance(10_000);
    expect(r.log).toEqual(['expired P1', 'expired P1']);
  });

  it('pauses the decision during a disconnect and hands the seat over when grace ends', () => {
    const r = rig();
    r.clock.startDecision('P1');
    r.advance(5_000);
    r.clock.disconnected('P1');
    expect(r.views.at(-1)).toMatchObject({ running: false, remainingMs: 65_000 });
    r.advance(59_999);
    expect(r.log).toEqual([]);
    r.advance(1);
    expect(r.log).toEqual(['grace P1']);
  });

  it('resumes the same decision on reconnect without a fresh allowance', () => {
    const r = rig();
    r.clock.startDecision('P1');
    r.advance(9_000);
    r.clock.disconnected('P1');
    r.advance(30_000);
    r.clock.reconnected('P1');
    expect(r.views.at(-1)).toMatchObject({ running: true, remainingMs: 61_000 });
    r.advance(61_000);
    expect(r.log).toEqual(['expired P1']);
  });

  it('shares one grace across repeated disconnects during the same pending choice', () => {
    const r = rig();
    r.clock.startDecision('P1');
    r.clock.disconnected('P1');
    r.advance(59_000); // just before grace runs out
    r.clock.reconnected('P1');
    r.clock.disconnected('P1');
    r.advance(999);
    expect(r.log).toEqual([]);
    r.advance(1);
    expect(r.log).toEqual(['grace P1']);
  });

  it('gives a new pending choice a new grace, but never returns spent budget', () => {
    const r = rig({ ...SETTINGS, disconnectBudgetMs: 90_000 });
    r.clock.startDecision('P1');
    r.clock.disconnected('P1');
    r.advance(50_000);
    r.clock.reconnected('P1');
    r.clock.endDecision('P1');
    r.clock.startDecision('P1');
    r.clock.disconnected('P1');
    // Grace is 60 s again, but only 40 s of budget remain.
    r.advance(40_000);
    expect(r.log).toEqual(['grace P1', 'budget P1']);
    expect(r.clock.budgetSpent('P1')).toBe(true);
  });

  it('reports an empty budget once while the seat stays away', () => {
    const r = rig();
    r.clock.disconnected('P2');
    r.advance(400_000);
    expect(r.log).toEqual(['grace P2', 'budget P2']);
    r.clock.reconnected('P2');
    r.clock.disconnected('P2');
    r.advance(10_000);
    expect(r.log.filter((line) => line === 'budget P2')).toHaveLength(1);
  });

  it('reaches the game cap, and a disposed clock fires nothing', () => {
    const r = rig();
    r.clock.startGame();
    r.advance(3_600_000);
    expect(r.log).toEqual(['cap']);
    const s = rig();
    s.clock.startGame();
    s.clock.startDecision('P1');
    s.clock.dispose();
    s.advance(10_000_000);
    expect(s.log).toEqual([]);
    expect(s.pendingCount()).toBe(0);
  });

  it('keeps no clock for a removed (eliminated) seat', () => {
    const r = rig();
    r.clock.remove('P2');
    r.clock.startDecision('P2');
    r.clock.disconnected('P2');
    r.advance(1_000_000);
    expect(r.log).toEqual([]);
    expect(r.clock.isRemoved('P2')).toBe(true);
  });
});

/**
 * Table clocks (ADR 0031 decision 10, plan M4 task 1). Pure: time and timers are injected, and
 * the clock only reports what ran out; the session decides what that means for the game.
 *
 * Per human seat:
 *
 * - **Decisions.** Each decision actually shown to the player gets a free allowance (10 s), then
 *   draws on the seat's bank (20 min relaxed, 10 standard). When both are gone the decision has
 *   expired. A decision the server answers by itself (smart yield, a quiet pass) is never shown
 *   and never starts a clock.
 * - **Disconnects.** While a seat is disconnected its decision clock is paused and a grace period
 *   (60 s) runs instead, charged to a per-seat disconnect budget (5 min). Repeated disconnects
 *   during one pending choice share that choice's grace. Reconnecting resumes the same decision
 *   with what was left of its allowance and bank: nothing is renewed, and spent grace or budget
 *   is never returned. When the grace runs out the seat is handed to its fallback bot; the budget
 *   keeps draining while the seat stays away, and an empty budget is reported once.
 * - **The game.** A cap on the whole game's wall-clock time (4 h relaxed, 3 h standard).
 *
 * Every remaining duration and deadline lives here, on the server. Nothing a socket sends can
 * set one.
 */

import type { PlayerId, TableClockMode } from '@mtg/shared';

export interface ClockSettings {
  allowanceMs: number;
  bankMs: number;
  graceMs: number;
  disconnectBudgetMs: number;
  gameCapMs: number;
}

export type ClockPreset = Exclude<TableClockMode, 'off'>;

const MINUTE = 60_000;

export const CLOCK_PRESETS: Readonly<Record<ClockPreset, Readonly<ClockSettings>>> = {
  relaxed: {
    allowanceMs: 10_000,
    bankMs: 20 * MINUTE,
    graceMs: MINUTE,
    disconnectBudgetMs: 5 * MINUTE,
    gameCapMs: 240 * MINUTE,
  },
  standard: {
    allowanceMs: 10_000,
    bankMs: 10 * MINUTE,
    graceMs: MINUTE,
    disconnectBudgetMs: 5 * MINUTE,
    gameCapMs: 180 * MINUTE,
  },
};

/** Every duration divided by `scale` (dev mode's `--clock-scale`, for end-to-end tests). */
export function scaledSettings(preset: ClockPreset, scale = 1): ClockSettings {
  const base = CLOCK_PRESETS[preset];
  const s = Math.max(1, scale);
  return {
    allowanceMs: Math.round(base.allowanceMs / s),
    bankMs: Math.round(base.bankMs / s),
    graceMs: Math.round(base.graceMs / s),
    disconnectBudgetMs: Math.round(base.disconnectBudgetMs / s),
    gameCapMs: Math.round(base.gameCapMs / s),
  };
}

export interface ClockTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClockTimers: ClockTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** What a seat's clock shows. `remainingMs` is the allowance and bank left for this decision. */
export interface SeatClockView {
  seat: PlayerId;
  remainingMs: number;
  bankMs: number;
  running: boolean;
}

export interface DecisionClockEvents {
  /** A shown decision used its allowance and the whole bank. */
  decisionExpired(seat: PlayerId): void;
  /** A disconnected seat's grace ran out. */
  graceExpired(seat: PlayerId): void;
  /** A disconnected seat's disconnect budget is spent. Reported once per seat. */
  budgetExhausted(seat: PlayerId): void;
  /** The whole game reached its time limit. */
  gameCapReached(): void;
  /** A seat's displayed clock changed (started, stopped, paused or resumed). */
  changed(view: SeatClockView): void;
}

interface SeatClock {
  seat: PlayerId;
  bankMs: number;
  budgetMs: number;
  /** The decision being timed; null between decisions. */
  decision: { allowanceMs: number; runningSince: number | null; timer: unknown } | null;
  /** Grace already used during the current pending choice (or since the last one). */
  graceUsedMs: number;
  /** Set while disconnected. */
  away: { since: number; graceTimer: unknown; budgetTimer: unknown } | null;
  graceExpired: boolean;
  budgetReported: boolean;
  removed: boolean;
}

export class DecisionClock {
  private readonly seats = new Map<PlayerId, SeatClock>();
  private gameCapTimer: unknown = null;
  private disposed = false;

  constructor(
    private readonly settings: ClockSettings,
    humanSeats: Iterable<PlayerId>,
    private readonly timers: ClockTimers,
    private readonly events: DecisionClockEvents,
  ) {
    for (const seat of humanSeats) {
      this.seats.set(seat, {
        seat,
        bankMs: settings.bankMs,
        budgetMs: settings.disconnectBudgetMs,
        decision: null,
        graceUsedMs: 0,
        away: null,
        graceExpired: false,
        budgetReported: false,
        removed: false,
      });
    }
  }

  /** Start the game's time limit. */
  startGame(): void {
    if (this.disposed || this.gameCapTimer !== null) return;
    this.gameCapTimer = this.timers.setTimeout(() => {
      this.gameCapTimer = null;
      if (!this.disposed) this.events.gameCapReached();
    }, this.settings.gameCapMs);
  }

  /** A decision was shown to the player. Starts its allowance, paused while the seat is away. */
  startDecision(seat: PlayerId): void {
    const clock = this.live(seat);
    if (clock === null) return;
    this.stopDecisionTimer(clock);
    clock.decision = { allowanceMs: this.settings.allowanceMs, runningSince: null, timer: null };
    // A new pending choice has its own grace; the disconnect budget carries on.
    clock.graceUsedMs = 0;
    if (clock.away === null) this.run(clock);
    else this.restartAway(clock);
    this.events.changed(this.view(clock));
  }

  /** The decision was answered, by anyone. What it used of the bank stays used. */
  endDecision(seat: PlayerId): void {
    const clock = this.seats.get(seat);
    if (clock === undefined || clock.decision === null) return;
    this.charge(clock);
    this.stopDecisionTimer(clock);
    clock.decision = null;
    if (!clock.removed) this.events.changed(this.view(clock));
  }

  disconnected(seat: PlayerId): void {
    const clock = this.live(seat);
    if (clock === null || clock.away !== null) return;
    if (clock.decision !== null) {
      this.charge(clock);
      this.stopDecisionTimer(clock);
    }
    clock.away = { since: this.timers.now(), graceTimer: null, budgetTimer: null };
    this.armAway(clock);
    if (clock.decision !== null) this.events.changed(this.view(clock));
  }

  reconnected(seat: PlayerId): void {
    const clock = this.live(seat);
    if (clock === null || clock.away === null) return;
    this.chargeAway(clock);
    this.clearAway(clock);
    clock.away = null;
    clock.graceExpired = false;
    if (clock.decision !== null) {
      this.run(clock);
      this.events.changed(this.view(clock));
    }
  }

  /** An eliminated seat has no clock. */
  remove(seat: PlayerId): void {
    const clock = this.seats.get(seat);
    if (clock === undefined || clock.removed) return;
    this.stopDecisionTimer(clock);
    if (clock.away !== null) this.clearAway(clock);
    clock.removed = true;
  }

  /** Whether this seat's disconnect budget is spent. */
  budgetSpent(seat: PlayerId): boolean {
    const clock = this.seats.get(seat);
    if (clock === undefined) return false;
    const spent = clock.away === null ? 0 : Math.max(0, this.timers.now() - clock.away.since);
    return clock.budgetMs - spent <= 0;
  }

  isRemoved(seat: PlayerId): boolean {
    return this.seats.get(seat)?.removed ?? true;
  }

  viewOf(seat: PlayerId): SeatClockView | null {
    const clock = this.seats.get(seat);
    return clock === undefined ? null : this.view(clock);
  }

  dispose(): void {
    this.disposed = true;
    if (this.gameCapTimer !== null) this.timers.clearTimeout(this.gameCapTimer);
    this.gameCapTimer = null;
    for (const clock of this.seats.values()) {
      this.stopDecisionTimer(clock);
      if (clock.away !== null) this.clearAway(clock);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  private live(seat: PlayerId): SeatClock | null {
    if (this.disposed) return null;
    const clock = this.seats.get(seat);
    return clock === undefined || clock.removed ? null : clock;
  }

  /** Allowance and bank left for the current decision, as of now. */
  private left(clock: SeatClock): { allowanceMs: number; bankMs: number } {
    const decision = clock.decision;
    if (decision === null) return { allowanceMs: 0, bankMs: clock.bankMs };
    const elapsed =
      decision.runningSince === null ? 0 : Math.max(0, this.timers.now() - decision.runningSince);
    const fromAllowance = Math.min(elapsed, decision.allowanceMs);
    const fromBank = Math.min(elapsed - fromAllowance, clock.bankMs);
    return {
      allowanceMs: decision.allowanceMs - fromAllowance,
      bankMs: clock.bankMs - fromBank,
    };
  }

  /** Fold the running time into the allowance and bank, and stop the running mark. */
  private charge(clock: SeatClock): void {
    const decision = clock.decision;
    if (decision === null || decision.runningSince === null) return;
    const left = this.left(clock);
    decision.allowanceMs = left.allowanceMs;
    clock.bankMs = left.bankMs;
    decision.runningSince = null;
  }

  private run(clock: SeatClock): void {
    const decision = clock.decision;
    if (decision === null) return;
    decision.runningSince = this.timers.now();
    const total = decision.allowanceMs + clock.bankMs;
    decision.timer = this.timers.setTimeout(() => {
      decision.timer = null;
      if (clock.decision !== decision || this.disposed) return;
      this.charge(clock);
      this.events.decisionExpired(clock.seat);
    }, total);
  }

  private stopDecisionTimer(clock: SeatClock): void {
    const decision = clock.decision;
    if (decision === null || decision.timer === null) return;
    this.timers.clearTimeout(decision.timer);
    decision.timer = null;
  }

  private chargeAway(clock: SeatClock): void {
    const away = clock.away;
    if (away === null) return;
    const now = this.timers.now();
    const elapsed = Math.max(0, now - away.since);
    clock.graceUsedMs += elapsed;
    clock.budgetMs = Math.max(0, clock.budgetMs - elapsed);
    away.since = now;
  }

  private clearAway(clock: SeatClock): void {
    const away = clock.away;
    if (away === null) return;
    if (away.graceTimer !== null) this.timers.clearTimeout(away.graceTimer);
    if (away.budgetTimer !== null) this.timers.clearTimeout(away.budgetTimer);
    away.graceTimer = null;
    away.budgetTimer = null;
  }

  /** Re-arm the away timers after the grace allowance changed (a new decision while away). */
  private restartAway(clock: SeatClock): void {
    this.chargeAway(clock);
    this.clearAway(clock);
    this.armAway(clock);
  }

  private armAway(clock: SeatClock): void {
    const away = clock.away;
    if (away === null) return;
    const graceLeft = Math.min(this.settings.graceMs - clock.graceUsedMs, clock.budgetMs);
    if (!clock.graceExpired) {
      away.graceTimer = this.timers.setTimeout(
        () => {
          away.graceTimer = null;
          if (clock.away !== away || this.disposed || clock.removed) return;
          clock.graceExpired = true;
          this.events.graceExpired(clock.seat);
        },
        Math.max(0, graceLeft),
      );
    }
    if (!clock.budgetReported) {
      away.budgetTimer = this.timers.setTimeout(
        () => {
          away.budgetTimer = null;
          if (clock.away !== away || this.disposed || clock.removed) return;
          this.chargeAway(clock);
          clock.budgetReported = true;
          this.events.budgetExhausted(clock.seat);
        },
        Math.max(0, clock.budgetMs),
      );
    }
  }

  private view(clock: SeatClock): SeatClockView {
    const left = this.left(clock);
    return {
      seat: clock.seat,
      remainingMs: clock.decision === null ? left.bankMs : left.allowanceMs + left.bankMs,
      bankMs: left.bankMs,
      running: clock.decision !== null && clock.decision.runningSince !== null,
    };
  }
}

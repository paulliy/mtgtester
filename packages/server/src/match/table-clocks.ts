/**
 * Clocks, timeouts and fallback bots for the human seats of a table game (ADR 0031 decision 10,
 * plan M4 tasks 3 to 5). The session owns one when its table runs a clock; spectator, bot-only
 * and single-player games construct none.
 *
 * - A shown decision starts the seat's clock (`decisionShown`); an answer stops it.
 * - On expiry the pending decision is taken from the player, so a late answer is stale, and the
 *   seat's fallback bot answers it in the player's place (source `timeout`).
 * - Three timeouts in a row, or a disconnect grace running out, hand the seat to the fallback bot
 *   (source `fallback`) until the player sends `resumeControl`.
 * - The fallback bot never activates a mana ability by hand: those options are removed from its
 *   menu, ids kept, as the smart-yield filter does. Its reasoning note is dropped.
 * - The game cap ends the game as a `timeLimit` draw, and every remaining human past their
 *   disconnect budget ends it as an `allAway` draw.
 */

import type {
  DecisionRequest,
  DecisionResponse,
  PlayerId,
  TableServerToClientMessage,
} from '@mtg/shared';
import type { DecisionSource } from '../db/games';
import {
  DecisionClock,
  realClockTimers,
  type ClockSettings,
  type ClockTimers,
} from './decision-clock';

/** Timeouts in a row after which the fallback bot keeps the seat. */
export const TIMEOUTS_BEFORE_TAKEOVER = 3;

export interface TableClockHost {
  humanSeats: ReadonlySet<PlayerId>;
  /** Take the seat's pending decision from its player; null when none is pending. */
  takeOver(seat: PlayerId): { request: DecisionRequest; resolve(r: DecisionResponse): void } | null;
  /** The seat's fallback bot's answer to `request`, from its own random stream. */
  fallbackDecide(seat: PlayerId, request: DecisionRequest): DecisionResponse;
  tagSource(requestId: string, source: DecisionSource): void;
  /** End the game by agreement, as a draw for everyone still in it. */
  concede(reason: 'timeLimit' | 'allAway'): void;
  isEliminated(seat: PlayerId): boolean;
  isConnected(seat: PlayerId): boolean;
  /** A frame for every seated player. */
  publish(message: TableServerToClientMessage): void;
}

interface SeatState {
  fallback: boolean;
  timeoutsInARow: number;
  /** The request whose clock is running, so a re-sent request keeps its clock. */
  timedRequestId: string | null;
}

export class TableClocks {
  private readonly clock: DecisionClock;
  private readonly seats = new Map<PlayerId, SeatState>();
  private stopped = false;

  constructor(
    settings: ClockSettings,
    private readonly host: TableClockHost,
    timers: ClockTimers = realClockTimers,
  ) {
    for (const seat of host.humanSeats) {
      this.seats.set(seat, { fallback: false, timeoutsInARow: 0, timedRequestId: null });
    }
    this.clock = new DecisionClock(settings, host.humanSeats, timers, {
      decisionExpired: (seat) => {
        this.onExpired(seat);
      },
      graceExpired: (seat) => {
        this.setFallback(seat, true);
      },
      budgetExhausted: () => {
        this.checkAllAway();
      },
      gameCapReached: () => {
        this.host.concede('timeLimit');
      },
      changed: (view) => {
        if (this.stopped) return;
        this.host.publish({ type: 'clockState', payload: view });
      },
    });
  }

  start(): void {
    this.clock.startGame();
  }

  stop(): void {
    this.stopped = true;
    this.clock.dispose();
  }

  isFallback(seat: PlayerId): boolean {
    return this.seats.get(seat)?.fallback === true;
  }

  /**
   * A decision frame went to the seat. Starts its clock the first time this request is shown;
   * a re-send (resume, yield change) keeps the clock it has.
   */
  decisionShown(seat: PlayerId, requestId: string): void {
    const state = this.seats.get(seat);
    if (state === undefined || this.stopped || state.timedRequestId === requestId) return;
    this.syncEliminations();
    state.timedRequestId = requestId;
    this.clock.startDecision(seat);
  }

  /** The player answered the timed decision themselves. */
  answered(seat: PlayerId): void {
    const state = this.seats.get(seat);
    if (state === undefined) return;
    state.timeoutsInARow = 0;
    this.closeDecision(seat);
  }

  /** The timed decision was answered without the player (a smart-yield pass after a re-send). */
  closeDecision(seat: PlayerId, requestId?: string): void {
    const state = this.seats.get(seat);
    if (state === undefined) return;
    if (requestId !== undefined && state.timedRequestId !== requestId) return;
    state.timedRequestId = null;
    this.clock.endDecision(seat);
  }

  /** The fallback bot's answer for a seat it holds, tagged `fallback`. */
  answerAsFallback(seat: PlayerId, request: DecisionRequest): DecisionResponse {
    const response = this.host.fallbackDecide(seat, request);
    this.host.tagSource(request.requestId, 'fallback');
    return response;
  }

  connection(seat: PlayerId, connected: boolean): void {
    if (!this.seats.has(seat) || this.stopped) return;
    if (connected) this.clock.reconnected(seat);
    else this.clock.disconnected(seat);
    this.publishStatus(seat);
  }

  /** The player takes the seat back from the fallback bot. False when it was not held. */
  resumeControl(seat: PlayerId): boolean {
    const state = this.seats.get(seat);
    if (state === undefined || !state.fallback || this.stopped) return false;
    if (!this.host.isConnected(seat)) return false;
    state.fallback = false;
    state.timeoutsInARow = 0;
    this.publishStatus(seat);
    return true;
  }

  /** Eliminated seats have no clock. */
  syncEliminations(): void {
    for (const seat of this.seats.keys()) {
      if (this.host.isEliminated(seat) && !this.clock.isRemoved(seat)) this.clock.remove(seat);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  private onExpired(seat: PlayerId): void {
    const state = this.seats.get(seat);
    if (state === undefined || this.stopped) return;
    state.timedRequestId = null;
    this.clock.endDecision(seat);
    const taken = this.host.takeOver(seat);
    if (taken === null) return;
    const response = this.host.fallbackDecide(seat, taken.request);
    this.host.tagSource(taken.request.requestId, 'timeout');
    state.timeoutsInARow += 1;
    if (state.timeoutsInARow >= TIMEOUTS_BEFORE_TAKEOVER) this.setFallback(seat, true);
    taken.resolve(response);
  }

  private setFallback(seat: PlayerId, fallback: boolean): void {
    const state = this.seats.get(seat);
    if (state === undefined || state.fallback === fallback || this.stopped) return;
    if (this.host.isEliminated(seat)) return;
    state.fallback = fallback;
    this.publishStatus(seat);
    if (!fallback) return;
    // A decision the player still had is the fallback bot's now.
    state.timedRequestId = null;
    this.clock.endDecision(seat);
    const taken = this.host.takeOver(seat);
    if (taken === null) return;
    taken.resolve(this.answerAsFallback(seat, taken.request));
  }

  private checkAllAway(): void {
    if (this.stopped) return;
    const remaining = [...this.seats.keys()].filter((seat) => !this.host.isEliminated(seat));
    if (remaining.length === 0) return;
    if (remaining.every((seat) => this.clock.budgetSpent(seat))) this.host.concede('allAway');
  }

  private publishStatus(seat: PlayerId): void {
    if (this.stopped) return;
    this.host.publish({
      type: 'seatStatus',
      payload: {
        seat,
        connected: this.host.isConnected(seat),
        fallback: this.seats.get(seat)?.fallback === true,
      },
    });
  }
}

/**
 * The fallback bot's view of a request: every manual mana activation removed, ids kept, so the
 * engine still validates the answer against the menu it offered.
 */
export function fallbackMenu(request: DecisionRequest): DecisionRequest {
  return {
    ...request,
    legalActions: request.legalActions.filter((action) => action.type !== 'activateManaAbility'),
  };
}

/** A response without the bot's reasoning: a timed-out seat's answer carries no note. */
export function withoutNote(response: DecisionResponse): DecisionResponse {
  const { note: _note, ...rest } = response;
  return rest;
}

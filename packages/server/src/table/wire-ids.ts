/**
 * Per-seat wire ids and cadence for table frames (ADR 0031 decision 5, plan M3 task 5).
 *
 * Engine request ids, event sequences and board revisions are global counters: the gaps in what
 * one seat receives would count how often the other seats had a real choice. A table therefore
 * never sends them. This class holds the mapping the session wiring consults instead. It is
 * pure and driven by explicit calls; it sends nothing and reads no clock.
 *
 * - **Request ids.** A seat's decision gets the next number in that seat's own counter, but only
 *   when the decision is actually shown to the human. `surfaceDecision` allocates and memoizes;
 *   asking again for the same engine id returns the same wire id without advancing anything, so a
 *   re-sent request keeps its id. A decision the engine or a smart-yield passes automatically is
 *   never surfaced and never advances the counter. `toEngineId` translates the other way, before
 *   the human provider sees an answer.
 * - **Revisions.** A seat's revision counts only that seat's own board and decision frames.
 *   Clock ticks, connection badges and health probes do not touch it.
 * - **Log sequences.** Each viewer has its own, starting at 0.
 * - **Board snapshots.** `recordBoard` reports `send: true` only when the seat's projection
 *   differs from the one last sent, and only then moves the revision.
 */

import type { PlayerId } from '@mtg/shared';

/** How many past request mappings a seat keeps. Only the pending one is ever looked up. */
const DEFAULT_REMEMBERED_REQUESTS = 256;

interface SeatWire {
  /** Next wire request number; the first surfaced decision is `q1`. */
  requestCounter: number;
  autoPassed: number;
  revision: number;
  /** engine id -> wire id */
  byEngine: Map<string, string>;
  /** wire id -> engine id */
  byWire: Map<string, string>;
  /** Serialization of the last board projection sent, or `null` before the first. */
  lastBoard: string | null;
}

export interface SurfacedDecision {
  /** The id the client sees and sends back. */
  requestId: string;
  /** The seat's revision for this frame. Bumped only for a decision not seen before. */
  revision: number;
  /** `false` when this is a re-send of a decision already surfaced to the seat. */
  fresh: boolean;
}

export interface BoardRecord {
  /** Whether a snapshot frame should go out. */
  send: boolean;
  /** The seat's revision after this call; unchanged when `send` is false. */
  revision: number;
}

export interface WireIdsOptions {
  /** Past request mappings kept per seat. Default 256. */
  rememberedRequests?: number;
}

/**
 * Stable serialization: object keys sorted, `undefined` properties dropped as `JSON.stringify`
 * does. Two projections with the same content serialize alike whatever their key order.
 */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return inner;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(inner).sort()) {
      sorted[key] = (inner as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

export class WireIds {
  private readonly seats = new Map<PlayerId, SeatWire>();
  private readonly logSequences = new Map<string, number>();
  private readonly remembered: number;

  constructor(options: WireIdsOptions = {}) {
    this.remembered = Math.max(1, options.rememberedRequests ?? DEFAULT_REMEMBERED_REQUESTS);
  }

  private seat(seat: PlayerId): SeatWire {
    let wire = this.seats.get(seat);
    if (wire === undefined) {
      wire = {
        requestCounter: 0,
        autoPassed: 0,
        revision: 0,
        byEngine: new Map(),
        byWire: new Map(),
        lastBoard: null,
      };
      this.seats.set(seat, wire);
    }
    return wire;
  }

  // ── Request ids ─────────────────────────────────────────────────────────────────────────

  /**
   * A decision is being shown to the seat's human. The first call for an engine id allocates the
   * seat's next wire id and bumps the seat's revision (a decision frame is a frame). Later calls
   * for the same engine id return the same wire id and the current revision, changing nothing.
   */
  surfaceDecision(seat: PlayerId, engineRequestId: string): SurfacedDecision {
    const wire = this.seat(seat);
    const existing = wire.byEngine.get(engineRequestId);
    if (existing !== undefined) {
      return { requestId: existing, revision: wire.revision, fresh: false };
    }
    wire.requestCounter += 1;
    const requestId = `q${wire.requestCounter}`;
    wire.byEngine.set(engineRequestId, requestId);
    wire.byWire.set(requestId, engineRequestId);
    wire.revision += 1;
    this.forget(wire);
    return { requestId, revision: wire.revision, fresh: true };
  }

  /**
   * The engine or a smart-yield resolved a decision without showing it. Nothing is allocated and
   * the request counter and revision do not move; a client that later presents an id for it finds
   * no mapping.
   */
  autoPassed(seat: PlayerId): void {
    this.seat(seat).autoPassed += 1;
  }

  /** Decisions passed without being shown. Server-side bookkeeping; never sent. */
  autoPassedCount(seat: PlayerId): number {
    return this.seats.get(seat)?.autoPassed ?? 0;
  }

  /** Engine id for a wire id the seat sent back, or `undefined` if it never held that id. */
  toEngineId(seat: PlayerId, wireRequestId: string): string | undefined {
    return this.seats.get(seat)?.byWire.get(wireRequestId);
  }

  /**
   * Wire id for a request id found in the game report, or `null` when the seat was never shown
   * that request. The engine id itself is never returned.
   */
  mapPendingRequestId(seat: PlayerId, engineRequestId: string | null | undefined): string | null {
    if (engineRequestId === null || engineRequestId === undefined) return null;
    return this.seats.get(seat)?.byEngine.get(engineRequestId) ?? null;
  }

  /** Decisions surfaced to the seat so far. */
  surfacedCount(seat: PlayerId): number {
    return this.seats.get(seat)?.requestCounter ?? 0;
  }

  private forget(wire: SeatWire): void {
    while (wire.byEngine.size > this.remembered) {
      const oldest = wire.byEngine.entries().next();
      if (oldest.done === true) return;
      const [engineId, wireId] = oldest.value;
      wire.byEngine.delete(engineId);
      wire.byWire.delete(wireId);
    }
  }

  // ── Revisions and snapshots ─────────────────────────────────────────────────────────────

  /** The seat's current revision (0 before any frame). */
  revision(seat: PlayerId): number {
    return this.seats.get(seat)?.revision ?? 0;
  }

  /**
   * Compare the seat's current board projection with the last one sent. If it changed (or none
   * was sent), remember it, bump the seat's revision and report `send: true`. If not, nothing
   * moves and no frame should go out. Pass the projection without its own revision field.
   */
  recordBoard(seat: PlayerId, projection: unknown): BoardRecord {
    const wire = this.seat(seat);
    const serialized = stableSerialize(projection);
    if (wire.lastBoard === serialized) return { send: false, revision: wire.revision };
    wire.lastBoard = serialized;
    wire.revision += 1;
    return { send: true, revision: wire.revision };
  }

  /** Drop the remembered projection so the next `recordBoard` sends (a resumed socket). */
  invalidateBoard(seat: PlayerId): void {
    const wire = this.seats.get(seat);
    if (wire !== undefined) wire.lastBoard = null;
  }

  // ── Log sequences ───────────────────────────────────────────────────────────────────────

  /**
   * The next log sequence for one viewer: a seat id or any other viewer key. Each viewer counts
   * its own lines from 0, so the numbers say nothing about lines other viewers were not sent.
   */
  nextLogSequence(viewer: string): number {
    const next = this.logSequences.get(viewer) ?? 0;
    this.logSequences.set(viewer, next + 1);
    return next;
  }

  /** The sequence `nextLogSequence` would return, without consuming it. */
  peekLogSequence(viewer: string): number {
    return this.logSequences.get(viewer) ?? 0;
  }
}

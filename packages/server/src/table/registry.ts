/**
 * The set of live tables on one server (ADR 0031 decision 6, plan M3 task 1).
 *
 * - Tables are keyed by a random id, up to a cap.
 * - One `AttemptThrottle` is shared by every table and by the host secret, so a client address
 *   that guesses at any of them is slowed for all of them.
 * - The host secret is generated at startup and printed by the CLI. It is only ever used to
 *   create a table.
 * - Reaping is a method, not a timer: the server owns the timer and calls `reapIdle`, and the
 *   clock is injected, so tests advance time without waiting.
 */

import type { TableClockMode } from '@mtg/shared';
import { DEFAULT_MAX_TABLES } from './config';
import type { DeckChecker } from './deck-check';
import { Table, type TableEffect, type TableLimits } from './table';
import { AttemptThrottle, constantTimeEqual, generateHostSecret } from './tokens';

export interface TableRegistryOptions {
  deckChecker: DeckChecker;
  /** Most tables alive at once, `reaped` ones excluded. Default 8. */
  maxTables?: number;
  /** Generated when omitted. */
  hostSecret?: string;
  now?: () => number;
  /** Shared with every table. One is made when omitted. */
  throttle?: AttemptThrottle;
  insecureLan?: boolean;
  clock?: TableClockMode | null;
  limits?: Partial<TableLimits>;
}

export type HostSecretCheck =
  { ok: true } | { ok: false; reason: 'bad' | 'throttled'; retryAfterMs: number };

export type CreateTableResult =
  | { ok: true; table: Table; tableId: string; hostToken: string; inviteCode: string }
  | { ok: false; reason: 'tooManyTables' };

export interface ReapedTable {
  tableId: string;
  /** Messages and closes for the sockets the table still held. */
  effects: TableEffect[];
}

export class TableRegistry {
  readonly hostSecret: string;
  readonly throttle: AttemptThrottle;
  private readonly tables = new Map<string, Table>();
  private readonly maxTables: number;
  private readonly now: () => number;

  constructor(private readonly options: TableRegistryOptions) {
    this.hostSecret = options.hostSecret ?? generateHostSecret();
    this.now = options.now ?? Date.now;
    this.throttle = options.throttle ?? new AttemptThrottle({ now: this.now });
    this.maxTables = Math.max(1, options.maxTables ?? DEFAULT_MAX_TABLES);
  }

  get size(): number {
    return this.tables.size;
  }

  /**
   * Check a host secret for `address`. A throttled address is not evaluated; a wrong secret
   * extends its delay; a right one clears it.
   */
  checkHostSecret(candidate: string, address: string): HostSecretCheck {
    const wait = this.throttle.check(address);
    if (wait > 0) return { ok: false, reason: 'throttled', retryAfterMs: wait };
    if (!constantTimeEqual(candidate, this.hostSecret)) {
      this.throttle.fail(address);
      return { ok: false, reason: 'bad', retryAfterMs: 0 };
    }
    this.throttle.succeed(address);
    return { ok: true };
  }

  /**
   * Make a table. The host token is returned here and nowhere else: the caller hands it to the
   * creator once.
   */
  create(): CreateTableResult {
    if (this.tables.size >= this.maxTables) return { ok: false, reason: 'tooManyTables' };
    const table = new Table({
      deckChecker: this.options.deckChecker,
      now: this.now,
      throttle: this.throttle,
      ...(this.options.insecureLan === undefined ? {} : { insecureLan: this.options.insecureLan }),
      ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
      ...(this.options.limits === undefined ? {} : { limits: this.options.limits }),
    });
    this.tables.set(table.id, table);
    return {
      ok: true,
      table,
      tableId: table.id,
      hostToken: table.issuedHostToken,
      inviteCode: table.currentInviteCode,
    };
  }

  get(tableId: string): Table | undefined {
    return this.tables.get(tableId);
  }

  ids(): string[] {
    return [...this.tables.keys()];
  }

  /** Tables whose game has started and not finished: a deploy waits for these to end. */
  activeGames(): number {
    let count = 0;
    for (const table of this.tables.values()) {
      const phase = table.currentPhase;
      if (phase === 'starting' || phase === 'playing') count++;
    }
    return count;
  }

  /**
   * Reap every table that has been `finished` long enough, and forget it. Called by the timer the
   * server owns. The effects close the sockets each table still held.
   */
  reapIdle(): ReapedTable[] {
    const reaped: ReapedTable[] = [];
    for (const [tableId, table] of [...this.tables]) {
      const result = table.reapIfIdle();
      if (!result.ok || !result.reaped) continue;
      this.tables.delete(tableId);
      reaped.push({ tableId, effects: result.effects });
    }
    return reaped;
  }
}

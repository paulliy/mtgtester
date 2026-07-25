/**
 * AI Call Persistence (§9, §13).
 * Records every AI decision call in the SQLite `ai_calls` table for the debug panel,
 * replay auditing, and token cost metrics.
 */

import type { DecisionRequest, DecisionResponse } from '@mtg/shared';
import type { CallMeta } from './client';

export interface CallResult {
  response: DecisionResponse;
  meta: CallMeta;
}

/**
 * How a decision was answered. `heuristic` and `cache` cost no network call at all — they are
 * still recorded, because the point of them is the ratio, and a decision that never appears in
 * the table would make the game look like it made fewer decisions rather than fewer calls.
 */
export type DecisionSource = 'primary' | 'retry' | 'fallback' | 'heuristic' | 'cache' | 'plan';

/** Sources answered locally: recorded, but never billed and never rate-limited. */
const SKIPPED_SOURCES: ReadonlySet<DecisionSource> = new Set<DecisionSource>([
  'heuristic',
  'cache',
  'plan',
]);

/** Placeholder metadata for a decision answered without contacting the model. */
export function localCallMeta(): CallMeta {
  return {
    model: 'none',
    promptTokens: 0,
    responseTokens: 0,
    latencyMs: 0,
    wasRetry: false,
    wasFallback: false,
    rawResponse: '',
  };
}

export interface SqliteDb {
  query(sql: string): {
    run(...args: unknown[]): void;
    all(...args: unknown[]): unknown[];
  };
}

export class AiCallLogger {
  private sequence = 0;
  /** Decisions answered locally — tracked in memory so it works with `db === null` too. */
  private skipped = 0;

  constructor(
    private readonly db: SqliteDb | null,
    private readonly gameId: string,
  ) {}

  log(
    request: DecisionRequest,
    result: CallResult,
    wasRetry: boolean,
    wasFallback: boolean,
    source: DecisionSource = 'primary',
  ): void {
    this.sequence++;
    if (SKIPPED_SOURCES.has(source)) this.skipped++;
    if (this.db === null) return;

    // Seat index: parse numeric seat from "P1" -> 1 if possible
    const seatMatch = /^P(\d+)$/i.exec(request.decidingPlayer);
    const seat = seatMatch ? Number.parseInt(seatMatch[1]!, 10) : 0;

    try {
      this.db
        .query(
          `INSERT INTO ai_calls (
            game_id, sequence, seat, model, prompt_tokens, response_tokens,
            request_json, response_json, was_retry, was_fallback, latency_ms, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.gameId,
          this.sequence,
          seat,
          result.meta.model,
          result.meta.promptTokens,
          result.meta.responseTokens,
          JSON.stringify(request),
          JSON.stringify(result.response),
          wasRetry ? 1 : 0,
          wasFallback ? 1 : 0,
          result.meta.latencyMs,
          source,
        );
    } catch {
      // Ignore database insert errors in loggers
    }
  }

  summary(): {
    totalDecisions: number;
    totalCalls: number;
    /** Decisions answered by a heuristic or the cache — network calls never made. */
    skippedCalls: number;
    retries: number;
    fallbacks: number;
    totalPromptTokens: number;
    totalResponseTokens: number;
    avgLatencyMs: number;
  } {
    if (this.db === null) {
      return {
        totalDecisions: this.sequence,
        totalCalls: this.sequence - this.skipped,
        skippedCalls: this.skipped,
        retries: 0,
        fallbacks: 0,
        totalPromptTokens: 0,
        totalResponseTokens: 0,
        avgLatencyMs: 0,
      };
    }

    const rows = this.db
      .query(
        `SELECT
          COUNT(*) as totalDecisions,
          SUM(CASE WHEN source IN ('heuristic', 'cache', 'plan') THEN 1 ELSE 0 END) as skippedCalls,
          SUM(was_retry) as retries,
          SUM(was_fallback) as fallbacks,
          SUM(prompt_tokens) as totalPromptTokens,
          SUM(response_tokens) as totalResponseTokens,
          AVG(latency_ms) as avgLatencyMs
        FROM ai_calls WHERE game_id = ?`,
      )
      .all(this.gameId) as Array<{
      totalDecisions?: number;
      skippedCalls?: number;
      retries?: number;
      fallbacks?: number;
      totalPromptTokens?: number;
      totalResponseTokens?: number;
      avgLatencyMs?: number;
    }>;

    const row = rows[0];
    const totalDecisions = row?.totalDecisions ?? 0;
    const skippedCalls = row?.skippedCalls ?? 0;
    return {
      totalDecisions,
      totalCalls: totalDecisions - skippedCalls,
      skippedCalls,
      retries: row?.retries ?? 0,
      fallbacks: row?.fallbacks ?? 0,
      totalPromptTokens: row?.totalPromptTokens ?? 0,
      totalResponseTokens: row?.totalResponseTokens ?? 0,
      avgLatencyMs: Math.round(row?.avgLatencyMs ?? 0),
    };
  }
}

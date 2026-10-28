/**
 * AI Call Persistence (§9, §13).
 * Records every AI decision call in the SQLite `ai_calls` table for the debug panel,
 * replay auditing, and token cost metrics.
 */

import type { DecisionRequest, DecisionResponse } from '@mtg/shared';
import type { AiAttemptObserver, AiNetworkAttempt, CallMeta } from './client';
import type { JevDecisionTrace, JevTraceObserver } from './jev-policy';

export interface CallResult {
  response: DecisionResponse;
  meta: CallMeta;
}

/**
 * How a decision was answered. `heuristic`, `cache`, and `plan` cost no network call at all —
 * they are still recorded, because the point of them is the ratio, and a decision that never
 * appears in the table would make the game look like it made fewer decisions rather than fewer
 * calls. `human` is the §7.7 step-2 override: the model failed twice and the watching user
 * picked. It is deliberately NOT counted as skipped — it cost two calls before the human saw it.
 *
 * `reflection` is the post-game review (ADR 0022 §7). It is a real billed call, so it is not
 * skipped either — but it decides nothing, so it is excluded from `avgLatencyMs`, which otherwise
 * stops meaning "how long a decision took".
 */
export type DecisionSource =
  | 'primary'
  | 'retry'
  | 'fallback'
  | 'heuristic'
  | 'cache'
  | 'plan'
  | 'strategist'
  | 'human'
  | 'reflection'
  /** Reading a player's free-text deal into terms (ADR 0035 phase 4). */
  | 'dealDraft'
  | 'jev';

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
    costUsd: 0,
    promptTokenSource: 'reported',
    responseTokenSource: 'reported',
    costSource: 'not_applicable',
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
  private retries = 0;
  private fallbacks = 0;
  private promptTokens = 0;
  private responseTokens = 0;
  private totalLatencyMs = 0;
  private totalCostUsd = 0;
  private readonly sourceCounts = new Map<DecisionSource, number>();
  /** Per-source latency, so the strategist and tactician tiers can be measured separately. */
  private readonly latencyBySource = new Map<DecisionSource, { sum: number; count: number }>();
  /** Latest resolution source by surfaced request, used by the CLI transcript. */
  private readonly sourcesByRequestId = new Map<string, DecisionSource>();
  /** Row `sequence` by request, so a later anchor can find the row it belongs to. */
  private readonly rowByRequestId = new Map<string, number>();
  private attemptSequence = 0;
  private readonly networkAttempts: AiNetworkAttempt[] = [];
  private attemptKnownCostUsd = 0;
  private readonly jevDecisionTraces: JevDecisionTrace[] = [];

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
    if (wasRetry) this.retries++;
    if (wasFallback) this.fallbacks++;
    this.promptTokens += result.meta.promptTokens;
    this.responseTokens += result.meta.responseTokens;
    this.totalLatencyMs += result.meta.latencyMs;
    if (result.meta.costUsd !== undefined) this.totalCostUsd += result.meta.costUsd;
    this.sourceCounts.set(source, (this.sourceCounts.get(source) ?? 0) + 1);
    this.sourcesByRequestId.set(request.requestId, source);
    this.rowByRequestId.set(request.requestId, this.sequence);
    const bucket = this.latencyBySource.get(source) ?? { sum: 0, count: 0 };
    bucket.sum += result.meta.latencyMs;
    bucket.count += 1;
    this.latencyBySource.set(source, bucket);
    if (this.db === null) return;

    // Seat index: parse numeric seat from "P1" -> 1 if possible
    const seatMatch = /^P(\d+)$/i.exec(request.decidingPlayer);
    const seat = seatMatch ? Number.parseInt(seatMatch[1]!, 10) : 0;

    try {
      this.db
        .query(
          `INSERT INTO ai_calls (
            game_id, sequence, seat, model, prompt_tokens, response_tokens,
            request_json, response_json, was_retry, was_fallback, latency_ms, cost_usd, source, turn
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          result.meta.costUsd ?? null,
          source,
          request.turn,
        );
    } catch {
      // Ignore database insert errors in loggers
    }
  }

  /** Observer passed to clients so failed and superseded physical requests remain attributable. */
  attemptObserver(): AiAttemptObserver {
    return (attempt) => this.recordAttempt(attempt);
  }

  recordAttempt(attempt: AiNetworkAttempt): void {
    this.attemptSequence++;
    this.networkAttempts.push(attempt);
    if (attempt.usage.costUsd !== undefined) this.attemptKnownCostUsd += attempt.usage.costUsd;
    if (this.db === null) return;
    // Benchmark writers intentionally fail loudly. Production persistence remains best-effort,
    // matching the existing ai_calls logger contract.
    try {
      this.db
        .query(
          `INSERT INTO ai_attempts (
             game_id, sequence, logical_request_id, client_attempt, requested_model,
             response_model, backend, provider_request_id, status, started_at, ended_at,
             duration_ms, attempt_json, cost_usd
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.gameId,
          this.attemptSequence,
          attempt.logicalRequestId,
          attempt.attemptIndex,
          attempt.requestedModel,
          attempt.responseModel ?? null,
          attempt.backend ?? null,
          attempt.providerRequestId ?? null,
          attempt.status,
          attempt.startedAt,
          attempt.endedAt,
          attempt.durationMs,
          JSON.stringify(attempt),
          attempt.usage.costUsd ?? null,
        );
    } catch {
      // The live debug logger must never stop a match because diagnostics could not persist.
    }
  }

  capturedAttempts(): readonly AiNetworkAttempt[] {
    return this.networkAttempts;
  }

  jevTraceObserver(): JevTraceObserver {
    return (trace) => this.recordJevTrace(trace);
  }

  recordJevTrace(trace: JevDecisionTrace): void {
    this.jevDecisionTraces.push({ ...trace });
    if (this.db === null) return;
    try {
      this.db
        .query(
          `INSERT INTO jev_decision_traces (
             game_id, logical_request_id, recorded_at, mode, outcome,
             fallback_reason, engine_acceptance, trace_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.gameId,
          trace.logicalRequestId,
          trace.recordedAt,
          trace.mode,
          trace.outcome,
          trace.fallbackReason ?? null,
          trace.engineAcceptance,
          JSON.stringify(trace),
        );
    } catch {
      // Diagnostics remain best-effort in live play.
    }
  }

  capturedJevTraces(): readonly JevDecisionTrace[] {
    return this.jevDecisionTraces;
  }

  /** Resolution source for a surfaced decision, if it was recorded by this logger. */
  sourceFor(requestId: string): DecisionSource | undefined {
    return this.sourcesByRequestId.get(requestId);
  }

  /**
   * Attach the `game_events.sequence` this call's decision produced (ADR 0022). Separate from
   * `log()` because the anchor is only knowable after `Engine.submit()`, which happens well
   * after the call itself was recorded.
   */
  recordAnchor(requestId: string, anchorSequence: number): void {
    for (const trace of this.jevDecisionTraces) {
      if (
        trace.logicalRequestId === requestId &&
        trace.mode === 'active' &&
        trace.outcome === 'accepted'
      ) {
        trace.engineAcceptance = 'accepted';
      }
    }
    const row = this.rowByRequestId.get(requestId);
    if (this.db !== null) {
      try {
        this.db
          .query(
            `UPDATE jev_decision_traces
             SET engine_acceptance = 'accepted'
             WHERE game_id = ? AND logical_request_id = ? AND mode = 'active' AND outcome = 'accepted'`,
          )
          .run(this.gameId, requestId);
      } catch {
        // Best-effort diagnostics.
      }
    }
    if (row === undefined || this.db === null) return;
    try {
      this.db
        .query(`UPDATE ai_calls SET anchor_sequence = ? WHERE game_id = ? AND sequence = ?`)
        .run(anchorSequence, this.gameId, row);
    } catch {
      // Ignore database update errors in loggers
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
    /** Strategist-tier latency only — the once-per-turn reasoning call. */
    avgStrategistLatencyMs: number;
    /** Tactician-tier latency only (`primary`/`retry`/`fallback`); excludes the strategist. */
    avgTacticianLatencyMs: number;
    totalCostUsd: number;
    strategistCalls: number;
    planExecutions: number;
    networkAttempts: number;
    unknownCostAttempts: number;
    costAccountingCoverage: number;
  } {
    if (this.db === null) {
      const totalCalls = this.sequence - this.skipped;
      const strategistLatency = this.latencyBySource.get('strategist');
      // A post-game review is not a decision, and a 20s one would otherwise drag the headline
      // "average decision latency" upward after every game.
      const reflectionLatency = this.latencyBySource.get('reflection');
      const decidingCalls = totalCalls - (reflectionLatency?.count ?? 0);
      const decidingLatencyMs = this.totalLatencyMs - (reflectionLatency?.sum ?? 0);
      const tacticianSources: DecisionSource[] = ['primary', 'retry', 'fallback', 'jev'];
      let tacticianSum = 0;
      let tacticianCount = 0;
      for (const source of tacticianSources) {
        const bucket = this.latencyBySource.get(source);
        if (bucket === undefined) continue;
        tacticianSum += bucket.sum;
        tacticianCount += bucket.count;
      }
      return {
        totalDecisions: this.sequence,
        totalCalls,
        skippedCalls: this.skipped,
        retries: this.retries,
        fallbacks: this.fallbacks,
        totalPromptTokens: this.promptTokens,
        totalResponseTokens: this.responseTokens,
        avgLatencyMs: decidingCalls > 0 ? Math.round(decidingLatencyMs / decidingCalls) : 0,
        avgStrategistLatencyMs:
          strategistLatency !== undefined && strategistLatency.count > 0
            ? Math.round(strategistLatency.sum / strategistLatency.count)
            : 0,
        avgTacticianLatencyMs: tacticianCount > 0 ? Math.round(tacticianSum / tacticianCount) : 0,
        totalCostUsd:
          this.networkAttempts.length > 0 ? this.attemptKnownCostUsd : this.totalCostUsd,
        strategistCalls: this.sourceCounts.get('strategist') ?? 0,
        planExecutions: this.sourceCounts.get('plan') ?? 0,
        networkAttempts: this.networkAttempts.length,
        unknownCostAttempts: this.networkAttempts.filter(
          (attempt) => attempt.usage.costSource === 'unknown',
        ).length,
        costAccountingCoverage:
          this.networkAttempts.length === 0
            ? 1
            : this.networkAttempts.filter((attempt) => attempt.usage.costSource !== 'unknown')
                .length / this.networkAttempts.length,
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
          SUM(cost_usd) as totalCostUsd,
          SUM(CASE WHEN source = 'strategist' THEN 1 ELSE 0 END) as strategistCalls,
          SUM(CASE WHEN source = 'plan' THEN 1 ELSE 0 END) as planExecutions,
          AVG(CASE WHEN source IS NULL OR source <> 'reflection' THEN latency_ms END) as avgLatencyMs,
          AVG(CASE WHEN source = 'strategist' THEN latency_ms END) as avgStrategistLatencyMs,
          AVG(CASE WHEN source IN ('primary', 'retry', 'fallback', 'jev') THEN latency_ms END) as avgTacticianLatencyMs
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
      avgStrategistLatencyMs?: number;
      avgTacticianLatencyMs?: number;
      totalCostUsd?: number;
      strategistCalls?: number;
      planExecutions?: number;
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
      avgStrategistLatencyMs: Math.round(row?.avgStrategistLatencyMs ?? 0),
      avgTacticianLatencyMs: Math.round(row?.avgTacticianLatencyMs ?? 0),
      totalCostUsd:
        this.networkAttempts.length > 0 ? this.attemptKnownCostUsd : (row?.totalCostUsd ?? 0),
      strategistCalls: row?.strategistCalls ?? 0,
      planExecutions: row?.planExecutions ?? 0,
      networkAttempts: this.networkAttempts.length,
      unknownCostAttempts: this.networkAttempts.filter(
        (attempt) => attempt.usage.costSource === 'unknown',
      ).length,
      costAccountingCoverage:
        this.networkAttempts.length === 0
          ? 1
          : this.networkAttempts.filter((attempt) => attempt.usage.costSource !== 'unknown')
              .length / this.networkAttempts.length,
    };
  }
}

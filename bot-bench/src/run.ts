/**
 * Runs a lineup over a set of cases. Every model plays every case (and every trial of it) on an
 * identical, freshly arranged position against the same deterministic table, so two models'
 * results differ only by what they chose. Models run side by side; one model's cases run in order.
 */
import type { AiNetworkAttempt } from '../../packages/server/src/ai/client';
import type { BenchCase } from './case';
import {
  actorFactory,
  publicEntry,
  type LineupEntry,
  type LlmRuntime,
  type RunMode,
} from './models';
import { playCase, type ActorFactory, type CaseRun } from './play';
import { scoreRun, type CaseScore } from './score';

/** One model's attempt at one case. The focus prompt is the same for every model, so it is not repeated here. */
export interface CaseResult {
  caseId: string;
  trial: number;
  run: Omit<CaseRun, 'focus'>;
  score: CaseScore;
}

export interface TranscriptEntry {
  modelId: string;
  caseId: string;
  trial: number;
  requestId: string;
  attemptIndex: number;
  status: AiNetworkAttempt['status'];
  durationMs: number;
  messages: AiNetworkAttempt['messages'];
  rawResponse?: string;
  error?: string;
  usage: AiNetworkAttempt['usage'];
  responseModel?: string;
  backend?: string;
}

export interface ModelResult {
  model: Record<string, unknown> & { id: string; label: string; kind: string };
  status: 'complete' | 'aborted';
  /** Why the model stopped early: provider failures, or the run's spend cap. */
  abortReason?: string;
  startedAt: string;
  endedAt: string;
  wallClockMs: number;
  cases: CaseResult[];
}

export interface RunOptions {
  mode: RunMode;
  trials: number;
  /** Models running at once. */
  concurrency: number;
  /** Stop every model once the known spend passes this many USD. */
  spendCapUsd: number | null;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  onTranscript?: (entry: TranscriptEntry) => void;
  onProgress?: (line: string) => void;
  /** Called as each model finishes, so a long run can be saved model by model. */
  onModel?: (result: ModelResult) => void;
}

/** Consecutive decisions lost to provider errors before a model is declared unavailable. */
const PROVIDER_FAILURE_LIMIT = 3;

/** Thrown in place of a decision once the spend cap is passed, so a case stops mid-turn. */
class SpendCapReached extends Error {
  constructor(capUsd: number) {
    super(`spend cap of $${capUsd.toFixed(2)} reached`);
    this.name = 'SpendCapReached';
  }
}

export async function runLineup(
  cases: readonly BenchCase[],
  lineup: readonly LineupEntry[],
  options: RunOptions,
): Promise<ModelResult[]> {
  let knownSpend = 0;
  const overBudget = (): boolean =>
    options.spendCapUsd !== null && knownSpend > options.spendCapUsd;

  const runModel = async (entry: LineupEntry): Promise<ModelResult> => {
    let trial = 1;
    const runtime: LlmRuntime = {
      env: options.env,
      mode: options.mode,
      ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
      ...(options.sleepImpl !== undefined && { sleepImpl: options.sleepImpl }),
      onAttempt: (attempt, context) => {
        if (attempt.usage.costUsd !== undefined) knownSpend += attempt.usage.costUsd;
        options.onTranscript?.({
          modelId: entry.id,
          caseId: context.caseId,
          trial,
          requestId: attempt.logicalRequestId,
          attemptIndex: attempt.attemptIndex,
          status: attempt.status,
          durationMs: attempt.durationMs,
          messages: attempt.messages,
          usage: attempt.usage,
          ...(attempt.rawResponse !== undefined && { rawResponse: attempt.rawResponse }),
          ...(attempt.error !== undefined && { error: attempt.error }),
          ...(attempt.responseModel !== undefined && { responseModel: attempt.responseModel }),
          ...(attempt.backend !== undefined && { backend: attempt.backend }),
        });
      },
    };
    const startedMs = Date.now();
    const results: CaseResult[] = [];
    let abortReason: string | undefined;
    let providerFailures = 0;

    try {
      // Built once per model: its request queue and rate limit are shared by all its cases.
      const baseFactory = actorFactory(entry, runtime);
      // The cap is checked before every decision, not only between cases: a whole-turn case
      // makes many paid requests, and other models spend from the same budget meanwhile. A
      // decision already sent still finishes its own retries, so the overshoot is at most one
      // decision per running model.
      let capReachedInCase = false;
      const makeActor: ActorFactory = (engine, benchCase) => {
        const actor = baseFactory(engine, benchCase);
        return {
          decide(request, view) {
            if (overBudget()) {
              capReachedInCase = true;
              throw new SpendCapReached(options.spendCapUsd ?? 0);
            }
            return actor.decide(request, view);
          },
        };
      };
      outer: for (const benchCase of cases) {
        for (trial = 1; trial <= options.trials; trial++) {
          if (overBudget()) {
            abortReason = new SpendCapReached(options.spendCapUsd ?? 0).message;
            break outer;
          }
          capReachedInCase = false;
          const played = await playCase(benchCase, makeActor);
          if (capReachedInCase) {
            // A case cut off by the cap is not scored: the rest of it was never asked.
            abortReason = `${new SpendCapReached(options.spendCapUsd ?? 0).message} during ${benchCase.id}`;
            break outer;
          }
          const score = scoreRun(benchCase, played);
          const { focus: _sameForEveryModel, ...run } = played;
          results.push({ caseId: benchCase.id, trial, run, score });
          for (const decision of run.decisions) {
            if (decision.failure?.startsWith('provider error') === true) providerFailures += 1;
            else providerFailures = 0;
          }
          options.onProgress?.(
            `${entry.id}  ${benchCase.id}${options.trials > 1 ? ` #${trial}` : ''}  ${(score.score * 100).toFixed(0)}%  ${run.decisions.map((decision) => decision.action).join(' | ')}`,
          );
          if (providerFailures >= PROVIDER_FAILURE_LIMIT) {
            const last = run.decisions.at(-1)?.failure ?? 'provider error';
            abortReason = `${PROVIDER_FAILURE_LIMIT} decisions in a row failed at the provider (${last})`;
            break outer;
          }
        }
      }
    } catch (cause) {
      // One model's failure is that model's result, not the end of everyone else's run.
      abortReason = cause instanceof Error ? cause.message : String(cause);
    }

    const endedMs = Date.now();
    return {
      model: publicEntry(entry) as ModelResult['model'],
      status: abortReason === undefined ? 'complete' : 'aborted',
      ...(abortReason !== undefined && { abortReason }),
      startedAt: new Date(startedMs).toISOString(),
      endedAt: new Date(endedMs).toISOString(),
      wallClockMs: endedMs - startedMs,
      cases: results,
    };
  };

  const results = new Array<ModelResult>(lineup.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < lineup.length) {
      const index = cursor++;
      const entry = lineup[index];
      if (entry === undefined) return;
      const result = await runModel(entry);
      results[index] = result;
      options.onModel?.(result);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(options.concurrency, lineup.length)) }, worker),
  );
  return results;
}

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionResponse } from '@mtg/shared';
import { decide as heuristicDecide, Rng } from '@mtg/bot';
import { OpenAiCompatibleClient, type AiNetworkAttempt, type CallMeta } from '../ai/client';
import { configForRole, type AiConfig } from '../ai/config';
import { assemblePrompt, type OpenAiMessage } from '../ai/context';
import { RequestQueue } from '../ai/queue';
import { assembleStrategistPrompt } from '../ai/strategy-context';
import type { StrategyContextVersion } from '../ai/strategy-context';
import { tryHeuristic } from '../ai/heuristics';
import { extractStateFeatures } from '../ai/state-features';
import { validateResponse } from '../ai/validate';
import { preparePromptForCaching } from '../ai/prompt-cache';
import { JevClient } from '../ai/jev-client';
import { JevActionPolicy, type JevDecisionTrace, type JevTacticalPolicy } from '../ai/jev-policy';
import type { BenchmarkCase, BenchmarkMode, BenchmarkResult } from './contracts';
import { scoreResponse, semanticDecisionKey } from './score';

export interface EvaluationOptions {
  runId: string;
  variantId: string;
  mode: BenchmarkMode;
  trials: number;
  outputDirectory: string;
  spendCapUsd: number | null;
  maxAttempts: number;
  concurrency: number;
  strategyContextVersion?: StrategyContextVersion;
  tacticianPromptVersion?: 'legacy-v1' | 'decision-shaped-v2';
  tacticianPolicy?: 'chat' | 'jev';
  /** Runtime-only secret; never written to a manifest. */
  jevApiKey?: string;
  /** Test seam for deterministic adapter coverage without a provider request. */
  jevPolicyFactory?: (onTrace: (trace: JevDecisionTrace) => void) => JevTacticalPolicy;
}

interface Answer {
  response: DecisionResponse;
  meta?: CallMeta;
  source: BenchmarkResult['source'];
  recovered: boolean;
}

function noScore(): BenchmarkResult['score'] {
  return { labelStatus: 'unscored', metrics: {} };
}

export async function evaluateCases(
  cases: readonly BenchmarkCase[],
  config: AiConfig,
  options: EvaluationOptions,
): Promise<{
  resultsPath: string;
  attemptsPath: string;
  jevTracesPath: string;
  results: BenchmarkResult[];
  attempts: AiNetworkAttempt[];
  jevTraces: JevDecisionTrace[];
}> {
  mkdirSync(options.outputDirectory, { recursive: true });
  const resultsPath = join(options.outputDirectory, 'results.jsonl');
  const attemptsPath = join(options.outputDirectory, 'attempts.jsonl');
  const jevTracesPath = join(options.outputDirectory, 'jev-traces.jsonl');
  writeFileSync(resultsPath, '', { flag: 'wx' });
  writeFileSync(attemptsPath, '', { flag: 'wx' });
  writeFileSync(jevTracesPath, '', { flag: 'wx' });
  const results: BenchmarkResult[] = [];
  const capturedAttempts: AiNetworkAttempt[] = [];
  const jevTraces: JevDecisionTrace[] = [];
  let attempts = 0;
  let knownSpend = 0;
  const queue = new RequestQueue({ rpmLimit: config.rpmLimit, concurrency: options.concurrency });
  if (
    options.tacticianPolicy === 'jev' &&
    options.mode === 'production' &&
    (config.jevMinConfidence === null || config.jevMinTopTwoMargin === null)
  ) {
    throw new Error('Production Jev evaluation requires explicit confidence and margin thresholds');
  }

  const recordAttempt = (attempt: AiNetworkAttempt): void => {
    capturedAttempts.push(attempt);
    attempts++;
    if (attempts > options.maxAttempts)
      throw new Error(`maximum attempt budget ${options.maxAttempts} exceeded`);
    if (attempt.usage.costUsd !== undefined) knownSpend += attempt.usage.costUsd;
    if (options.spendCapUsd !== null && knownSpend > options.spendCapUsd) {
      throw new Error(`known spend cap $${options.spendCapUsd.toFixed(4)} exceeded`);
    }
    appendFileSync(attemptsPath, `${JSON.stringify(attempt)}\n`, 'utf8');
  };
  const recordJevTrace = (trace: JevDecisionTrace): void => {
    jevTraces.push(trace);
    appendFileSync(jevTracesPath, `${JSON.stringify(trace)}\n`, 'utf8');
  };

  const jobs = cases.flatMap((caseValue) =>
    Array.from({ length: options.trials }, (_, trial) => ({ caseValue, trial: trial + 1 })),
  );
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      if (job === undefined) return;
      const { caseValue, trial } = job;
      const roleConfig = configForRole(config, caseValue.role);
      const client = new OpenAiCompatibleClient(roleConfig);
      const recordJobAttempt = (attempt: AiNetworkAttempt): void =>
        recordAttempt({
          ...attempt,
          benchmark: {
            runId: options.runId,
            variantId: options.variantId,
            caseId: caseValue.caseId,
            trial,
            role: caseValue.role,
            mode: options.mode,
          },
        });
      client.setAttemptObserver(recordJobAttempt);
      const startedMs = Date.now();
      const startedAt = new Date(startedMs).toISOString();
      let answer: Answer | undefined;
      let failure: string | undefined;
      let rawJsonValidity = false;
      let schemaValidity = false;
      let menuValidation: boolean | 'not_applicable' =
        caseValue.role === 'tactician' ? false : 'not_applicable';
      let skipChat = false;

      try {
        if (options.mode === 'production' && caseValue.role === 'tactician') {
          const local = tryHeuristic(caseValue.input.request, caseValue.input.view);
          if (local !== null) answer = { response: local, source: 'heuristic', recovered: false };
        }

        if (
          answer === undefined &&
          caseValue.role === 'tactician' &&
          options.tacticianPolicy === 'jev'
        ) {
          const jevPolicy =
            options.jevPolicyFactory?.(recordJevTrace) ??
            new JevActionPolicy(
              new JevClient(
                {
                  apiKey: options.jevApiKey ?? '',
                  baseUrl: 'https://openrouter.ai/api/v1',
                  requestTimeoutMs: roleConfig.jevRequestTimeoutMs,
                },
                undefined,
                recordJobAttempt,
              ),
              queue,
              {
                model: roleConfig.jevModel,
                minConfidence: options.mode === 'raw' ? 0 : (roleConfig.jevMinConfidence ?? 1),
                minTopTwoMargin: options.mode === 'raw' ? 0 : (roleConfig.jevMinTopTwoMargin ?? 1),
                maxActions: roleConfig.jevMaxActions,
                mode: 'active',
                onTrace: recordJevTrace,
              },
            );
          if (options.jevPolicyFactory === undefined && (options.jevApiKey ?? '').length === 0) {
            throw new Error('Jev benchmark requires AI_JEV_API_KEY or OPENROUTER_API_KEY');
          }
          const outcome = await jevPolicy.decide(
            caseValue.input.request,
            caseValue.input.view,
            caseValue.input.guidance,
          );
          if (outcome.kind === 'answered') {
            answer = {
              response: outcome.response,
              meta: outcome.meta,
              source: 'jev',
              recovered: false,
            };
            rawJsonValidity = true;
            schemaValidity = true;
            menuValidation = true;
          } else if (options.mode === 'raw') {
            failure = `Jev fallthrough: ${outcome.reason} (${outcome.detail})`;
            skipChat = true;
          }
        }

        if (answer === undefined && !skipChat) {
          const assembledPrompt =
            caseValue.role === 'tactician'
              ? assemblePrompt(
                  caseValue.input.request,
                  caseValue.input.view,
                  caseValue.input.guidance,
                  {
                    includeMemory: roleConfig.contextMemoryEnabled,
                    includeFeatures: roleConfig.contextFeaturesEnabled,
                    useBudgeter: roleConfig.contextBudgeterEnabled,
                    useCardSummaries: roleConfig.contextCardSummariesEnabled,
                    inputTokenBudget: roleConfig.contextInputTokenBudget,
                    useLegacyTacticianPrimer: options.tacticianPromptVersion === 'legacy-v1',
                    ...(roleConfig.contextFeaturesEnabled
                      ? {
                          stateFeatures: extractStateFeatures(
                            caseValue.input.request,
                            caseValue.input.view,
                          ),
                        }
                      : {}),
                    ...(roleConfig.contextMemoryEnabled &&
                    caseValue.input.guidance.publicMemory !== undefined
                      ? { publicMemory: caseValue.input.guidance.publicMemory }
                      : {}),
                  },
                )
              : assembleStrategistPrompt(
                  caseValue.input.request,
                  caseValue.input.view,
                  caseValue.input.recentDecisions,
                  caseValue.input.deckArchetype,
                  {
                    ...(options.strategyContextVersion === undefined
                      ? {}
                      : { version: options.strategyContextVersion }),
                    ...(caseValue.input.profile === undefined
                      ? {}
                      : { profile: caseValue.input.profile }),
                    context: {
                      includeMemory: roleConfig.contextMemoryEnabled,
                      includeFeatures: roleConfig.contextFeaturesEnabled,
                      useBudgeter: roleConfig.contextBudgeterEnabled,
                      useCardSummaries: roleConfig.contextCardSummariesEnabled,
                      inputTokenBudget: roleConfig.contextInputTokenBudget,
                      ...(roleConfig.contextFeaturesEnabled
                        ? {
                            stateFeatures: extractStateFeatures(
                              caseValue.input.request,
                              caseValue.input.view,
                            ),
                          }
                        : {}),
                      ...(roleConfig.contextMemoryEnabled &&
                      caseValue.input.publicMemory !== undefined
                        ? { publicMemory: caseValue.input.publicMemory }
                        : {}),
                    },
                  },
                );
          const prompt = roleConfig.providerPromptCacheLayoutEnabled
            ? preparePromptForCaching(assembledPrompt, {
                role: caseValue.role,
                ...(caseValue.role === 'strategist' && caseValue.input.profile !== undefined
                  ? { staticContext: { yourStrategyProfile: caseValue.input.profile } }
                  : {}),
                ...(caseValue.role === 'strategist'
                  ? { removeDynamicKeys: ['yourStrategyProfile'] }
                  : {}),
              })
            : assembledPrompt;
          const first = await queue.enqueue(() =>
            client.requestDecision(prompt, caseValue.input.request),
          );
          rawJsonValidity = true;
          schemaValidity = true;
          const validation =
            caseValue.role === 'tactician'
              ? validateResponse(first.response, caseValue.input.request)
              : null;
          menuValidation = caseValue.role === 'tactician' ? validation === null : 'not_applicable';
          if (validation === null || options.mode === 'raw') {
            answer = {
              response: first.response,
              meta: first.meta,
              source: 'model',
              recovered: false,
            };
          } else {
            const correctiveMessages: OpenAiMessage[] = [
              ...prompt.messages,
              { role: 'assistant', content: first.meta.rawResponse },
              {
                role: 'user',
                content: `Validation error: ${validation}. Return a legal actionId only.`,
              },
            ];
            const retry = await queue.enqueue(() =>
              client.requestDecision(
                { messages: correctiveMessages, estimatedTokens: prompt.estimatedTokens },
                caseValue.input.request,
              ),
            );
            const retryValidation = validateResponse(retry.response, caseValue.input.request);
            menuValidation = retryValidation === null;
            if (retryValidation === null) {
              answer = {
                response: retry.response,
                meta: retry.meta,
                source: 'model',
                recovered: true,
              };
            }
          }
        }

        if (
          answer === undefined &&
          options.mode === 'production' &&
          caseValue.role === 'tactician'
        ) {
          answer = {
            response: heuristicDecide(
              caseValue.input.request,
              caseValue.input.view,
              new Rng(caseValue.caseId),
            ),
            source: 'fallback',
            recovered: true,
          };
          menuValidation = true;
        }
      } catch (error) {
        rawJsonValidity = false;
        failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }

      const endedMs = Date.now();
      const result: BenchmarkResult = {
        schemaVersion: 1,
        runId: options.runId,
        variantId: options.variantId,
        caseId: caseValue.caseId,
        trial,
        role: caseValue.role,
        mode: options.mode,
        source: answer?.source ?? 'error',
        rawJsonValidity,
        schemaValidity,
        recoverySuccess: answer?.recovered ?? false,
        menuValidation,
        engineAcceptance: 'not_checked',
        ...(answer !== undefined
          ? { semanticDecision: semanticDecisionKey(answer.response), response: answer.response }
          : {}),
        score: answer === undefined ? noScore() : scoreResponse(caseValue, answer.response),
        startedAt,
        endedAt: new Date(endedMs).toISOString(),
        endToEndMs: endedMs - startedMs,
        ...(answer?.meta !== undefined
          ? {
              promptTokens: answer.meta.promptTokens,
              responseTokens: answer.meta.responseTokens,
              ...(answer.meta.costUsd !== undefined ? { costUsd: answer.meta.costUsd } : {}),
            }
          : {}),
        costSource:
          answer?.meta?.costSource ??
          (answer?.source === 'heuristic' ? 'not_applicable' : 'unknown'),
        ...(failure !== undefined ? { failure } : {}),
      };
      results.push(result);
      appendFileSync(resultsPath, `${JSON.stringify(result)}\n`, 'utf8');
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, () => worker()));
  return {
    resultsPath,
    attemptsPath,
    jevTracesPath,
    results,
    attempts: capturedAttempts,
    jevTraces,
  };
}

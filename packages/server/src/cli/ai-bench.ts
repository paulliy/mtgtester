import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { decide as heuristicDecide, Rng } from '@mtg/bot';
import type { GameConfig } from '@mtg/engine';
import type { DecisionResponse, PlayerId, TurnStrategy } from '@mtg/shared';
import { captureCase } from '../benchmark/capture';
import { assertFixtureCompatibility, loadSuite } from '../benchmark/cases';
import { evaluateCases } from '../benchmark/eval';
import { createRunManifest, defaultRunDirectory, writeManifest } from '../benchmark/manifest';
import { buildReport, readAttemptsJsonl, readResultsJsonl } from '../benchmark/report';
import {
  captureReplayTranscript,
  replayTranscript,
  runTurnHarness,
  type ObservationPolicy,
  type ReplayTranscript,
  type TurnHarnessMode,
} from '../benchmark/replay';
import { loadAiConfig, type AiConfig } from '../ai/config';
import type { StrategyContextVersion } from '../ai/strategy-context';
import { evaluateCounterfactual, type CounterfactualHorizon } from '../benchmark/counterfactual';
import { buildCacheExperimentReports } from '../benchmark/cache-experiment';
import { runControlledLeague, type LeaguePolicyFactory } from '../benchmark/league';
import { evaluatePromotion, parseReleasePolicy } from '../benchmark/promotion';
import { formatRefreshReport, refreshCaseCompatibility } from '../benchmark/refresh';
import type { VariantReport } from '../benchmark/report';
import { confinedBenchmarkPath } from '../benchmark/paths';

type Flags = Record<string, string | boolean>;

function flags(values: string[]): Flags {
  const result: Flags = {};
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = values[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      i++;
    } else result[key] = true;
  }
  return result;
}

function textFlag(input: Flags, key: string, fallback?: string): string {
  const value = input[key];
  if (typeof value === 'string') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${key}`);
}

function intFlag(input: Flags, key: string, fallback: number): number {
  const value = input[key];
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be positive`);
  return parsed;
}

function nonNegativeIntFlag(input: Flags, key: string, fallback: number): number {
  const value = input[key];
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('--' + key + ' must be non-negative');
  return parsed;
}

function numberFlag(input: Flags, key: string, fallback: number): number {
  const value = input[key];
  if (typeof value !== 'string') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('--' + key + ' must be a number');
  return parsed;
}

function requiredBooleanFlag(input: Flags, key: string): boolean {
  const value = input[key];
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${key} must be explicitly true or false`);
}

function requiredNonNegativeIntFlag(input: Flags, key: string): number {
  if (typeof input[key] !== 'string') throw new Error(`missing --${key}`);
  return nonNegativeIntFlag(input, key, 0);
}

function pathFrom(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

interface VariantFile {
  schemaVersion: 1;
  description: string;
  env?: Record<string, string>;
  strategyContextVersion?: StrategyContextVersion;
  tacticianPromptVersion?: 'legacy-v1' | 'decision-shaped-v2';
}

function loadVariant(
  root: string,
  id: string,
): {
  config: AiConfig;
  context?: StrategyContextVersion;
  tacticianPromptVersion?: 'legacy-v1' | 'decision-shaped-v2';
} {
  if (id === 'current') return { config: loadAiConfig(process.env), context: 'v2' };
  const path = confinedBenchmarkPath(
    root,
    join('benchmarks', 'variants', `${id}.json`),
    'variants',
  );
  const variant = JSON.parse(readFileSync(path, 'utf8')) as VariantFile;
  if (variant.schemaVersion !== 1) throw new Error(`unsupported variant schema: ${id}`);
  const env = { ...process.env, ...(variant.env ?? {}) };
  const loaded = { config: loadAiConfig(env) } as {
    config: AiConfig;
    context?: StrategyContextVersion;
    tacticianPromptVersion?: 'legacy-v1' | 'decision-shaped-v2';
  };
  if (variant.strategyContextVersion !== undefined) loaded.context = variant.strategyContextVersion;
  if (variant.tacticianPromptVersion !== undefined) {
    loaded.tacticianPromptVersion = variant.tacticianPromptVersion;
  }
  return loaded;
}

function resolveSuite(root: string, value: string): string {
  const candidate = existsSync(pathFrom(root, value))
    ? value
    : join('benchmarks', 'suites', `${value}.json`);
  return confinedBenchmarkPath(root, candidate, 'suites');
}

function capture(root: string, input: Flags): void {
  const manifestPath = input['manifest'];
  if (typeof manifestPath === 'string') {
    const manifest = JSON.parse(readFileSync(pathFrom(root, manifestPath), 'utf8')) as {
      captures: Array<{ input: string; output: string }>;
    };
    for (const item of manifest.captures) {
      const source = JSON.parse(readFileSync(pathFrom(root, item.input), 'utf8')) as unknown;
      captureCase(source, confinedBenchmarkPath(root, item.output, 'benchmarks'), {
        repositoryRoot: root,
      });
    }
    return;
  }
  const source = JSON.parse(
    readFileSync(pathFrom(root, textFlag(input, 'input')), 'utf8'),
  ) as unknown;
  captureCase(source, pathFrom(root, textFlag(input, 'output')), { repositoryRoot: root });
}

async function evaluate(root: string, input: Flags): Promise<void> {
  const role = textFlag(input, 'role') as 'tactician' | 'strategist';
  if (role !== 'tactician' && role !== 'strategist')
    throw new Error('--role must be tactician or strategist');
  const mode = textFlag(input, 'mode', 'raw') as 'raw' | 'production';
  if (mode !== 'raw' && mode !== 'production') throw new Error('--mode must be raw or production');
  const suitePath = resolveSuite(root, textFlag(input, 'suite'));
  const loaded = loadSuite(suitePath);
  const selected = loaded.cases.filter((item) => item.role === role);
  if (selected.length === 0) throw new Error(`suite ${loaded.suite.suiteId} has no ${role} cases`);
  const trials = intFlag(input, 'trials', 3);
  const concurrency = intFlag(input, 'concurrency', 1);
  const maxAttempts = intFlag(input, 'max-attempts', selected.length * trials * 4);
  const spendCap = typeof input['spend-cap'] === 'string' ? Number(input['spend-cap']) : null;
  const variants = textFlag(input, 'variants', textFlag(input, 'variant', 'current')).split(',');
  const tacticianPolicy = textFlag(input, 'tactician-policy', 'chat') as 'chat' | 'jev';
  if (tacticianPolicy !== 'chat' && tacticianPolicy !== 'jev') {
    throw new Error('--tactician-policy must be chat or jev');
  }

  for (const variantId of variants) {
    const variant = loadVariant(root, variantId);
    const roleConfig = {
      ...variant.config,
      requestTimeoutMs: intFlag(input, 'timeout', variant.config.requestTimeoutMs),
    };
    const manifest = createRunManifest({
      repositoryRoot: root,
      variantId,
      baselineId:
        role === 'strategist' ? 'baseline-current-strategist-v1' : 'baseline-current-tactician-v1',
      role,
      mode,
      trials,
      suiteId: loaded.suite.suiteId,
      suiteValue: loaded.suite,
      cases: selected,
      config: roleConfig,
      spendCapUsd: spendCap,
      maxAttempts,
      concurrency,
      timeoutMs: roleConfig.requestTimeoutMs,
      ...(variant.tacticianPromptVersion === undefined
        ? {}
        : { tacticianPromptVersion: variant.tacticianPromptVersion }),
    });
    const outputBase =
      typeof input['output'] === 'string'
        ? pathFrom(root, input['output'])
        : defaultRunDirectory(root, manifest);
    const outputDirectory = variants.length > 1 ? join(outputBase, variantId) : outputBase;
    assertFixtureCompatibility(selected, {
      engine: manifest.hashes.engine,
      cardDefinitions: manifest.hashes.cardDefinitions,
    });
    writeManifest(join(outputDirectory, 'manifest.json'), manifest);
    const evaluated = await evaluateCases(selected, roleConfig, {
      runId: manifest.runId,
      variantId,
      mode,
      trials,
      outputDirectory,
      spendCapUsd: spendCap,
      maxAttempts,
      concurrency,
      tacticianPolicy,
      tacticianPromptVersion: variant.tacticianPromptVersion ?? 'decision-shaped-v2',
      ...(tacticianPolicy === 'jev'
        ? {
            jevApiKey: process.env['AI_JEV_API_KEY'] ?? process.env['OPENROUTER_API_KEY'] ?? '',
          }
        : {}),
      ...(variant.context === undefined ? {} : { strategyContextVersion: variant.context }),
    });
    const report = buildReport(evaluated.results, evaluated.attempts);
    writeFileSync(join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
    });
    console.log(`${variantId}: ${evaluated.resultsPath}`);
  }
}

function report(root: string, input: Flags): void {
  const paths = textFlag(input, 'runs')
    .split(',')
    .map((value) => pathFrom(root, value))
    .map((value) => (value.endsWith('.jsonl') ? value : join(value, 'results.jsonl')));
  const attempts = paths.flatMap((path) =>
    readAttemptsJsonl(join(resolve(path, '..'), 'attempts.jsonl')),
  );
  const reportValue = buildReport(paths.flatMap(readResultsJsonl), attempts);
  console.log(JSON.stringify(reportValue, null, 2));
}

function heuristicPolicies(
  seed: string,
  onDecision?: () => void,
): (seat: PlayerId) => ObservationPolicy {
  const rngs = new Map<PlayerId, Rng>();
  return (seat) => (request, view) => {
    onDecision?.();
    let rng = rngs.get(seat);
    if (rng === undefined) {
      rng = new Rng(seed + ':' + seat);
      rngs.set(seat, rng);
    }
    return heuristicDecide(request, view, rng);
  };
}

async function replay(root: string, input: Flags): Promise<void> {
  if (typeof input['config'] === 'string') {
    const config = JSON.parse(readFileSync(pathFrom(root, input['config']), 'utf8')) as GameConfig;
    const transcript = await captureReplayTranscript(
      config,
      heuristicPolicies(config.seed + ':replay-capture'),
      {
        maxDecisions: intFlag(input, 'max-decisions', 100_000),
        maxTransitions: intFlag(input, 'max-transitions', 1_000_000),
      },
    );
    const output = pathFrom(root, textFlag(input, 'output'));
    writeFileSync(output, JSON.stringify(transcript, null, 2) + '\n', { flag: 'wx' });
    console.log(output);
    return;
  }
  const transcript = JSON.parse(
    readFileSync(pathFrom(root, textFlag(input, 'input')), 'utf8'),
  ) as ReplayTranscript;
  console.log(JSON.stringify(replayTranscript(transcript), null, 2));
}

async function turn(root: string, input: Flags): Promise<void> {
  const transcript = JSON.parse(
    readFileSync(pathFrom(root, textFlag(input, 'input')), 'utf8'),
  ) as ReplayTranscript;
  const strategy = JSON.parse(
    readFileSync(pathFrom(root, textFlag(input, 'strategy')), 'utf8'),
  ) as TurnStrategy;
  const mode = textFlag(input, 'mode', 'ready') as TurnHarnessMode;
  if (mode !== 'ready' && mode !== 'asynchronous')
    throw new Error('--mode must be ready or asynchronous');
  const actingSeat = textFlag(input, 'seat') as PlayerId;
  const arrivalDecisions = nonNegativeIntFlag(input, 'arrival-decisions', 0);
  let seen = 0;
  let release: ((value: TurnStrategy) => void) | undefined;
  const delayed = new Promise<TurnStrategy>((resolvePromise) => {
    release = resolvePromise;
  });
  if (arrivalDecisions === 0) release?.(strategy);
  const policies = heuristicPolicies(transcript.seed + ':turn', () => {
    seen++;
    if (seen >= arrivalDecisions) release?.(strategy);
  });
  const metrics = await runTurnHarness({
    transcript,
    forkDecisionIndex: nonNegativeIntFlag(input, 'fork', 0),
    mode,
    actingSeat,
    policyFor: policies,
    ...(mode === 'ready' ? { strategy } : { strategyFactory: () => delayed }),
    maxTransitions: intFlag(input, 'max-transitions', 20_000),
  });
  const rendered = JSON.stringify(metrics, null, 2) + '\n';
  if (typeof input['output'] === 'string') {
    writeFileSync(pathFrom(root, input['output']), rendered, { flag: 'wx' });
  } else console.log(rendered);
}

async function counterfactual(root: string, input: Flags): Promise<void> {
  const transcript = JSON.parse(
    readFileSync(pathFrom(root, textFlag(input, 'input')), 'utf8'),
  ) as ReplayTranscript;
  const candidateResponse = JSON.parse(
    readFileSync(pathFrom(root, textFlag(input, 'candidate')), 'utf8'),
  ) as DecisionResponse;
  const baselineResponse = JSON.parse(
    readFileSync(pathFrom(root, textFlag(input, 'baseline')), 'utf8'),
  ) as DecisionResponse;
  const horizonKind = textFlag(
    input,
    'horizon',
    'end_of_active_turn',
  ) as CounterfactualHorizon['kind'];
  if (!['end_of_active_turn', 'stack_resolved', 'end_of_combat'].includes(horizonKind)) {
    throw new Error('--horizon must be end_of_active_turn, stack_resolved, or end_of_combat');
  }
  const policySeed = transcript.seed + ':counterfactual';
  const result = await evaluateCounterfactual({
    transcript,
    forkDecisionIndex: nonNegativeIntFlag(input, 'fork', 0),
    actor: textFlag(input, 'seat') as PlayerId,
    candidateResponse,
    baselineResponse,
    policies: {
      policyId: 'seeded-heuristic-v1',
      rngPolicyId: 'independent-branch-streams-same-seed-v1',
      policyFor: () => heuristicPolicies(policySeed),
    },
    horizon: { kind: horizonKind },
    maxTransitions: intFlag(input, 'max-transitions', 20_000),
    epsilon: numberFlag(input, 'epsilon', 1),
  });
  const rendered = JSON.stringify(result, null, 2) + '\n';
  if (typeof input['output'] === 'string') {
    writeFileSync(pathFrom(root, input['output']), rendered, { flag: 'wx' });
  } else console.log(rendered);
}

function cacheReport(root: string, input: Flags): void {
  const attempts = readAttemptsJsonl(pathFrom(root, textFlag(input, 'attempts')));
  console.log(JSON.stringify(buildCacheExperimentReports(attempts), null, 2));
}

function promotion(root: string, input: Flags): void {
  const policy = parseReleasePolicy(
    JSON.parse(readFileSync(pathFrom(root, textFlag(input, 'policy')), 'utf8')),
  );
  const loadReport = (key: string): VariantReport => {
    const value = JSON.parse(readFileSync(pathFrom(root, textFlag(input, key)), 'utf8')) as
      VariantReport | VariantReport[];
    const reportValue = Array.isArray(value) ? value[0] : value;
    if (reportValue === undefined) throw new Error(`--${key} contains no report`);
    return reportValue;
  };
  const result = evaluatePromotion(policy, {
    baseline: loadReport('baseline'),
    candidate: loadReport('candidate'),
    newConfirmedCriticalBlunders: requiredNonNegativeIntFlag(input, 'critical-blunders'),
    comparableWorkload: requiredBooleanFlag(input, 'comparable-workload'),
    deterministicGatesPassed: requiredBooleanFlag(input, 'deterministic-gates-passed'),
    hiddenInformationLeaks: requiredNonNegativeIntFlag(input, 'privacy-leaks'),
    engineAcceptedIllegalActions: requiredNonNegativeIntFlag(input, 'illegal-actions'),
    ...(typeof input['active-turn-cost'] === 'string'
      ? { candidateActiveTurnCostUsd: numberFlag(input, 'active-turn-cost', 0) }
      : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  if (input['require-pass'] === true && !result.defaultMayChange) {
    throw new Error(`promotion gate ${result.verdict}: ${result.reasons.join('; ')}`);
  }
}

async function league(root: string, input: Flags): Promise<void> {
  const config = JSON.parse(
    readFileSync(pathFrom(root, textFlag(input, 'config')), 'utf8'),
  ) as GameConfig;
  const factory: LeaguePolicyFactory = ({ seat, seed, role }) => {
    const rng = new Rng(`${seed}:league:${role}:${seat}`);
    return {
      decide: (request, view) => heuristicDecide(request, view, rng),
      telemetry: () => ({ knownCostUsd: 0, costKnown: true }),
    };
  };
  const result = await runControlledLeague({
    scenarios: [{ scenarioId: textFlag(input, 'scenario', config.gameId), config }],
    candidateFactory: factory,
    opponentFactory: factory,
    includeAllCandidateTables: input['all-candidate'] === true,
    maxTransitions: intFlag(input, 'max-transitions', 1_000_000),
  });
  const rendered = JSON.stringify(result, null, 2) + '\n';
  if (typeof input['output'] === 'string') {
    writeFileSync(pathFrom(root, input['output']), rendered, { flag: 'wx' });
  } else console.log(rendered);
}

/**
 * Re-pin existing snapshots to the current engine and card-definition hashes. Dry run by default:
 * it prints every old-to-new value and writes nothing unless --write is passed.
 */
function refresh(root: string, input: Flags): void {
  const casePaths: string[] = [];
  const single = input['case'];
  if (typeof single === 'string') casePaths.push(confinedBenchmarkPath(root, single, 'benchmarks'));
  const suite = input['suite'];
  if (typeof suite === 'string') {
    const suitePath = resolveSuite(root, suite);
    // Read the suite directly: loadSuite validates content hashes, which is precisely what a
    // stale fixture fails, so it cannot be used to find the files that need re-pinning.
    const parsed = JSON.parse(readFileSync(suitePath, 'utf8')) as { caseFiles?: unknown };
    if (!Array.isArray(parsed.caseFiles)) throw new Error('invalid benchmark suite ' + suitePath);
    for (const file of parsed.caseFiles) {
      if (typeof file !== 'string') throw new Error('invalid caseFiles entry in ' + suitePath);
      casePaths.push(
        confinedBenchmarkPath(root, file, 'benchmarks', {
          origin: dirname(suitePath),
          relativeOnly: true,
        }),
      );
    }
  }
  if (casePaths.length === 0) throw new Error('refresh requires --suite <id> or --case <path>');

  const report = refreshCaseCompatibility({
    repositoryRoot: root,
    casePaths,
    write: input['write'] === true,
  });
  console.log(formatRefreshReport(report));
}

async function main(): Promise<void> {
  const root = process.cwd();
  const command = process.argv[2];
  const input = flags(process.argv.slice(3));
  if (command === 'capture') capture(root, input);
  else if (command === 'eval') await evaluate(root, input);
  else if (command === 'report') report(root, input);
  else if (command === 'replay') await replay(root, input);
  else if (command === 'turn') await turn(root, input);
  else if (command === 'counterfactual') await counterfactual(root, input);
  else if (command === 'cache-report') cacheReport(root, input);
  else if (command === 'promote') promotion(root, input);
  else if (command === 'league') await league(root, input);
  else if (command === 'refresh') refresh(root, input);
  else {
    throw new Error(
      'usage: ai-bench <capture|eval|report|replay|turn|counterfactual|cache-report|promote|league|refresh> [options]',
    );
  }
}

await main();

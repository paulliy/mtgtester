/**
 * `bun run bot-bench <command>`: list and inspect cases, check references against the engine,
 * run a lineup of models, build the judge bundle, and collate the scorecards that come back.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describeScenarioRequest } from '../../packages/engine/src';
import { analyzeCase } from './analysis';
import {
  benchFingerprint,
  newManifest,
  readRun,
  writeBundle,
  writeModelResult,
  type RunManifest,
} from './bundle';
import { loadCases, type BenchCase } from './case';
import { collate, parseScorecard } from './collate';
import { modelMetrics } from './metrics';
import {
  loadLineupFile,
  parseModelList,
  resolveLlmConfig,
  type LineupEntry,
  type RunMode,
} from './models';
import { dollars, milliseconds, percent } from './report';
import { runLineup, type TranscriptEntry } from './run';
import { verifyCase } from './verify';

type Flags = Record<string, string | true>;

function parseArguments(values: readonly string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[value.slice(2)] = next;
      index += 1;
    } else {
      flags[value.slice(2)] = true;
    }
  }
  return { positional, flags };
}

function text(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function positive(flags: Flags, key: string, fallback: number): number {
  const value = text(flags, key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`--${key} must be a positive number`);
  return parsed;
}

function selectCases(flags: Flags): BenchCase[] {
  let cases = loadCases();
  const scope = text(flags, 'scope');
  if (scope !== undefined) {
    if (scope !== 'single' && scope !== 'turn') throw new Error('--scope must be single or turn');
    cases = cases.filter((benchCase) => benchCase.scope === scope);
  }
  const ids = text(flags, 'cases');
  if (ids !== undefined) {
    const wanted = ids.split(',').map((id) => id.trim());
    for (const id of wanted)
      if (!cases.some((benchCase) => benchCase.id === id)) throw new Error(`no case "${id}"`);
    cases = cases.filter((benchCase) => wanted.includes(benchCase.id));
  }
  if (cases.length === 0) throw new Error('no cases selected');
  return cases;
}

function gitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function listCases(): void {
  for (const benchCase of loadCases())
    console.log(
      `${benchCase.scope.padEnd(6)} ${benchCase.id.padEnd(34)} ${benchCase.title}  [${benchCase.skills.join(', ')}]`,
    );
}

async function inspect(id: string | undefined, flags: Flags): Promise<void> {
  const benchCase = loadCases().find((candidate) => candidate.id === id);
  if (benchCase === undefined) throw new Error(`inspect needs a case id; see "bot-bench list"`);
  const analysis = await analyzeCase(benchCase);
  console.log(`${benchCase.id}: ${benchCase.title}\n`);
  console.log(describeScenarioRequest(analysis.focus.request));
  if (analysis.scope === 'single') {
    console.log(
      `\n${analysis.options.length} distinct legal answers${analysis.exhaustive ? '' : ' (not exhaustive)'}:`,
    );
    for (const option of analysis.options) {
      console.log(
        `\n[${option.graded.grade}] ${option.action}${option.legal ? '' : '  (REFUSED BY ENGINE)'}\n    reference: ${option.graded.label}`,
      );
      for (const change of option.changes) console.log(`    ${change}`);
      if (flags['log'] === true) for (const line of option.log) console.log(`      | ${line}`);
    }
  } else {
    for (const line of analysis.lines) {
      console.log(
        `\n[${line.line.grade}] ${line.line.label}: ${percent(line.score.score)} (${line.termination})`,
      );
      console.log(`    ${line.actions.join(' → ')}`);
      for (const change of line.changes) console.log(`    ${change}`);
      for (const objective of line.score.objectives ?? [])
        console.log(`    ${objective.met ? 'met ' : 'MISS'} ${objective.label}`);
      if (flags['log'] === true) for (const entry of line.log) console.log(`      | ${entry}`);
    }
  }
  const problems = await verifyCase(benchCase);
  console.log(
    problems.length === 0 ? '\nreference holds' : `\nPROBLEMS:\n- ${problems.join('\n- ')}`,
  );
}

async function verify(flags: Flags): Promise<void> {
  let failed = 0;
  for (const benchCase of selectCases(flags)) {
    const problems = await verifyCase(benchCase);
    console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${benchCase.id}`);
    for (const problem of problems) console.log(`       ${problem}`);
    if (problems.length > 0) failed += 1;
  }
  if (failed > 0) throw new Error(`${failed} case(s) have a reference the engine disagrees with`);
}

function printLeaderboard(runDirectory: string, cases: readonly BenchCase[]): void {
  const run = readRun(runDirectory);
  const selected = cases.filter((benchCase) => run.manifest.caseIds.includes(benchCase.id));
  console.log(
    '\nmodel                                    accuracy  median     p90        cost/decision',
  );
  for (const model of run.models) {
    const metrics = modelMetrics(model, selected, run.manifest.trials);
    console.log(
      `${model.model.label.slice(0, 40).padEnd(40)} ${percent(metrics.accuracy.overall).padEnd(9)} ${milliseconds(metrics.speed.p50Ms).padEnd(10)} ${milliseconds(metrics.speed.p90Ms).padEnd(10)} ${dollars(metrics.cost.perDecisionUsd)} (${metrics.cost.source})${model.status === 'aborted' ? `  STOPPED: ${model.abortReason ?? ''}` : ''}`,
    );
  }
}

async function run(flags: Flags): Promise<void> {
  const lineupPath = text(flags, 'lineup');
  const modelList = text(flags, 'models');
  const lineup: LineupEntry[] = [
    ...(lineupPath === undefined ? [] : loadLineupFile(lineupPath)),
    ...(modelList === undefined ? [] : parseModelList(modelList)),
  ];
  if (lineup.length === 0)
    throw new Error(
      'name the models: --models local:heuristic,openrouter:vendor/model or --lineup file.json',
    );
  // Two entries with one id would write to the same result file, and one would be lost.
  const ids = lineup.map((entry) => entry.id);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeated.length > 0)
    throw new Error(
      `model id ${[...new Set(repeated)].join(', ')} appears more than once across --lineup and --models; give each model its own id`,
    );
  const mode = (text(flags, 'mode') ?? 'raw') as RunMode;
  if (mode !== 'raw' && mode !== 'production') throw new Error('--mode must be raw or production');
  const trials = Math.floor(positive(flags, 'trials', 1));
  const cases = selectCases(flags);
  // A missing key is found now, not after the other models have been paid for.
  for (const entry of lineup)
    if (entry.kind === 'llm') resolveLlmConfig(entry, { env: process.env, mode });

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');
  const runDirectory = resolve(text(flags, 'out') ?? join('benchmark-output', 'bot-bench', stamp));
  mkdirSync(runDirectory, { recursive: true });
  const manifestPath = join(runDirectory, 'run.json');
  let manifest: RunManifest;
  if (existsSync(manifestPath)) {
    // Adding models to an earlier run: only comparable if it is the same test.
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest;
    const same =
      manifest.mode === mode &&
      manifest.trials === trials &&
      manifest.caseIds.join(',') === cases.map((benchCase) => benchCase.id).join(',');
    if (!same)
      throw new Error(
        `${runDirectory} holds a run with mode ${manifest.mode}, ${manifest.trials} trial(s) and ${manifest.caseIds.length} cases; use the same settings to add models, or another --out`,
      );
    // The same ids are not the same test: a case, its reference, the primer, the engine or the
    // prompt version may have changed since, and results from both would be judged as one run.
    if (manifest.fingerprint !== benchFingerprint(cases))
      throw new Error(
        `${runDirectory} was measured against different cases, primer, engine or AI versions than this checkout; start a new run (another --out) so the results stay comparable`,
      );
  } else {
    manifest = newManifest(stamp, mode, trials, cases, gitCommit());
  }
  manifest.modelIds = [
    ...manifest.modelIds,
    ...lineup.map((entry) => entry.id).filter((id) => !manifest.modelIds.includes(id)),
  ];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `bot-bench run ${manifest.runId}: ${lineup.length} model(s) × ${cases.length} case(s) × ${trials} trial(s), mode ${mode}`,
  );
  const transcripts = new Map<string, TranscriptEntry[]>();
  const spendCap = text(flags, 'spend-cap');
  await runLineup(cases, lineup, {
    mode,
    trials,
    concurrency: Math.floor(positive(flags, 'concurrency', 4)),
    spendCapUsd: spendCap === undefined ? null : positive(flags, 'spend-cap', 0),
    env: process.env,
    onTranscript: (entry) =>
      transcripts.set(entry.modelId, [...(transcripts.get(entry.modelId) ?? []), entry]),
    onProgress: (line) => console.log(`  ${line}`),
    // Saved as each model finishes: an interrupted run keeps the models that completed.
    onModel: (result) =>
      writeModelResult(runDirectory, result, transcripts.get(result.model.id) ?? []),
  });

  printLeaderboard(runDirectory, cases);
  await bundle({ ...flags, run: runDirectory });
}

async function bundle(flags: Flags): Promise<void> {
  const runDirectory = text(flags, 'run');
  if (runDirectory === undefined) throw new Error('bundle needs --run <run directory>');
  const built = await writeBundle(resolve(runDirectory), loadCases(), {
    blind: flags['reveal-models'] !== true,
  });
  console.log(`\njudge bundle: ${built.files} files, ${Math.round(built.bytes / 1024)} KB`);
  console.log(`  folder  ${built.directory}`);
  console.log(`  zip     ${built.zipPath}   <- send this to the judges`);
  if (built.keyPath !== null)
    console.log(
      `  key     ${built.keyPath}   <- which alias is which model; keep it, do not send it`,
    );
}

function collateCommand(positional: readonly string[], flags: Flags): void {
  const runDirectory = text(flags, 'run');
  if (runDirectory === undefined || positional.length === 0)
    throw new Error('collate needs --run <run directory> and one or more scorecard files');
  const { manifest } = readRun(resolve(runDirectory));
  const cards = positional.map((path) =>
    parseScorecard(JSON.parse(readFileSync(path, 'utf8')), path, manifest.runId),
  );
  const page = collate(resolve(runDirectory), cards);
  const target = join(resolve(runDirectory), 'judges.md');
  writeFileSync(target, page);
  console.log(page);
  console.log(`written to ${target}`);
}

const USAGE = `bot-bench: tactician benchmark with a judge bundle

  bun run bot-bench list
  bun run bot-bench inspect <case-id> [--log]       every legal answer or reference line, played by the engine
  bun run bot-bench verify [--scope single|turn]     check every reference against the engine
  bun run bot-bench run --models <list> | --lineup <file.json>
        [--cases id,id] [--scope single|turn] [--trials N] [--mode raw|production]
        [--out <run directory>] [--concurrency N] [--spend-cap <USD>] [--reveal-models]
  bun run bot-bench bundle --run <run directory> [--reveal-models]
  bun run bot-bench collate --run <run directory> <scorecard.json> [...]

  --models   comma separated: local:heuristic, local:first-legal, local:random,
             openrouter:<vendor/model>, groq:<model>, gemini:<model>, deepseek:<model>, openai:<model>;
             add @low, @medium or @high to turn reasoning on
  --out      an existing run directory adds models to that run and rebuilds its bundle
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArguments(rest);
  if (command === 'list') listCases();
  else if (command === 'inspect') await inspect(positional[0], flags);
  else if (command === 'verify') await verify(flags);
  else if (command === 'run') await run(flags);
  else if (command === 'bundle') await bundle(flags);
  else if (command === 'collate') collateCommand(positional, flags);
  else console.log(USAGE);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

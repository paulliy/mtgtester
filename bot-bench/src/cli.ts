/**
 * `bun run bot-bench <command>`: list and inspect cases, check references against the engine,
 * run a lineup of models, build the judge bundle, and collate the scorecards that come back.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { loadCases, parseBenchCase, type BenchCase } from './case';
import { collate, parseScorecard } from './collate';
import { modelMetrics } from './metrics';
import {
  crossLineup,
  liveStrategist,
  loadLineupFile,
  parseModelList,
  resolveDecisionKey,
  resolveBotLedConfig,
  resolveLlmConfig,
  type LineupEntry,
  type RunMode,
} from './models';
import { checkArms, publicArms, renderDuel, runDuel } from './duel';
import { openCase, type CaseRun } from './play';
import { parseStrategistList, resolveStrategistClientConfig } from './strategist';
import { dollars, milliseconds, percent } from './report';
import { runLineup, type TranscriptEntry } from './run';
import { scoreRun } from './score';
import { foldSeeds, seedGate } from './seeds';
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
  const role = text(flags, 'role') ?? 'tactician';
  if (role !== 'tactician' && role !== 'strategist' && role !== 'all')
    throw new Error('--role must be tactician, strategist or all');
  let cases = loadCases(role);
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
  for (const benchCase of loadCases('all'))
    console.log(
      `${(benchCase.role === 'strategist' ? `strategist ${benchCase.turns ?? 1}t` : benchCase.scope).padEnd(13)} ${benchCase.id.padEnd(34)} ${benchCase.title}  [${benchCase.skills.join(', ')}]`,
    );
}

async function inspect(id: string | undefined, flags: Flags): Promise<void> {
  // `--file` reads a draft from anywhere, so a case can be worked on before it joins the set.
  const file = text(flags, 'file');
  const benchCase =
    file === undefined
      ? loadCases('all').find((candidate) => candidate.id === id)
      : parseBenchCase(JSON.parse(readFileSync(file, 'utf8')), file);
  if (benchCase === undefined)
    throw new Error(`inspect needs a case id (see "bot-bench list") or --file <case.json>`);
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
  console.log(`\n${'model'.padEnd(60)} accuracy  median     p90        cost/decision`);
  for (const model of run.models) {
    const metrics = modelMetrics(model, selected, run.manifest.trials);
    console.log(
      `${model.model.label.slice(0, 60).padEnd(60)} ${percent(metrics.accuracy.overall).padEnd(9)} ${milliseconds(metrics.speed.p50Ms).padEnd(10)} ${milliseconds(metrics.speed.p90Ms).padEnd(10)} ${dollars(metrics.cost.perDecisionUsd)} (${metrics.cost.source})${model.status === 'aborted' ? `  STOPPED: ${model.abortReason ?? ''}` : ''}`,
    );
  }
}

/** The entries `--lineup`, `--models` and `--strategists` name together, ids checked unique. */
function lineupFromFlags(flags: Flags): LineupEntry[] {
  const lineupPath = text(flags, 'lineup');
  const modelList = text(flags, 'models');
  const strategistList = text(flags, 'strategists');
  if (strategistList !== undefined && modelList === undefined)
    throw new Error(
      '--strategists crosses with --models; a lineup file lists its own strategists and tacticians',
    );
  const listed = modelList === undefined ? [] : parseModelList(modelList);
  const lineup: LineupEntry[] = [
    ...(lineupPath === undefined ? [] : loadLineupFile(lineupPath)),
    ...(strategistList === undefined
      ? listed
      : crossLineup(listed, parseStrategistList(strategistList))),
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
  return lineup;
}

async function run(flags: Flags): Promise<void> {
  const lineup = lineupFromFlags(flags);
  const mode = (text(flags, 'mode') ?? 'raw') as RunMode;
  if (mode !== 'raw' && mode !== 'production') throw new Error('--mode must be raw or production');
  const trials = Math.floor(positive(flags, 'trials', 1));
  const cases = selectCases(flags);
  // A missing key is found now, not after the other models have been paid for.
  for (const entry of lineup) {
    if (entry.kind === 'llm') resolveLlmConfig(entry, { env: process.env, mode });
    else if (entry.kind === 'decision') resolveDecisionKey(entry, { env: process.env, mode });
    else if (entry.kind === 'bot-led') resolveBotLedConfig(entry, { env: process.env, mode });
    const strategist = liveStrategist(entry);
    if (strategist !== undefined) resolveStrategistClientConfig(strategist, { env: process.env });
  }

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

/**
 * Whole games between two or four lineup entries (`duel.ts`). `--arms` picks them by id from the
 * lineup; without it the lineup itself must hold exactly two or four entries.
 */
async function duel(flags: Flags): Promise<void> {
  const lineup = lineupFromFlags(flags);
  const armList = text(flags, 'arms');
  const arms =
    armList === undefined
      ? lineup
      : armList.split(',').map((id) => {
          const entry = lineup.find((candidate) => candidate.id === id.trim());
          if (entry === undefined)
            throw new Error(
              `--arms names ${id.trim()}, which is not in the lineup (${lineup.map((e) => e.id).join(', ')})`,
            );
          return entry;
        });
  checkArms(arms);
  const offline = flags['offline'] === true;
  const deals = Math.floor(positive(flags, 'deals', 1));
  const turnCap = Math.floor(positive(flags, 'turn-cap', 40));
  const jobs = Math.floor(positive(flags, 'jobs', 1));
  const seed = text(flags, 'seed') ?? 'duel';
  const capText = text(flags, 'spend-cap');
  const spendCapUsd = capText === undefined ? (offline ? null : 2) : Number(capText);
  if (spendCapUsd !== null && !(spendCapUsd >= 0)) throw new Error('--spend-cap must be USD');
  // A missing key is found now, not after the other arms have been paid for.
  if (!offline)
    for (const entry of arms) {
      if (entry.kind === 'llm') resolveLlmConfig(entry, { env: process.env, mode: 'production' });
      else if (entry.kind === 'decision')
        resolveDecisionKey(entry, { env: process.env, mode: 'production' });
      else if (entry.kind === 'bot-led')
        resolveBotLedConfig(entry, { env: process.env, mode: 'production' });
      const strategist = liveStrategist(entry);
      if (strategist !== undefined) resolveStrategistClientConfig(strategist, { env: process.env });
    }
  const runId = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const out = resolve(text(flags, 'out') ?? join('benchmark-output', 'bot-bench-duel', runId));
  mkdirSync(out, { recursive: true });
  const gamesPath = join(out, 'games.jsonl');
  writeFileSync(gamesPath, '');
  const race = flags['race'] === true;
  console.log(
    `bot-bench duel ${runId}: ${arms.map((arm) => arm.id).join(' vs ')}, ${deals} deal(s) × ${arms.length} rotations, turn cap ${turnCap}${offline ? ', OFFLINE' : `, spend cap ${spendCapUsd === null ? 'none' : `$${spendCapUsd}`}`}`,
  );
  const { games, summary } = await runDuel({
    arms,
    deals,
    seed,
    turnCap,
    jobs,
    spendCapUsd,
    env: process.env,
    race,
    offline,
    onGame: (game) => appendFileSync(gamesPath, `${JSON.stringify(game)}\n`),
    onProgress: (line) => console.log(`  ${line}`),
  });
  const options = { arms, seed, turnCap, race, offline };
  const markdown = renderDuel(options, games, summary);
  writeFileSync(join(out, 'summary.md'), markdown);
  writeFileSync(
    join(out, 'summary.json'),
    `${JSON.stringify({ runId, seed, turnCap, deals, race, offline, arms: publicArms(arms), summary }, null, 2)}\n`,
  );
  console.log(`\n${markdown.split('## Games')[0]!.trim()}\n`);
  console.log(`  games    ${gamesPath}\n  summary  ${join(out, 'summary.md')}`);
}

async function bundle(flags: Flags): Promise<void> {
  const runDirectory = text(flags, 'run');
  if (runDirectory === undefined) throw new Error('bundle needs --run <run directory>');
  const built = await writeBundle(resolve(runDirectory), loadCases('all'), {
    blind: flags['reveal-models'] !== true,
  });
  console.log(`\njudge bundle: ${built.files} files, ${Math.round(built.bytes / 1024)} KB`);
  console.log(`  folder  ${built.directory}`);
  console.log(`  zip     ${built.zipPath}   <- send this to the judges`);
  if (built.leaks.length > 0) {
    console.log('\nWARNING: a model name is still visible in the blind bundle; do not send it:');
    for (const leak of built.leaks.slice(0, 20)) console.log(`  "${leak.name}" in ${leak.file}`);
    process.exitCode = 1;
  }
  if (built.keyPath !== null)
    console.log(
      `  key     ${built.keyPath}   <- which alias is which model; keep it, do not send it`,
    );
}

/**
 * Grade a run's saved play again against the references as they are now. No model is called: a
 * score is a function of the case and the recorded run, so a corrected grade or objective can be
 * applied to play that was already paid for. The run's fingerprint is left as it was, so no model
 * can be added to a rescored run: its play was recorded against the earlier cases.
 */
async function rescore(flags: Flags): Promise<void> {
  const runDirectory = text(flags, 'run');
  if (runDirectory === undefined) throw new Error('rescore needs --run <run directory>');
  const directory = resolve(runDirectory);
  const { manifest, models } = readRun(directory);
  const cases = loadCases('all');
  // The decision under test is the same for every model, so a saved run does not repeat it.
  const focuses = new Map<string, CaseRun['focus']>();
  const focusOf = (benchCase: BenchCase): CaseRun['focus'] => {
    let focus = focuses.get(benchCase.id);
    if (focus === undefined) {
      const { request, view, names } = openCase(benchCase);
      focus = { request, view, names };
      focuses.set(benchCase.id, focus);
    }
    return focus;
  };
  let changed = 0;
  for (const model of models) {
    for (const entry of model.cases) {
      const benchCase = cases.find((candidate) => candidate.id === entry.caseId);
      if (benchCase === undefined)
        throw new Error(`run names case ${entry.caseId}, which no longer exists`);
      const score = scoreRun(benchCase, { ...entry.run, focus: focusOf(benchCase) });
      if (score.score !== entry.score.score) {
        changed += 1;
        console.log(
          `  ${model.model.id}  ${entry.caseId}  ${percent(entry.score.score)} -> ${percent(score.score)}`,
        );
      }
      entry.score = score;
    }
    writeFileSync(
      join(directory, 'results', `${model.model.id}.json`),
      `${JSON.stringify(model, null, 2)}
`,
    );
  }
  writeFileSync(
    join(directory, 'run.json'),
    `${JSON.stringify({ ...manifest, rescoredAt: new Date().toISOString() }, null, 2)}
`,
  );
  console.log(`rescored ${models.length} model(s): ${changed} case score(s) changed`);
  printLeaderboard(directory, cases);
  await bundle({ ...flags, run: directory });
}

/**
 * Fold a seeded run by entry and print each case's mean across seeds (ADR 0043 decision 3.1).
 * With `--baseline` and `--candidate`, apply the gate: the candidate must raise the overall score
 * and lower no case's mean. Exits 1 when the gate fails.
 */
function seedsCommand(flags: Flags): void {
  const runDirectory = text(flags, 'run');
  if (runDirectory === undefined) throw new Error('seeds needs --run <run directory>');
  const { models } = readRun(resolve(runDirectory));
  const entries = foldSeeds(models);
  const caseIds = [...new Set(entries.flatMap((entry) => Object.keys(entry.caseMeans)))].sort();
  console.log(
    `${'case'.padEnd(34)} ${entries.map((entry) => entry.id.slice(0, 16).padEnd(16)).join(' ')}`,
  );
  for (const caseId of caseIds)
    console.log(
      `${caseId.padEnd(34)} ${entries
        .map((entry) => {
          const value = entry.caseMeans[caseId];
          const escalated = entry.escalated?.[caseId];
          const cell = value === undefined ? '-' : percent(value);
          return (escalated === undefined ? cell : `${cell} (${escalated} esc)`).padEnd(16);
        })
        .join(' ')}`,
    );
  console.log(
    `${'overall'.padEnd(34)} ${entries.map((entry) => percent(entry.overall).padEnd(16)).join(' ')}`,
  );
  console.log(
    `${'seeds'.padEnd(34)} ${entries.map((entry) => String(entry.seeds.length).padEnd(16)).join(' ')}`,
  );
  const baselineId = text(flags, 'baseline');
  const candidateId = text(flags, 'candidate');
  if (baselineId === undefined && candidateId === undefined) return;
  if (baselineId === undefined || candidateId === undefined)
    throw new Error('the seed gate needs both --baseline <id> and --candidate <id>');
  const find = (id: string | undefined): (typeof entries)[number] => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry === undefined)
      throw new Error(
        `no entry "${id ?? ''}" in the run (have: ${entries.map((e) => e.id).join(', ')})`,
      );
    return entry;
  };
  const gate = seedGate(find(baselineId), find(candidateId));
  console.log(
    `\ngate ${candidateId} against ${baselineId}: ${gate.pass ? 'PASS' : 'FAIL'} (overall ${gate.overallDelta >= 0 ? '+' : ''}${(gate.overallDelta * 100).toFixed(1)} points)`,
  );
  for (const problem of gate.problems) console.log(`  problem: ${problem}`);
  for (const r of gate.regressions)
    console.log(`  lower   ${r.caseId}: ${percent(r.baseline)} -> ${percent(r.candidate)}`);
  for (const r of gate.improvements)
    console.log(`  higher  ${r.caseId}: ${percent(r.baseline)} -> ${percent(r.candidate)}`);
  if (!gate.pass) process.exitCode = 1;
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
  bun run bot-bench inspect <case-id> | --file <case.json> [--log]
                                                     every legal answer or reference line, played by the engine
  bun run bot-bench verify [--scope single|turn]     check every reference against the engine
  bun run bot-bench run --models <list> | --lineup <file.json>
        [--cases id,id] [--scope single|turn] [--trials N] [--mode raw|production]
        [--strategists <list>] [--out <run directory>] [--concurrency N] [--spend-cap <USD>]
        [--reveal-models]
  bun run bot-bench duel --models <list> | --lineup <file.json> [--strategists <list>] [--arms id,id]
        [--deals N] [--turn-cap N] [--seed S] [--jobs N] [--spend-cap <USD>] [--race] [--offline]
        [--out <directory>]                         whole four-player games between 2 or 4 entries
  bun run bot-bench bundle --run <run directory> [--reveal-models]
  bun run bot-bench rescore --run <run directory>    grade saved play again against the current references
  bun run bot-bench collate --run <run directory> <scorecard.json> [...]
  bun run bot-bench seeds --run <run directory> [--baseline <id> --candidate <id>]
                                                     mean per case across seeds; the ADR 0043 seed gate

  --models   comma separated: local:heuristic (card-aware, the production bot),
             local:heuristic-plain (no card knowledge), local:first-legal, local:random,
             bot-led:never, bot-led:uncertain=openrouter/<vendor/model>,
             openrouter:<vendor/model>, groq:<model>, gemini:<model>, deepseek:<model>, openai:<model>;
             add @low, @medium or @high to turn reasoning on;
             decision:<vendor/model> for a Decisions API model (decision:typesafe/jev-1.14),
             add @hold to hold still on attacks and blocks instead of letting the bot play them
  --strategists  comma separated, crossed with every --models entry: none (no strategy), case (the
             case's own context), or a strategist model such as openrouter:z-ai/glm-5.3-flash@low;
             local bots pair with none and case only
  --lineup   a JSON file; a top-level "seeds" list plays every heuristic and bot-led entry once
             per seed (see bot-bench/lineups/bot-gate.json); "strategists" and "tacticians"
             lists instead of "models" run every pair (see bot-bench/lineups/strategist-grid.json)
  --out      an existing run directory adds models to that run and rebuilds its bundle
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArguments(rest);
  if (command === 'list') listCases();
  else if (command === 'inspect') await inspect(positional[0], flags);
  else if (command === 'verify') await verify(flags);
  else if (command === 'run') await run(flags);
  else if (command === 'duel') await duel(flags);
  else if (command === 'bundle') await bundle(flags);
  else if (command === 'rescore') await rescore(flags);
  else if (command === 'collate') collateCommand(positional, flags);
  else if (command === 'seeds') seedsCommand(flags);
  else console.log(USAGE);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

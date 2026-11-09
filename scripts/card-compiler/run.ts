/**
 * The batch card compiler's pipeline (see README.md in this folder).
 *
 *   bun run scripts/card-compiler/run.ts prepare <trial-dir>       # first-round compile prompts
 *   bun run scripts/card-compiler/run.ts exec <trial-dir> <stage>  # answer pending prompts via the API
 *   bun run scripts/card-compiler/run.ts check <trial-dir>         # validate, smoke, next prompts
 *   bun run scripts/card-compiler/run.ts report <trial-dir>        # results.json and summary.md
 *
 *   bun run scripts/card-compiler/run.ts recheck <trial-dir>       # redo back-translation and judge
 *
 * Stages are `compile`, `back` and `judge`. Every prompt is a file under <trial-dir>/work/prompts
 * and every answer a file under <trial-dir>/work/answers, so any executor can answer them: the
 * `exec` command (Anthropic API), a batch job, or an agent. `check` is idempotent: run it after
 * each round of answers until nothing is pending.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import {
  applyPatch,
  compileTarget,
  parseAnswer,
  pinnedPool,
  smokeTest,
  type CompileTarget,
  type SmokeResult,
} from './lib';
import {
  BACK_PREFIX,
  JUDGE_PREFIX,
  backSuffix,
  compilePrefix,
  compileSuffix,
  judgeSuffix,
} from './prompts';

const MAX_COMPILE_ROUNDS = 3;

interface TargetRow {
  name: string;
  rank: number;
  lines: string[];
  xmageBucket?: string;
}

export interface CardState {
  name: string;
  rank: number;
  xmageBucket?: string;
  lines: string[];
  /** Compile rounds answered so far. */
  rounds: number;
  stage: 'compile' | 'invalid' | 'inexpressible' | 'back' | 'judge' | 'done' | 'stale';
  validatorIssues: string[][];
  inexpressibleReason?: string;
  smoke?: SmokeResult[];
  /** The merged definition passed validation. */
  valid?: boolean;
  backTranslation?: string;
  verdict?: 'same' | 'different';
  differences?: string[];
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function paths(trial: string) {
  const work = `${trial}/work`;
  return {
    work,
    state: `${work}/state.json`,
    prompt: (stage: string, name: string, round?: number) =>
      `${work}/prompts/${stage}/${slug(name)}${round === undefined ? '' : `.r${round}`}.md`,
    answer: (stage: string, name: string, round?: number) =>
      `${work}/answers/${stage}/${slug(name)}${round === undefined ? '' : `.r${round}`}.${stage === 'back' ? 'txt' : 'json'}`,
    prefix: (stage: string) => `${work}/prompts/${stage}-prefix.md`,
    patch: (name: string) => `${trial}/patches/${slug(name)}.json`,
  };
}

function write(path: string, text: string): void {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, text);
}

function loadTargets(trial: string): Map<string, CompileTarget> {
  const rows = JSON.parse(readFileSync(`${trial}/targets.json`, 'utf8')) as TargetRow[];
  const byName = new Map(pinnedPool().map((row) => [row.card.name, row]));
  const out = new Map<string, CompileTarget>();
  for (const row of rows) {
    const pinned = byName.get(row.name);
    const target = pinned === undefined ? null : compileTarget(pinned);
    if (target !== null) out.set(row.name, target);
  }
  return out;
}

function loadState(trial: string): Map<string, CardState> {
  const p = paths(trial);
  if (!existsSync(p.state)) return new Map();
  const list = JSON.parse(readFileSync(p.state, 'utf8')) as CardState[];
  return new Map(list.map((state) => [state.name, state]));
}

function saveState(trial: string, states: Map<string, CardState>): void {
  write(paths(trial).state, `${JSON.stringify([...states.values()], null, 2)}\n`);
}

function prepare(trial: string): void {
  const p = paths(trial);
  const rows = JSON.parse(readFileSync(`${trial}/targets.json`, 'utf8')) as TargetRow[];
  const targets = loadTargets(trial);
  const states = loadState(trial);
  write(p.prefix('compile'), compilePrefix());
  write(p.prefix('back'), BACK_PREFIX);
  write(p.prefix('judge'), JUDGE_PREFIX);
  for (const row of rows) {
    const target = targets.get(row.name);
    if (target === undefined) {
      states.set(row.name, { ...row, rounds: 0, stage: 'stale', validatorIssues: [] });
      continue;
    }
    if (states.has(row.name)) continue;
    states.set(row.name, {
      ...row,
      lines: target.lines,
      rounds: 0,
      stage: 'compile',
      validatorIssues: [],
    });
    write(p.prompt('compile', row.name, 1), compileSuffix(target));
  }
  saveState(trial, states);
  console.log(`prepared ${states.size} cards`);
}

function check(trial: string): void {
  const p = paths(trial);
  const targets = loadTargets(trial);
  const states = loadState(trial);
  let pending = 0;
  for (const state of states.values()) {
    const target = targets.get(state.name);
    if (target === undefined) continue;
    if (state.stage === 'compile') {
      const round = state.rounds + 1;
      const answerPath = p.answer('compile', state.name, round);
      if (!existsSync(answerPath)) {
        pending++;
        continue;
      }
      const raw = readFileSync(answerPath, 'utf8');
      state.rounds = round;
      let issues: string[];
      try {
        const answer = parseAnswer(raw);
        if (answer.status === 'inexpressible') {
          state.stage = 'inexpressible';
          state.inexpressibleReason = answer.reason;
          continue;
        }
        const result = applyPatch(target, answer.def);
        issues = result.issues;
        if (result.ok) {
          state.valid = true;
          write(
            p.patch(state.name),
            `${JSON.stringify({ name: state.name, oracleId: target.oracleId, handledLines: target.lines, compose: 'append', def: answer.def }, null, 2)}\n`,
          );
          state.smoke = smokeTest(target, answer.def);
          state.stage = 'back';
          write(p.prompt('back', state.name), backSuffix(target, answer.def));
          pending++;
          continue;
        }
      } catch (error) {
        issues = [`answer is not valid JSON in the required shape: ${String(error)}`];
      }
      state.validatorIssues.push(issues);
      if (round >= MAX_COMPILE_ROUNDS) {
        state.stage = 'invalid';
        continue;
      }
      write(
        p.prompt('compile', state.name, round + 1),
        compileSuffix(target, { previous: raw.slice(0, 12_000), issues: issues.slice(0, 20) }),
      );
      pending++;
      continue;
    }
    if (state.stage === 'back') {
      const answerPath = p.answer('back', state.name);
      if (!existsSync(answerPath)) {
        pending++;
        continue;
      }
      state.backTranslation = readFileSync(answerPath, 'utf8').trim();
      state.stage = 'judge';
      write(p.prompt('judge', state.name), judgeSuffix(target, state.backTranslation));
      pending++;
      continue;
    }
    if (state.stage === 'judge') {
      const answerPath = p.answer('judge', state.name);
      if (!existsSync(answerPath)) {
        pending++;
        continue;
      }
      const raw = readFileSync(answerPath, 'utf8');
      try {
        const value = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
          verdict?: string;
          differences?: string[];
        };
        state.verdict = value.verdict === 'same' ? 'same' : 'different';
        state.differences = value.differences ?? [];
      } catch {
        state.verdict = 'different';
        state.differences = ['judge answer was not JSON'];
      }
      state.stage = 'done';
    }
  }
  saveState(trial, states);
  const counts = new Map<string, number>();
  for (const state of states.values()) counts.set(state.stage, (counts.get(state.stage) ?? 0) + 1);
  console.log(`${pending} prompts pending;`, Object.fromEntries(counts));
}

/**
 * Re-run the meaning check (back-translation and judge) on every valid patch, after a change to
 * those prompts. Earlier answers are kept, moved to `answers/<stage>.<timestamp>/`.
 */
function recheck(trial: string): void {
  const p = paths(trial);
  const targets = loadTargets(trial);
  const states = loadState(trial);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const stage of ['back', 'judge']) {
    const dir = `${p.work}/answers/${stage}`;
    if (existsSync(dir)) renameSync(dir, `${dir}.${stamp}`);
    const promptDir = `${p.work}/prompts/${stage}`;
    if (existsSync(promptDir)) renameSync(promptDir, `${promptDir}.${stamp}`);
  }
  write(p.prefix('back'), BACK_PREFIX);
  write(p.prefix('judge'), JUDGE_PREFIX);
  for (const state of states.values()) {
    const target = targets.get(state.name);
    if (target === undefined || state.valid !== true) continue;
    const patch = JSON.parse(readFileSync(p.patch(state.name), 'utf8')) as {
      def: Partial<CardDefinition>;
    };
    delete state.backTranslation;
    delete state.verdict;
    delete state.differences;
    state.stage = 'back';
    write(p.prompt('back', state.name), backSuffix(target, patch.def));
  }
  saveState(trial, states);
  console.log('meaning check reset for every valid patch');
}

/** Prompts with no answer yet, for one stage. */
export function pendingPrompts(trial: string, stage: string): { prompt: string; answer: string }[] {
  const p = paths(trial);
  const dir = `${p.work}/prompts/${stage}`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({
      prompt: `${dir}/${file}`,
      answer: `${p.work}/answers/${stage}/${file.replace(/\.md$/, stage === 'back' ? '.txt' : '.json')}`,
    }))
    .filter((entry) => !existsSync(entry.answer));
}

async function exec(trial: string, stage: string): Promise<void> {
  const { answerPrompts } = await import('./provider');
  const p = paths(trial);
  const prefix = readFileSync(p.prefix(stage), 'utf8');
  const pending = pendingPrompts(trial, stage);
  await answerPrompts(stage, prefix, pending, `${p.work}/usage.jsonl`);
}

/**
 * Cost estimated from prompt and answer sizes, for runs not made through `exec` (which records
 * real usage). About 3.5 characters per token for this JSON- and TypeScript-heavy text. Each
 * stage's prefix is billed once as a cache write and then as cache reads; compile rounds after the
 * first are priced on the retry model.
 */
function estimateCost(trial: string): Record<string, number> {
  const p = paths(trial);
  const tokens = (path: string): number => Math.ceil(readFileSync(path, 'utf8').length / 3.5);
  const price = {
    base: { input: 0.1, output: 0.5, read: 0.01, write: 0.125 },
    retry: { input: 2, output: 10, read: 0.1, write: 2.5 },
  };
  const out: Record<string, number> = {};
  let total = 0;
  for (const stage of ['compile', 'back', 'judge']) {
    const dir = `${p.work}/prompts/${stage}`;
    if (!existsSync(dir) || !existsSync(p.prefix(stage))) continue;
    const prefix = tokens(p.prefix(stage));
    let cost = 0;
    let calls = 0;
    const tiersSeen = new Set<string>();
    for (const file of readdirSync(dir)) {
      const ext = stage === 'back' ? '.txt' : '.json';
      const answer = `${p.work}/answers/${stage}/${file.replace(/\.md$/, ext)}`;
      if (!existsSync(answer)) continue;
      const round = Number(/\.r(\d+)\.md$/.exec(file)?.[1] ?? 1);
      const tier = stage === 'compile' && round > 1 ? 'retry' : 'base';
      const rate = price[tier];
      cost += tiersSeen.has(tier) ? prefix * rate.read : prefix * rate.write;
      tiersSeen.add(tier);
      cost += tokens(`${dir}/${file}`) * rate.input + tokens(answer) * rate.output;
      calls++;
    }
    out[`${stage}Usd`] = cost / 1_000_000;
    out[`${stage}Calls`] = calls;
    total += cost / 1_000_000;
  }
  out['totalUsd'] = total;
  return out;
}

/** Cards a smoke run counts as passing: no halt or throw in any scenario. */
function smokeOk(state: CardState): boolean {
  return (state.smoke ?? []).every((run) => run.ok);
}

function report(trial: string): void {
  const states = [...loadState(trial).values()];
  const p = paths(trial);
  const usage = existsSync(`${p.work}/usage.jsonl`)
    ? readFileSync(`${p.work}/usage.jsonl`, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { stage: string; costUsd: number })
    : [];
  const totalCost = usage.reduce((sum, row) => sum + row.costUsd, 0);
  const estimate = estimateCost(trial);
  const compiled = states.filter((state) => state.valid === true);
  const checked = compiled.filter((state) => smokeOk(state) && state.verdict === 'same');
  const byBucket = new Map<string, { total: number; checked: number }>();
  for (const state of states) {
    const bucket = state.xmageBucket ?? 'all';
    const entry = byBucket.get(bucket) ?? { total: 0, checked: 0 };
    entry.total++;
    if (checked.includes(state)) entry.checked++;
    byBucket.set(bucket, entry);
  }
  const results = states.map((state) => ({
    name: state.name,
    rank: state.rank,
    xmageBucket: state.xmageBucket,
    lines: state.lines,
    outcome:
      state.stage === 'stale'
        ? 'stale'
        : state.stage === 'inexpressible'
          ? 'inexpressible'
          : state.stage === 'invalid'
            ? 'invalid'
            : state.valid !== true
              ? 'pending'
              : !smokeOk(state)
                ? 'smoke-failed'
                : state.verdict === 'same'
                  ? 'compiled-checked'
                  : state.verdict === 'different'
                    ? 'meaning-differs'
                    : 'pending',
    compileRounds: state.rounds,
    validatorIssues: state.validatorIssues,
    inexpressibleReason: state.inexpressibleReason,
    smoke: state.smoke?.map((run) => ({
      scenario: run.scenario,
      ok: run.ok,
      exercised: run.exercised,
      abilityResolved: run.abilityResolved,
      detail: run.detail,
    })),
    backTranslation: state.backTranslation,
    differences: state.differences,
  }));
  write(
    `${trial}/results.json`,
    `${JSON.stringify({ measuredCostUsd: totalCost, estimatedCost: estimate, cards: results }, null, 2)}\n`,
  );
  const tally = new Map<string, number>();
  for (const row of results) tally.set(row.outcome, (tally.get(row.outcome) ?? 0) + 1);
  console.log(Object.fromEntries(tally));
  console.log('by XMage bucket:', Object.fromEntries(byBucket));
  console.log(`API cost recorded: $${totalCost.toFixed(4)} over ${usage.length} calls`);
  console.log('estimate from prompt and answer sizes:', estimate);
}

const [command, trial, stage] = process.argv.slice(2);
if (trial === undefined)
  throw new Error('usage: run.ts <prepare|exec|check|report> <trial-dir> [stage]');
if (command === 'prepare') prepare(trial);
else if (command === 'check') check(trial);
else if (command === 'report') report(trial);
else if (command === 'recheck') recheck(trial);
else if (command === 'exec') await exec(trial, stage ?? 'compile');
else throw new Error(`unknown command ${command}`);

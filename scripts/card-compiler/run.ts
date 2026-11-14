/**
 * The batch card compiler's pipeline (see README.md in this folder).
 *
 *   bun run scripts/card-compiler/run.ts prepare <trial-dir>       # first-round compile prompts
 *   bun run scripts/card-compiler/run.ts exec <trial-dir> <stage>  # answer pending prompts via the API
 *       [--executor api|claude|codex|antigravity]                 # ...or via a coding-agent CLI
 *   bun run scripts/card-compiler/run.ts check <trial-dir>         # validate, smoke, next prompts
 *   bun run scripts/card-compiler/run.ts report <trial-dir>        # results.json and summary.md
 *
 *   bun run scripts/card-compiler/run.ts recheck <trial-dir>       # redo back-translation and judge
 *   bun run scripts/card-compiler/run.ts import <trial-dir> <dir>  # check patches made elsewhere
 *   bun run scripts/card-compiler/run.ts queue <trial-dir>...      # rebuild the review queue
 *   bun run scripts/card-compiler/run.ts audit [--seed S] [--count N]  # sample provisional cards
 *   bun run scripts/card-compiler/run.ts audit-verdict "<name>" <source> accepted|rejected --by <who>
 *
 * Stages are `compile`, `back` and `judge`. Every prompt is a file under <trial-dir>/work/prompts
 * and every answer a file under <trial-dir>/work/answers, so any executor can answer them: the
 * `exec` command (Anthropic API), a batch job, or an agent. `check` is idempotent: run it after
 * each round of answers until nothing is pending.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { textCheck } from './render';
import { audit, review } from './audit';
import {
  applyPatch,
  behaviorOf,
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

/**
 * The source tag of a patch this pipeline compiled itself. `CARD_COMPILER_SOURCE` overrides it
 * when the prompts were answered by something other than `exec` (an agent, a batch job).
 */
function compilerSource(): string {
  return (
    process.env['CARD_COMPILER_SOURCE'] ??
    `compiler@${process.env['CARD_COMPILER_MODEL'] ?? 'claude-haiku-5-5'}`
  );
}

/** The shape every patch file has, whatever produced it. */
export interface PatchFile {
  name: string;
  oracleId: string;
  /** `compiler@<model>`, `xmage@<commit>`, or another producer's tag. */
  source: string;
  handledLines: string[];
  compose: 'append';
  def: Partial<CardDefinition>;
}

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
  /**
   * Where the patch came from: `compiler@<model>` for this pipeline's own compile stage, or the
   * tag an imported patch carries (`xmage@<commit>`).
   */
  source?: string;
  /** The patch came from `import`, not the compile prompt, so it gets no compile retries. */
  imported?: true;
  /** How the meaning check was decided: the deterministic renderer, or model back-translation. */
  textCheck?: 'renderer' | 'model';
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
            `${JSON.stringify(
              {
                name: state.name,
                oracleId: target.oracleId,
                source: state.source ?? compilerSource(),
                handledLines: target.lines,
                compose: 'append',
                def: answer.def,
              },
              null,
              2,
            )}\n`,
          );
          state.smoke = smokeTest(target, answer.def);
          // Free meaning check first: render the IR back to English and compare it with the
          // Oracle lines. Only when that cannot decide does the card go to the model check.
          const text = textCheck(
            answer.def,
            target.lines,
            target.name,
            target.card.oracleText ?? '',
          );
          if (text.verdict === 'match') {
            state.textCheck = 'renderer';
            state.verdict = 'same';
            state.differences = [];
            state.stage = 'done';
            continue;
          }
          state.textCheck = 'model';
          state.stage = 'back';
          write(p.prompt('back', state.name), backSuffix(target, answer.def));
          pending++;
          continue;
        }
      } catch (error) {
        issues = [`answer is not valid JSON in the required shape: ${String(error)}`];
      }
      state.validatorIssues.push(issues);
      if (round >= MAX_COMPILE_ROUNDS || state.imported === true) {
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
  // An answer saved under the wrong extension would otherwise leave its card pending forever.
  for (const stage of ['compile', 'back', 'judge']) {
    const dir = `${p.work}/answers/${stage}`;
    if (!existsSync(dir)) continue;
    const want = stage === 'back' ? '.txt' : '.json';
    for (const file of readdirSync(dir))
      if (!file.endsWith(want))
        console.warn(`warning: ${dir}/${file} is ignored; ${stage} answers must end in ${want}`);
  }
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

/**
 * Take patches produced elsewhere (an XMage translator, a person) into a trial, so they go
 * through exactly the checks compiled patches do. Each file in `patchDir` is a `PatchFile`. The
 * patch becomes the card's first and only compile answer: a patch that fails validation is
 * `invalid`, with no retry, because the compile prompt is not what produced it.
 */
function importPatches(trial: string, patchDir: string): void {
  const p = paths(trial);
  const byName = new Map(pinnedPool().map((row) => [row.card.name, row]));
  const targetsPath = `${trial}/targets.json`;
  const rows: TargetRow[] = existsSync(targetsPath)
    ? (JSON.parse(readFileSync(targetsPath, 'utf8')) as TargetRow[])
    : [];
  const states = loadState(trial);
  write(p.prefix('back'), BACK_PREFIX);
  write(p.prefix('judge'), JUDGE_PREFIX);
  let imported = 0;
  for (const file of readdirSync(patchDir).filter((name) => name.endsWith('.json'))) {
    const patch = JSON.parse(readFileSync(`${patchDir}/${file}`, 'utf8')) as PatchFile;
    if (typeof patch.source !== 'string' || patch.source.length === 0)
      throw new Error(`${file}: a patch needs a "source" tag`);
    const answer = `${JSON.stringify({ status: 'compiled', def: patch.def })}\n`;
    const existing = states.get(patch.name);
    if (existing !== undefined) {
      const previous = existsSync(p.answer('compile', patch.name, 1))
        ? readFileSync(p.answer('compile', patch.name, 1), 'utf8')
        : null;
      if (existing.imported !== true || previous === answer) continue;
      // The patch changed since it was checked: earlier results belong to the old bytes, so move
      // its meaning-check answers aside and check it again from the start.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const stage of ['back', 'judge']) {
        const old = p.answer(stage, patch.name);
        if (existsSync(old)) renameSync(old, `${old}.stale-${stamp}`);
      }
      console.warn(`${patch.name}: patch changed since its last check; rechecking`);
    }
    const pinned = byName.get(patch.name);
    const target = pinned === undefined ? null : compileTarget(pinned);
    if (pinned !== undefined && !rows.some((row) => row.name === patch.name))
      rows.push({ name: patch.name, rank: pinned.rank, lines: target?.lines ?? [] });
    if (target === null) {
      // Modeled already, multi-face, or not in the pinned pool: nothing to check against.
      states.set(patch.name, {
        name: patch.name,
        rank: pinned?.rank ?? 0,
        lines: patch.handledLines,
        source: patch.source,
        imported: true,
        rounds: 0,
        stage: 'stale',
        validatorIssues: [],
      });
      continue;
    }
    states.set(patch.name, {
      name: patch.name,
      rank: target.rank,
      lines: target.lines,
      source: patch.source,
      imported: true,
      rounds: 0,
      stage: 'compile',
      validatorIssues: [],
    });
    write(p.answer('compile', patch.name, 1), answer);
    imported++;
  }
  write(targetsPath, `${JSON.stringify(rows, null, 2)}\n`);
  saveState(trial, states);
  console.log(`imported ${imported} patches; run check next`);
}

export type QueueStatus = 'compiled-checked' | 'meaning-differs' | 'smoke-failed' | 'invalid';

/** One card awaiting human review. Nothing in the queue is registered with the engine. */
export interface QueueEntry {
  name: string;
  oracleId: string;
  source: string;
  status: QueueStatus;
  handledLines: string[];
  /** Repository path of the patch file. */
  patch: string | null;
  /** SHA-256 of the patch file's bytes; a recorded review applies only to this exact patch. */
  patchSha256: string | null;
  trial: string;
  textCheck?: 'renderer' | 'model';
  differences?: string[];
  validatorIssues?: string[];
  smoke?: { scenario: string; ok: boolean; abilityResolved: boolean; detail: string }[];
  /**
   * Whether any smoke game resolved one of the card's own abilities or the spell. When false the
   * smoke run only shows the card does not crash the engine; it says nothing about the behavior.
   */
  smokeExercised?: boolean;
  /**
   * Cross-check against an independent translation of the same card (an XMage patch): whether the
   * two merged definitions have identical behavior (descriptions ignored, allOf/anyOf unordered).
   * Identical is strong evidence; a difference tells the reviewer where to look.
   */
  crossCheck?: { source: string; verdict: 'identical' | 'differs' | 'other-invalid' };
  /** Filled in by the reviewer: accepted, rejected, or null while waiting. */
  review: { verdict: 'accepted' | 'rejected'; by: string; note?: string } | null;
}

const QUEUE_PATH = 'docs/reviews/compiled-card-queue.json';

/**
 * Rebuild the review queue from every trial directory given. Reviews already recorded in the
 * queue are kept for cards whose patch is unchanged. Cards the compiler declined are not queued;
 * they are a primitive backlog, listed in each trial's results.json.
 */
/** Behavior of a definition as canonical JSON: descriptions dropped, keys sorted. */
function canonicalBehavior(definition: CardDefinition): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value === null || typeof value !== 'object') return value;
    const node = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'description' && key !== 'prompt' && key !== 'label')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
    // allOf and anyOf are unordered: "another Elf" and "an Elf that is another" are the same.
    if ((node['kind'] === 'allOf' || node['kind'] === 'anyOf') && Array.isArray(node['of']))
      node['of'] = [...(node['of'] as unknown[])].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
    return node;
  };
  return JSON.stringify(sortKeys(behaviorOf(definition)));
}

/**
 * Compare a queued patch with an independent patch for the same card from `crossDir` (one JSON
 * per card, named by slug, in the shared patch format).
 */
function crossCheck(
  target: CompileTarget,
  ownDef: Partial<CardDefinition>,
  otherPath: string,
): NonNullable<QueueEntry['crossCheck']> {
  const other = JSON.parse(readFileSync(otherPath, 'utf8')) as PatchFile;
  const mine = applyPatch(target, ownDef);
  const theirs = applyPatch(target, other.def);
  if (!theirs.ok || theirs.definition === null)
    return { source: other.source, verdict: 'other-invalid' };
  if (!mine.ok || mine.definition === null) return { source: other.source, verdict: 'differs' };
  return {
    source: other.source,
    verdict:
      canonicalBehavior(mine.definition) === canonicalBehavior(theirs.definition)
        ? 'identical'
        : 'differs',
  };
}

function queue(args: string[]): void {
  const crossIndex = args.indexOf('--cross');
  const crossDir = crossIndex < 0 ? undefined : args[crossIndex + 1];
  const trials =
    crossIndex < 0
      ? args
      : args.filter((_, index) => index !== crossIndex && index !== crossIndex + 1);
  const previous = existsSync(QUEUE_PATH)
    ? (JSON.parse(readFileSync(QUEUE_PATH, 'utf8')) as { cards: QueueEntry[] }).cards
    : [];
  const previousByKey = new Map(previous.map((entry) => [`${entry.name}|${entry.source}`, entry]));
  const entries: QueueEntry[] = [];
  for (const trial of trials) {
    const p = paths(trial);
    const targets = loadTargets(trial);
    for (const state of loadState(trial).values()) {
      const target = targets.get(state.name);
      if (target === undefined) continue;
      let status: QueueStatus | null = null;
      if (state.stage === 'invalid') status = 'invalid';
      else if (state.stage === 'done')
        status = !smokeOk(state)
          ? 'smoke-failed'
          : state.verdict === 'same'
            ? 'compiled-checked'
            : 'meaning-differs';
      if (status === null) continue;
      const patchPath = existsSync(p.patch(state.name)) ? p.patch(state.name) : null;
      const source = state.source ?? compilerSource();
      const old = previousByKey.get(`${state.name}|${source}`);
      const patchSha256 =
        patchPath === null
          ? null
          : createHash('sha256').update(readFileSync(patchPath)).digest('hex');
      // A review is kept only for the exact bytes that were reviewed: a recompiled, re-imported
      // or hand-edited patch goes back to waiting.
      const samePatch =
        patchSha256 !== null && old?.patchSha256 !== undefined && old.patchSha256 === patchSha256;
      entries.push({
        name: state.name,
        oracleId: target.oracleId,
        source,
        status,
        handledLines: state.lines,
        patch: patchPath,
        patchSha256,
        trial,
        ...(state.textCheck !== undefined && { textCheck: state.textCheck }),
        ...(state.differences !== undefined &&
          state.differences.length > 0 && { differences: state.differences }),
        ...(status === 'invalid' && { validatorIssues: state.validatorIssues.at(-1) ?? [] }),
        ...(crossDir !== undefined &&
          patchPath !== null &&
          existsSync(`${crossDir}/${slug(state.name)}.json`) && {
            crossCheck: crossCheck(
              target,
              (JSON.parse(readFileSync(patchPath, 'utf8')) as PatchFile).def,
              `${crossDir}/${slug(state.name)}.json`,
            ),
          }),
        ...(state.smoke !== undefined && {
          smokeExercised: state.smoke.some((run) => run.abilityResolved),
          smoke: state.smoke.map((run) => ({
            scenario: run.scenario,
            ok: run.ok,
            abilityResolved: run.abilityResolved,
            detail: run.detail,
          })),
        }),
        review: samePatch ? (old?.review ?? null) : null,
      });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  write(QUEUE_PATH, `${JSON.stringify({ schemaVersion: 1, cards: entries }, null, 2)}\n`);
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  console.log(`${entries.length} cards queued for review:`, Object.fromEntries(counts));
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

async function exec(trial: string, stage: string, executor: string): Promise<void> {
  const p = paths(trial);
  if (executor !== 'api') {
    const { answerPromptsWithAgent, isAgentKind, AGENT_KINDS } = await import('./agent-cli');
    if (!isAgentKind(executor))
      throw new Error(`unknown executor ${executor}; use api, ${AGENT_KINDS.join(', ')}`);
    await answerPromptsWithAgent(
      executor,
      stage,
      p.prefix(stage),
      pendingPrompts(trial, stage),
      `${p.work}/usage.jsonl`,
    );
    return;
  }
  const { answerPrompts } = await import('./provider');
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
        .map((line) => JSON.parse(line) as { stage: string; model: string; costUsd: number | null })
    : [];
  const unpriced = usage.filter((row) => row.costUsd === null);
  if (unpriced.length > 0)
    console.warn(
      `warning: ${unpriced.length} calls used models with no price (${[...new Set(unpriced.map((row) => row.model))].join(', ')}); the measured cost leaves them out`,
    );
  const totalCost = usage.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
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

const argv = process.argv.slice(2);
const executorFlag = argv.indexOf('--executor');
let executor = process.env['CARD_COMPILER_EXECUTOR'] ?? 'api';
if (executorFlag >= 0) {
  const value = argv[executorFlag + 1];
  if (value === undefined)
    throw new Error('--executor needs a value: api, claude, codex or antigravity');
  executor = value;
  argv.splice(executorFlag, 2);
}
const [command, trial, stage] = argv;
if (command === 'audit') {
  audit(argv.slice(1));
  process.exit(0);
}
if (command === 'audit-verdict') {
  review(argv.slice(1));
  process.exit(0);
}
if (trial === undefined)
  throw new Error(
    'usage: run.ts <prepare|exec|check|report|recheck|import|queue> <trial-dir> [stage|patch-dir] [--executor api|claude|codex|antigravity]',
  );
if (command === 'queue') queue(process.argv.slice(3));
else if (command === 'import') {
  if (stage === undefined) throw new Error('usage: run.ts import <trial-dir> <patch-dir>');
  importPatches(trial, stage);
} else if (command === 'prepare') prepare(trial);
else if (command === 'check') check(trial);
else if (command === 'report') report(trial);
else if (command === 'recheck') recheck(trial);
else if (command === 'exec') await exec(trial, stage ?? 'compile', executor);
else throw new Error(`unknown command ${command}`);

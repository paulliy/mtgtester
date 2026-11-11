/**
 * Turns a run directory into the folder and ZIP a judge receives. The bundle is self-contained:
 * instructions, rubric, primer, every position, every model's answers, the scorecard to return,
 * and the raw data. With `blind` on, candidate models are renamed "Model A", "Model B", ... inside
 * the bundle and the key that maps them back is written beside the ZIP, never inside it.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENGINE_VERSION } from '../../packages/engine/src';
import { AI_VERSIONS } from '../../packages/server/src/ai/versions';
import { analyzeCase, type CaseAnalysis } from './analysis';
import type { BenchCase } from './case';
import { modelMetrics } from './metrics';
import {
  caseFileName,
  renderBrief,
  renderCase,
  renderModel,
  renderPrimer,
  renderReadme,
  renderSummary,
  scorecardSchema,
  scorecardTemplate,
  type ReportInput,
} from './report';
import type { ModelResult, TranscriptEntry } from './run';
import { zipArchive, type ZipEntry } from './zip';

export interface RunManifest {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  mode: 'raw' | 'production';
  trials: number;
  caseIds: string[];
  /** Models in the order they were first run, which is the order every table lists them in. */
  modelIds: string[];
  engineVersion: string;
  aiVersions: Record<string, string>;
  gitCommit: string | null;
}

export function newManifest(
  runId: string,
  mode: RunManifest['mode'],
  trials: number,
  cases: readonly BenchCase[],
  gitCommit: string | null,
  createdAt = new Date().toISOString(),
): RunManifest {
  return {
    schemaVersion: 1,
    runId,
    createdAt,
    mode,
    trials,
    caseIds: cases.map((benchCase) => benchCase.id),
    modelIds: [],
    engineVersion: ENGINE_VERSION,
    aiVersions: { ...AI_VERSIONS },
    gitCommit,
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function writeModelResult(
  runDirectory: string,
  result: ModelResult,
  transcripts: readonly TranscriptEntry[],
): void {
  mkdirSync(join(runDirectory, 'results'), { recursive: true });
  mkdirSync(join(runDirectory, 'transcripts'), { recursive: true });
  writeFileSync(join(runDirectory, 'results', `${result.model.id}.json`), json(result));
  writeFileSync(
    join(runDirectory, 'transcripts', `${result.model.id}.jsonl`),
    transcripts.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
  );
}

export function readRun(runDirectory: string): {
  manifest: RunManifest;
  models: ModelResult[];
  transcripts: TranscriptEntry[];
} {
  const manifest = JSON.parse(readFileSync(join(runDirectory, 'run.json'), 'utf8')) as RunManifest;
  const names = readdirSync(join(runDirectory, 'results'))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const models = names.map(
    (name) => JSON.parse(readFileSync(join(runDirectory, 'results', name), 'utf8')) as ModelResult,
  );
  const place = (id: string): number => {
    const index = manifest.modelIds.indexOf(id);
    return index === -1 ? manifest.modelIds.length : index;
  };
  models.sort(
    (left, right) =>
      place(left.model.id) - place(right.model.id) || (left.model.id < right.model.id ? -1 : 1),
  );
  const transcripts = models.flatMap((model) => {
    try {
      return readFileSync(join(runDirectory, 'transcripts', `${model.model.id}.jsonl`), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TranscriptEntry);
    } catch {
      return [];
    }
  });
  return { manifest, models, transcripts };
}

export interface JudgeKey {
  runId: string;
  aliases: Array<{ alias: string; aliasId: string; model: ModelResult['model'] }>;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Rename every model run through a provider; local baselines keep their names. */
export function anonymise(
  models: readonly ModelResult[],
  transcripts: readonly TranscriptEntry[],
): { models: ModelResult[]; transcripts: TranscriptEntry[]; key: JudgeKey['aliases'] } {
  const key: JudgeKey['aliases'] = [];
  const ids = new Map<string, string>();
  const renamed = models.map((result) => {
    if (result.model.kind !== 'llm') return result;
    const letter = LETTERS[key.length] ?? `N${key.length + 1}`;
    const alias = `Model ${letter}`;
    const aliasId = `model-${letter.toLowerCase()}`;
    key.push({ alias, aliasId, model: result.model });
    ids.set(result.model.id, aliasId);
    return {
      ...result,
      // Only what does not identify the model: its thinking setting and output budget.
      model: {
        id: aliasId,
        label: alias,
        kind: 'llm',
        ...(result.model['reasoning'] !== undefined && { reasoning: result.model['reasoning'] }),
        ...(result.model['maxOutputTokens'] !== undefined && {
          maxOutputTokens: result.model['maxOutputTokens'],
        }),
      },
    };
  });
  return {
    models: renamed,
    transcripts: transcripts.map(({ responseModel: _model, backend: _backend, ...entry }) => ({
      ...entry,
      modelId: ids.get(entry.modelId) ?? entry.modelId,
    })),
    key,
  };
}

export interface BundleResult {
  directory: string;
  zipPath: string;
  keyPath: string | null;
  files: number;
  bytes: number;
}

/** Build the judge bundle for everything a run directory holds. */
export async function writeBundle(
  runDirectory: string,
  cases: readonly BenchCase[],
  options: { blind: boolean },
): Promise<BundleResult> {
  const run = readRun(runDirectory);
  const selected = run.manifest.caseIds.map((id) => {
    const benchCase = cases.find((candidate) => candidate.id === id);
    if (benchCase === undefined) throw new Error(`run names case ${id}, which no longer exists`);
    return benchCase;
  });
  const shown = options.blind
    ? anonymise(run.models, run.transcripts)
    : { models: run.models, transcripts: run.transcripts, key: [] };

  const analyses = new Map<string, CaseAnalysis>();
  for (const benchCase of selected) analyses.set(benchCase.id, await analyzeCase(benchCase));

  const input: ReportInput = {
    runId: run.manifest.runId,
    createdAt: run.manifest.createdAt,
    mode: run.manifest.mode,
    trials: run.manifest.trials,
    blind: options.blind,
    cases: selected,
    analyses,
    models: shown.models,
    metrics: shown.models.map((model) => modelMetrics(model, selected, run.manifest.trials)),
  };

  const files = new Map<string, string>([
    ['README.md', renderReadme(input)],
    ['JUDGE_BRIEF.md', renderBrief(input)],
    ['PRIMER.md', renderPrimer()],
    ['SUMMARY.md', renderSummary(input)],
    ['scorecard.template.json', json(scorecardTemplate(input))],
    ['scorecard.schema.json', json(scorecardSchema(input))],
    [
      'data/run.json',
      json({
        ...run.manifest,
        // The manifest's own ids are the real model ids; a blind bundle lists the aliases instead.
        modelIds: shown.models.map((m) => m.model.id),
        blind: options.blind,
        models: shown.models.map((m) => m.model),
      }),
    ],
    [
      'data/cases.json',
      json(
        selected.map((benchCase) => ({ case: benchCase, analysis: analyses.get(benchCase.id) })),
      ),
    ],
    ['data/results.json', json(shown.models)],
    ['data/metrics.json', json(input.metrics)],
    [
      'data/transcripts.jsonl',
      shown.transcripts.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    ],
  ]);
  selected.forEach((benchCase, index) =>
    files.set(`cases/${caseFileName(benchCase, index)}`, renderCase(input, benchCase, index)),
  );
  for (const model of shown.models)
    files.set(`models/${model.model.id}.md`, renderModel(input, model));

  const directory = join(runDirectory, 'bundle');
  rmSync(directory, { recursive: true, force: true });
  const root = `bot-bench-${run.manifest.runId}`;
  const entries: ZipEntry[] = [];
  let bytes = 0;
  for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    const data = Buffer.from(text, 'utf8');
    bytes += data.length;
    entries.push({ path: `${root}/${path}`, data });
  }
  const zipPath = join(runDirectory, `${root}.zip`);
  writeFileSync(zipPath, zipArchive(entries));

  const keyPath = join(runDirectory, 'judge-key.json');
  if (options.blind && shown.key.length > 0) {
    const key: JudgeKey = { runId: run.manifest.runId, aliases: shown.key };
    writeFileSync(keyPath, json(key));
  } else {
    rmSync(keyPath, { force: true });
  }
  return {
    directory,
    zipPath,
    keyPath: options.blind && shown.key.length > 0 ? keyPath : null,
    files: files.size,
    bytes,
  };
}

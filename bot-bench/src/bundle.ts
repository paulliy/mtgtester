/**
 * Turns a run directory into the folder and ZIP a judge receives. The bundle is self-contained:
 * instructions, rubric, primer, every position, every model's answers, the scorecard to return,
 * and the raw data. With `blind` on, candidate models are renamed "Model A", "Model B", ... inside
 * the bundle and the key that maps them back is written beside the ZIP, never inside it.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BOT_POLICY_VERSION } from '../../packages/bot/src';
import { ENGINE_VERSION } from '../../packages/engine/src';
import { PROVIDERS } from '../../packages/server/src/ai/config';
import { primerCatalog } from '../../packages/server/src/ai/primer';
import { AI_VERSIONS } from '../../packages/server/src/ai/versions';
import { analyzeCase, type CaseAnalysis } from './analysis';
import type { BenchCase } from './case';
import { modelMetrics } from './metrics';
import { isCandidate, isRemoteKind } from './models';
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
  /**
   * What the run measured against: the cases as written, the live primer, the engine and the AI
   * versions. Models are only added to a run whose fingerprint still matches.
   */
  fingerprint: string;
  /** Set when the saved play was graded again against later references (`bot-bench rescore`). */
  rescoredAt?: string;
  /**
   * The heuristic bot's policy version. From ADR 0043 on, `local:heuristic` is the card-aware bot
   * (`local:heuristic-plain` is the old baseline); a run without this field predates that, and its
   * `local:heuristic` results are the plain bot's and not comparable with newer runs.
   */
  botPolicyVersion?: string;
}

/** A hash of everything a measurement depends on besides the model, for `run --out`. */
export function benchFingerprint(cases: readonly BenchCase[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        cases,
        primer: primerCatalog(),
        engineVersion: ENGINE_VERSION,
        aiVersions: AI_VERSIONS,
        botPolicyVersion: BOT_POLICY_VERSION,
      }),
    )
    .digest('hex');
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
    fingerprint: benchFingerprint(cases),
    botPolicyVersion: BOT_POLICY_VERSION,
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
/**
 * Fields that hold free text a provider or the pipeline wrote, where a model's name can appear
 * (a timeout message names the model; a raw answer may introduce itself). Only these are redacted:
 * identifiers such as a case id or an action key are left alone, so a model id that happens to
 * appear in one (`turn` in `land-for-the-turn`) cannot corrupt it.
 */
const FREE_TEXT = new Set([
  'error',
  'failure',
  'raw',
  'rawResponse',
  'note',
  'abortReason',
  // A strategist's own words: its intent and planned steps.
  'intent',
  'plannedActions',
  // A transcript's prompt text, which carries the strategist's words into the tactician's prompt.
  'content',
]);

/** Regex special characters, escaped so a model name can be matched literally. */
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches a name however it is punctuated and capitalised: `claude-haiku-5.5` also matches
 * `Claude Haiku 5.5`, so a model that spells its own name differently still cannot give itself away.
 */
function nameRegex(name: string): RegExp {
  const parts = name.split(/[-_./ ]+/).filter((part) => part.length > 0);
  return new RegExp(parts.map(escapeRegex).join('[-_./ ]?'), 'gi');
}

/** Replaces each name with its alias in the free-text fields anywhere inside `value`. */
function redact<T>(value: T, names: ReadonlyArray<readonly [RegExp, string]>): T {
  const scrub = (text: string): string =>
    names.reduce((out, [pattern, alias]) => out.replace(pattern, alias), text);
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, field]) => [
          key,
          FREE_TEXT.has(key) && typeof field === 'string'
            ? scrub(field)
            : FREE_TEXT.has(key) && Array.isArray(field)
              ? field.map((part: unknown) => (typeof part === 'string' ? scrub(part) : walk(part)))
              : walk(field),
        ]),
      );
    return item;
  };
  return walk(value) as T;
}

/** The base URL of a provider preset, for naming its host in a blind bundle. */
function providerUrl(provider: unknown): string | undefined {
  return typeof provider === 'string' ? PROVIDERS[provider]?.baseUrl : undefined;
}

/** Every way a provider URL names its host: `https://openrouter.ai/api/v1` gives openrouter.ai and openrouter. */
function hostNames(baseUrl: unknown): string[] {
  if (typeof baseUrl !== 'string') return [];
  try {
    const labels = new URL(baseUrl).hostname.split('.');
    return [labels.join('.'), labels.slice(-2).join('.'), labels.at(-2) ?? ''];
  } catch {
    return [];
  }
}

/**
 * Rename every model run through a provider; local baselines keep their names. With a `seed`
 * (the run id) the letters are handed out in a fixed shuffled order, so "Model A" is not simply
 * the first model in the lineup and two settings of one model are not neighbours.
 */
export function anonymise(
  models: readonly ModelResult[],
  transcripts: readonly TranscriptEntry[],
  seed?: string,
  /**
   * The run's earlier key. A model it already names keeps its alias, and its letters are never
   * handed to another model: scorecards judges returned for an earlier bundle must still resolve
   * to the same models after `run --out` adds more (`collate` reads the latest key).
   */
  previous: JudgeKey['aliases'] = [],
): { models: ModelResult[]; transcripts: TranscriptEntry[]; key: JudgeKey['aliases'] } {
  const key: JudgeKey['aliases'] = [];
  const kept = new Map(previous.map((entry) => [entry.model.id, entry]));
  const taken = new Set(previous.map((entry) => entry.aliasId));
  const freshLetter = (): string => {
    for (let index = 0; ; index++) {
      const letter = LETTERS[index] ?? `N${index + 1}`;
      if (!taken.has(`model-${letter.toLowerCase()}`)) {
        taken.add(`model-${letter.toLowerCase()}`);
        return letter;
      }
    }
  };
  const ids = new Map<string, string>();
  // Every way a model or its provider can be named: the model string and each half of it
  // (vendor and short name), its id and label, what the provider reported it as, and the
  // provider's own name and host. An error message that names any of them cannot give it away.
  const names: Array<[string, string]> = [];
  const nameAs = (name: unknown, alias: string, minimum = 3): void => {
    if (typeof name === 'string' && name.length >= minimum) names.push([name, alias]);
  };
  const llm = models.filter((result) => isCandidate(result.model));
  const rank = (id: string): string => createHash('sha256').update(`${seed}:${id}`).digest('hex');
  const turn =
    seed === undefined
      ? llm
      : [...llm].sort((left, right) => (rank(left.model.id) < rank(right.model.id) ? -1 : 1));
  // A strategist or a remote tactician that sits in several cells of a grid gets one alias of its
  // own, so a judge can still read the grid ("Tactician B behind Strategist A") without names.
  const roleAliases = new Map<string, string>();
  const roleAlias = (role: 'Strategist' | 'Tactician', id: string): string => {
    const key = `${role}:${id}`;
    let alias = roleAliases.get(key);
    if (alias === undefined) {
      const used = [...roleAliases.keys()].filter((k) => k.startsWith(`${role}:`)).length;
      alias = `${role} ${LETTERS[used] ?? `N${used + 1}`}`;
      roleAliases.set(key, alias);
    }
    return alias;
  };
  const nameModel = (fields: Record<string, unknown>, alias: string): void => {
    const modelName = fields['model'];
    nameAs(modelName, alias);
    if (typeof modelName === 'string' && modelName.includes('/')) {
      const [vendor = '', ...rest] = modelName.split('/');
      nameAs(vendor, alias, 4);
      nameAs(rest.join('/'), alias, 4);
    }
    nameAs(fields['label'], alias);
    nameAs(fields['provider'], 'the provider', 4);
    for (const host of hostNames(fields['baseUrl'] ?? providerUrl(fields['provider'])))
      nameAs(host, 'the provider', 4);
  };
  const renamedBy = new Map<string, ModelResult>();
  for (const result of turn) {
    const earlier = kept.get(result.model.id);
    const letter = earlier === undefined ? freshLetter() : null;
    const alias = earlier?.alias ?? `Model ${letter}`;
    const aliasId = earlier?.aliasId ?? `model-${String(letter).toLowerCase()}`;
    key.push({ alias, aliasId, model: result.model });
    ids.set(result.model.id, aliasId);
    const modelName = result.model['model'];
    nameAs(modelName, alias);
    if (typeof modelName === 'string' && modelName.includes('/')) {
      const [vendor = '', ...rest] = modelName.split('/');
      nameAs(vendor, alias, 4);
      nameAs(rest.join('/'), alias, 4);
    }
    nameAs(result.model.label, alias);
    nameAs(result.model.id, aliasId);
    nameAs(result.model['provider'], 'the provider', 4);
    for (const host of hostNames(result.model['baseUrl'] ?? providerUrl(result.model['provider'])))
      nameAs(host, 'the provider', 4);
    const strategist = result.model['strategist'] as Record<string, unknown> | undefined;
    const strategistAlias =
      strategist?.['kind'] === 'llm'
        ? roleAlias('Strategist', String(strategist['id']))
        : undefined;
    if (strategist !== undefined && strategistAlias !== undefined) {
      nameModel(strategist, strategistAlias);
      nameAs(strategist['id'], strategistAlias);
    }
    const tactician = result.model['tactician'] as { id?: string; label?: string } | undefined;
    const tacticianAlias =
      tactician !== undefined && isRemoteKind(result.model.kind)
        ? roleAlias('Tactician', String(tactician.id))
        : undefined;
    if (tacticianAlias !== undefined && tactician !== undefined) {
      nameAs(tactician.label, tacticianAlias);
      nameAs(tactician.id, tacticianAlias);
    }
    for (const entry of transcripts)
      if (entry.modelId === result.model.id) {
        nameAs(
          entry.responseModel,
          entry.role === 'strategist' ? (strategistAlias ?? alias) : alias,
        );
        nameAs(entry.backend, 'the provider');
      }
    renamedBy.set(result.model.id, {
      ...result,
      // Only what does not identify the model: its thinking setting and output budget.
      model: {
        id: aliasId,
        label: alias,
        kind: result.model.kind,
        ...(result.model['reasoning'] !== undefined && { reasoning: result.model['reasoning'] }),
        // A decision model's settings change what it was asked, not who it is.
        ...(result.model['unsupported'] !== undefined && {
          unsupported: result.model['unsupported'],
        }),
        ...(result.model['expandTargets'] !== undefined && {
          expandTargets: result.model['expandTargets'],
        }),
        ...(result.model['maxOutputTokens'] !== undefined && {
          maxOutputTokens: result.model['maxOutputTokens'],
        }),
        // The pair's shape survives: which strategist kind, under which alias, at which effort.
        ...(strategist !== undefined && {
          strategist:
            strategistAlias === undefined
              ? { id: strategist['id'], kind: strategist['kind'], label: strategist['label'] }
              : {
                  id: strategistAlias.toLowerCase().replace(' ', '-'),
                  kind: 'llm',
                  label: strategistAlias,
                  ...(strategist['reasoning'] !== undefined && {
                    reasoning: strategist['reasoning'],
                  }),
                },
        }),
        ...(tactician !== undefined && {
          tactician:
            tacticianAlias === undefined
              ? tactician
              : { id: tacticianAlias.toLowerCase().replace(' ', '-'), label: tacticianAlias },
        }),
      },
    });
  }
  // A model the earlier key named that has since left the run keeps its entry, so its alias still
  // resolves for scorecards already returned and its letter is never handed to another model.
  const present = new Set(llm.map((result) => result.model.id));
  for (const entry of previous) if (!present.has(entry.model.id)) key.push(entry);
  // Longest first, so a name that contains another is replaced whole.
  names.sort((a, b) => b[0].length - a[0].length);
  const patterns = names.map(([name, alias]) => [nameRegex(name), alias] as const);
  const renamed = models.map((result) => renamedBy.get(result.model.id) ?? result);
  // Shuffled letters are listed in letter order, with the baselines ahead of the candidates.
  const ordered =
    seed === undefined
      ? renamed
      : [
          ...renamed.filter((result) => !isCandidate(result.model)),
          ...renamed
            .filter((result) => isCandidate(result.model))
            .sort((left, right) => (left.model.id < right.model.id ? -1 : 1)),
        ];
  return {
    models: ordered.map(({ model, ...rest }) => ({ model, ...redact(rest, patterns) })),
    transcripts: transcripts.map(({ responseModel: _model, backend: _backend, ...entry }) =>
      redact({ ...entry, modelId: ids.get(entry.modelId) ?? entry.modelId }, patterns),
    ),
    key,
  };
}

/**
 * The aliases a run's earlier key assigned, with any model that has since left the run kept too,
 * so its letter is never reused. A key from another run (a copied directory) is ignored.
 */
function previousAliases(keyPath: string, run: ReturnType<typeof readRun>): JudgeKey['aliases'] {
  let key: JudgeKey;
  try {
    key = JSON.parse(readFileSync(keyPath, 'utf8')) as JudgeKey;
  } catch {
    return [];
  }
  return key.runId === run.manifest.runId && Array.isArray(key.aliases) ? key.aliases : [];
}

export interface BundleResult {
  directory: string;
  zipPath: string;
  keyPath: string | null;
  files: number;
  bytes: number;
  /** Blind bundles only: a model's name found anywhere in the bundle after redaction. Should be empty. */
  leaks: Array<{ file: string; name: string }>;
}

/** Names that identify a model: its model string, each half of it, and its provider's host. */
export function identifyingNames(model: ModelResult['model']): string[] {
  const own = (fields: Record<string, unknown>): string[] => {
    const modelName = fields['model'];
    const parts = typeof modelName === 'string' ? [modelName, ...modelName.split('/')] : [];
    const provider = typeof fields['provider'] === 'string' ? [fields['provider']] : [];
    const hosts = hostNames(fields['baseUrl'] ?? providerUrl(fields['provider']));
    return [...parts, ...hosts, ...provider];
  };
  const strategist = model['strategist'] as Record<string, unknown> | undefined;
  const theirs = strategist?.['kind'] === 'llm' ? own(strategist) : [];
  return [...new Set([...own(model), ...theirs])].filter((name) => name.length >= 4);
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
  const keyPath = join(runDirectory, 'judge-key.json');
  const shown = options.blind
    ? anonymise(run.models, run.transcripts, run.manifest.runId, previousAliases(keyPath, run))
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
    ['PRIMER.md', renderPrimer(input)],
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
  // A blind bundle is checked, not trusted: every identifying name is searched for in every file.
  const leaks: BundleResult['leaks'] = [];
  if (options.blind)
    for (const entry of shown.key)
      for (const name of identifyingNames(entry.model))
        for (const [path, text] of files)
          if (new RegExp(nameRegex(name)).test(text)) leaks.push({ file: path, name });
  const zipPath = join(runDirectory, `${root}.zip`);
  writeFileSync(zipPath, zipArchive(entries));

  // A bundle with real names needs no key, but an existing one is kept: it maps the aliases in
  // bundles already sent to judges, and a later blind rebuild must reuse them.
  if (options.blind && shown.key.length > 0) {
    const key: JudgeKey = { runId: run.manifest.runId, aliases: shown.key };
    writeFileSync(keyPath, json(key));
  }
  return {
    directory,
    zipPath,
    keyPath: options.blind && shown.key.length > 0 ? keyPath : null,
    files: files.size,
    bytes,
    leaks,
  };
}

/**
 * The pages a judge reads. Every page is built from the run's data and from the live production
 * code (the primer catalog, the prompt assembler), never from a copy, so a bundle always shows
 * what the models were actually sent.
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_AI_CONFIG } from '../../packages/server/src/ai/config';
import { assemblePrompt } from '../../packages/server/src/ai/context';
import { primerCatalog, tacticianPrimerSectionIds } from '../../packages/server/src/ai/primer';
import { AI_VERSIONS } from '../../packages/server/src/ai/versions';
import type { CaseAnalysis, OptionRow, TurnAnalysis } from './analysis';
import { describeChanges } from './analysis';
import { GRADE_POINTS, type BenchCase, type SingleReference, type TurnReference } from './case';
import { cell, foldRepeats, meaningfulActions, renderPosition } from './describe';
import { DECISIONS_PER_GAME, type CostMetrics, type ModelMetrics } from './metrics';
import type { CaseResult, ModelResult } from './run';

const JUDGE_DIRECTORY = new URL('../judge/', import.meta.url);

export interface ReportInput {
  runId: string;
  createdAt: string;
  mode: string;
  trials: number;
  blind: boolean;
  cases: readonly BenchCase[];
  analyses: ReadonlyMap<string, CaseAnalysis>;
  models: readonly ModelResult[];
  metrics: readonly ModelMetrics[];
}

// ── Formatting ─────────────────────────────────────────────────────────────────────────────────

export function percent(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

export function milliseconds(value: number | null): string {
  if (value === null) return 'n/a';
  if (value < 1) return '<1 ms';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}

export function dollars(value: number | null): string {
  if (value === null) return 'unknown';
  if (value === 0) return '$0';
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(3)}`;
}

/** A total that is only a lower bound when some billed decisions have no price. */
function totalCost(cost: CostMetrics): string {
  return cost.source === 'partial' ? `at least ${dollars(cost.totalUsd)}` : dollars(cost.totalUsd);
}

/** The cost source, with how many billed decisions had no price when that is the case. */
function costSourceText(cost: CostMetrics): string {
  return cost.source === 'partial'
    ? `partial (${cost.unpricedDecisions} decision${cost.unpricedDecisions === 1 ? '' : 's'} unpriced; averages from priced ones)`
    : cost.source;
}

function count(value: number | null): string {
  return value === null ? 'n/a' : String(Math.round(value));
}

function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

function fence(text: string): string {
  // A fence longer than any run of backticks inside the text, so nothing can close it early.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
}

export function caseFileName(benchCase: BenchCase, index: number): string {
  return `${String(index + 1).padStart(2, '0')}-${benchCase.id}.md`;
}

/** Candidates are the models being chosen between; local policies are calibration only. */
export function isCandidate(model: ModelResult['model'], models: readonly ModelResult[]): boolean {
  return model.kind === 'llm' || models.every((other) => other.model.kind !== 'llm');
}

function firstTrial(model: ModelResult, caseId: string): CaseResult | undefined {
  return model.cases.find((entry) => entry.caseId === caseId && entry.trial === 1);
}

function trialsOf(model: ModelResult, caseId: string): CaseResult[] {
  return model.cases.filter((entry) => entry.caseId === caseId);
}

function gradeWord(result: CaseResult | undefined, benchCase: BenchCase): string {
  if (result === undefined) return 'not played';
  if (benchCase.scope === 'turn') return percent(result.score.score);
  const decision = result.run.decisions[0];
  if (
    decision === undefined ||
    decision.invalid !== undefined ||
    decision.source === 'fallback' ||
    result.score.graded === undefined
  )
    return 'NO LEGAL ANSWER';
  const grade = result.score.graded.grade;
  return grade === 'best' || grade === 'blunder' ? grade.toUpperCase() : grade;
}

function sequenceOf(result: CaseResult): string[] {
  return meaningfulActions(result.run.decisions.map((decision) => decision.action));
}

// ── PRIMER.md ──────────────────────────────────────────────────────────────────────────────────

export function renderPrimer(): string {
  const sections = primerCatalog().filter((section) => section.role === 'tactician');
  return [
    '# Primer',
    '',
    readFileSync(new URL('GAME_PRIMER.md', JUDGE_DIRECTORY), 'utf8').trim(),
    '',
    '## The instructions the models were given',
    '',
    `These are the production tactician primer sections (\`${AI_VERSIONS.tacticianPrimer}\`), read from the product's source when this bundle was built. Every decision gets the first section; the others are added only when the decision needs them. They form the system message. The user message is the position as compact JSON (context \`${AI_VERSIONS.context}\`); each case page shows the exact messages for its decision.`,
    '',
    ...sections.flatMap((section) => [
      `### ${section.title}`,
      '',
      `Sent when: ${section.appliesWhen}.`,
      '',
      fence(section.text),
      '',
    ]),
    '## How to read the position JSON',
    '',
    '- `ctx`: turn, phase, step, active player (`ap`), deciding player (`dp`) and the prompt.',
    '- `you`: the tested seat: life, available mana, mana sources, graveyard, and its hand with full card text.',
    '- `opponents`: each other seat: life, hand size, library size, commander damage dealt, graveyard.',
    '- `battlefield`: every permanent with controller, tapped state, power/toughness, keywords and rules text (sent once per card name).',
    '- `stack`, `recentLog`: what is waiting to resolve and what just happened.',
    '- `legalActions`: the menu. The reply must name one `id` from it.',
    '',
  ].join('\n');
}

// ── JUDGE_BRIEF.md ─────────────────────────────────────────────────────────────────────────────

export function renderBrief(input: ReportInput): string {
  const candidates = input.models.filter((model) => isCandidate(model.model, input.models));
  const baselines = input.models.filter((model) => !isCandidate(model.model, input.models));
  const single = input.cases.filter((benchCase) => benchCase.scope === 'single').length;
  const values: Record<string, string> = {
    RUN_LINE: `run \`${input.runId}\`, ${input.createdAt.slice(0, 10)}, ${input.cases.length} cases, ${input.trials} trial${input.trials === 1 ? '' : 's'} per case, mode \`${input.mode}\` (${
      input.mode === 'raw'
        ? 'every decision goes to the model'
        : 'decisions with one sensible answer are answered locally before the model is asked'
    }).`,
    CANDIDATES: candidates
      .map((model) => `**${model.model.label}** (\`${model.model.id}\`)`)
      .join(', '),
    BASELINE_NOTE:
      baselines.length === 0
        ? 'This run has no separate baselines.'
        : `Baselines, shown for calibration and not to be scored: ${baselines
            .map((model) => `**${model.model.label}** (\`${model.model.id}\`)`)
            .join(
              ', ',
            )}. The heuristic baseline is the non-model bot the product falls back to when a model fails; a candidate that does not play better than it adds nothing.`,
    BLIND_NOTE: !input.models.some((model) => model.model.kind === 'llm')
      ? 'This run holds only local policies, which are not language models; they are named as they are.'
      : input.blind
        ? 'The candidates are anonymised. An alias such as "Model A" is all you should know about a model.'
        : 'Model names are shown. Score what the model did in this bundle, not its reputation.',
    SINGLE_COUNT: String(single),
    TURN_COUNT: String(input.cases.length - single),
    DECISIONS_PER_GAME: String(DECISIONS_PER_GAME),
    TIMEOUT_SECONDS: String(DEFAULT_AI_CONFIG.tactician.requestTimeoutMs / 1000),
  };
  return readFileSync(new URL('JUDGE_BRIEF.md', JUDGE_DIRECTORY), 'utf8').replace(
    /\{\{([A-Z_]+)\}\}/g,
    (whole, key: string) => values[key] ?? whole,
  );
}

// ── SUMMARY.md ─────────────────────────────────────────────────────────────────────────────────

function metricTables(input: ReportInput): string[] {
  const label = (metrics: ModelMetrics): string =>
    `${metrics.label}${metrics.status === 'aborted' ? ' (stopped early)' : ''}`;
  const { metrics } = input;
  return [
    '## Accuracy',
    '',
    'Mean harness score per case, 0 to 100%. One-decision grades count `best` / `good` / `weak` / `blunder` / no legal answer.',
    '',
    table(
      [
        'Model',
        'Overall',
        'One-decision',
        'Whole-turn',
        'best / good / weak / blunder / none',
        'Turn objectives met',
        'Cases played',
      ],
      metrics.map((m) => [
        label(m),
        percent(m.accuracy.overall),
        percent(m.accuracy.single),
        percent(m.accuracy.turn),
        `${m.accuracy.grades.best} / ${m.accuracy.grades.good} / ${m.accuracy.grades.weak} / ${m.accuracy.grades.blunder} / ${m.accuracy.grades.noAnswer}`,
        `${m.accuracy.objectivesMet} of ${m.accuracy.objectivesTotal}`,
        `${m.accuracy.casesPlayed} of ${m.accuracy.casesExpected}`,
      ]),
    ),
    '',
    '### Reliability (part of accuracy)',
    '',
    'How often the model produced a usable answer by itself. A corrective retry is a second request after an illegal or unreadable answer; a fallback means the heuristic bot had to play the decision.',
    '',
    table(
      [
        'Model',
        'Decisions',
        'Legal on first try',
        'Corrective retries',
        'Fallbacks',
        'Refused answers',
        'Provider errors',
        'Turns cut off',
        'Same answer across trials',
      ],
      metrics.map((m) => [
        label(m),
        String(m.reliability.decisions),
        `${m.reliability.firstTryLegal} (${percent(m.reliability.decisions === 0 ? null : m.reliability.firstTryLegal / m.reliability.decisions)})`,
        String(m.reliability.correctiveRetries),
        String(m.reliability.fallbacks),
        String(m.reliability.refused),
        String(m.reliability.providerErrors),
        String(m.reliability.decisionCaps),
        m.reliability.consistency === null ? 'one trial' : percent(m.reliability.consistency),
      ]),
    ),
    '',
    '## Speed',
    '',
    'Wall-clock time per decision as the harness measured it, retries included.',
    '',
    table(
      [
        'Model',
        'Decisions timed',
        'Median',
        '90th percentile',
        'Mean',
        'Slowest',
        'Mean time for a whole turn',
      ],
      metrics.map((m) => [
        label(m),
        String(m.speed.decisions),
        milliseconds(m.speed.p50Ms),
        milliseconds(m.speed.p90Ms),
        milliseconds(m.speed.meanMs),
        milliseconds(m.speed.maxMs),
        milliseconds(m.speed.meanTurnMs),
      ]),
    ),
    '',
    '## Cost',
    '',
    `Source says where the dollar figures come from: \`reported\` by the provider, \`estimated\` from the price list given to the harness, \`unknown\`, or \`free\` (no model call). The game projection is cost per decision times ${DECISIONS_PER_GAME}.`,
    '',
    table(
      [
        'Model',
        'Total',
        'Source',
        'Per decision',
        `Per ${DECISIONS_PER_GAME} decisions`,
        'Prompt tokens / decision',
        'Output tokens / decision',
        'Provider requests',
      ],
      metrics.map((m) => [
        label(m),
        totalCost(m.cost),
        costSourceText(m.cost),
        dollars(m.cost.perDecisionUsd),
        dollars(m.cost.perGameUsd),
        count(m.cost.promptTokensPerDecision),
        count(m.cost.responseTokensPerDecision),
        String(m.cost.providerRequests),
      ]),
    ),
    '',
  ];
}

interface AnswerGroup {
  key: string;
  text: string;
  word: string;
  score: number;
  models: string[];
}

function answerGroups(input: ReportInput, benchCase: BenchCase): AnswerGroup[] {
  const groups = new Map<string, AnswerGroup>();
  for (const model of input.models) {
    const result = firstTrial(model, benchCase.id);
    if (result === undefined) continue;
    const sequence = sequenceOf(result);
    const text =
      benchCase.scope === 'single'
        ? (result.run.decisions[0]?.action ?? 'no answer')
        : sequence.length === 0
          ? 'passed the whole turn'
          : foldRepeats(sequence).join('; then ');
    const word = gradeWord(result, benchCase);
    const key = `${word}|${benchCase.scope === 'single' ? (result.run.decisions[0]?.actionKey ?? '') : sequence.join('|')}`;
    const group = groups.get(key) ?? { key, text, word, score: result.score.score, models: [] };
    group.models.push(model.model.label);
    groups.set(key, group);
  }
  // Best first, so the reader meets the right answer before the mistakes.
  return [...groups.values()].sort((left, right) => right.score - left.score);
}

export function renderSummary(input: ReportInput): string {
  const out: string[] = [
    '# Summary: every model side by side',
    '',
    `Run \`${input.runId}\`. ${input.cases.length} cases, ${input.trials} trial${input.trials === 1 ? '' : 's'} each, mode \`${input.mode}\`.`,
    '',
  ];
  for (const model of input.models)
    if (model.status === 'aborted')
      out.push(
        `> **${model.model.label} stopped early:** ${model.abortReason ?? 'unknown reason'}. Its numbers cover only the cases it played.`,
        '',
      );
  out.push(...metricTables(input));

  out.push(
    '## What each model did, case by case',
    '',
    'One-decision cases show the reference grade of the answer; whole-turn cases show the share of objective points. Each case name links to its page.',
    '',
    table(
      ['Case', 'Kind', ...input.models.map((model) => model.model.label)],
      input.cases.map((benchCase, index) => [
        `[${benchCase.id}](cases/${caseFileName(benchCase, index)})`,
        benchCase.scope === 'single' ? 'one decision' : 'whole turn',
        ...input.models.map((model) => gradeWord(firstTrial(model, benchCase.id), benchCase)),
      ]),
    ),
    '',
    '## Where the models disagreed',
    '',
  );
  const agreed: string[] = [];
  input.cases.forEach((benchCase, index) => {
    const groups = answerGroups(input, benchCase);
    if (groups.length <= 1) {
      const only = groups[0];
      agreed.push(
        `- [${benchCase.id}](cases/${caseFileName(benchCase, index)}): ${only === undefined ? 'not played' : `\`${only.word}\` ${only.text}`}`,
      );
      return;
    }
    out.push(
      `**[${benchCase.id}](cases/${caseFileName(benchCase, index)})**: ${benchCase.title}`,
      '',
    );
    for (const group of groups)
      out.push(`- \`${group.word}\` ${group.text}: ${group.models.join(', ')}`);
    out.push('');
  });
  if (agreed.length === input.cases.length)
    out.push('Every model made the same choices in every case.', '');
  if (agreed.length > 0)
    out.push('### Cases where every model did the same thing', '', ...agreed, '');
  return out.join('\n');
}

// ── cases/*.md ─────────────────────────────────────────────────────────────────────────────────

const OPTION_ROWS_SHOWN = 30;

function optionTable(
  input: ReportInput,
  benchCase: BenchCase,
  options: readonly OptionRow[],
  exhaustive: boolean,
): string[] {
  const chosenBy = new Map<string, string[]>();
  for (const model of input.models)
    for (const result of trialsOf(model, benchCase.id)) {
      const key = result.run.decisions[0]?.actionKey;
      if (key === undefined) continue;
      const names = chosenBy.get(key) ?? [];
      if (!names.includes(model.model.label)) names.push(model.model.label);
      chosenBy.set(key, names);
    }
  const everything = options.length <= OPTION_ROWS_SHOWN;
  const shown = everything
    ? options
    : options.filter(
        (option) => option.graded.label !== 'Unlisted answer' || chosenBy.has(option.key),
      );
  const out = [
    exhaustive
      ? `The engine played out all ${options.length} distinct legal answers to this decision.${
          everything
            ? ''
            : ` The table shows the ${shown.length} that the reference names or a model chose; the rest are in \`data/cases.json\`.`
        }`
      : 'There are too many legal answers to play them all; the table shows the ones the reference names and the ones a model chose.',
    '',
    table(
      [
        'Answer',
        'Grade',
        'Why (reference)',
        'What happened when the engine played it',
        'Chosen by',
      ],
      shown.map((option) => [
        option.action,
        option.graded.grade === 'best' || option.graded.grade === 'blunder'
          ? `**${option.graded.grade.toUpperCase()}**`
          : option.graded.grade,
        option.graded.why,
        option.legal ? option.changes.join('; ') : 'the engine refused this answer',
        (chosenBy.get(option.key) ?? []).join(', ') || '-',
      ]),
    ),
    '',
  ];
  if (!everything) {
    const hidden = options.filter((option) => !shown.includes(option));
    const tally = new Map<string, number>();
    for (const option of hidden)
      tally.set(option.graded.grade, (tally.get(option.graded.grade) ?? 0) + 1);
    out.push(
      `Not shown: ${[...tally].map(([grade, total]) => `${total} graded \`${grade}\``).join(', ')} (${cell((benchCase.reference as SingleReference).otherwise.why)}).`,
      '',
    );
  }
  return out;
}

function departure(reference: TurnAnalysis, result: CaseResult): string {
  const mine = sequenceOf(result);
  const best = reference.lines
    .filter((line) => line.line.grade === 'best')
    .map((line) => meaningfulActions(line.actions));
  let closest: { line: string[]; shared: number } | undefined;
  for (const line of best) {
    let shared = 0;
    while (shared < line.length && shared < mine.length && line[shared] === mine[shared])
      shared += 1;
    if (closest === undefined || shared > closest.shared) closest = { line, shared };
  }
  if (closest === undefined) return '';
  const { line, shared } = closest;
  if (shared === line.length && mine.length === line.length)
    return 'Follows a best reference line exactly.';
  if (shared === line.length)
    return `Follows a best reference line, then also: ${mine.slice(shared).join('; then ')}.`;
  const played = mine[shared];
  return `Leaves the best reference line at step ${shared + 1}: the line plays \`${line[shared]}\`, the model ${
    played === undefined ? 'stopped acting' : `played \`${played}\``
  }.`;
}

function singleModelTable(input: ReportInput, benchCase: BenchCase): string[] {
  const rows: string[][] = [];
  for (const model of input.models)
    for (const result of trialsOf(model, benchCase.id)) {
      const decision = result.run.decisions[0];
      rows.push([
        `${model.model.label}${input.trials > 1 ? ` (trial ${result.trial})` : ''}`,
        decision === undefined
          ? 'no answer'
          : decision.invalid !== undefined
            ? `refused (${decision.invalid}); the table then played: ${decision.action}`
            : decision.action,
        gradeWord(result, benchCase),
        decision?.source ?? '-',
        milliseconds(decision?.latencyMs ?? null),
        decision?.promptTokens === undefined
          ? '-'
          : `${decision.promptTokens} / ${decision.responseTokens ?? 0}`,
        decision === undefined || decision.requests === 0
          ? '$0'
          : dollars(decision.costUsd ?? null),
        decision?.note ?? '',
      ]);
    }
  return [
    table(
      [
        'Model',
        'Answer',
        'Grade',
        'Answered by',
        'Time',
        'Tokens in / out',
        'Cost',
        'Reason the model gave',
      ],
      rows,
    ),
    '',
    "`Answered by`: `model` is the model's first reply, `model-retry` its reply after being told the first was illegal, `fallback` the heuristic bot after the model failed twice, `local` a baseline policy.",
    '',
  ];
}

function turnModelSections(
  input: ReportInput,
  benchCase: BenchCase,
  analysis: TurnAnalysis,
): string[] {
  const reference = benchCase.reference as TurnReference;
  const played = input.models.filter((model) => firstTrial(model, benchCase.id) !== undefined);
  const out: string[] = [
    '### Objectives met',
    '',
    table(
      ['Objective (points)', ...played.map((model) => model.model.label)],
      [
        ...reference.objectives.map((objective) => [
          `${objective.label} (${objective.points})`,
          ...played.map((model) =>
            firstTrial(model, benchCase.id)?.score.objectives?.find((o) => o.id === objective.id)
              ?.met === true
              ? 'yes'
              : 'NO',
          ),
        ]),
        [
          '**Harness score**',
          ...played.map(
            (model) => `**${percent(firstTrial(model, benchCase.id)?.score.score ?? null)}**`,
          ),
        ],
      ],
    ),
    '',
    '### Action sequences',
    '',
    'Priority passes are left out; each model page has the full decision list.',
    '',
  ];
  for (const model of played) {
    const result = firstTrial(model, benchCase.id)!;
    const total = result.run.decisions.reduce((sum, decision) => sum + decision.latencyMs, 0);
    const sequence = foldRepeats(sequenceOf(result));
    out.push(
      `**${model.model.label}**: ${percent(result.score.score)}, ${result.run.decisions.length} decisions, ${milliseconds(total)}`,
      '',
      ...(sequence.length === 0
        ? ['1. (passed the whole turn)']
        : sequence.map((action, index) => `${index + 1}. ${action}`)),
      '',
      `- ${departure(analysis, result)}`,
      `- Result: ${describeChanges(result.run.before, result.run.after, benchCase.actor).join('; ')}.`,
      ...(result.score.flags.length > 0 ? [`- Flags: ${result.score.flags.join('; ')}.`] : []),
      ...trialsOf(model, benchCase.id)
        .filter((other) => other.trial > 1)
        .map(
          (other) =>
            `- Trial ${other.trial}: ${percent(other.score.score)}: ${foldRepeats(sequenceOf(other)).join('; then ') || 'passed the whole turn'}.`,
        ),
      '',
    );
  }
  return out;
}

export function renderCase(input: ReportInput, benchCase: BenchCase, index: number): string {
  const analysis = input.analyses.get(benchCase.id);
  if (analysis === undefined) throw new Error(`${benchCase.id}: no analysis`);
  const { request, view, names } = analysis.focus;
  const prompt = assemblePrompt(request, view, { strategy: null, recentDecisions: [] });
  const out: string[] = [
    `# Case ${index + 1}: ${benchCase.title}`,
    '',
    `\`${benchCase.id}\` · ${benchCase.scope === 'single' ? 'one decision' : 'whole turn'} · skills: ${benchCase.skills.join(', ')}`,
    '',
    '## What this case tests',
    '',
    benchCase.briefing,
    '',
    benchCase.scope === 'single'
      ? '## The position and the decision'
      : '## The position at the start of the turn',
    '',
    renderPosition(request, view, names),
    '## Reference analysis',
    '',
    'Not shown to the models.',
    '',
    benchCase.reference.analysis,
    '',
  ];
  if (analysis.scope === 'single') {
    out.push(...optionTable(input, benchCase, analysis.options, analysis.exhaustive));
    out.push('## What each model answered', '', ...singleModelTable(input, benchCase));
  } else {
    const reference = benchCase.reference as TurnReference;
    out.push(
      '### Objectives',
      '',
      ...reference.objectives.map(
        (objective) =>
          `- ${objective.label} (${objective.points} point${objective.points === 1 ? '' : 's'})`,
      ),
      '',
      '### Reference lines, replayed by the engine',
      '',
      table(
        ['Line', 'Grade', 'Harness score', 'Actions', 'Result', 'Why'],
        analysis.lines.map((line) => [
          line.line.label,
          line.line.grade === 'best' || line.line.grade === 'blunder'
            ? `**${line.line.grade.toUpperCase()}**`
            : line.line.grade,
          percent(line.score.score),
          foldRepeats(meaningfulActions(line.actions)).join('; then '),
          line.changes.join('; '),
          line.line.why,
        ]),
      ),
      '',
      '## What each model did',
      '',
      ...turnModelSections(input, benchCase, analysis),
    );
  }
  out.push(
    benchCase.scope === 'single'
      ? '## The exact prompt for this decision'
      : '## The exact prompt for the first decision of the turn',
    '',
    'Built by the production prompt assembler. Later decisions in a whole-turn case get the same system message plus sections for their decision type, and the updated position.',
    '',
    `Primer sections sent: ${tacticianPrimerSectionIds(request)
      .map((id) => `\`${id}\``)
      .join(', ')}.`,
    '',
    ...prompt.messages.flatMap((message) => [
      `**${message.role}**`,
      '',
      fence(message.content),
      '',
    ]),
  );
  return out.join('\n');
}

// ── models/*.md ────────────────────────────────────────────────────────────────────────────────

export function renderModel(input: ReportInput, model: ModelResult): string {
  const metrics = input.metrics.find((entry) => entry.modelId === model.model.id);
  const { id: _id, label: _label, ...settings } = model.model;
  const out: string[] = [
    `# ${model.model.label}`,
    '',
    `\`${model.model.id}\` · ${isCandidate(model.model, input.models) ? 'candidate' : 'baseline (not scored)'} · ${model.status === 'complete' ? 'played every case' : `stopped early: ${model.abortReason ?? ''}`}`,
    '',
    `Settings: ${fence(JSON.stringify(settings))}`,
    '',
  ];
  if (metrics !== undefined)
    out.push(
      '## Numbers',
      '',
      `- Accuracy: overall ${percent(metrics.accuracy.overall)}, one-decision ${percent(metrics.accuracy.single)}, whole-turn ${percent(metrics.accuracy.turn)}.`,
      `- Reliability: ${metrics.reliability.firstTryLegal} of ${metrics.reliability.decisions} decisions legal on the first try, ${metrics.reliability.correctiveRetries} corrective retries, ${metrics.reliability.fallbacks} fallbacks.`,
      `- Speed: median ${milliseconds(metrics.speed.p50Ms)}, 90th percentile ${milliseconds(metrics.speed.p90Ms)}, slowest ${milliseconds(metrics.speed.maxMs)}.`,
      `- Cost: ${totalCost(metrics.cost)} total (${costSourceText(metrics.cost)}), ${dollars(metrics.cost.perDecisionUsd)} per decision, ${dollars(metrics.cost.perGameUsd)} per ${DECISIONS_PER_GAME} decisions.`,
      '',
    );
  out.push('## Every decision', '');
  input.cases.forEach((benchCase, index) => {
    for (const result of trialsOf(model, benchCase.id)) {
      out.push(
        `### [${benchCase.id}](../cases/${caseFileName(benchCase, index)})${input.trials > 1 ? `, trial ${result.trial}` : ''}: ${gradeWord(result, benchCase)}`,
        '',
        table(
          [
            '#',
            'Decision',
            'Answer',
            'Answered by',
            'Time',
            'Tokens in / out',
            'Cost',
            'Reason given',
          ],
          result.run.decisions.map((decision) => [
            String(decision.index + 1),
            `${decision.decisionType} (${decision.step ?? decision.phase}, ${decision.optionCount} options)`,
            decision.invalid === undefined
              ? decision.action
              : `REFUSED: ${decision.invalid}. Played instead: ${decision.action}`,
            decision.source,
            milliseconds(decision.latencyMs),
            decision.promptTokens === undefined
              ? '-'
              : `${decision.promptTokens} / ${decision.responseTokens ?? 0}`,
            decision.requests === 0 ? '$0' : dollars(decision.costUsd ?? null),
            decision.note ?? decision.failure ?? '',
          ]),
        ),
        '',
        `Result: ${describeChanges(result.run.before, result.run.after, benchCase.actor).join('; ')}.${
          result.score.flags.length > 0 ? ` Flags: ${result.score.flags.join('; ')}.` : ''
        }`,
        '',
      );
      const raws = result.run.decisions.filter((decision) => decision.raw !== undefined);
      if (raws.length > 0)
        out.push(
          '<details><summary>Raw model output</summary>',
          '',
          ...raws.flatMap((decision) => [
            `Decision ${decision.index + 1}:`,
            '',
            fence(decision.raw ?? ''),
            '',
          ]),
          '</details>',
          '',
        );
    }
  });
  return out.join('\n');
}

// ── README.md, scorecard ───────────────────────────────────────────────────────────────────────

export function renderReadme(input: ReportInput): string {
  return [
    '# Tactician benchmark: judge bundle',
    '',
    `Run \`${input.runId}\`, built ${input.createdAt}.`,
    '',
    'Start with `JUDGE_BRIEF.md`. It says what you are judging, how to score it and what to send back.',
    '',
    '| File | What it is |',
    '| --- | --- |',
    '| `JUDGE_BRIEF.md` | Your instructions and the scoring rubric (accuracy, speed, cost, overall, blurb). |',
    '| `PRIMER.md` | The rules these positions use and the exact instructions the models were given. |',
    '| `SUMMARY.md` | All models side by side: accuracy, speed and cost tables, the case grid, the disagreements. |',
    `| \`cases/\` | ${input.cases.length} pages, one per position: board, legal menu, reference analysis, every model's answer. |`,
    `| \`models/\` | ${input.models.length} pages, one per model: every decision with its reason, raw output, time and tokens. |`,
    '| `scorecard.template.json` | The form to fill in and return. |',
    '| `scorecard.schema.json` | The JSON Schema the returned scorecard must satisfy. |',
    '| `data/` | The same information as JSON: `run.json`, `cases.json`, `results.json`, `metrics.json`, `transcripts.jsonl`. |',
    '',
    '## Cases',
    '',
    ...input.cases.map(
      (benchCase, index) =>
        `${index + 1}. [${benchCase.title}](cases/${caseFileName(benchCase, index)}) (\`${benchCase.id}\`, ${benchCase.scope === 'single' ? 'one decision' : 'whole turn'})`,
    ),
    '',
    '## Models',
    '',
    ...input.models.map(
      (model) =>
        `- [${model.model.label}](models/${model.model.id}.md)${isCandidate(model.model, input.models) ? '' : ' (baseline)'}`,
    ),
    '',
  ].join('\n');
}

export function scorecardTemplate(input: ReportInput): unknown {
  const candidates = input.models.filter((model) => isCandidate(model.model, input.models));
  const axis = { score: null, reason: '' };
  return {
    schemaVersion: 1,
    runId: input.runId,
    judge: '',
    models: candidates.map((model) => ({
      modelId: model.model.id,
      accuracy: { ...axis },
      speed: { ...axis },
      cost: { ...axis },
      overall: { ...axis },
      blurb: '',
    })),
    ranking: [],
    referenceDisagreements: [],
    notes: '',
  };
}

export function scorecardSchema(input: ReportInput): unknown {
  const ids = input.models
    .filter((model) => isCandidate(model.model, input.models))
    .map((model) => model.model.id);
  const axis = (what: string) => ({
    type: 'object',
    additionalProperties: false,
    required: ['score', 'reason'],
    properties: {
      score: {
        type: ['number', 'null'],
        minimum: 0,
        maximum: 10,
        description: `${what}, 0 to 10; null only if it cannot be judged.`,
      },
      reason: {
        type: 'string',
        minLength: 1,
        description: 'One to three sentences. Name case ids for claims about play.',
      },
    },
  });
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Tactician benchmark scorecard',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'runId', 'judge', 'models', 'ranking', 'referenceDisagreements'],
    properties: {
      schemaVersion: { const: 1 },
      runId: { const: input.runId },
      judge: { type: 'string', minLength: 1, description: 'Who is judging: a name or a model id.' },
      models: {
        type: 'array',
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['modelId', 'accuracy', 'speed', 'cost', 'overall', 'blurb'],
          properties: {
            modelId: { enum: ids },
            accuracy: axis('Quality and legality of play'),
            speed: axis('Latency per decision'),
            cost: axis('Billed cost per decision'),
            overall: axis('Recommendation for the tactician seat (not an average)'),
            blurb: {
              type: 'string',
              minLength: 40,
              description: 'Two to four plain sentences about this model.',
            },
          },
        },
      },
      ranking: {
        type: 'array',
        items: { enum: ids },
        minItems: ids.length,
        maxItems: ids.length,
        uniqueItems: true,
        description: 'Every candidate, best first.',
      },
      referenceDisagreements: {
        type: 'array',
        description: 'Reference grades you think are wrong. Empty if none.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['caseId', 'answer', 'referenceGrade', 'yourGrade', 'reason'],
          properties: {
            caseId: { enum: input.cases.map((benchCase) => benchCase.id) },
            answer: { type: 'string' },
            referenceGrade: { enum: Object.keys(GRADE_POINTS) },
            yourGrade: { enum: Object.keys(GRADE_POINTS) },
            reason: { type: 'string', minLength: 1 },
          },
        },
      },
      notes: { type: 'string' },
    },
  };
}

/**
 * Reads the scorecards judges send back and lays them side by side: each judge's three scores,
 * overall and blurb per model, the spread between judges, and the reference grades they disputed.
 * Aliases are turned back into model names when the run's key is beside it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JudgeKey } from './bundle';

const AXES = ['accuracy', 'speed', 'cost', 'overall'] as const;
type Axis = (typeof AXES)[number];

export interface Scorecard {
  schemaVersion: 1;
  runId: string;
  judge: string;
  models: Array<
    { modelId: string; blurb: string } & Record<Axis, { score: number | null; reason: string }>
  >;
  ranking: string[];
  referenceDisagreements: Array<{
    caseId: string;
    answer: string;
    referenceGrade: string;
    yourGrade: string;
    reason: string;
  }>;
  notes?: string;
}

/** A returned scorecard, checked for the fields the collation reads. Throws with the file's name. */
export function parseScorecard(json: unknown, source: string, runId: string): Scorecard {
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  if (typeof json !== 'object' || json === null) fail('is not a JSON object');
  const card = json as Record<string, unknown>;
  if (card['runId'] !== runId) fail(`is for run ${String(card['runId'])}, not ${runId}`);
  if (typeof card['judge'] !== 'string' || card['judge'] === '') fail('names no judge');
  if (!Array.isArray(card['models']) || card['models'].length === 0) fail('scores no models');
  for (const model of card['models'] as Array<Record<string, unknown>>) {
    if (typeof model['modelId'] !== 'string') fail('has a model without modelId');
    if (typeof model['blurb'] !== 'string') fail(`${String(model['modelId'])} has no blurb`);
    for (const axis of AXES) {
      const entry = model[axis] as { score?: unknown } | undefined;
      const score = entry?.score;
      if (score !== null && !(typeof score === 'number' && score >= 0 && score <= 10))
        fail(`${String(model['modelId'])}.${axis}.score must be 0 to 10 or null`);
    }
  }
  if (!Array.isArray(card['ranking'])) fail('has no ranking');
  if (!Array.isArray(card['referenceDisagreements'])) card['referenceDisagreements'] = [];
  return card as unknown as Scorecard;
}

function spread(values: readonly number[]): string {
  if (values.length === 0) return 'n/a';
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.length === 1
    ? mean.toFixed(1)
    : `${mean.toFixed(1)} (${Math.min(...values)} to ${Math.max(...values)})`;
}

/** The judges' verdicts as one Markdown page. */
export function collate(runDirectory: string, cards: readonly Scorecard[]): string {
  const keyPath = join(runDirectory, 'judge-key.json');
  const key = existsSync(keyPath) ? (JSON.parse(readFileSync(keyPath, 'utf8')) as JudgeKey) : null;
  const name = (id: string): string => {
    const entry = key?.aliases.find((alias) => alias.aliasId === id);
    return entry === undefined ? id : `${entry.model.label} (${entry.alias})`;
  };
  const ids = [...new Set(cards.flatMap((card) => card.models.map((model) => model.modelId)))];
  const out: string[] = [
    "# Judges' verdicts",
    '',
    `${cards.length} scorecard${cards.length === 1 ? '' : 's'}: ${cards.map((card) => card.judge).join(', ')}.`,
    '',
    '## Mean score per model (lowest to highest judge)',
    '',
    '| Model | Accuracy | Speed | Cost | Overall | Mean rank |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const id of ids) {
    const rows = cards.flatMap((card) => card.models.filter((model) => model.modelId === id));
    const ranks = cards.map((card) => card.ranking.indexOf(id) + 1).filter((rank) => rank > 0);
    out.push(
      `| ${name(id)} | ${AXES.map((axis) =>
        spread(
          rows.flatMap((row) => (row[axis].score === null ? [] : [row[axis].score as number])),
        ),
      ).join(
        ' | ',
      )} | ${ranks.length === 0 ? 'n/a' : (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1)} |`,
    );
  }
  out.push('');
  for (const id of ids) {
    out.push(`## ${name(id)}`, '');
    for (const card of cards) {
      const row = card.models.find((model) => model.modelId === id);
      if (row === undefined) continue;
      out.push(
        `**${card.judge}**: accuracy ${row.accuracy.score ?? 'n/a'}, speed ${row.speed.score ?? 'n/a'}, cost ${row.cost.score ?? 'n/a'}, overall ${row.overall.score ?? 'n/a'}.`,
        '',
        `> ${row.blurb.replace(/\s*\n\s*/g, ' ')}`,
        '',
        ...AXES.map((axis) => `- ${axis}: ${row[axis].reason.replace(/\s*\n\s*/g, ' ')}`),
        '',
      );
    }
  }
  const disputes = cards.flatMap((card) =>
    card.referenceDisagreements.map((dispute) => ({ judge: card.judge, ...dispute })),
  );
  out.push('## Reference grades the judges disputed', '');
  if (disputes.length === 0) out.push('None.', '');
  for (const dispute of disputes)
    out.push(
      `- \`${dispute.caseId}\`, "${dispute.answer}": reference \`${dispute.referenceGrade}\`, ${dispute.judge} says \`${dispute.yourGrade}\`. ${dispute.reason.replace(/\s*\n\s*/g, ' ')}`,
    );
  out.push('');
  return out.join('\n');
}

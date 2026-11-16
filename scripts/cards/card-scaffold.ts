/**
 * `bun run card:scaffold "<name>" [--write] [--json]` (hill-climb S4): drafts promotion scenarios
 * for a pinned card from its interpreted IR, so promoting it is review, not writing.
 * `bun run card:scaffold "<name>" --approve <id>... | --approve all` records that review.
 *
 * Every printed draft has already passed the scenario runner on the production engine. It proves
 * the engine does what the IR says through the normal cast or activation path; it does not prove
 * the IR matches the Oracle text. Read each draft's `expectedOutcome` against the Oracle line its
 * `clauses` names, and write the negatives yourself (a filter that must refuse a target, a "you
 * may" declined, a cost that must be paid): the drafts are positives only, and the parts and
 * mutants they leave are listed below them.
 *
 * With `--write`, the drafts go to `packages/engine/tests/scenarios/<slug>.json`. An existing file
 * keeps every scenario it has; drafts whose id it already holds are skipped.
 *
 * Reviewed drafts may satisfy manifest clauses (Paul, 2026-11-16). `--approve` rewrites each named
 * draft's title mark to "reviewed" and names it in the manifest clause whose Oracle text is its
 * line; `check:manifest-tests` refuses a manifest reference to a draft not approved this way.
 * `card:new` runs the drafting step for every card it starts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { OracleCard } from '../../packages/shared/src';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import type { CardScenarioFile } from '../../packages/engine/src/testing/card-scenario';
import { cardMutants } from '../../packages/engine/tests/mutation/operators';
import { pinStore } from '../../packages/engine/tests/scenario/pin-store';
import { resolveScenarioCard } from '../../packages/engine/tests/scenario/runner';
import {
  isUnreviewedDraft,
  markReviewed,
  scaffoldCard,
  type ScaffoldResult,
} from '../../packages/engine/tests/scenario/scaffold';
import { mutantKills } from '../../packages/server/src/hill-climb/authoring';
import { mapDraftsIntoManifest } from '../contracts/generated-drafts';
import { slugOf } from './card-new';
import { runPrettier } from './prettier';

const MANIFEST = 'packages/server/fixtures/card-verification-manifest.json';
export const scenarioPathOf = (name: string): string =>
  `packages/engine/tests/scenarios/${slugOf(name)}.json`;

export interface ScaffoldReport {
  result: ScaffoldResult;
  mutants: number;
  killed: number;
  /** Labels of the mutants no draft kills. */
  survivors: string[];
}

/** The card's drafts and the mutants they leave. */
export function scaffoldReport(card: OracleCard): ScaffoldReport {
  const definition = interpretCard(card);
  const result = scaffoldCard(card, resolveScenarioCard);
  const mutants = cardMutants(definition);
  const killed = new Set(
    result.file.scenarios.length === 0
      ? []
      : mutantKills(definition, result.file, resolveScenarioCard),
  );
  return {
    result,
    mutants: mutants.length,
    killed: killed.size,
    survivors: mutants.filter((_, index) => !killed.has(index)).map((mutant) => mutant.label),
  };
}

export function printScaffoldReport(card: OracleCard, report: ScaffoldReport): void {
  const { result } = report;
  console.log(`${card.name}: ${result.file.scenarios.length} passing draft(s)\n`);
  for (const unit of result.units)
    console.log(
      `  ${unit.status.padEnd(11)} ${unit.part}${unit.clause === null ? '' : ` (line ${unit.clause})`}${
        unit.reason === undefined ? '' : `: ${unit.reason.split('\n')[0]}`
      }`,
    );
  console.log(
    `\nThe drafts kill ${report.killed} of ${report.mutants} IR mutants. Left for your tests or equivalentMutants:`,
  );
  for (const label of report.survivors) console.log(`  ${label}`);
}

/** Merges the drafts into the card's scenario file; returns its path, or null with no drafts. */
export function writeDrafts(card: OracleCard, result: ScaffoldResult): string | null {
  if (result.file.scenarios.length === 0) return null;
  const path = scenarioPathOf(card.name);
  let file: CardScenarioFile = result.file;
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as CardScenarioFile;
    const ids = new Set(existing.scenarios.map((scenario) => scenario.id));
    const support = new Map((existing.supportCards ?? []).map((spec) => [spec.name, spec]));
    for (const spec of result.file.supportCards ?? [])
      if (!support.has(spec.name)) support.set(spec.name, spec);
    file = {
      ...existing,
      ...(support.size > 0 && { supportCards: [...support.values()] }),
      scenarios: [
        ...existing.scenarios,
        ...result.file.scenarios.filter((scenario) => !ids.has(scenario.id)),
      ],
    };
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  runPrettier([path]);
  return path;
}

/**
 * Marks the named drafts (or every unreviewed one, for `all`) reviewed in the card's scenario
 * file and names them in its manifest clauses. Returns what changed, for printing.
 */
export function approveDrafts(
  card: OracleCard,
  ids: readonly string[],
): { approved: string[]; mapped: string[]; unmapped: string[]; unknown: string[] } {
  const path = scenarioPathOf(card.name);
  if (!existsSync(path))
    throw new Error(`${path} does not exist; run bun run card:scaffold "${card.name}" --write`);
  const file = JSON.parse(readFileSync(path, 'utf8')) as CardScenarioFile;
  const all = ids.includes('all');
  const known = new Set(file.scenarios.map((scenario) => scenario.id));
  const unknown = all ? [] : ids.filter((id) => !known.has(id));
  const approved: string[] = [];
  for (const scenario of file.scenarios)
    if ((all || ids.includes(scenario.id)) && isUnreviewedDraft(scenario.title)) {
      scenario.title = markReviewed(scenario.title);
      approved.push(scenario.id);
    }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  const mapping = mapDraftsIntoManifest(
    readFileSync(MANIFEST, 'utf8'),
    card.name,
    card.oracleText,
    file.scenarios.filter((scenario) => approved.includes(scenario.id)),
  );
  if (mapping.mapped.length > 0) writeFileSync(MANIFEST, mapping.manifestJson);
  runPrettier(mapping.mapped.length > 0 ? [path, MANIFEST] : [path]);
  return { approved, mapped: mapping.mapped, unmapped: mapping.unmapped, unknown };
}

function main(): void {
  const args = process.argv.slice(2);
  const approveAt = args.indexOf('--approve');
  const approveIds =
    approveAt === -1 ? [] : args.slice(approveAt + 1).filter((a) => !a.startsWith('--'));
  const name = args.find(
    (arg, index) => !arg.startsWith('--') && (approveAt === -1 || index < approveAt),
  );
  if (name === undefined || (approveAt !== -1 && approveIds.length === 0)) {
    console.error(
      'usage: bun run card:scaffold "<name>" [--write] [--json]\n       bun run card:scaffold "<name>" --approve <scenario id>... | all',
    );
    process.exit(2);
  }
  if (!pinStore.has(name)) {
    console.error(
      `"${name}" is not pinned; run bun run card:new "${name}" (or pin-store add) first`,
    );
    process.exit(2);
  }
  const card = pinStore.get(name);

  if (approveAt !== -1) {
    const outcome = approveDrafts(card, approveIds);
    if (outcome.unknown.length > 0)
      console.error(`not in ${scenarioPathOf(card.name)}: ${outcome.unknown.join(', ')}`);
    console.log(`reviewed: ${outcome.approved.join(', ') || 'none'}`);
    console.log(`named in the manifest: ${outcome.mapped.join(', ') || 'none'}`);
    if (outcome.unmapped.length > 0)
      console.log(
        `no manifest clause matched (the card has no entry, or the line differs): ${outcome.unmapped.join(', ')}`,
      );
    process.exit(outcome.unknown.length > 0 ? 1 : 0);
  }

  const report = scaffoldReport(card);
  if (args.includes('--json'))
    console.log(
      JSON.stringify({ ...report.result, mutants: report.mutants, killed: report.killed }, null, 2),
    );
  else printScaffoldReport(card, report);

  if (args.includes('--write')) {
    const path = writeDrafts(card, report.result);
    if (path !== null)
      console.log(
        `\nwrote ${path}; read each draft against its Oracle line, then bun run card:scaffold "${card.name}" --approve <id>`,
      );
  }
}

if (import.meta.main) main();

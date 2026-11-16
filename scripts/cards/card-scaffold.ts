/**
 * `bun run card:scaffold "<name>" [--write] [--json]` (hill-climb S4): drafts promotion scenarios
 * for a pinned card from its interpreted IR, so promoting it is review, not writing.
 *
 * Every printed draft has already passed the scenario runner on the production engine. It proves
 * the engine does what the IR says through the normal cast or activation path; it does not prove
 * the IR matches the Oracle text. Read each draft's `expectedOutcome` against the Oracle line its
 * `clauses` names before mapping it in the manifest, and write the negatives yourself (a filter
 * that must refuse a target, a "you may" declined, a cost that must be paid): the drafts are
 * positives only, and the parts and mutants they leave are listed below them.
 *
 * With `--write`, the drafts go to `packages/engine/tests/scenarios/<slug>.json`. An existing file
 * keeps every scenario it has; drafts whose id it already holds are skipped.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import type { CardScenarioFile } from '../../packages/engine/src/testing/card-scenario';
import { cardMutants } from '../../packages/engine/tests/mutation/operators';
import { pinStore } from '../../packages/engine/tests/scenario/pin-store';
import { resolveScenarioCard } from '../../packages/engine/tests/scenario/runner';
import { scaffoldCard } from '../../packages/engine/tests/scenario/scaffold';
import { mutantKills } from '../../packages/server/src/hill-climb/authoring';
import { slugOf } from './card-new';
import { runPrettier } from './prettier';

const args = process.argv.slice(2);
const name = args.find((arg) => !arg.startsWith('--'));
if (name === undefined) {
  console.error('usage: bun run card:scaffold "<name>" [--write] [--json]');
  process.exit(2);
}
if (!pinStore.has(name)) {
  console.error(`"${name}" is not pinned; run bun run card:new "${name}" (or pin-store add) first`);
  process.exit(2);
}
const card = pinStore.get(name);
const definition = interpretCard(card);
const result = scaffoldCard(card, resolveScenarioCard);
const mutants = cardMutants(definition);
const killed = new Set(
  result.file.scenarios.length === 0
    ? []
    : mutantKills(definition, result.file, resolveScenarioCard),
);

if (args.includes('--json')) {
  console.log(JSON.stringify({ ...result, mutants: mutants.length, killed: killed.size }, null, 2));
} else {
  console.log(`${card.name}: ${result.file.scenarios.length} passing draft(s)\n`);
  for (const unit of result.units)
    console.log(
      `  ${unit.status.padEnd(11)} ${unit.part}${unit.clause === null ? '' : ` (line ${unit.clause})`}${
        unit.reason === undefined ? '' : `: ${unit.reason.split('\n')[0]}`
      }`,
    );
  console.log(
    `\nThe drafts kill ${killed.size} of ${mutants.length} IR mutants. Left for your tests or equivalentMutants:`,
  );
  mutants.forEach((mutant, index) => {
    if (!killed.has(index)) console.log(`  ${mutant.label}`);
  });
}

if (args.includes('--write') && result.file.scenarios.length > 0) {
  const path = `packages/engine/tests/scenarios/${slugOf(card.name)}.json`;
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
  console.log(`\nwrote ${path}; review every draft before naming it in the manifest`);
}

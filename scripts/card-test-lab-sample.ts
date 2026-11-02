/**
 * Card Test Lab sampling (ADR 0037).
 *
 *   index --write   rewrite the committed scenario fingerprint index
 *   index --check   fail when the committed index differs from the current scenarios
 *   select --seed <sha> --out <path> [--base <sha>] [--sample] [--latest] [--per-family <n>]
 *                   write the selection a sampled Playwright lab run plays (`LAB_SELECTION`)
 *
 * The index maps each scenario ID to a fingerprint of what the scenario sets up: its metadata
 * (which carries the Oracle pin and clause IDs), seed, seat cards, their card overrides, and the
 * prepared board. `select` compares the current fingerprints with the index at the merge base to
 * find the scenarios a change adds or edits; those always run.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { GameId, OracleCard } from '../packages/shared/src';
import { deriveCardCapabilities } from '../packages/engine/src/cards/capabilities';
import { interpretCard } from '../packages/engine/src/cards/interpret';
import { getOverride } from '../packages/engine/src/cards/overrides/index';
import {
  CARD_TEST_SCENARIO_IDS,
  createCardTestScenario,
} from '../packages/server/src/cards/card-test-scenarios';
import type { LabSelectionFile } from '../apps/web/e2e/lab-selection';
import {
  addedScenarios,
  boardSummary,
  capabilitiesNamed,
  changedScenarios,
  enclosingLiterals,
  fingerprint,
  formatLabIndex,
  isEnginePrimitiveSource,
  parseLabIndex,
  parseUnifiedDiff,
  selectLabScenarios,
  specTests,
  stringLiterals,
  type LabIndex,
  type LabScenario,
} from './contracts/lab-sample';

const LAB_INDEX_PATH = 'packages/server/fixtures/card-test-lab-index.json';
const LATEST_WINDOW_DAYS = 7;
const SPEC_DIRECTORY = 'apps/web/e2e';

interface CollectedScenario extends LabScenario {
  fingerprint: string;
}

function collectScenarios(): CollectedScenario[] {
  return CARD_TEST_SCENARIO_IDS.map((id) => {
    const scenario = createCardTestScenario(id, 'card-test-lab-index' as GameId);
    if (scenario === null) throw new Error(`lab sample: scenario ${id} did not build`);
    const cards = new Map<string, OracleCard>();
    for (const { config } of scenario.seats)
      for (const card of [
        ...config.commanders,
        ...config.cards,
        ...(config.companion ? [config.companion] : []),
      ])
        if (!cards.has(card.oracleId)) cards.set(card.oracleId, card);
    const sorted = [...cards.values()].sort((a, b) =>
      a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0,
    );
    const capabilities = new Set<string>();
    for (const card of sorted) {
      const definition = interpretCard(card);
      if (definition.modeled)
        for (const capability of deriveCardCapabilities(definition)) capabilities.add(capability);
    }
    return {
      id,
      title: scenario.metadata.title,
      capabilities: [...capabilities].sort(),
      fingerprint: fingerprint({
        metadata: scenario.metadata,
        seed: scenario.seed,
        cards: sorted,
        overrides: sorted.map((card) => getOverride(card.oracleId) ?? null),
        board: boardSummary(scenario.engine.getState()),
      }),
    };
  });
}

function indexOf(scenarios: readonly CollectedScenario[]): LabIndex {
  return {
    schemaVersion: 1,
    scenarios: Object.fromEntries(scenarios.map(({ id, fingerprint }) => [id, fingerprint])),
  };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

function tryGit(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function indexAt(commit: string): LabIndex | null {
  const text = tryGit(['show', `${commit}:${LAB_INDEX_PATH}`]);
  return text === null ? null : parseLabIndex(text);
}

function runIndex(args: string[]): void {
  const text = formatLabIndex(indexOf(collectScenarios()).scenarios);
  if (args.includes('--write')) {
    writeFileSync(LAB_INDEX_PATH, text);
    console.log(`lab index: wrote ${LAB_INDEX_PATH}`);
    return;
  }
  if (!args.includes('--check')) throw new Error('Use: index --write | index --check');
  const committed = existsSync(LAB_INDEX_PATH) ? readFileSync(LAB_INDEX_PATH, 'utf8') : '';
  if (committed === text) {
    console.log(`lab index: ${LAB_INDEX_PATH} is current`);
    return;
  }
  const stale = committed === '' ? null : parseLabIndex(committed);
  const current = parseLabIndex(text);
  const differing = stale === null ? ['(missing file)'] : [...changedScenarios(current, stale)];
  const removed =
    stale === null ? [] : Object.keys(stale.scenarios).filter((id) => !(id in current.scenarios));
  console.error(
    `lab index: ${LAB_INDEX_PATH} is out of date (${differing.length} changed or new, ${removed.length} removed): ${[...differing, ...removed].slice(0, 20).join(', ')}`,
  );
  console.error('Run `bun run lab:index --write` and commit the result.');
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

function runSelect(args: string[]): void {
  const seed = option(args, '--seed');
  const out = option(args, '--out');
  if (seed === undefined || out === undefined)
    throw new Error('Use: select --seed <sha> --out <path> [--base <sha>] [--sample] [--latest]');
  const baseArg = option(args, '--base');
  const sample = args.includes('--sample');
  const latestWanted = args.includes('--latest');
  const perFamily = Number(option(args, '--per-family') ?? '1');
  const notes: string[] = [];

  const scenarios = collectScenarios();
  const current = indexOf(scenarios);

  let base: string | null = null;
  if (baseArg !== undefined && baseArg !== '' && !/^0+$/.test(baseArg)) {
    base = tryGit(['merge-base', baseArg, 'HEAD'])?.trim() ?? null;
    if (base === null)
      notes.push(`No merge base with ${baseArg}: the change itself is not compared.`);
  }

  let changed = new Set<string>();
  const mentioned = new Set<string>();
  const engineLiterals = new Set<string>();
  if (base !== null) {
    const baseIndex = indexAt(base);
    if (baseIndex === null)
      notes.push(`The base has no ${LAB_INDEX_PATH}: changed scenarios come from the diff only.`);
    else changed = changedScenarios(current, baseIndex);
    const diff = git(['diff', '-U0', '--no-color', '--no-ext-diff', base, 'HEAD']);
    for (const file of parseUnifiedDiff(diff)) {
      if (file.path === LAB_INDEX_PATH) continue;
      const literals = new Set(file.text.flatMap(stringLiterals));
      if (file.path.endsWith('.ts') && existsSync(file.path))
        for (const literal of enclosingLiterals(
          file.path,
          readFileSync(file.path, 'utf8'),
          file.lines,
          !isEnginePrimitiveSource(file.path),
        ))
          literals.add(literal);
      for (const literal of literals) mentioned.add(literal);
      if (isEnginePrimitiveSource(file.path))
        for (const literal of literals) engineLiterals.add(literal);
    }
  } else if (baseArg === undefined) notes.push('No --base: only the sample runs.');

  const allCapabilities = new Set(scenarios.flatMap(({ capabilities }) => capabilities));
  const touchedCapabilities = capabilitiesNamed(allCapabilities, engineLiterals);

  let latest = new Set<string>();
  if (latestWanted) {
    const tip = baseArg !== undefined && base !== null ? baseArg : 'HEAD';
    const since = new Date(Date.now() - LATEST_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    let older = tryGit(['rev-list', '-1', `--before=${since}`, tip])?.trim() || null;
    let olderIndex = older === null ? null : indexAt(older);
    if (olderIndex === null) {
      // The window starts before the index existed: compare with the commit that added it.
      older =
        tryGit(['log', '--diff-filter=A', '--format=%H', '--reverse', tip, '--', LAB_INDEX_PATH])
          ?.split('\n')
          .find((line) => line !== '') ?? null;
      olderIndex = older === null ? null : indexAt(older);
    }
    if (olderIndex === null) notes.push('No earlier index on main: `ci:lab-latest` adds nothing.');
    else {
      latest = addedScenarios(current, olderIndex);
      notes.push(
        `Latest: ${latest.size} scenarios added since ${older!.slice(0, 12)} (${LATEST_WINDOW_DAYS}-day window).`,
      );
    }
  }

  const tests = readdirSync(SPEC_DIRECTORY)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort()
    .flatMap((name) => {
      const path = join(SPEC_DIRECTORY, name);
      return specTests(path, readFileSync(path, 'utf8'));
    });
  const selection = selectLabScenarios({
    tests,
    scenarios,
    seed,
    changed,
    mentioned,
    touchedCapabilities,
    latest,
    sample,
    perFamily,
  });
  const file: LabSelectionFile = {
    schemaVersion: 1,
    seed,
    base,
    sample,
    latest: latestWanted,
    perFamily,
    total: scenarios.length,
    selected: selection.selected,
    excludedTitles: selection.excludedTitles,
    notes,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);

  const counts = new Map<string, number>();
  for (const { reasons } of selection.selected)
    for (const reason of new Set(reasons.map((reason) => reason.split(':')[0]!)))
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const breakdown = [...counts].map(([reason, count]) => `${reason} ${count}`).join(', ');
  const headline = `Card Test Lab sample: ${selection.selected.length} of ${scenarios.length} scenarios (${breakdown || 'none'}); seed ${seed.slice(0, 12)}, ${perFamily} per family. Tests whose titles name no scenario always run.`;
  console.log(headline);
  for (const note of notes) console.log(note);
  if (touchedCapabilities.size > 0)
    console.log(
      `Engine primitives the change names: ${[...touchedCapabilities].sort().join(', ')}`,
    );
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') {
    const rows = selection.selected
      .map(({ id, reasons }) => `| \`${id}\` | ${reasons.join(', ')} |`)
      .join('\n');
    appendFileSync(
      summary,
      `### ${headline}\n\n${notes.map((note) => `- ${note}`).join('\n')}\n\n` +
        `Reproduce locally: \`bun run lab:select --seed ${seed}${base ? ` --base ${base}` : ''}${sample ? ' --sample' : ''}${latestWanted ? ' --latest' : ''} --out lab-selection.json && LAB_SELECTION=lab-selection.json bun run test:e2e\`\n\n` +
        `<details><summary>Selected scenarios</summary>\n\n| Scenario | Reasons |\n| --- | --- |\n${rows}\n\n</details>\n`,
    );
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'index') runIndex(rest);
else if (command === 'select') runSelect(rest);
else {
  console.error('Use: card-test-lab-sample.ts index --write|--check, or select --seed <sha> ...');
  process.exit(1);
}

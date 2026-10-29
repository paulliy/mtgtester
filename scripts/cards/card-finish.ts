/**
 * `bun run card:finish [--batch <id>] [--no-bench] [--dry-run]` (ADR 0033 decision 1, plan phase 2
 * step 7): the mechanical tail of a card batch.
 *
 * 1. Rewrites both definition snapshots and prints a per-card diff of what changed, to read.
 * 2. Re-seals benchmark compatibility (`ai-bench refresh --suite core-fast --write`).
 * 3. Registers new scenario files with the Card Test Lab (`runner-scenarios.ts`).
 * 4. Binds every source the evidence generators now reach into their `SOURCE_FILES` lists.
 * 5. Reports which containment expectations the batch retires: manifest `unsupported` cards that
 *    now model, and must move to a supported status with tests.
 * 6. Prints the batch's manifest and progress skeleton.
 *
 * It writes nothing a gate accepts unread: the snapshot diff and the skeleton are for review, and
 * every scaffold `card:new` wrote stays rejected until filled.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { OracleCard } from '../../packages/shared/src';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { interpretSnapshot } from '../../packages/engine/src/cards/interpret-snapshot';
import { overrideSnapshot } from '../../packages/engine/src/cards/overrides/snapshot';
import { pinStore } from '../../packages/engine/tests/scenario/pin-store';
import { discoverGeneratorSourceFiles } from '../card-evidence-input';
import { snapshotChange } from './card-check';

const INTERPRET_FIXTURE = 'packages/engine/tests/fixtures/urdragon-oracle.json';
const INTERPRET_SNAPSHOT = 'packages/engine/tests/fixtures/interpret-defs.json';
const OVERRIDE_SNAPSHOT = 'packages/engine/tests/fixtures/override-defs.json';
const RUNNER_SCENARIOS = 'packages/server/src/cards/runner-scenarios.ts';
const SCENARIO_DIR = 'packages/engine/tests/scenarios';
const MANIFEST = 'packages/server/fixtures/card-verification-manifest.json';
const OVERRIDES_DIR = 'packages/engine/src/cards/overrides';

// ── Snapshots ──────────────────────────────────────────────────────────────────────────────────

/** Each entry that differs between two snapshots, by name, with its line diff. */
export function snapshotChanges(
  baseline: string,
  current: string,
): Array<{ name: string; kind: 'changed' | 'added' | 'removed'; diff: string[] }> {
  const entries = (json: string) =>
    new Map(
      (JSON.parse(json) as Array<{ oracleId: string; name?: string }>).map((e) => [e.oracleId, e]),
    );
  const before = entries(baseline);
  const after = entries(current);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: Array<{ name: string; kind: 'changed' | 'added' | 'removed'; diff: string[] }> =
    [];
  for (const id of ids) {
    const diff = snapshotChange(baseline, current, id);
    if (diff === null || diff.length === 0) continue;
    const name = after.get(id)?.name ?? before.get(id)?.name ?? id;
    changes.push({
      name,
      kind: !before.has(id) ? 'added' : !after.has(id) ? 'removed' : 'changed',
      diff,
    });
  }
  return changes;
}

// ── Scenario registration ──────────────────────────────────────────────────────────────────────

/** The runner-scenarios source with an entry for each listed file it does not read yet. */
export function registerScenarioFiles(source: string, files: readonly string[]): string {
  const marker =
    'export const RUNNER_SCENARIO_FILES: ReadonlyArray<{ name: string; file: CardScenarioFile }> = [';
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`${RUNNER_SCENARIOS} has no RUNNER_SCENARIO_FILES list`);
  const end = source.indexOf('\n];', start);
  const missing = files.filter((name) => !source.slice(start, end).includes(`'${name}'`));
  if (missing.length === 0) return source;
  const entries = missing
    .map((name) =>
      [
        '  {',
        `    name: '${name}',`,
        '    file: scenarioFile(',
        `      '${name}',`,
        '      readFileSync(',
        `        new URL('../../../../packages/engine/tests/scenarios/${name}', import.meta.url),`,
        "        'utf8',",
        '      ),',
        '    ),',
        '  },',
      ].join('\n'),
    )
    .join('\n');
  return `${source.slice(0, end)}\n${entries}${source.slice(end)}`;
}

// ── Evidence binding ───────────────────────────────────────────────────────────────────────────

const LIST = /const SOURCE_FILES = \[([\s\S]*?)\] as const;/;

export function sourceList(generator: string): string[] {
  const list = LIST.exec(generator);
  if (list === null) throw new Error('the generator has no SOURCE_FILES list');
  return [...list[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

const sharedPrefix = (a: string, b: string): number => {
  let length = 0;
  while (length < a.length && a[length] === b[length]) length += 1;
  return length;
};

/**
 * The generator with each missing path added beside its closest sibling: the listed entry from the
 * same directory sharing the longest prefix with it (the last such entry sorting before it, else
 * the first after it), or at the end when none shares its directory.
 */
export function bindSources(generator: string, missing: readonly string[]): string {
  let text = generator;
  for (const path of [...missing].sort()) {
    const listed = sourceList(text);
    if (listed.includes(path)) continue;
    const sameDir = listed.filter((entry) => posix.dirname(entry) === posix.dirname(path));
    const line = `  '${path}',\n`;
    const list = LIST.exec(text)!;
    const bodyStart = list.index + list[0].indexOf('[') + 1;
    const bodyEnd = list.index + list[0].lastIndexOf(']');
    let at = bodyEnd;
    if (sameDir.length > 0) {
      const best = Math.max(...sameDir.map((entry) => sharedPrefix(entry, path)));
      const closest = sameDir.filter((entry) => sharedPrefix(entry, path) === best);
      const before = closest.filter((entry) => entry < path);
      const anchor = before.length > 0 ? before[before.length - 1]! : closest[0]!;
      const anchorAt = bodyStart + text.slice(bodyStart, bodyEnd).indexOf(`  '${anchor}',\n`);
      at = before.length > 0 ? anchorAt + `  '${anchor}',\n`.length : anchorAt;
    }
    text = `${text.slice(0, at)}${line}${text.slice(at)}`;
  }
  return text;
}

// ── Containment and the manifest ───────────────────────────────────────────────────────────────

interface ManifestCard {
  name: string;
  oracleSha256: string;
  implementationStatus: string;
  clauses: Array<{ oracleText: string; engineTestIds?: string[]; viewerScenarioIds?: string[] }>;
}

/** Manifest `unsupported` cards whose pinned Oracle object now interprets as modeled. */
function retiredContainment(manifest: Record<string, ManifestCard>): string[] {
  return Object.values(manifest)
    .filter((entry) => entry.implementationStatus === 'unsupported')
    .filter((entry) => {
      let card: OracleCard;
      try {
        card = pinStore.bySha(entry.oracleSha256);
      } catch {
        return false;
      }
      return interpretCard(card).modeled;
    })
    .map((entry) => entry.name);
}

/** The cards a batch's override file registers, by name. */
export function batchCards(source: string): string[] {
  return [
    ...new Set(
      [
        ...source.matchAll(
          /['"][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"],\s*(['"])((?:(?!\1).)+)\1/g,
        ),
      ].map((match) => match[2]!),
    ),
  ];
}

function scenarioIdsFor(card: string): string[] {
  if (!existsSync(SCENARIO_DIR)) return [];
  return readdirSync(SCENARIO_DIR)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const file = JSON.parse(readFileSync(`${SCENARIO_DIR}/${name}`, 'utf8')) as {
        card: string;
        scenarios: Array<{ id: string; clauses: number[] }>;
      };
      return file.card === card ? file.scenarios.map((scenario) => scenario.id) : [];
    });
}

// ── The command ────────────────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const bench = !args.includes('--no-bench') && !dryRun;
  const batchFlag = args.indexOf('--batch');
  const batch = batchFlag === -1 ? null : (args[batchFlag + 1] ?? null);
  const write = (path: string, text: string) => {
    if (!dryRun) writeFileSync(path, text);
  };

  console.log('1. Definition snapshots');
  const fixture = JSON.parse(readFileSync(INTERPRET_FIXTURE, 'utf8')) as OracleCard[];
  for (const [path, current] of [
    [INTERPRET_SNAPSHOT, interpretSnapshot(fixture)],
    [OVERRIDE_SNAPSHOT, overrideSnapshot()],
  ] as const) {
    const changes = snapshotChanges(readFileSync(path, 'utf8'), current);
    console.log(`   ${path}: ${changes.length === 0 ? 'unchanged' : `${changes.length} card(s)`}`);
    for (const change of changes) {
      console.log(`   ${change.kind}: ${change.name}`);
      for (const line of change.diff.slice(0, 40)) console.log(`     ${line}`);
      if (change.diff.length > 40) console.log(`     … ${change.diff.length - 40} more lines`);
    }
    if (changes.length > 0) write(path, current);
  }

  console.log('\n2. Benchmark compatibility');
  if (bench) {
    execFileSync('bun', ['run', 'ai-bench', 'refresh', '--suite', 'core-fast', '--write'], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const changed = execFileSync('git', ['status', '--porcelain', '--', 'benchmarks'], {
      encoding: 'utf8',
    }).trim();
    console.log(
      changed === '' ? '   pins unchanged' : `   re-sealed:\n${changed.replace(/^/gm, '   ')}`,
    );
  } else console.log('   skipped');

  console.log('\n3. Scenario registration');
  const scenarioFiles = existsSync(SCENARIO_DIR)
    ? readdirSync(SCENARIO_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
  const registration = readFileSync(RUNNER_SCENARIOS, 'utf8');
  const registered = registerScenarioFiles(registration, scenarioFiles);
  if (registered === registration) console.log('   every scenario file is registered');
  else {
    write(RUNNER_SCENARIOS, registered);
    console.log(`   registered new scenario files in ${RUNNER_SCENARIOS}`);
  }

  console.log('\n4. Evidence generator sources');
  for (const generator of readdirSync('scripts')
    .filter((name) => /^generate-.*-evidence\.ts$/.test(name))
    .sort()) {
    const path = `scripts/${generator}`;
    const text = readFileSync(path, 'utf8');
    if (!LIST.test(text)) continue;
    const listed = sourceList(text);
    const missing = discoverGeneratorSourceFiles(process.cwd(), path).filter(
      (file) => !listed.includes(file),
    );
    if (missing.length === 0) continue;
    write(path, bindSources(text, missing));
    console.log(`   ${path}: bound ${missing.join(', ')}`);
  }

  console.log('\n5. Containment the batch retires');
  const manifest = (
    JSON.parse(readFileSync(MANIFEST, 'utf8')) as { cards: Record<string, ManifestCard> }
  ).cards;
  const retired = retiredContainment(manifest);
  console.log(
    retired.length === 0
      ? '   none'
      : retired
          .map((name) => `   ${name}: now modeled; move it off "unsupported" with tests`)
          .join('\n'),
  );

  if (batch !== null) {
    const file = `${OVERRIDES_DIR}/${batch}.ts`;
    const cards = existsSync(file) ? batchCards(readFileSync(file, 'utf8')) : [];
    console.log(
      `\n6. Manifest and progress skeleton for ${batch} (${cards.length} cards; review, do not paste blind)`,
    );
    console.log('   | Card | Modeled | Clauses | Scenarios |');
    console.log('   | ---- | ------- | ------- | --------- |');
    for (const name of cards) {
      const entry = Object.values(manifest).find((candidate) => candidate.name === name);
      const modeled = pinStore.has(name) ? interpretCard(pinStore.get(name)).modeled : false;
      const ids = scenarioIdsFor(name);
      console.log(
        `   | ${name} | ${modeled ? 'yes' : 'no'} | ${entry?.clauses.length ?? '-'} | ${ids.join(', ') || '-'} |`,
      );
    }
    for (const name of cards) {
      const entry = Object.values(manifest).find((candidate) => candidate.name === name);
      if (entry === undefined) continue;
      const empty = entry.clauses.filter((clause) => (clause.engineTestIds ?? []).length === 0);
      if (empty.length > 0)
        console.log(
          `   ${name}: ${empty.length} clause(s) without test IDs (scenarios: ${scenarioIdsFor(name).join(', ') || 'none'})`,
        );
    }
  }
  if (dryRun) console.log('\n(dry run: nothing written)');
}

if (import.meta.main) main();

/**
 * `bun run card:check "<name>"` (ADR 0033 decision 1, plan phase 2 step 4): what the engine makes
 * of one card right now. It interprets the card with its override applied, validates the
 * definition, and diffs the card's entry in the override snapshot against the committed baseline,
 * so an author sees one card's change instead of a whole-registry drift report.
 *
 * Exit status: 0 when the card is modeled and valid, 1 otherwise. A snapshot change is reported
 * but does not fail: it is expected while authoring, and `snapshots:check` is the gate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import { overrideSnapshot } from '../../packages/engine/src/cards/overrides/snapshot';
import { facetNotes, facetReport } from './facet-report';
import { findCard } from './resolve-card';

const OVERRIDE_SNAPSHOT = 'packages/engine/tests/fixtures/override-defs.json';
const MANIFEST = 'packages/server/fixtures/card-verification-manifest.json';

interface SnapshotEntry {
  oracleId: string;
  name: string;
  handledLines: string[];
  def: unknown;
}

/** Lines of `after` not in `before` and the reverse, as a short line diff of two JSON texts. */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Longest common subsequence: snapshot entries are small, so the quadratic table is fine.
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j === b.length || table[i + 1]![j]! >= table[i]![j + 1]!))
      out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  return out;
}

export function snapshotChange(
  baseline: string,
  current: string,
  oracleId: string,
): string[] | null {
  const find = (json: string) =>
    (JSON.parse(json) as SnapshotEntry[]).find((entry) => entry.oracleId === oracleId);
  const before = find(baseline);
  const after = find(current);
  if (before === undefined && after === undefined) return null;
  const text = (entry: SnapshotEntry | undefined) =>
    entry === undefined ? '' : JSON.stringify(entry, null, 2);
  if (text(before) === text(after)) return [];
  return lineDiff(text(before), text(after));
}

function main(): void {
  const name = process.argv.slice(2).join(' ').trim();
  if (name === '') {
    console.error('usage: bun run card:check "<card name>"');
    process.exit(2);
  }
  const found = findCard(name);
  if (found === null) {
    console.error(`"${name}" is not in the pin store, the coverage pool or the Scryfall bulk file`);
    process.exit(1);
  }
  const { card, source } = found;
  console.log(`${card.name} (${card.typeLine}) from the ${source}`);
  console.log(
    card.oracleText
      .split('\n')
      .map((line, index) => `  ${index + 1}. ${line}`)
      .join('\n'),
  );

  const def = interpretCard(card);
  const issues = def.modeled ? validateCardDefinition(def) : [];
  console.log(`\nmodeled: ${def.modeled ? 'yes' : 'no'}`);
  for (const reason of def.unmodeledReasons) console.log(`  unmodeled: ${reason}`);
  for (const issue of issues) console.log(`  invalid at ${issue.path}: ${issue.message}`);
  if (def.modeled && issues.length === 0) console.log('  valid IR');
  if (def.modeled) {
    const facets = facetReport(card, def, facetNotes(readFileSync(MANIFEST, 'utf8'), card.name));
    console.log(`\nfacets: ${facets.length === 0 ? 'the text and the IR agree' : ''}`);
    for (const line of facets) console.log(`  ${line}`);
  }

  if (existsSync(OVERRIDE_SNAPSHOT)) {
    const baseline = readFileSync(OVERRIDE_SNAPSHOT, 'utf8');
    const current = overrideSnapshot();
    // A spell face (Adventure, Omen, modal) registers under `<oracleId>:back`.
    for (const [id, label] of [
      [card.oracleId, 'override snapshot'],
      [`${card.oracleId}:back`, 'face override snapshot'],
    ] as const) {
      const change = snapshotChange(baseline, current, id);
      if (change === null) {
        if (id === card.oracleId) console.log(`\n${label}: no override for this card`);
      } else if (change.length === 0) console.log(`\n${label}: unchanged`);
      else {
        console.log(
          `\n${label}: changed (${change.length} lines); bun run snapshots:write records it`,
        );
        for (const line of change.slice(0, 80)) console.log(`  ${line}`);
        if (change.length > 80) console.log(`  … ${change.length - 80} more`);
      }
    }
  }
  process.exit(def.modeled && issues.length === 0 ? 0 : 1);
}

if (import.meta.main) main();

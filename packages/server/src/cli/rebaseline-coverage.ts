/**
 * Review and explicitly revise the coverage Oracle baseline.
 *
 *   bun run coverage:rebaseline                                  # pinned fixture: must match the baseline
 *   bun run coverage:rebaseline --bulk                           # local Scryfall download: drift report
 *   bun run coverage:rebaseline --oracle-fixture <revised.json>  # review a revised projection
 *   bun run coverage:rebaseline --oracle-fixture <revised.json> --write
 *
 * Every drifted card is printed with the fields that differ from the pinned fixture, which is what
 * the baseline was built from. `--write` only rewrites hashes in coverage-contract.json and never
 * touches the pinned fixture: copy the revised projection over it in the same commit, then run
 * `bun run coverage:complete`. Exits 1 while anything drifted.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { coverageInput, PINNED_ORACLE_FIXTURE } from './coverage-input';
import { canonicalOracle } from '../cards/coverage-contract';

const BASELINE_PATH = 'packages/server/fixtures/coverage-contract.json';

interface BaselineEntry {
  oracleId: string;
  name: string;
  sha256: string;
}

interface Baseline {
  oracle: BaselineEntry[];
  [key: string]: unknown;
}

interface Drift {
  entry: BaselineEntry;
  previous: OracleCard;
  next: OracleCard;
}

function fail(message: string): never {
  console.error(`rebaseline: ${message}`);
  process.exit(1);
}

function hash(card: OracleCard): string {
  return createHash('sha256').update(canonicalOracle(card)).digest('hex');
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function printDrift({ entry, previous, next }: Drift): void {
  console.log(`\n${entry.name} (${entry.oracleId})`);
  const fields = (card: OracleCard): Record<string, unknown> =>
    card as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort();
  for (const key of keys) {
    const before = fields(previous)[key];
    const after = fields(next)[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    console.log(`  ${key}: ${preview(before)} -> ${preview(after)}`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const candidate = coverageInput(argv.filter((arg) => arg !== '--write'));
  if (candidate.args.length > 0) fail(`unexpected arguments: ${candidate.args.join(' ')}`);
  if (write && !argv.includes('--oracle-fixture'))
    fail(
      '--write needs an explicit --oracle-fixture <revised.json>; it never writes from the pinned or bulk input',
    );

  const baseline = JSON.parse(readFileSync(resolve(BASELINE_PATH), 'utf8')) as Baseline;
  const pinned = coverageInput([]).index;

  const drifted: Drift[] = [];
  const missing: string[] = [];
  for (const entry of baseline.oracle) {
    const previous = pinned.getByOracleId(entry.oracleId);
    if (previous === null || hash(previous) !== entry.sha256)
      fail(
        `${PINNED_ORACLE_FIXTURE} no longer matches the baseline for ${entry.name}; reconcile them before revising`,
      );
    const next = candidate.index.getByOracleId(entry.oracleId);
    if (next === null) missing.push(entry.name);
    else if (hash(next) !== entry.sha256) drifted.push({ entry, previous, next });
  }

  if (missing.length > 0)
    fail(
      `${missing.length} baseline card(s) are absent from ${candidate.path}: ${missing.join(', ')}. ` +
        'Removing a card from the baseline is a separate, reviewed decision.',
    );

  if (drifted.length === 0) {
    console.log(`baseline matches ${candidate.path}: ${baseline.oracle.length} cards, no drift`);
    return;
  }

  for (const drift of drifted) printDrift(drift);
  console.log(
    `\n${drifted.length} of ${baseline.oracle.length} baseline cards drifted in ${candidate.path}.`,
  );

  if (!write) {
    console.log(
      `Re-run with --oracle-fixture ${candidate.path} --write to update ${BASELINE_PATH}, if the changes are intended.`,
    );
    process.exit(1);
  }

  for (const { entry, next } of drifted) entry.sha256 = hash(next);
  writeFileSync(resolve(BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`\nupdated ${drifted.length} hash(es) in ${BASELINE_PATH}.`);
  console.log(
    `Next: copy ${candidate.path} over ${PINNED_ORACLE_FIXTURE}, then run bun run coverage:complete.`,
  );
}

main();

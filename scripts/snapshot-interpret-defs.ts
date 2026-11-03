/**
 * Write or verify the golden snapshots of `interpretCard`'s output (ADR 0038 decision 5).
 *
 *   bun run scripts/snapshot-interpret-defs.ts            # write the baselines
 *   bun run scripts/snapshot-interpret-defs.ts --check    # diff against them; non-zero on drift
 *
 * Three sets, each a net for a different part of the parser:
 *
 * - the 93-card Ur-Dragon fixture, the deck interpret.ts's name-keyed special cases were written
 *   for (see `packages/engine/src/cards/interpret-snapshot.ts`);
 * - the full pinned coverage fixture (`coverage-oracle.json`), every real card the coverage gates
 *   read;
 * - the one-line probe corpus: each ready-list blocking line on a synthetic card
 *   (`scripts/interpret-corpus.ts`). A refactor must leave its outcomes unchanged; a coverage
 *   change shows its yield as rows that turned `modeled`.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { OracleCard } from '../packages/shared/src';
import { interpretSnapshot } from '../packages/engine/src/cards/interpret-snapshot';
import {
  ONE_LINE_CORPUS_PATH,
  ONE_LINE_OUTCOMES_PATH,
  oneLineOutcomes,
  type OneLineCorpusRow,
} from './interpret-corpus';

interface SnapshotSet {
  label: string;
  path: string;
  render: () => string;
  /** Names of the entries that differ between two renders, for the drift report. */
  changed: (before: string, after: string) => string[];
  size: number;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function cardSet(label: string, fixture: string, path: string): SnapshotSet {
  const cards = readJson<OracleCard[]>(fixture);
  const nameOf = new Map(cards.map((card) => [card.oracleId, card.name]));
  const index = (json: string): Map<string, string> =>
    new Map(
      (JSON.parse(json) as { oracleId: string }[]).map((e) => [e.oracleId, JSON.stringify(e)]),
    );
  return {
    label,
    path,
    size: cards.length,
    render: () => interpretSnapshot(cards),
    changed: (before, after) => {
      const was = index(before);
      const now = index(after);
      const ids = new Set([...was.keys(), ...now.keys()]);
      return [...ids].filter((id) => was.get(id) !== now.get(id)).map((id) => nameOf.get(id) ?? id);
    },
  };
}

function corpusSet(): SnapshotSet {
  const rows = readJson<OneLineCorpusRow[]>(ONE_LINE_CORPUS_PATH);
  const nameOf = new Map(rows.map((row) => [String(row.rank), row.name]));
  const index = (tsv: string): Map<string, string> =>
    new Map(
      tsv
        .trimEnd()
        .split('\n')
        .slice(1)
        .map((line) => [line.slice(0, line.indexOf('\t')), line]),
    );
  return {
    label: 'one-line corpus outcomes',
    path: ONE_LINE_OUTCOMES_PATH,
    size: rows.length,
    render: () => oneLineOutcomes(rows),
    changed: (before, after) => {
      const was = index(before);
      const now = index(after);
      const ranks = new Set([...was.keys(), ...now.keys()]);
      return [...ranks]
        .filter((rank) => was.get(rank) !== now.get(rank))
        .map((rank) => {
          const outcome = (line: string | undefined) => line?.split('\t')[1] ?? 'absent';
          return `${rank}. ${nameOf.get(rank) ?? '?'}: ${outcome(was.get(rank))} -> ${outcome(now.get(rank))}`;
        });
    },
  };
}

const sets: SnapshotSet[] = [
  cardSet(
    'interpret defs',
    'packages/engine/tests/fixtures/urdragon-oracle.json',
    'packages/engine/tests/fixtures/interpret-defs.json',
  ),
  cardSet(
    'pinned interpret defs',
    'packages/server/fixtures/coverage-oracle.json',
    'packages/engine/tests/fixtures/interpret-defs-pinned.json',
  ),
  corpusSet(),
];

const check = process.argv.includes('--check');
let drifted = false;
for (const set of sets) {
  const current = set.render();
  if (!check) {
    writeFileSync(set.path, current);
    console.log(`wrote ${set.path} (${set.size} entries)`);
    continue;
  }
  if (!existsSync(set.path)) {
    console.error(`no baseline at ${set.path}; run without --check first`);
    drifted = true;
    continue;
  }
  const baseline = readFileSync(set.path, 'utf8');
  if (baseline === current) {
    console.log(`${set.label} unchanged (${set.size} entries)`);
    continue;
  }
  drifted = true;
  const changed = set.changed(baseline, current);
  console.error(`${set.label} DRIFTED: ${changed.length} of ${set.size} entries changed`);
  for (const name of changed.slice(0, 30)) console.error(`  changed: ${name}`);
  if (changed.length > 30) console.error(`  … and ${changed.length - 30} more`);
}
process.exit(drifted ? 1 : 0);

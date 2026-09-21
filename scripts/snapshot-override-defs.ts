/**
 * Write or verify the golden snapshot of the authored-override registry.
 *
 * The serialization itself lives in `packages/engine/src/cards/overrides/snapshot.ts` (so the
 * matching vitest check can import it); this is just the CLI around it.
 *
 *   bun run scripts/snapshot-override-defs.ts            # write the baseline
 *   bun run scripts/snapshot-override-defs.ts --check    # diff against it; non-zero exit on drift
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { overrideSnapshot } from '../packages/engine/src/cards/overrides/snapshot';

const SNAPSHOT_PATH = 'packages/engine/tests/fixtures/override-defs.json';

const check = process.argv.includes('--check');
const current = overrideSnapshot();

if (!check) {
  writeFileSync(SNAPSHOT_PATH, current);
  console.log(
    `wrote ${SNAPSHOT_PATH} (${(JSON.parse(current) as unknown[]).length} registrations)`,
  );
  process.exit(0);
}

if (!existsSync(SNAPSHOT_PATH)) {
  console.error(`no baseline at ${SNAPSHOT_PATH} — run without --check first`);
  process.exit(1);
}

const baseline = readFileSync(SNAPSHOT_PATH, 'utf8');
if (baseline === current) {
  console.log(
    `override defs unchanged (${(JSON.parse(current) as unknown[]).length} registrations)`,
  );
  process.exit(0);
}

// Report the drifting cards by id rather than dumping a diff of a 35k-line file.
const index = (json: string): Map<string, string> =>
  new Map((JSON.parse(json) as { oracleId: string }[]).map((e) => [e.oracleId, JSON.stringify(e)]));

const before = index(baseline);
const after = index(current);
const added = [...after.keys()].filter((k) => !before.has(k));
const removed = [...before.keys()].filter((k) => !after.has(k));
const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));

console.error(
  `override defs DRIFTED: ${changed.length} changed, ${added.length} added, ${removed.length} removed`,
);
for (const id of changed.slice(0, 20)) console.error(`  changed: ${id}`);
for (const id of added.slice(0, 20)) console.error(`  added:   ${id}`);
for (const id of removed.slice(0, 20)) console.error(`  removed: ${id}`);
process.exit(1);

/**
 * Write or verify the golden snapshot of `interpretCard`'s output over the committed 93-card
 * Ur-Dragon fixture. See `packages/engine/src/cards/interpret-snapshot.ts` for what this proves
 * and why the fixture is the right one for it (it's exactly the deck the hand-authored
 * name-keyed special cases in interpret.ts were written for).
 *
 *   bun run scripts/snapshot-interpret-defs.ts            # write the baseline
 *   bun run scripts/snapshot-interpret-defs.ts --check    # diff against it; non-zero on drift
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { interpretSnapshot } from '../packages/engine/src/cards/interpret-snapshot';

const FIXTURE = 'packages/engine/tests/fixtures/urdragon-oracle.json';
const SNAPSHOT_PATH = 'packages/engine/tests/fixtures/interpret-defs.json';

const cards = JSON.parse(readFileSync(FIXTURE, 'utf8')) as OracleCard[];
const check = process.argv.includes('--check');
const current = interpretSnapshot(cards);

if (!check) {
  writeFileSync(SNAPSHOT_PATH, current);
  console.log(`wrote ${SNAPSHOT_PATH} (${cards.length} cards)`);
  process.exit(0);
}

if (!existsSync(SNAPSHOT_PATH)) {
  console.error(`no baseline at ${SNAPSHOT_PATH} — run without --check first`);
  process.exit(1);
}

const baseline = readFileSync(SNAPSHOT_PATH, 'utf8');
if (baseline === current) {
  console.log(`interpret defs unchanged (${cards.length} cards)`);
  process.exit(0);
}

const index = (json: string): Map<string, string> =>
  new Map((JSON.parse(json) as { oracleId: string }[]).map((e) => [e.oracleId, JSON.stringify(e)]));
const before = index(baseline);
const after = index(current);
const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));

console.error(`interpret defs DRIFTED: ${changed.length} of ${cards.length} cards changed`);
const byId = new Map(cards.map((c) => [c.oracleId, c.name]));
for (const id of changed.slice(0, 30)) console.error(`  changed: ${byId.get(id) ?? id}`);
process.exit(1);

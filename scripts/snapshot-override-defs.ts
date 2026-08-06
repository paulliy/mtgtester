/**
 * Golden snapshot of the authored-override registry.
 *
 * The card-builder refactor (templates.ts) changes HOW override data is written, not what it says.
 * That claim needs a proof, and the repo's existing signals cannot give one: `docs/modelled-cards.md`
 * compares card *names* only, and `determinism.test.ts` compares a run against itself, so both stay
 * green through a refactor that silently changes a definition's body.
 *
 * This serializes every registration to canonical JSON instead. Two rules make the comparison the
 * right one:
 *
 * - **Object keys are sorted.** `applyOverride` merges with a shallow spread (`overrides/index.ts`),
 *   which is key-order-insensitive, and a builder legitimately emits fields in a different order
 *   than the hand-written literal it replaces. Only the sorted projection is the semantic contract.
 * - **Array order is preserved.** It is load-bearing: `Effect[]` order decides resolution order, and
 *   `TargetSpec[]` position IS the slot index every `EffectRef` number points at.
 *
 * An explicitly-`undefined` property is recorded as a `<undefined>` sentinel rather than dropped —
 * a spread copies own enumerable keys regardless of value, so `{ foo: undefined }` overwrites an
 * interpreted `foo` while omitting the key preserves it. Those two are not the same override.
 *
 *   bun run scripts/snapshot-override-defs.ts            # write the baseline
 *   bun run scripts/snapshot-override-defs.ts --check    # diff against it; non-zero exit on drift
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { listOverrides } from '../packages/engine/src/cards/overrides/index';

const SNAPSHOT_PATH = 'packages/engine/tests/fixtures/override-defs.json';

const UNDEFINED = '<undefined>';

/** Recursively sort object keys; leave arrays in place. */
function canonical(value: unknown): unknown {
  if (value === undefined) return UNDEFINED;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);
  return out;
}

export function snapshot(): string {
  const entries = listOverrides().map((o) => ({
    oracleId: o.oracleId,
    name: o.name,
    // Sorted: which lines an override claims is a set, and the order they are listed in does not
    // change which reasons `applyOverride` clears.
    handledLines: [...o.handledLines].sort(),
    def: canonical(o.def),
  }));
  return `${JSON.stringify(entries, null, 2)}\n`;
}

const check = process.argv.includes('--check');
const current = snapshot();

if (!check) {
  writeFileSync(SNAPSHOT_PATH, current);
  const count = JSON.parse(current).length;
  console.log(`wrote ${SNAPSHOT_PATH} (${count} registrations)`);
  process.exit(0);
}

if (!existsSync(SNAPSHOT_PATH)) {
  console.error(`no baseline at ${SNAPSHOT_PATH} — run without --check first`);
  process.exit(1);
}

const baseline = readFileSync(SNAPSHOT_PATH, 'utf8');
if (baseline === current) {
  console.log(`override defs unchanged (${JSON.parse(current).length} registrations)`);
  process.exit(0);
}

// Report the drifting cards by name rather than dumping a diff of a multi-megabyte file.
const before = new Map<string, string>(
  (JSON.parse(baseline) as { oracleId: string }[]).map((e) => [e.oracleId, JSON.stringify(e)]),
);
const after = new Map<string, string>(
  (JSON.parse(current) as { oracleId: string }[]).map((e) => [e.oracleId, JSON.stringify(e)]),
);

const added = [...after.keys()].filter((k) => !before.has(k));
const removed = [...before.keys()].filter((k) => !after.has(k));
const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));

console.error(`override defs DRIFTED: ${changed.length} changed, ${added.length} added, ${removed.length} removed`);
for (const id of changed.slice(0, 20)) console.error(`  changed: ${id}`);
for (const id of added.slice(0, 20)) console.error(`  added:   ${id}`);
for (const id of removed.slice(0, 20)) console.error(`  removed: ${id}`);
process.exit(1);

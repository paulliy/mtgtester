import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '../packages/shared/src';
import { interpretCard } from '../packages/engine/src/cards/interpret';
import { validateCardDefinition } from '../packages/engine/src/cards/authoring-validation';

function jsonFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? jsonFiles(path)
        : entry.isFile() && path.endsWith('.json')
          ? [path]
          : [];
    })
    .sort();
}
const cards = new Map<string, { card: OracleCard; paths: string[]; sha256: string }>();
function collect(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collect(item, path));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    typeof record['oracleId'] === 'string' &&
    typeof record['oracleText'] === 'string' &&
    typeof record['name'] === 'string' &&
    Array.isArray(record['types']) &&
    (record['manaCost'] === null || typeof record['manaCost'] === 'string')
  ) {
    const sha256 = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const key = `${record['oracleId']}:${sha256}`;
    const existing = cards.get(key);
    if (existing) existing.paths.push(path);
    else cards.set(key, { card: record as unknown as OracleCard, paths: [path], sha256 });
  } else {
    Object.values(record).forEach((item) => collect(item, path));
  }
}
for (const directory of ['packages/engine/tests/fixtures', 'packages/server/fixtures']) {
  for (const path of jsonFiles(directory))
    collect(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
}
const manifest = JSON.parse(
  readFileSync('packages/server/fixtures/card-verification-manifest.json', 'utf8'),
) as {
  cards: Record<string, { name: string; implementationStatus: string; unsupportedReason?: string }>;
};
const failures: { name: string; oracleId: string; paths: string[]; reasons: string[] }[] = [];
const contained: { name: string; oracleId: string; paths: string[]; reasons: string[] }[] = [];
let modeled = 0;
for (const { card, paths } of [...cards.values()].sort(
  (a, b) => a.card.oracleId.localeCompare(b.card.oracleId) || a.sha256.localeCompare(b.sha256),
)) {
  const def = interpretCard(card);
  if (def.modeled) {
    modeled++;
    const issues = validateCardDefinition(def);
    if (issues.length > 0)
      failures.push({
        name: card.name,
        oracleId: card.oracleId,
        paths,
        reasons: issues.map((issue) => `${issue.path}: ${issue.message}`),
      });
  } else {
    const reasons = def.unmodeledReasons.filter((reason) =>
      reason.startsWith('Invalid ability IR'),
    );
    if (reasons.length === 0) continue;
    const item = { name: card.name, oracleId: card.oracleId, paths, reasons };
    contained.push(item);
    const declaration = manifest.cards[card.oracleId];
    if (declaration?.implementationStatus !== 'unsupported' || !declaration.unsupportedReason)
      failures.push({
        ...item,
        reasons: [
          ...reasons,
          'IR containment must be explicitly declared in the verification manifest',
        ],
      });
  }
}
console.log(
  JSON.stringify(
    {
      scope: 'committed Oracle projections; semantic validation only, not card behavior proof',
      projections: cards.size,
      modeled,
      contained,
      failures,
    },
    null,
    2,
  ),
);
process.exitCode = failures.length === 0 ? 0 : 1;

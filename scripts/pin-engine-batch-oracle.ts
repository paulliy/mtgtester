import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function dump(path: string): void {
  const file = JSON.parse(readFileSync(path, 'utf8')) as {
    cards: { sha256: string; card: { name: string; oracleId: string } }[];
  };
  for (const entry of file.cards) {
    console.log(`${entry.card.name}\t${entry.sha256}\t${entry.card.oracleId}`);
  }
}

const names = process.argv.slice(2);
if (names.length === 0) {
  console.log('--- necron remaining ---');
  dump('packages/engine/tests/fixtures/necron-remaining-engine-batch1-oracle.json');
  console.log('--- necron main ---');
  dump('packages/engine/tests/fixtures/necron-main-engine-batch1-oracle.json');
  process.exit(0);
}

const coverage = JSON.parse(
  readFileSync(resolve('packages/server/fixtures/coverage-oracle.json'), 'utf8'),
) as Array<{ name: string; oracleText?: string }>;
const cards = names.map((name) => {
  const card = coverage.find((entry) => entry.name === name);
  if (card === undefined) throw new Error(`missing ${name}`);
  return {
    sha256: createHash('sha256').update(canonical(card)).digest('hex'),
    card,
  };
});
const outPath = process.env.PIN_OUT;
if (outPath === undefined) throw new Error('PIN_OUT is required when names are given');
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
      cards,
    },
    null,
    2,
  )}\n`,
);
for (const entry of cards) {
  console.log(`${entry.card.name}\t${entry.sha256}`);
}

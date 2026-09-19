/**
 * Generate a list of all modelled cards by the engine.
 *
 *   bun run modelled-cards          # write to docs/modelled-cards.md
 *   bun run modelled-cards --json   # output JSON instead
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { toOracleCard, type RawScryfallCard } from '../cards/scryfall';
import { buildSupportedPool, type SupportedPool } from '../cards/pool';

const BULK_PATH = 'data/scryfall-oracle-cards.json';
const OUTPUT_PATH = 'docs/modelled-cards.md';

function loadPool() {
  console.log(`Loading oracle data from ${BULK_PATH} …`);
  const parsed: unknown = JSON.parse(readFileSync(resolve(BULK_PATH), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Expected a JSON array in "${BULK_PATH}".`);

  const cards: OracleCard[] = [];
  for (const raw of parsed as RawScryfallCard[]) {
    const card = toOracleCard(raw);
    if (card !== null) cards.push(card);
  }
  return buildSupportedPool(cards);
}

function generateMarkdown(pool: SupportedPool): string {
  const nonLands = pool.cards
    .filter((c) => !c.isLand)
    .sort((a, b) => a.card.name.localeCompare(b.card.name));

  const lines = [
    '# Modelled Cards by Engine',
    '',
    `Generated from the engine-supported card pool.`,
    '',
    `**Total**: ${nonLands.length} modeled non-land cards`,
    '',
  ];

  for (const card of nonLands) {
    lines.push(`- ${card.card.name}`);
  }

  return lines.join('\n') + '\n';
}

function generateJson(pool: SupportedPool) {
  const nonLands = pool.cards
    .filter((c) => !c.isLand)
    .sort((a, b) => a.card.name.localeCompare(b.card.name));
  return JSON.stringify(
    {
      generated: new Date().toISOString(),
      total: nonLands.length,
      cards: nonLands.map((c) => c.card.name),
    },
    null,
    2,
  );
}

async function main(): Promise<void> {
  const pool = loadPool();

  const args = process.argv.slice(2);
  const isJson = args.includes('--json');

  if (isJson) {
    console.log(generateJson(pool));
  } else {
    const markdown = generateMarkdown(pool);
    mkdirSync(resolve('docs'), { recursive: true });
    writeFileSync(resolve(OUTPUT_PATH), markdown, 'utf8');
    console.log(`✓ Written ${OUTPUT_PATH}`);
    const nonLandCount = pool.cards.filter((c) => !c.isLand).length;
    console.log(`✓ Listed ${nonLandCount} modeled non-land cards`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

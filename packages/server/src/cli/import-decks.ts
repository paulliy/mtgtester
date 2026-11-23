/**
 * Phase 1 verification CLI (brief §14.1: "paste four real decklists, get four validated
 * snapshots or precise errors"). Runs the deck pipeline over each input and prints a report.
 *
 *   bun run decks <deckUrlOrFile> [more...]        # imports + validates + snapshots
 *   bun run decks --no-save <...>                  # skip persistence (validation only)
 *
 * Each positional argument is a Moxfield/Archidekt URL, or a path to a plaintext decklist file.
 * Paths and options are resolved from the repository root (the process working directory).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadOracleIndexFromFile } from '../cards/oracle-index-file';
import { loadBannedList } from '../decks/banned-file';
import { runDeckPipeline, type DeckPipelineResult } from '../decks/pipeline';
import { GameStore } from '../db';

const BULK_PATH = 'data/scryfall-oracle-cards.json';
const BANNED_PATH = 'docs/rules/commander-banned-list.md';
const DB_PATH = 'data/decks.sqlite';

function parseArgs(argv: string[]): { inputs: string[]; save: boolean } {
  const inputs: string[] = [];
  let save = true;
  for (const arg of argv) {
    if (arg === '--no-save') save = false;
    else inputs.push(arg);
  }
  return { inputs, save };
}

/** A positional arg is a URL as-is, or the contents of the file it names (plaintext deck). */
function readInput(arg: string): string {
  if (/^https?:\/\//i.test(arg)) return arg;
  return readFileSync(resolve(arg), 'utf8');
}

function printResult(idx: number, result: DeckPipelineResult): void {
  const label = result.deckName ?? result.sourceType ?? 'deck';
  const header = `[${idx + 1}] ${label}`;
  console.log('\n' + header);
  console.log('─'.repeat(header.length));

  if (result.status === 'importError') {
    console.log(`  ✗ IMPORT FAILED — ${result.importError}`);
    return;
  }

  console.log(`  source:    ${result.sourceType}`);
  console.log(`  commander: ${result.commanderNames.join(' & ') || '(none)'}`);
  console.log(`  identity:  {${result.colorIdentity.join('') || 'C'}}`);
  console.log(`  archetype: ${result.archetypeTag}`);
  console.log(`  cards:     ${result.cardCount}`);

  if (result.status === 'unresolved') {
    console.log(`  ✗ UNRESOLVED NAMES (${result.unresolvedNames.length}):`);
    for (const name of result.unresolvedNames) console.log(`      - ${name}`);
    return;
  }
  if (result.status === 'invalid') {
    console.log(`  ✗ INVALID — ${result.issues.length} problem(s):`);
    for (const issue of result.issues) console.log(`      • [${issue.code}] ${issue.message}`);
    return;
  }
  console.log(`  ✓ VALID${result.snapshotId ? ` — snapshot ${result.snapshotId}` : ''}`);
}

async function main(): Promise<void> {
  const { inputs, save } = parseArgs(process.argv.slice(2));
  if (inputs.length === 0) {
    console.error('Usage: bun run decks [--no-save] <deckUrlOrFile> [more...]');
    process.exit(2);
  }

  console.log(`Loading oracle data from ${BULK_PATH} …`);
  const index = loadOracleIndexFromFile(resolve(BULK_PATH));
  console.log(`  indexed ${index.size.toLocaleString()} cards.`);
  const banned = loadBannedList(resolve(BANNED_PATH));
  console.log(`  loaded ${banned.names.length} banned card names.`);

  const store = save ? new GameStore(resolve(DB_PATH)) : undefined;

  const results: DeckPipelineResult[] = [];
  for (const arg of inputs) {
    let input: string;
    try {
      input = readInput(arg);
    } catch (err) {
      console.error(`Could not read input "${arg}": ${(err as Error).message}`);
      continue;
    }
    results.push(await runDeckPipeline(input, { index, banned, ...(store ? { store } : {}) }));
  }

  results.forEach((r, i) => printResult(i, r));

  const valid = results.filter((r) => r.status === 'valid').length;
  console.log(`\n${valid}/${results.length} deck(s) valid${save ? ' and snapshotted' : ''}.`);
  store?.close();
}

void main();

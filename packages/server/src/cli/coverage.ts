/**
 * Real-deck model-coverage report (see `cards/coverage.ts` for what the families mean).
 *
 *   bun run coverage                          # the committed fixture decks
 *   bun run coverage --json                   # machine-diffable, for tracking a delta
 *   bun run coverage <fileOrUrl> [more...]    # arbitrary decks, including live URLs
 *   bun run coverage --strict                 # skip decks that aren't Commander-legal
 *   bun run coverage --oracle-fixture packages/server/fixtures/coverage-oracle.json
 *
 * Paths are resolved from the repository root (the process working directory).
 *
 * Deck legality is NOT required by default: coverage measures which cards the engine can model,
 * which is independent of whether the pile around them is a legal 100. Some committed fixtures
 * are real decks mid-tune (see `snapshot-coverage-decks.ts`), and dropping them would silently
 * shrink the measured population. `--strict` restores the old skip-on-invalid behaviour.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { coverageInput } from './coverage-input';
import { measureCoverage, type DeckCards } from '../cards/coverage';
import { checkCoverageBaseline } from '../cards/coverage-baseline';
import { assertCompleteCoverage } from '../cards/coverage-contract';
import { importDeck } from '../decks/source';
import { resolveDeck } from '../decks/resolve';
import { validateDeck } from '../decks/validate';
import { loadBannedList } from '../decks/banned';

const FIXTURE_DIR = 'packages/server/fixtures/coverage-decks';
/** Precon/catalog leftovers that must not re-enter required coverage counts. */
const EXCLUDED_COVERAGE_DECKS = new Set(['counter-intelligence.txt']);

function parseArgs(argv: string[]): { inputs: string[]; json: boolean; strict: boolean } {
  const inputs: string[] = [];
  let json = false;
  let strict = false;
  for (const arg of argv) {
    if (arg === '--complete') continue;
    else if (arg === '--json') json = true;
    else if (arg === '--strict') strict = true;
    else inputs.push(arg);
  }
  return { inputs, json, strict };
}

/**
 * Default to every fixture in the directory. Listed explicitly rather than via a shell glob:
 * PowerShell does not expand `*.txt`, so a glob argument would arrive here literal.
 */
function defaultInputs(): string[] {
  return readdirSync(resolve(FIXTURE_DIR))
    .filter((f) => f.endsWith('.txt') && !EXCLUDED_COVERAGE_DECKS.has(f))
    .sort()
    .map((f) => join(FIXTURE_DIR, f));
}

function readInput(arg: string): string {
  if (/^https?:\/\//i.test(arg)) return arg;
  return readFileSync(resolve(arg), 'utf8');
}

const pct = (n: number, of: number): string =>
  of === 0 ? '0.0%' : `${((n / of) * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const input = coverageInput(process.argv.slice(2));
  const { inputs: userInputs, json, strict } = parseArgs(input.args);
  const inputs = userInputs.length > 0 ? userInputs : defaultInputs();
  if (inputs.length === 0) {
    console.error(
      `No decks to measure. Run "bun run coverage:snapshot" to populate ${FIXTURE_DIR}.`,
    );
    process.exit(2);
  }

  if (!json) console.error(`Loading oracle data from ${input.path} …`);
  const index = input.index;
  if (!json) console.error(`  indexed ${index.size.toLocaleString()} cards.`);

  const banned = loadBannedList(resolve('docs/rules/commander-banned-list.md'));

  const decks: DeckCards[] = [];
  let inputFailures = 0;
  for (const arg of inputs) {
    let raw: string;
    try {
      raw = readInput(arg);
    } catch (err) {
      console.error(`  ✗ could not read "${arg}": ${(err as Error).message}`);
      inputFailures++;
      continue;
    }

    let parsed;
    try {
      parsed = await importDeck(raw);
    } catch (err) {
      console.error(`  ✗ import failed for "${arg}": ${(err as Error).message}`);
      inputFailures++;
      continue;
    }

    const { resolved, unresolvedNames } = resolveDeck(parsed, index);
    if (resolved === null) {
      console.error(`  ✗ unresolved names in "${arg}": ${unresolvedNames.join(', ')}`);
      inputFailures++;
      continue;
    }

    const validation = validateDeck(resolved, banned);
    if (!validation.valid) {
      const issues = validation.issues.map((i) => `[${i.code}] ${i.message}`).join('; ');
      if (strict) {
        console.error(`  ✗ invalid deck in "${arg}": ${issues} — skipped (--strict)`);
        continue;
      }
      console.error(`  ! measuring "${arg}" anyway: ${issues}`);
    }

    // Commanders and the companion live OUTSIDE `.cards` — unioning them is not optional,
    // or the commander (the most mechanically complex card in the deck) goes unmeasured.
    const cards: OracleCard[] = [
      ...resolved.commanders,
      ...(resolved.companion === null ? [] : [resolved.companion]),
      ...resolved.cards.map((e) => e.card),
    ];
    decks.push({ name: resolved.name ?? parsed.name ?? basename(arg), cards });
  }

  if (inputFailures > 0)
    throw new Error(`coverage failed: ${inputFailures} input(s) could not be measured`);
  const report = measureCoverage(decks);
  if (userInputs.length === 0 && !strict) checkCoverageBaseline(report, index, 'fixtures');
  if (process.argv.includes('--complete')) {
    if (userInputs.length > 0 || strict)
      throw new Error('--complete requires the entire default fixture population');
    assertCompleteCoverage(report);
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\nPer-deck coverage');
  console.log('─'.repeat(17));
  for (const deck of report.decks) {
    const label = deck.name.length > 52 ? `${deck.name.slice(0, 49)}…` : deck.name;
    console.log(
      `  ${label.padEnd(53)} ${String(deck.modeled).padStart(3)}/${String(deck.uniqueCards).padEnd(4)} ${pct(deck.modeled, deck.uniqueCards)}`,
    );
  }

  console.log('\nAggregate (unique cards across all decks)');
  console.log('─'.repeat(41));
  console.log(`  unique cards: ${report.uniqueCards}`);
  console.log(
    `  modeled:      ${report.modeledCards} (${pct(report.modeledCards, report.uniqueCards)})`,
  );

  console.log('\nBlocking mechanics — cards each would unblock, at most');
  console.log('─'.repeat(53));
  console.log('  (overlapping: a card blocked by three mechanics counts in all three)\n');
  for (const { family, cards } of report.byFamily) {
    console.log(`  ${String(cards).padStart(4)}  ${family}`);
  }

  console.log('\nTop reason strings');
  console.log('─'.repeat(18));
  for (const { reason, count } of report.topReasons.slice(0, 15)) {
    const flat = reason.replace(/\s+/g, ' ');
    const shown = flat.length > 96 ? `${flat.slice(0, 93)}…` : flat;
    console.log(`  ${String(count).padStart(3)}  ${shown}`);
  }
  console.log();
}

void main();

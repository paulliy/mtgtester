/**
 * Deck-level coverage: how many whole decks the engine can play (see `cards/deck-coverage.ts`).
 *
 *   bun run deck-coverage                  # write the committed report (JSON and Markdown)
 *   bun run deck-coverage --check          # fail if the committed report is out of date
 *   bun run deck-coverage --json           # print the report instead of writing it
 *   bun run deck-coverage --decks <dir>    # measure a folder of plaintext decks; prints, never writes
 *   bun run deck-coverage --decks <file.json>
 *                                          # measure an average-deck fixture (pinned Oracle beside it
 *                                          # at --oracle <file>, default the committed one)
 *   bun run deck-coverage --pin [--bank <file>]
 *                                          # copy the Oracle records of every average-deck card from
 *                                          # the Scryfall bank into the pinned file
 *
 * Populations, in report order:
 * - **fixture decks**: the coverage decks, resolved against the pinned coverage Oracle fixture.
 * - **EDHREC average decks**: present once `bun run edhrec:fetch --average-decks N` and
 *   `bun run deck-coverage --pin` have been run and their two fixtures committed.
 *
 * Never uses the network.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import {
  DECK_COVERAGE_PATH,
  measureDeckCoverage,
  NO_PROVISIONAL,
  provisionalFromQueue,
  renderDeckCoverageJson,
  renderDeckCoverageMarkdown,
  headline,
  type DeckInput,
  type PopulationReport,
  type ProvisionalLookup,
  type QueueEntryView,
} from '../cards/deck-coverage';
import {
  AVERAGE_DECKS_ORACLE_PATH,
  AVERAGE_DECKS_PATH,
  averageDeckInputs,
  pinAverageDeckOracle,
  renderPinnedOracle,
  type AverageDecksFixture,
  type PinnedAverageDeckOracle,
} from '../cards/edhrec-average-decks';
import {
  buildOracleIndexFromCards,
  loadOracleIndexFromFile,
  type OracleIndex,
} from '../cards/oracle-index';
import { importDeck } from '../decks/source';
import { resolveDeck } from '../decks/resolve';
import { PINNED_ORACLE_FIXTURE } from './coverage-input';

const JSON_PATH = DECK_COVERAGE_PATH;
const MARKDOWN_PATH = 'docs/plans/deck-coverage.md';
/**
 * The coverage decks only. The generated decks are built from the modeled pool, so they are
 * playable by construction and their cards are not in the pinned Oracle fixture.
 */
const DECK_DIRS = ['packages/server/fixtures/coverage-decks'];
/** Same exclusion as `bun run coverage` and the known-decks list. */
const EXCLUDED_DECKS = new Set(['counter-intelligence.txt']);
const QUEUE_PATH = 'docs/reviews/compiled-card-queue.json';
/** Patches pulled out of the provisional tier after a fuzz failure (written by that tier's work). */
const DEMOTED_PATH = 'docs/reviews/provisional-demoted.json';
const DEFAULT_BANK = 'data/scryfall-oracle-cards.json';

function option(name: string): string | undefined {
  const slot = process.argv.indexOf(name);
  if (slot < 0) return undefined;
  const value = process.argv[slot + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

/**
 * The provisional column's source. Until the provisional trust tier lands it is the compiled-card
 * review queue read directly; switching to that tier's loader means changing only this function.
 */
function provisionalLookup(): ProvisionalLookup {
  if (!existsSync(resolve(QUEUE_PATH))) return NO_PROVISIONAL;
  const queue = JSON.parse(readFileSync(resolve(QUEUE_PATH), 'utf8')) as {
    cards: QueueEntryView[];
  };
  const demoted = existsSync(resolve(DEMOTED_PATH))
    ? (
        JSON.parse(readFileSync(resolve(DEMOTED_PATH), 'utf8')) as {
          cards: { oracleId: string; patchSha256: string }[];
        }
      ).cards.map((card) => `${card.oracleId}|${card.patchSha256}`)
    : [];
  return provisionalFromQueue(
    queue.cards,
    (path) =>
      existsSync(resolve(path))
        ? createHash('sha256')
            .update(readFileSync(resolve(path)))
            .digest('hex')
        : null,
    new Set(demoted),
  );
}

function readPinnedOracle(path: string): OracleIndex {
  return buildOracleIndexFromCards(JSON.parse(readFileSync(resolve(path), 'utf8')) as OracleCard[]);
}

/** Plaintext decks from folders, commanders and companion unioned in, resolved against `index`. */
async function textDecks(dirs: readonly string[], index: OracleIndex): Promise<DeckInput[]> {
  const decks: DeckInput[] = [];
  for (const dir of dirs) {
    const files = readdirSync(resolve(dir))
      .filter((file) => file.endsWith('.txt') && !EXCLUDED_DECKS.has(file))
      .sort();
    for (const file of files) {
      const parsed = await importDeck(readFileSync(resolve(join(dir, file)), 'utf8'));
      const { resolved, unresolvedNames } = resolveDeck(parsed, index);
      if (resolved === null)
        throw new Error(`${join(dir, file)}: unresolved names ${unresolvedNames.join(', ')}`);
      decks.push({
        name: basename(file, '.txt'),
        cards: [
          ...resolved.commanders,
          ...(resolved.companion === null ? [] : [resolved.companion]),
          ...resolved.cards.map((entry) => entry.card),
        ],
      });
    }
  }
  return decks;
}

function averageDecks(fixturePath: string, oraclePath: string): DeckInput[] {
  const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8')) as AverageDecksFixture;
  const pinned = JSON.parse(readFileSync(resolve(oraclePath), 'utf8')) as PinnedAverageDeckOracle;
  return averageDeckInputs(fixture, buildOracleIndexFromCards(pinned.cards), pinned.unresolved);
}

async function committedPopulations(lookup: ProvisionalLookup): Promise<PopulationReport[]> {
  const populations: PopulationReport[] = [
    {
      name: 'fixture decks',
      source: `the coverage deck fixtures, Oracle text from \`${PINNED_ORACLE_FIXTURE}\``,
      ...measureDeckCoverage(
        await textDecks(DECK_DIRS, readPinnedOracle(PINNED_ORACLE_FIXTURE)),
        lookup,
      ),
    },
  ];
  if (existsSync(resolve(AVERAGE_DECKS_PATH)) && existsSync(resolve(AVERAGE_DECKS_ORACLE_PATH))) {
    const fixture = JSON.parse(
      readFileSync(resolve(AVERAGE_DECKS_PATH), 'utf8'),
    ) as AverageDecksFixture;
    populations.push({
      name: 'EDHREC average decks',
      source: `EDHREC average decks of the top ${fixture.decks.length} commanders, fetched ${fixture.fetchedAt}; Oracle text from \`${AVERAGE_DECKS_ORACLE_PATH}\``,
      ...measureDeckCoverage(averageDecks(AVERAGE_DECKS_PATH, AVERAGE_DECKS_ORACLE_PATH), lookup),
    });
  }
  return populations;
}

function pin(): void {
  const bank = option('--bank') ?? DEFAULT_BANK;
  if (!existsSync(resolve(bank))) {
    console.error(
      `deck-coverage --pin needs the Scryfall bank at ${bank}; run bun run scryfall:update`,
    );
    process.exit(2);
  }
  if (!existsSync(resolve(AVERAGE_DECKS_PATH))) {
    console.error(`no ${AVERAGE_DECKS_PATH}; run bun run edhrec:fetch --average-decks 200 first`);
    process.exit(2);
  }
  const fixture = JSON.parse(
    readFileSync(resolve(AVERAGE_DECKS_PATH), 'utf8'),
  ) as AverageDecksFixture;
  console.error(`Loading Oracle data from ${bank} …`);
  const { cards, unresolved } = pinAverageDeckOracle(
    fixture,
    loadOracleIndexFromFile(resolve(bank)),
  );
  if (unresolved.length > 0)
    console.error(`unresolved (each blocks its decks): ${unresolved.join(', ')}`);
  writeFileSync(resolve(AVERAGE_DECKS_ORACLE_PATH), renderPinnedOracle({ unresolved, cards }));
  console.log(
    `pinned ${cards.length} cards to ${AVERAGE_DECKS_ORACLE_PATH}; run bun run deck-coverage`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--pin')) {
    pin();
    return;
  }
  const lookup = provisionalLookup();
  const decksArg = option('--decks');
  if (decksArg !== undefined) {
    const decks = statSync(resolve(decksArg)).isDirectory()
      ? await textDecks([decksArg], readPinnedOracle(option('--oracle') ?? PINNED_ORACLE_FIXTURE))
      : averageDecks(decksArg, option('--oracle') ?? AVERAGE_DECKS_ORACLE_PATH);
    const population: PopulationReport = {
      name: basename(decksArg),
      source: `\`${decksArg}\``,
      ...measureDeckCoverage(decks, lookup),
    };
    console.log(
      process.argv.includes('--json')
        ? renderDeckCoverageJson([population])
        : renderDeckCoverageMarkdown([population]),
    );
    return;
  }

  const populations = await committedPopulations(lookup);
  const json = renderDeckCoverageJson(populations);
  const markdown = renderDeckCoverageMarkdown(populations);
  if (process.argv.includes('--json')) {
    console.log(json);
    return;
  }
  if (process.argv.includes('--check')) {
    const stale = [JSON_PATH, MARKDOWN_PATH].filter(
      (path, i) =>
        !existsSync(resolve(path)) || readFileSync(resolve(path), 'utf8') !== [json, markdown][i],
    );
    if (stale.length > 0) {
      console.error(`out of date: ${stale.join(', ')}; run bun run deck-coverage`);
      process.exit(1);
    }
    console.log(`deck coverage is up to date. ${populations.map(headline).join(' ')}`);
    return;
  }
  writeFileSync(resolve(JSON_PATH), json);
  writeFileSync(resolve(MARKDOWN_PATH), markdown);
  for (const population of populations) console.log(headline(population));
  console.log(`wrote ${JSON_PATH} and ${MARKDOWN_PATH}`);
}

await main();

/**
 * Snapshot real decklists into plaintext fixtures for the coverage suite.
 *
 *   bun run coverage:snapshot                      # refresh the committed baseline decks
 *   bun run coverage:snapshot <url> [more...]      # snapshot arbitrary decks
 *   bun run coverage:snapshot --lenient <url>      # keep going when a deck isn't Commander-legal
 *   bun run coverage:snapshot --only <slug>        # refresh just one baseline deck, in place
 *
 * The coverage suite reads committed .txt files rather than hitting the network, so the
 * measurement is reproducible offline and in CI. Re-run this only to refresh against the live
 * lists (precons get re-published and drift).
 *
 * Fixture names are derived from the URL when snapshotting arbitrary decks; the defaults
 * carry fixed slugs so re-running overwrites in place rather than accumulating files.
 *
 * `--lenient` downgrades deck-legality failures (wrong card count, banned card, colour identity)
 * to warnings. Coverage measures which CARDS the engine can model, which is independent of
 * whether the pile around them is a legal 100. A real deck someone is still tuning is a
 * perfectly good coverage sample, and refusing it only hides mechanics we can't yet play.
 * Legality still gates the paths that actually deal a game — `bun run decks` and match setup.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ParsedDeck } from '@mtg/shared';
import { importDeck } from '../decks/source';
import { loadOracleIndexFromFile } from '../cards/oracle-index';
import { resolveDeck } from '../decks/resolve';
import { validateDeck } from '../decks/validate';
import { loadBannedList } from '../decks/banned';

const OUT_DIR = 'packages/server/fixtures/coverage-decks';

/**
 * The committed baseline: real Commander precons across all five colors, plus community decks
 * that stress mechanics the precons never touch. `lenient` marks a deck that is not a legal 100
 * — kept deliberately, and snapshotted verbatim rather than trimmed to fit.
 */
const DEFAULT_DECKS: { slug: string; url: string; lenient?: boolean }[] = [
  { slug: 'silverquill-influence', url: 'https://moxfield.com/decks/OFOsgdmYqEuQKkJwsOmrpQ' },
  { slug: 'living-energy', url: 'https://moxfield.com/decks/jWSmSfkdGEijTfTX_d8qNQ' },
  {
    slug: 'counter-intelligence',
    url: 'https://archidekt.com/decks/14921159/counter_intelligence_edge_of_eternities_commander_precon_decklist',
  },
  {
    slug: 'necron-dynasties',
    url: 'https://archidekt.com/decks/15372331/necron_dynasties_warhammer_40000_commander_precon_decklist',
  },
  { slug: 'draconic-destruction', url: 'https://moxfield.com/decks/s1kxq0vGHka-4sJoo2LfGQ' },
  { slug: 'token-triumph', url: 'https://moxfield.com/decks/pMWE5dQwp02YoeVXDgkF0A' },
  // Community decks (102 cards each — mid-tune, hence `lenient`). Both sit near 35% modeled and
  // are the samples driving the current coverage plan: Brigid is go-wide tokens + counters,
  // Pramikon is a goad/politics pile with planeswalkers. See docs/plans/edh-staple-coverage.md.
  {
    slug: 'brigid-clachans-heart',
    url: 'https://moxfield.com/decks/JNb6eS0_L0WHZAsGq-wjRA',
    lenient: true,
  },
  {
    slug: 'pramikon-sky-rampart',
    url: 'https://moxfield.com/decks/QkagAeRybXmuv4wZIIaASw',
    lenient: true,
  },
];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * A filesystem-safe fixture name for a user-supplied deck. Prefers the deck's own name — a
 * Moxfield URL ends in an opaque id (`wrCzCStOikeFbl4UmYL3oQ`), which makes an unreadable
 * fixture — and falls back to the URL tail only when the source gives no name.
 */
function slugFor(deckName: string | null, url: string): string {
  const fromName = deckName === null ? '' : slugify(deckName);
  if (fromName.length > 0) return fromName;
  return slugify(url.replace(/\/+$/, '').split('/').pop() ?? 'deck') || 'deck';
}

/** Render a parsed deck in the plaintext format `parsePlaintextDeck` accepts. */
function toPlaintext(deck: ParsedDeck, url: string): string {
  const lines = [`# ${deck.name ?? 'Untitled'}`, `# snapshot of ${url}`, ''];
  if (deck.commanderNames.length > 0) {
    lines.push('Commander');
    for (const name of deck.commanderNames) lines.push(`1 ${name}`);
    lines.push('');
  }
  if (deck.companionName !== null) {
    lines.push('Companion', `1 ${deck.companionName}`, '');
  }
  lines.push('Deck');
  for (const entry of deck.cards) lines.push(`${entry.quantity} ${entry.name}`);
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const lenientFlag = args.includes('--lenient');
  // `--only <slug>` (repeatable) narrows the baseline refresh to named decks, so refreshing one
  // deck doesn't rewrite every other fixture and churn the suites that read them.
  const only = new Set<string>();
  const urls: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--lenient') continue;
    if (arg === '--only') {
      const slug = args[++i];
      if (slug === undefined) {
        console.error('--only requires a slug, e.g. --only token-triumph');
        process.exit(2);
      }
      only.add(slug);
      continue;
    }
    urls.push(arg as string);
  }

  const known = new Set(DEFAULT_DECKS.map((d) => d.slug));
  for (const slug of only) {
    if (!known.has(slug)) {
      console.error(`--only ${slug}: not a baseline deck. Known: ${[...known].join(', ')}`);
      process.exit(2);
    }
  }

  // A default deck keeps its fixed slug so re-running overwrites in place; a user-supplied
  // one is named from the deck itself, which is only known after the fetch.
  const targets: { slug: string | null; url: string; lenient?: boolean }[] =
    urls.length > 0
      ? urls.map((url) => ({ slug: null, url, lenient: lenientFlag }))
      : DEFAULT_DECKS.filter((d) => only.size === 0 || only.has(d.slug));

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const index = loadOracleIndexFromFile(resolve('data/scryfall-oracle-cards.json'));
  const banned = loadBannedList(resolve('docs/rules/commander-banned-list.md'));
  let failures = 0;

  for (const { slug, url, lenient = false } of targets) {
    try {
      const parsed = await importDeck(url);
      const { resolved } = resolveDeck(parsed, index);
      if (resolved === null) {
        throw new Error('unresolved card names');
      }
      const validation = validateDeck(resolved, banned);
      if (!validation.valid) {
        const issues = validation.issues.map((i) => `[${i.code}] ${i.message}`).join('; ');
        if (!lenient)
          throw new Error(`deck invalid: ${issues} (pass --lenient to snapshot anyway)`);
        console.warn(`  ! ${url}: ${issues} — snapshotting anyway (--lenient)`);
      }
      const name = slug ?? slugFor(parsed.name, url);
      const total =
        parsed.commanderNames.length +
        (parsed.companionName === null ? 0 : 1) +
        parsed.cards.reduce((sum, entry) => sum + entry.quantity, 0);
      writeFileSync(resolve(OUT_DIR, `${name}.txt`), toPlaintext(parsed, url), 'utf8');
      console.log(`✓ ${name}.txt — ${total} cards (${parsed.name ?? 'untitled'})`);
    } catch (err) {
      failures++;
      console.error(`✗ ${url}: ${(err as Error).message}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures}/${targets.length} deck(s) failed to snapshot.`);
    process.exitCode = 1;
  }
}

void main();

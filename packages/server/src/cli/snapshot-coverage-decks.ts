/**
 * Snapshot real decklists into plaintext fixtures for the coverage suite.
 *
 *   bun run coverage:snapshot                      # refresh the six committed precons
 *   bun run coverage:snapshot <url> [more...]      # snapshot arbitrary decks
 *
 * The coverage suite reads committed .txt files rather than hitting the network, so the
 * measurement is reproducible offline and in CI. Re-run this only to refresh against the live
 * lists (precons get re-published and drift).
 *
 * Fixture names are derived from the URL when snapshotting arbitrary decks; the six defaults
 * carry fixed slugs so re-running overwrites in place rather than accumulating files.
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

/** The committed baseline: six real Commander precons across all five colors. */
const DEFAULT_DECKS: { slug: string; url: string }[] = [
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
  // A default deck keeps its fixed slug so re-running overwrites in place; a user-supplied
  // one is named from the deck itself, which is only known after the fetch.
  const targets =
    args.length > 0 ? args.map((url) => ({ slug: null, url })) : DEFAULT_DECKS;

  mkdirSync(resolve(OUT_DIR), { recursive: true });
  const index = loadOracleIndexFromFile(resolve('data/scryfall-oracle-cards.json'));
  const banned = loadBannedList(resolve('docs/rules/commander-banned-list.md'));
  let failures = 0;

  for (const { slug, url } of targets) {
    try {
      const parsed = await importDeck(url);
      const { resolved } = resolveDeck(parsed, index);
      if (resolved === null) {
        throw new Error('unresolved card names');
      }
      const validation = validateDeck(resolved, banned);
      if (!validation.valid) {
        const issues = validation.issues.map((i) => `[${i.code}] ${i.message}`).join('; ');
        throw new Error(`deck invalid: ${issues}`);
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

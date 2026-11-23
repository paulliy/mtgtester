import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256Hex, type OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { importDeck } from '../decks/source';
import { resolveDeck } from '../decks/resolve';
import { buildOracleIndexFromCards } from './oracle-index';
import { buildSupportedPool } from './pool';
import {
  buildSiteCards,
  deckCardNames,
  SITE_CARD_SHARDS,
  SITE_CARDS_MANIFEST,
  SiteCards,
  siteShardOf,
} from './site-cards';

const ROOT = resolve(__dirname, '../../../..');
const fixture = JSON.parse(
  readFileSync(join(ROOT, 'packages/server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const DECK_DIR = join(ROOT, 'packages/server/fixtures/coverage-decks');

let nextId = 0;
const base = fixture.find((card) => card.name === 'Llanowar Elves') ?? fixture[0]!;
/** A card the engine does not model, so it lands in a shard rather than the pool. */
function unmodeled(name: string, extra: Partial<OracleCard> = {}): OracleCard {
  nextId++;
  return {
    ...base,
    oracleId: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    scryfallId: `10000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    name,
    oracleText: 'Whenever the moon is full, you may sing a song of the zyxwv. If you do, xyzzy.',
    ...extra,
  };
}

/** The awkward names: shared strict keys, loose collisions, double faces, diacritics. */
const extras: OracleCard[] = [
  unmodeled('Moonsong Zyxwv'),
  unmodeled('Pick Your Poison', { commanderLegality: 'not_legal' }), // shares a real name
  unmodeled('Nazgûl Zyxwv'),
  unmodeled('Front Face Zyxwv // Back Face Zyxwv', { layout: 'transform' }),
  unmodeled('Loose-Twin Zyxwv'),
  unmodeled('Loose Twin, Zyxwv'), // same loose key as the one above: ambiguous
  unmodeled("Zyxwv's Gambit"),
  unmodeled('Banned Zyxwv', { commanderLegality: 'banned' }),
];
// A repeated Oracle id: both sides keep the first.
extras.push({ ...extras[0]!, name: 'Duplicate Id Zyxwv' });
const cards = [...fixture, ...extras];

const built = buildSiteCards({
  cards,
  bannedNames: ['Banned Zyxwv', 'Sol Ring'],
  decks: [],
  sourceSha256: 'f'.repeat(64),
  engine: { version: 'test', commit: null },
});

function served(files = built.files): {
  fetchText: (path: string) => Promise<string>;
  log: string[];
} {
  const log: string[] = [];
  return {
    log,
    fetchText: async (path) => {
      log.push(path);
      const text = files.get(path);
      if (text === undefined) throw new Error(`404 ${path}`);
      return text;
    },
  };
}

/** Every spelling a decklist might use for each card, plus misses. */
function queries(): string[] {
  const out = new Set<string>();
  for (const card of cards) {
    const names = [
      card.name,
      ...(card.name.includes('//') ? [card.name.split('//')[0]!.trim()] : []),
    ];
    for (const name of names) {
      out.add(name);
      out.add(name.toUpperCase());
      out.add(name.replace(/'/g, '’'));
      out.add(name.normalize('NFD').replace(/\p{Diacritic}/gu, ''));
      out.add(name.replace(/[^A-Za-z0-9 ]+/g, ' '));
      out.add(`${name}x`);
    }
  }
  out.add('Loose Twin Zyxwv');
  out.add('No Such Card At All');
  return [...out];
}

describe('site card files', () => {
  it('resolve every name to the same card as the server index', async () => {
    const server = buildOracleIndexFromCards(cards);
    const sites = await SiteCards.open(served().fetchText);
    const names = queries();
    const site = await sites.indexFor(names);
    let resolvedCount = 0;
    for (const name of names) {
      const expected = server.resolve(name);
      if (expected !== null) resolvedCount++;
      expect(site.resolve(name), name).toEqual(expected);
    }
    // The cases above exercise both outcomes, including the ambiguous loose key.
    expect(resolvedCount).toBeGreaterThan(cards.length);
    expect(server.resolve('Loose Twin Zyxwv')).toBeNull();
    expect(site.resolve('Pick Your Poison')?.commanderLegality).not.toBe('not_legal');
  });

  it('resolve every committed deck the same way', async () => {
    const server = buildOracleIndexFromCards(cards);
    const sites = await SiteCards.open(served().fetchText);
    for (const file of readdirSync(DECK_DIR).filter((f) => f.endsWith('.txt'))) {
      const parsed = await importDeck(readFileSync(join(DECK_DIR, file), 'utf8'));
      const site = await sites.indexFor(deckCardNames(parsed));
      expect(resolveDeck(parsed, site), file).toEqual(resolveDeck(parsed, server));
    }
  });

  it('carry the supported pool, the banned list and the counts', async () => {
    const sites = await SiteCards.open(served().fetchText);
    const pool = buildSupportedPool(cards.slice(0, -1)); // the duplicate id is dropped
    expect(sites.pool).toEqual({ cards: pool.cards, considered: pool.considered });
    expect(sites.banned.isBanned('banned zyxwv')).toBe(true);
    expect(sites.banned.isBanned('Llanowar Elves')).toBe(false);
    expect(built.manifest.counts).toMatchObject({
      cards: cards.length - 1,
      pool: pool.cards.length,
      banned: 2,
    });
    expect(built.manifest.files.shards).toHaveLength(SITE_CARD_SHARDS);
  });

  it('fetch only the shards a deck needs', async () => {
    const { fetchText, log } = served();
    const sites = await SiteCards.open(fetchText);
    const opened = log.length;
    await sites.indexFor(['Llanowar Elves', 'Sol Ring']); // pool cards
    expect(log.length).toBe(opened);
    const index = await sites.indexFor(['Moonsong Zyxwv']);
    expect(log.slice(opened)).toEqual([
      built.manifest.files.shards[siteShardOf(extras[0]!.oracleId)],
    ]);
    expect(index.resolve('Moonsong Zyxwv')?.oracleId).toBe(extras[0]!.oracleId);
    expect(index.getByOracleId(extras[0]!.oracleId)?.name).toBe('Moonsong Zyxwv');
    await sites.indexFor(['Moonsong Zyxwv']);
    expect(log.length).toBe(opened + 1);
  });

  it('name each file by its hash and rebuild byte for byte', () => {
    for (const [name, text] of built.files) {
      if (name === SITE_CARDS_MANIFEST) continue;
      expect(name).toContain(`.${sha256Hex(text).slice(0, 16)}.json`);
    }
    const again = buildSiteCards({
      cards,
      bannedNames: ['Banned Zyxwv', 'Sol Ring'],
      decks: [],
      sourceSha256: 'f'.repeat(64),
      engine: { version: 'test', commit: null },
    });
    expect([...again.files]).toEqual([...built.files]);
  });

  it('keep unrelated shards byte for byte when a card is added', () => {
    // Not Commander-legal, so the pool's `considered` count stays the same too.
    const added = unmodeled('Newcomer Zyxwv', { commanderLegality: 'not_legal' });
    const grown = buildSiteCards({
      cards: [added, ...cards],
      bannedNames: ['Banned Zyxwv', 'Sol Ring'],
      decks: [],
      sourceSha256: 'f'.repeat(64),
      engine: { version: 'test', commit: null },
    });
    const changed = grown.manifest.files.shards.filter(
      (name, n) => name !== built.manifest.files.shards[n],
    );
    expect(changed).toEqual([grown.manifest.files.shards[siteShardOf(added.oracleId)]]);
    expect(grown.manifest.files.pool).toBe(built.manifest.files.pool);
  });

  it('refuse a file that does not match its hash', async () => {
    const files = new Map(built.files);
    const pool = built.manifest.files.pool;
    files.set(pool, files.get(pool)!.replace('Llanowar Elves', 'Llanowar Elvez'));
    await expect(SiteCards.open(served(files).fetchText)).rejects.toThrow(
      /does not match its hash/,
    );
  });
});

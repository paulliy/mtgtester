/**
 * The website's card data (ADR 0053): static, content-hashed files that let single player run in
 * the visitor's browser without the server's 30 MB card file.
 *
 * - `names`: every card's name, Commander legality flag, and where its body lives. Resolving a
 *   decklist runs `buildNameIndex` over these entries, the same code the server's
 *   `buildOracleIndexFromCards` runs, so a name resolves to the same card on both sides.
 * - `pool`: the engine-supported pool (`buildSupportedPool`), with full card bodies. Every
 *   playable card is here, so a playable deck needs no other body file.
 * - `shards`: the bodies of every other card, split by a hash of the Oracle id. A deck that names
 *   an unplayable card fetches only that card's shard, to report it the way the server does.
 * - `banned` and `decks`: the banned list and the known bot decks, precomputed.
 *
 * Every file name carries the first 16 hex digits of its SHA-256, so the files can be cached
 * forever; only `manifest.json` changes name-free. This module is browser-safe: the builder is
 * pure and the reader takes a `fetchText` function. The CLI that writes files is
 * `cli/site-cards.ts`.
 */

import { sha256Hex, type OracleCard, type ParsedDeck } from '@mtg/shared';
import {
  buildNameIndex,
  type NameIndex,
  type NameIndexEntry,
  type OracleIndex,
} from './oracle-index';
import { buildSupportedPool, type PoolCard, type SupportedPool } from './pool';
import { bannedListFromNames, type BannedList } from '../decks/banned';
import type { KnownDeckSummary } from './known-decks';

/** Changes whenever any file's shape does; the reader refuses any other value. */
export const SITE_CARDS_FORMAT = 'mtg-site-cards/1';

/** The one file without a hash in its name: the entry point that names all the others. */
export const SITE_CARDS_MANIFEST = 'manifest.json';

/** Body shards for cards outside the pool: about 500 cards, 60 KB gzipped, each. */
export const SITE_CARD_SHARDS = 64;

/** Where a name entry's body lives: `POOL_LOCATION` for the pool file, else a shard number. */
const POOL_LOCATION = -1;

export interface SiteCardsManifest {
  format: typeof SITE_CARDS_FORMAT;
  /** SHA-256 of the card data the files were built from (the Scryfall bulk file). */
  sourceSha256: string;
  /** The engine build that interpreted the cards into the pool. */
  engine: { version: string; commit: string | null };
  /** SHA-256 over every file name below. Each name carries its own file's hash. */
  contentSha256: string;
  counts: { cards: number; pool: number; considered: number; banned: number; decks: number };
  files: { names: string; pool: string; banned: string; decks: string; shards: string[] };
}

/** One name entry: `[name, commanderLegal ? 1 : 0, location]`. Its body is keyed by position. */
type NameEntry = [name: string, legal: 0 | 1, location: number];

interface NamesFile {
  format: typeof SITE_CARDS_FORMAT;
  entries: NameEntry[];
}
interface PoolFile {
  format: typeof SITE_CARDS_FORMAT;
  considered: number;
  cards: Array<[entry: number, card: PoolCard]>;
}
interface ShardFile {
  format: typeof SITE_CARDS_FORMAT;
  cards: Array<[entry: number, card: OracleCard]>;
}
interface BannedFile {
  format: typeof SITE_CARDS_FORMAT;
  names: string[];
}
interface DecksFile {
  format: typeof SITE_CARDS_FORMAT;
  decks: KnownDeckSummary[];
}

export interface SiteCardsInput {
  cards: readonly OracleCard[];
  bannedNames: readonly string[];
  decks: readonly KnownDeckSummary[];
  sourceSha256: string;
  engine: { version: string; commit: string | null };
}

export interface SiteCardsBuild {
  manifest: SiteCardsManifest;
  /** Every file to publish, manifest included, by its path relative to the site's card folder. */
  files: Map<string, string>;
}

/** FNV-1a, 32 bit: a stable shard for an Oracle id, so unchanged cards keep their shard. */
export function siteShardOf(oracleId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < oracleId.length; i++) {
    hash ^= oracleId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % SITE_CARD_SHARDS;
}

const hashedName = (stem: string, text: string): string =>
  `${stem}.${sha256Hex(text).slice(0, 16)}.json`;

/** The hash a file name claims, or null for a name without one. */
function claimedHash(file: string): string | null {
  return /\.([0-9a-f]{16})\.json$/.exec(file)?.[1] ?? null;
}

/** Build every site card file. Pure and deterministic: the same input gives the same bytes. */
export function buildSiteCards(input: SiteCardsInput): SiteCardsBuild {
  // The server's index keeps the first card of a repeated Oracle id; so do the name entries.
  const seen = new Set<string>();
  const cards: OracleCard[] = [];
  for (const card of input.cards) {
    if (seen.has(card.oracleId)) continue;
    seen.add(card.oracleId);
    cards.push(card);
  }

  const pool = buildSupportedPool(cards);
  const inPool = new Map(pool.cards.map((entry) => [entry.card.oracleId, entry]));
  const position = new Map(cards.map((card, i) => [card.oracleId, i]));

  const entries: NameEntry[] = [];
  const shards: Array<Array<[number, OracleCard]>> = Array.from(
    { length: SITE_CARD_SHARDS },
    () => [],
  );
  cards.forEach((card, i) => {
    const location = inPool.has(card.oracleId) ? POOL_LOCATION : siteShardOf(card.oracleId);
    entries.push([card.name, card.commanderLegality === 'not_legal' ? 0 : 1, location]);
    if (location !== POOL_LOCATION) shards[location]?.push([i, card]);
  });

  const files = new Map<string, string>();
  const write = (stem: string, body: object): string => {
    const text = `${JSON.stringify({ format: SITE_CARDS_FORMAT, ...body })}\n`;
    const name = hashedName(stem, text);
    files.set(name, text);
    return name;
  };

  const names = write('names', { entries } satisfies Omit<NamesFile, 'format'>);
  const poolFile = write('pool', {
    considered: pool.considered,
    cards: pool.cards.map((entry) => [position.get(entry.card.oracleId) ?? -1, entry]),
  } satisfies Omit<PoolFile, 'format'>);
  const shardFiles = shards.map((list, n) =>
    write(`shard-${String(n).padStart(2, '0')}`, { cards: list } satisfies Omit<
      ShardFile,
      'format'
    >),
  );
  const banned = write('banned', { names: [...input.bannedNames] } satisfies Omit<
    BannedFile,
    'format'
  >);
  const decks = write('decks', { decks: [...input.decks] } satisfies Omit<DecksFile, 'format'>);

  const listed = { names, pool: poolFile, banned, decks, shards: shardFiles };
  const manifest: SiteCardsManifest = {
    format: SITE_CARDS_FORMAT,
    sourceSha256: input.sourceSha256,
    engine: { ...input.engine },
    contentSha256: sha256Hex([names, poolFile, banned, decks, ...shardFiles].join('\n')),
    counts: {
      cards: cards.length,
      pool: pool.cards.length,
      considered: pool.considered,
      banned: input.bannedNames.length,
      decks: input.decks.length,
    },
    files: listed,
  };
  files.set(SITE_CARDS_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, files };
}

/** Fetch one file's text by its path relative to the site's card folder. */
export type FetchText = (path: string) => Promise<string>;

/** A name entry as `buildNameIndex` sees it: its position stands in for the Oracle id. */
interface NameStub extends NameIndexEntry {
  readonly entry: number;
  readonly location: number;
}

/** Every name a deck resolves: commanders, companion, main deck (`resolveDeck`'s order). */
export function deckCardNames(parsed: ParsedDeck): string[] {
  return [
    ...parsed.commanderNames,
    ...(parsed.companionName ? [parsed.companionName] : []),
    ...parsed.cards.map((entry) => entry.name),
  ];
}

/** The site's card data, read in the browser. Open once; `indexFor` fetches bodies on demand. */
export class SiteCards {
  private readonly bodies = new Map<number, OracleCard>();
  private readonly byOracleId = new Map<string, OracleCard>();
  private readonly loadedShards = new Map<number, Promise<void>>();

  private constructor(
    private readonly read: <T>(file: string) => Promise<T>,
    readonly manifest: SiteCardsManifest,
    private readonly names: NameIndex<NameStub>,
    readonly pool: SupportedPool,
    readonly banned: BannedList,
    readonly decks: readonly KnownDeckSummary[],
    poolEntries: ReadonlyArray<[number, PoolCard]>,
  ) {
    for (const [entry, card] of poolEntries) this.addBody(entry, card.card);
  }

  private addBody(entry: number, card: OracleCard): void {
    this.bodies.set(entry, card);
    if (!this.byOracleId.has(card.oracleId)) this.byOracleId.set(card.oracleId, card);
  }

  /** Read the manifest and the files every game needs: names, pool, banned list, bot decks. */
  static async open(fetchText: FetchText): Promise<SiteCards> {
    const manifest = parseFile<SiteCardsManifest>(
      await fetchText(SITE_CARDS_MANIFEST),
      SITE_CARDS_MANIFEST,
    );
    const read = async <T>(file: string): Promise<T> => {
      const text = await fetchText(file);
      const expected = claimedHash(file);
      if (expected === null || sha256Hex(text).slice(0, 16) !== expected) {
        throw new Error(`Card file "${file}" does not match its hash. Reload the page.`);
      }
      return parseFile<T>(text, file);
    };
    const [names, pool, banned, decks] = await Promise.all([
      read<NamesFile>(manifest.files.names),
      read<PoolFile>(manifest.files.pool),
      read<BannedFile>(manifest.files.banned),
      read<DecksFile>(manifest.files.decks),
    ]);
    const stubs: NameStub[] = names.entries.map(([name, legal, location], entry) => ({
      oracleId: String(entry),
      name,
      commanderLegality: legal === 1 ? 'legal' : 'not_legal',
      entry,
      location,
    }));
    return new SiteCards(
      read,
      manifest,
      buildNameIndex(stubs),
      { cards: pool.cards.map(([, card]) => card), considered: pool.considered },
      bannedListFromNames(banned.names),
      decks.decks,
      pool.cards,
    );
  }

  /**
   * An `OracleIndex` that resolves `names` exactly as the server's index would. It fetches the
   * shard of every resolved card outside the pool first, so the returned index is synchronous.
   * Names outside `names` may resolve to `null` when their body was never fetched.
   */
  async indexFor(names: readonly string[]): Promise<OracleIndex> {
    const needed = new Set<number>();
    for (const name of names) {
      const stub = this.names.resolve(name);
      if (stub !== null && !this.bodies.has(stub.entry)) needed.add(stub.location);
    }
    await Promise.all([...needed].map((shard) => this.loadShard(shard)));
    return {
      size: this.names.size,
      resolve: (name) => {
        const stub = this.names.resolve(name);
        return stub === null ? null : (this.bodies.get(stub.entry) ?? null);
      },
      getByOracleId: (oracleId) => this.byOracleId.get(oracleId) ?? null,
    };
  }

  private loadShard(shard: number): Promise<void> {
    const pending = this.loadedShards.get(shard);
    if (pending !== undefined) return pending;
    const file = this.manifest.files.shards[shard];
    if (file === undefined) {
      return Promise.reject(new Error(`The card data has no shard ${shard}. Reload the page.`));
    }
    const loading = this.read<ShardFile>(file).then((parsed) => {
      for (const [entry, card] of parsed.cards) this.addBody(entry, card);
    });
    // A failed fetch must not stick: the next deck retries it.
    loading.catch(() => this.loadedShards.delete(shard));
    this.loadedShards.set(shard, loading);
    return loading;
  }
}

function parseFile<T>(text: string, file: string): T {
  const parsed = JSON.parse(text) as { format?: unknown } | null;
  if (parsed === null || typeof parsed !== 'object' || parsed.format !== SITE_CARDS_FORMAT) {
    throw new Error(`"${file}" is not ${SITE_CARDS_FORMAT} card data. Reload the page.`);
  }
  return parsed as T;
}

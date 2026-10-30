/**
 * The content-addressed Oracle pin store (ADR 0034 decision 10). One file holds every pinned
 * card, keyed by `sha256(JSON.stringify(card))` (the manifest's `oracleSha256`), and a name index
 * that says which pin a card name means. `pinStore.get(name)` throws on a name the index does
 * not hold, so a test never runs against a card it did not pin. `bun run pin-store add "<name>"`
 * adds a card; the existing per-batch fixtures and their `pinned()` helpers stay as they are.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';

export const PIN_STORE_PATH = new URL('../fixtures/pin-store.json', import.meta.url);

export interface PinStoreFile {
  schemaVersion: 1;
  /** Card name to the hash of the pin that name means. */
  names: Record<string, string>;
  /** Every pinned card by the hash of its JSON. */
  cards: Record<string, OracleCard>;
}

/** The hash a new pin is stored under: `sha256(JSON.stringify(card))`. */
export function oracleSha256(card: OracleCard): string {
  return createHash('sha256').update(JSON.stringify(card)).digest('hex');
}

/** The same object with its keys sorted at every level. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

/**
 * Both hashes a pin may be stored under. Pins before PR08 hashed the card's JSON with its keys
 * sorted; later ones hash it as written. The manifest's `oracleSha256` is whichever the card's
 * own batch used, so the store keeps that key and accepts either definition.
 */
export function oracleHashes(card: OracleCard): [string, string] {
  return [
    oracleSha256(card),
    createHash('sha256')
      .update(JSON.stringify(canonical(card)))
      .digest('hex'),
  ];
}

/** The store's own consistency: every card hashes to its key, every name to a held card. */
export function pinStoreErrors(file: PinStoreFile): string[] {
  const errors: string[] = [];
  for (const [sha, card] of Object.entries(file.cards))
    if (!oracleHashes(card).includes(sha))
      errors.push(`${card.name}: stored under ${sha}, which is neither of its hashes`);
  for (const [name, sha] of Object.entries(file.names)) {
    const card = file.cards[sha];
    if (card === undefined) errors.push(`${name}: names ${sha}, which the store does not hold`);
    else if (card.name !== name) errors.push(`${name}: names the pin of ${card.name}`);
  }
  return errors;
}

let loaded: PinStoreFile | null = null;

function store(): PinStoreFile {
  if (loaded !== null) return loaded;
  const file = JSON.parse(readFileSync(PIN_STORE_PATH, 'utf8')) as PinStoreFile;
  const errors = pinStoreErrors(file);
  if (errors.length > 0) throw new Error(`pin store is inconsistent:\n  ${errors.join('\n  ')}`);
  loaded = file;
  return file;
}

export const pinStore = {
  /** The pinned card this name means. Throws on a name the store does not hold. */
  get(name: string): OracleCard {
    const sha = store().names[name];
    if (sha === undefined)
      throw new Error(`"${name}" is not in the pin store; add it with bun run pin-store add`);
    return store().cards[sha]!;
  },
  /** The pin with this hash. Throws on an unknown hash. */
  bySha(sha: string): OracleCard {
    const card = store().cards[sha];
    if (card === undefined) throw new Error(`no pinned card has the hash ${sha}`);
    return card;
  },
  /** The hash of the pin this name means. */
  shaOf(name: string): string {
    const sha = store().names[name];
    if (sha === undefined) throw new Error(`"${name}" is not in the pin store`);
    return sha;
  },
  has(name: string): boolean {
    return Object.hasOwn(store().names, name);
  },
  /** Every name the store holds. */
  names(): string[] {
    return Object.keys(store().names);
  },
};

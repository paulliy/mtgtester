/**
 * Saved decks in a local-games build (ADR 0053): there is no database, so a deck the player
 * brings is kept in this browser's storage as its decklist text, and seated again as that text.
 * A list is saved when a game starts with it, as the server saves an import with its first game.
 * The same list saved twice is one deck, freshened. Export writes every saved list to one file.
 */

import type { SavedDeckOption } from '@mtg/shared';

export interface LocalSavedDeck extends SavedDeckOption {
  text: string;
  /** ISO time it was last saved or played: the list shows the most recent first. */
  usedAt: string;
}

export const LOCAL_DECKS_KEY = 'decktank-saved-decks';
/** Enough for anyone's collection; the oldest is dropped past it so storage cannot fill. */
export const LOCAL_DECKS_LIMIT = 60;

/** The list as typed, with line endings and blank edges evened out, so a re-paste matches. */
function normalize(list: string): string {
  return list
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/** A stable ID for a list's text (FNV-1a), so the same list saved twice is the same deck. */
export function localDeckId(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of normalize(text)) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `local-${hash.toString(16).padStart(8, '0')}`;
}

function isDeck(value: unknown): value is LocalSavedDeck {
  if (typeof value !== 'object' || value === null) return false;
  const deck = value as Record<string, unknown>;
  return (
    typeof deck['snapshotId'] === 'string' &&
    typeof deck['name'] === 'string' &&
    typeof deck['text'] === 'string' &&
    typeof deck['usedAt'] === 'string' &&
    typeof deck['archetypeTag'] === 'string' &&
    Array.isArray(deck['commanderNames']) &&
    Array.isArray(deck['colorIdentity'])
  );
}

/** Every saved deck, most recently used first. */
export function readLocalDecks(
  storage: Storage | undefined = globalThis.localStorage,
): LocalSavedDeck[] {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(LOCAL_DECKS_KEY) ?? '[]');
    return Array.isArray(raw)
      ? raw.filter(isDeck).sort((a, b) => b.usedAt.localeCompare(a.usedAt))
      : [];
  } catch {
    return [];
  }
}

function write(decks: readonly LocalSavedDeck[], storage: Storage | undefined): void {
  try {
    storage?.setItem(LOCAL_DECKS_KEY, JSON.stringify(decks.slice(0, LOCAL_DECKS_LIMIT)));
  } catch {
    // A full or refused storage loses the save, never the game being started.
  }
}

export interface DeckToSave {
  text: string;
  commanderNames: string[];
  colorIdentity: string[];
  archetypeTag: string;
}

/** Save a list (or freshen it, if it is already saved) and return its ID. */
export function saveLocalDeck(
  deck: DeckToSave,
  now: Date = new Date(),
  storage: Storage | undefined = globalThis.localStorage,
): string {
  const snapshotId = localDeckId(deck.text);
  const name = deck.commanderNames.length > 0 ? deck.commanderNames.join(' & ') : 'Imported deck';
  const saved: LocalSavedDeck = {
    snapshotId,
    name,
    commanderNames: [...deck.commanderNames],
    colorIdentity: [...deck.colorIdentity],
    archetypeTag: deck.archetypeTag,
    text: normalize(deck.text),
    usedAt: now.toISOString(),
  };
  write(
    [saved, ...readLocalDecks(storage).filter((old) => old.snapshotId !== snapshotId)],
    storage,
  );
  return snapshotId;
}

/** Mark a saved deck as just played, so it moves to the top of the list. */
export function touchLocalDeck(
  snapshotId: string,
  now: Date = new Date(),
  storage: Storage | undefined = globalThis.localStorage,
): void {
  const decks = readLocalDecks(storage);
  const deck = decks.find((d) => d.snapshotId === snapshotId);
  if (deck === undefined) return;
  write([{ ...deck, usedAt: now.toISOString() }, ...decks.filter((d) => d !== deck)], storage);
}

export function removeLocalDeck(
  snapshotId: string,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  write(
    readLocalDecks(storage).filter((deck) => deck.snapshotId !== snapshotId),
    storage,
  );
}

/** Every saved list in one text file, each under a comment line naming it. */
export function exportLocalDecks(decks: readonly LocalSavedDeck[]): string {
  return decks
    .map((deck) => {
      const tag = deck.archetypeTag === '' ? '' : ` (${deck.archetypeTag})`;
      return `// ${deck.name}${tag}\n${deck.text}\n`;
    })
    .join('\n');
}

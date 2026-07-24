/**
 * Moxfield import adapter (brief §8.1). Derives the public deck id from the URL and reads the
 * public deck JSON. Handles both the v3 (`boards.<name>.cards`) and v2 (`<name>` map) response
 * shapes so a Moxfield API change on one doesn't break import outright.
 */

import type { ParsedDeck, ParsedDeckEntry } from '@mtg/shared';
import { DeckImportError } from './errors';

const USER_AGENT = 'mtg-commander-ai-simulator/0.1 (local deck-evaluation tool)';

export function isMoxfieldUrl(url: string): boolean {
  return /(^|\.)moxfield\.com$/i.test(safeHost(url));
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Extract the public deck id: the path segment after `/decks/`. */
function extractDeckId(url: string): string {
  const match = /\/decks\/([^/?#]+)/.exec(new URL(url).pathname);
  const id = match?.[1];
  if (!id)
    throw new DeckImportError(`Could not find a deck id in Moxfield URL: ${url}`, 'moxfield');
  return id;
}

interface MoxCardEntry {
  quantity?: number;
  card?: { name?: string };
}
type MoxBoard = { cards?: Record<string, MoxCardEntry> } & Record<string, MoxCardEntry>;
interface MoxDeck {
  name?: string;
  boards?: Record<string, MoxBoard>;
  mainboard?: MoxBoard;
  sideboard?: MoxBoard;
  commanders?: MoxBoard;
  companions?: MoxBoard;
}

/** Yield `(quantity, name)` pairs from either board shape. */
function boardEntries(board: MoxBoard | undefined): ParsedDeckEntry[] {
  if (!board) return [];
  const source = board.cards ?? board;
  const out: ParsedDeckEntry[] = [];
  for (const entry of Object.values(source)) {
    const name = entry?.card?.name;
    if (name) out.push({ quantity: entry.quantity ?? 1, name });
  }
  return out;
}

function pickBoard(
  deck: MoxDeck,
  key: 'mainboard' | 'sideboard' | 'commanders' | 'companions',
): MoxBoard | undefined {
  return deck.boards?.[key] ?? deck[key];
}

export async function importMoxfieldDeck(url: string): Promise<ParsedDeck> {
  const id = extractDeckId(url);
  const endpoints = [
    `https://api2.moxfield.com/v3/decks/all/${id}`,
    `https://api2.moxfield.com/v2/decks/all/${id}`,
  ];

  let deck: MoxDeck | null = null;
  let lastStatus = 0;
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (res.ok) {
      deck = (await res.json()) as MoxDeck;
      break;
    }
    lastStatus = res.status;
  }
  if (!deck) {
    throw new DeckImportError(
      `Moxfield returned HTTP ${lastStatus} for deck "${id}". The deck may be private, or Moxfield blocked the request — paste the decklist as plaintext instead.`,
      'moxfield',
    );
  }

  const commanderNames = boardEntries(pickBoard(deck, 'commanders')).flatMap((e) =>
    Array<string>(e.quantity).fill(e.name),
  );
  const companion = boardEntries(pickBoard(deck, 'companions'))[0] ?? null;

  return {
    sourceType: 'moxfield',
    sourceUrl: url,
    name: deck.name ?? null,
    commanderNames,
    companionName: companion?.name ?? null,
    cards: boardEntries(pickBoard(deck, 'mainboard')),
    archetypeTag: null,
  };
}

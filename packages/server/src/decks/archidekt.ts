/**
 * Archidekt import adapter (brief §8.1). Reads the public deck JSON and separates commander /
 * companion / maindeck by Archidekt's per-card categories, honoring category `includedInDeck`
 * flags so maybeboard and sideboard cards are excluded.
 */

import type { ParsedDeck, ParsedDeckEntry } from '@mtg/shared';
import { DeckImportError } from './errors';

const USER_AGENT = 'mtg-commander-ai-simulator/0.1 (local deck-evaluation tool)';

export function isArchidektUrl(url: string): boolean {
  return /(^|\.)archidekt\.com$/i.test(safeHost(url));
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function extractDeckId(url: string): string {
  const match = /\/decks\/(\d+)/.exec(new URL(url).pathname);
  const id = match?.[1];
  if (!id)
    throw new DeckImportError(`Could not find a deck id in Archidekt URL: ${url}`, 'archidekt');
  return id;
}

interface ArchidektCard {
  quantity?: number;
  categories?: string[];
  card?: { oracleCard?: { name?: string }; name?: string };
}
interface ArchidektDeck {
  name?: string;
  categories?: { name?: string; includedInDeck?: boolean }[];
  cards?: ArchidektCard[];
}

function cardName(card: ArchidektCard): string | null {
  return card.card?.oracleCard?.name ?? card.card?.name ?? null;
}

export async function importArchidektDeck(url: string): Promise<ParsedDeck> {
  const id = extractDeckId(url);
  const res = await fetch(`https://archidekt.com/api/decks/${id}/`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new DeckImportError(
      `Archidekt returned HTTP ${res.status} for deck "${id}". The deck may be private — paste the decklist as plaintext instead.`,
      'archidekt',
    );
  }
  const deck = (await res.json()) as ArchidektDeck;

  // Categories flagged not included in the deck (maybeboard, sideboard, "Considering", …).
  const excluded = new Set(
    (deck.categories ?? []).filter((c) => c.includedInDeck === false).map((c) => c.name),
  );

  const commanderNames: string[] = [];
  let companionName: string | null = null;
  const cards: ParsedDeckEntry[] = [];

  for (const card of deck.cards ?? []) {
    const name = cardName(card);
    if (!name) continue;
    const categories = card.categories ?? [];
    if (categories.some((c) => excluded.has(c))) continue;

    const quantity = card.quantity ?? 1;
    if (categories.includes('Commander')) {
      for (let i = 0; i < quantity; i++) commanderNames.push(name);
    } else if (categories.includes('Companion')) {
      companionName = name;
    } else {
      cards.push({ quantity, name });
    }
  }

  return {
    sourceType: 'archidekt',
    sourceUrl: url,
    name: deck.name ?? null,
    commanderNames,
    companionName,
    cards,
    archetypeTag: null,
  };
}

/**
 * The deck-source abstraction (brief §8.1). Each service (Moxfield, Archidekt) has an adapter
 * that turns a public deck URL into a `ParsedDeck`; a plaintext paste is the fallback. A third
 * source is added by implementing this interface and registering it in `detectSource`.
 */

import type { DeckSourceType, ParsedDeck } from '@mtg/shared';
import { importMoxfieldDeck, isMoxfieldUrl } from './moxfield';
import { importArchidektDeck, isArchidektUrl } from './archidekt';
import { parsePlaintextDeck } from './plaintext';
import { DeckImportError } from './errors';

export { DeckImportError };

export interface DeckSourceAdapter {
  readonly sourceType: DeckSourceType;
  matches(url: string): boolean;
  fetchDeck(url: string): Promise<ParsedDeck>;
}

const URL_ADAPTERS: DeckSourceAdapter[] = [
  { sourceType: 'moxfield', matches: isMoxfieldUrl, fetchDeck: importMoxfieldDeck },
  { sourceType: 'archidekt', matches: isArchidektUrl, fetchDeck: importArchidektDeck },
];

/** Return the adapter for a URL, or `null` if no live source recognizes it. */
export function detectSource(url: string): DeckSourceAdapter | null {
  return URL_ADAPTERS.find((a) => a.matches(url)) ?? null;
}

/**
 * Import a deck from any supported input: a Moxfield/Archidekt URL, or — when `input` is not a
 * recognized URL — a plaintext decklist paste.
 */
export async function importDeck(input: string): Promise<ParsedDeck> {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const adapter = detectSource(trimmed);
    if (!adapter) {
      throw new DeckImportError(
        `Unrecognized deck URL: ${trimmed}. Supported: Moxfield, Archidekt, or a plaintext paste.`,
        'plaintext',
      );
    }
    return adapter.fetchDeck(trimmed);
  }
  return parsePlaintextDeck(trimmed);
}

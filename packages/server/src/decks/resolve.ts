/**
 * Resolve a `ParsedDeck` against the oracle index (brief §8.2 step 2). Every name — commanders,
 * companion, and main deck — must resolve to a single `OracleCard`. On any failure we return
 * `resolved: null` with the exact unresolved names (original spelling, de-duplicated) so the
 * user can fix them; we never guess a substitute.
 */

import type { ParsedDeck, ResolutionResult, ResolvedDeck, ResolvedDeckEntry } from '@mtg/shared';
import type { OracleIndex } from '../cards/oracle-index';

export function resolveDeck(parsed: ParsedDeck, index: OracleIndex): ResolutionResult {
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();
  const noteUnresolved = (name: string): void => {
    const key = name.toLowerCase();
    if (!seenUnresolved.has(key)) {
      seenUnresolved.add(key);
      unresolved.push(name);
    }
  };

  const commanders = parsed.commanderNames.map((name) => {
    const card = index.resolve(name);
    if (!card) noteUnresolved(name);
    return card;
  });

  const companion = parsed.companionName ? index.resolve(parsed.companionName) : null;
  if (parsed.companionName && !companion) noteUnresolved(parsed.companionName);

  const cards: (ResolvedDeckEntry | null)[] = parsed.cards.map((entry) => {
    const card = index.resolve(entry.name);
    if (!card) {
      noteUnresolved(entry.name);
      return null;
    }
    return { quantity: entry.quantity, card };
  });

  if (unresolved.length > 0) {
    return { resolved: null, unresolvedNames: unresolved };
  }

  const resolved: ResolvedDeck = {
    sourceType: parsed.sourceType,
    sourceUrl: parsed.sourceUrl,
    name: parsed.name,
    archetypeTag: parsed.archetypeTag,
    commanders: commanders.filter((c): c is NonNullable<typeof c> => c !== null),
    companion,
    cards: cards.filter((c): c is ResolvedDeckEntry => c !== null),
  };
  return { resolved, unresolvedNames: [] };
}

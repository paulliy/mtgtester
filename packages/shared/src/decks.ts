/**
 * Deck pipeline contracts (brief §8, §9). A deck moves through three shapes:
 *
 *   raw input  →  ParsedDeck        (import adapter: quantities + names, no card data)
 *              →  ResolvedDeck      (Scryfall resolution: every name → OracleCard)
 *              →  DeckSnapshot      (persisted, immutable point-in-time record — §8.2)
 *
 * Validation (§8.3) runs on the ResolvedDeck and reports *every* problem, not just the first.
 */

import type { Color } from './mana';
import type { OracleCard } from './cards';
import type { DeckId, DeckSnapshotId, OracleId } from './ids';

/** Where a decklist came from. A new source is added by implementing another adapter (§8.1). */
export const DECK_SOURCE_TYPES = ['moxfield', 'archidekt', 'plaintext'] as const;
export type DeckSourceType = (typeof DECK_SOURCE_TYPES)[number];

/** One `(quantity, cardName)` line from a decklist, before resolution (§8.2 step 1). */
export interface ParsedDeckEntry {
  quantity: number;
  name: string;
}

/**
 * A decklist as parsed from its source, before any Scryfall resolution. Commanders and the
 * optional companion are pulled out of the main list so the count/identity rules can treat
 * them specially (§8.3).
 */
export interface ParsedDeck {
  sourceType: DeckSourceType;
  /** Original URL, or `null` for a plaintext paste. */
  sourceUrl: string | null;
  /** Deck name from the source, if any. */
  name: string | null;
  /** One or two commander names (Partner / Background — §8.3). */
  commanderNames: string[];
  /** Companion name, if declared. */
  companionName: string | null;
  /** The main deck, excluding commander(s) and companion. */
  cards: ParsedDeckEntry[];
  /** Optional user archetype tag (§8.4); `null` means "derive the default". */
  archetypeTag: string | null;
}

/** A main-deck entry after resolution: quantity plus full card data. */
export interface ResolvedDeckEntry {
  quantity: number;
  card: OracleCard;
}

/** A fully resolved deck: every name mapped to an `OracleCard`. Input to validation (§8.3). */
export interface ResolvedDeck {
  sourceType: DeckSourceType;
  sourceUrl: string | null;
  name: string | null;
  archetypeTag: string | null;
  /** One or two commanders. */
  commanders: OracleCard[];
  companion: OracleCard | null;
  /** Main deck, excluding commander(s) and companion. */
  cards: ResolvedDeckEntry[];
}

/**
 * The result of resolving a `ParsedDeck` against the oracle data. `resolved` is `null` when any
 * name failed to resolve; `unresolvedNames` then lists exactly which (brief §8.2 step 2 — never
 * guess).
 */
export interface ResolutionResult {
  resolved: ResolvedDeck | null;
  unresolvedNames: string[];
}

/** The specific rule a validation issue belongs to (brief §8.3). */
export const VALIDATION_CODES = [
  'cardCount',
  'commanderLegality',
  'partnerPairing',
  'singleton',
  'colorIdentity',
  'banned',
  'companion',
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

/** One concrete validation failure. `cardName` is set when the problem is card-specific. */
export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  cardName?: string;
}

/** The outcome of validating a resolved deck. When `valid` is false, `issues` lists them all. */
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/** A `(quantity, oracleId)` line in a persisted snapshot (§9 `card_list_json`). */
export interface DeckCardEntry {
  oracleId: OracleId;
  name: string;
  quantity: number;
}

/**
 * An immutable, point-in-time snapshot of a resolved deck (brief §8.2). Historical stats key on
 * this, so it must never change when the upstream deck is edited. Re-importing a URL creates a
 * new snapshot. Full card data lives in the card cache, keyed by the oracle ids referenced here.
 */
export interface DeckSnapshot {
  id: DeckSnapshotId;
  deckId: DeckId;
  commanderOracleIds: OracleId[];
  commanderNames: string[];
  companionOracleId: OracleId | null;
  colorIdentity: Color[];
  /** Every main-deck card including the commander(s) and companion. */
  cards: DeckCardEntry[];
  /** ISO-8601 import timestamp. */
  importedAt: string;
}

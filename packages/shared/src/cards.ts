/**
 * Resolved card data (brief §8.2, §3). An `OracleCard` is the immutable, printing-independent
 * projection of a Scryfall oracle-card entry that the deck pipeline persists into the SQLite
 * card cache and that the engine will later read (games never touch the bulk file — §3).
 *
 * Color identity is taken verbatim from Scryfall's `color_identity`, which already implements
 * CR 903.4 (mana symbols in cost and rules text, color indicators, etc.). We do not recompute it.
 */

import type { Color, ManaCostString } from './mana';
import type { OracleId } from './ids';

/** Commander legality as reported by Scryfall (`legalities.commander`). */
export const COMMANDER_LEGALITIES = ['legal', 'not_legal', 'banned', 'restricted'] as const;
export type CommanderLegality = (typeof COMMANDER_LEGALITIES)[number];

/**
 * The card types we split out of a type line (CR 300.1). Stored as raw strings rather than a
 * closed union so an unfamiliar type from a new set never breaks import; the engine can narrow
 * later. Supertypes (Basic, Legendary, Snow, World) and subtypes are kept separately.
 */
export interface OracleCard {
  /** Stable Scryfall oracle id — the cache primary key and the link from game objects. */
  oracleId: OracleId;
  /** A representative Scryfall printing id (for image lookup in the UI, Phase 4). */
  scryfallId: string;
  name: string;
  /** Oracle mana cost, e.g. `"{3}{G}"`. `null` for lands and other costless cards. */
  manaCost: ManaCostString | null;
  /** Converted mana cost / mana value (CR 202.3). */
  cmc: number;
  /** The card's colors (CR 105) — its cost/indicator colors, not its identity. */
  colors: Color[];
  /** Color identity (CR 903.4), verbatim from Scryfall. Drives the §8.3 identity check. */
  colorIdentity: Color[];
  /** Full type line, e.g. `"Legendary Creature — Elf Druid"`. */
  typeLine: string;
  /** Supertypes parsed from the type line (Basic, Legendary, Snow, World, Ongoing, Host). */
  supertypes: string[];
  /** Card types parsed from the type line (Creature, Instant, Land, …). */
  types: string[];
  /** Subtypes parsed from the type line (right of the em dash), e.g. `["Elf", "Druid"]`. */
  subtypes: string[];
  /** Oracle rules text (may be empty). Used to detect singleton overrides and commander-ness. */
  oracleText: string;
  /** Printed power/loyalty as strings — may be `"*"`; `null` when not applicable. */
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  /** Printed starting defense (Battle cards, CR 310.6) as a string; `null` otherwise. */
  defense: string | null;
  /** Scryfall keyword list (e.g. `["Partner", "Flying"]`). */
  keywords: string[];
  /** Scryfall card layout (`normal`, `modal_dfc`, `split`, …). */
  layout: string;
  /** `legalities.commander` — used as a defensive secondary ban/pool check (§8.3). */
  commanderLegality: CommanderLegality;
  /** Derived: a Basic land (CR 205.4b), exempt from the singleton rule (§8.3). */
  isBasicLand: boolean;
}

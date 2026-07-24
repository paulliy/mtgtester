/**
 * Identifier types used across the engine, server, and UI.
 *
 * These are string aliases in v1 — nominal branding can be added later without touching
 * call sites. Keep them opaque: nothing outside the engine should construct or parse them.
 */

/** A seat/player within a single game (e.g. "P1"). */
export type PlayerId = string;

/**
 * Identity for a game object. A card that changes zones becomes a NEW object with a new
 * `ObjectId` (CR 400.7); use `OracleId` to link back to immutable card data.
 */
export type ObjectId = string;

/** Scryfall oracle id — stable across printings; the link to card data. */
export type OracleId = string;

/** A user-managed deck (source URL, archetype tag). */
export type DeckId = string;

/** An immutable, point-in-time snapshot of a resolved deck (brief §8.2). */
export type DeckSnapshotId = string;

/** A single played game. */
export type GameId = string;

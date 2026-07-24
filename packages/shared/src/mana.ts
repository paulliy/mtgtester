/** The five colors of Magic. Colorless is not a color and is tracked separately. */
export const ALL_COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
export type Color = (typeof ALL_COLORS)[number];

/**
 * A printed mana cost in Scryfall/oracle notation, e.g. `"{2}{G}{G}"`, `"{X}{R}"`.
 * Structured parsing (hybrid, Phyrexian, {X}, generic vs. colored) is a Phase 2 concern —
 * see TODO(phase-2) in the engine's cost handling. Kept as a string in shared types.
 */
export type ManaCostString = string;

/**
 * A player's mana pool: colored mana (WUBRG) plus colorless ({C}).
 * "Generic" is a *cost* concept, not a pool concept — generic costs are paid from any
 * mana — so the pool tracks colorless, not generic.
 *
 * Mana with spending restrictions or riders (e.g. "spend only on creature spells") is a
 * Phase 2 refinement; v1 shared type is plain counts.
 */
export interface ManaPool {
  W: number;
  U: number;
  B: number;
  R: number;
  G: number;
  /** Colorless mana ({C}). */
  C: number;
}

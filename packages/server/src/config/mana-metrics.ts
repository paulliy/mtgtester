/**
 * Tunable Phase 5 mana heuristic (brief §9.2). Raw inputs are stored in SQLite, so changing
 * these constants recalculates historical statistics without rerunning a game.
 */
export const MANA_METRICS = {
  trailingDraws: 5,
  floodedLandDraws: 4,
  floodedUnspentMana: 3,
  affectedTurns: 3,
  droughtUncastableCards: 2,
  expectedLandLag: 1,
} as const;

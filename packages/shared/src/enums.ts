/**
 * Core game enumerations. Each is defined as a `readonly` tuple so it exists at runtime
 * (for iteration, validation, and UI) with the union type derived from it — one source of
 * truth for both.
 */

/** Phases of a turn, in order (CR 500–514, brief §5.3). Main phases have no steps. */
export const PHASES = ['beginning', 'precombatMain', 'combat', 'postcombatMain', 'ending'] as const;
export type Phase = (typeof PHASES)[number];

/**
 * Steps within phases (brief §5.3). `firstStrikeCombatDamage` exists only when a creature
 * with first/double strike is in combat (CR 510.5). Main phases have `step === null`.
 */
export const STEPS = [
  // Beginning phase
  'untap',
  'upkeep',
  'draw',
  // Combat phase
  'beginCombat',
  'declareAttackers',
  'declareBlockers',
  'firstStrikeCombatDamage',
  'combatDamage',
  'endCombat',
  // Ending phase
  'end',
  'cleanup',
] as const;
export type Step = (typeof STEPS)[number];

/** Zones (CR 400). `command` holds commanders; `stack` is shared and ordered LIFO. */
export const ZONES = [
  'library',
  'hand',
  'battlefield',
  'graveyard',
  'stack',
  'exile',
  'command',
] as const;
export type Zone = (typeof ZONES)[number];

/**
 * The kinds of choice the engine can ask a player to make. The engine always supplies the
 * legal option set; the AI only picks (brief §1.2, §7.3). Extended as mechanics are added.
 */
export const DECISION_TYPES = [
  'priority',
  'mulligan', // keep or mulligan (brief §5.8)
  'bottomCards', // London mulligan bottoming
  'declareAttackers',
  'declareBlockers',
  'chooseTargets',
  'chooseModes',
  'chooseX',
  'orderTriggers', // order simultaneous same-controller triggers (brief §5.5)
  'optionalTrigger', // yes/no on a "may" trigger
  'commanderReplacement', // send commander to the command zone? (brief §5.7)
  'legendRule', // which legendary permanent to keep
  'assignCombatDamage', // damage assignment order / division
  'general', // catch-all for a card-specific choice
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

/** Mechanical reason a player lost (SBA-level; brief §5.6). Stat categories derive from this + the log. */
export const LOSS_REASONS = [
  'lifeZeroOrLess',
  'emptyLibraryDraw',
  'poisonCounters',
  'commanderDamage',
  'other',
] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

/**
 * Combat damage from one commander that eliminates a player (CR 903.10a). The one copy of the
 * number: the engine's state-based action and the projection's `lethal`/`remaining` both read it,
 * so no client holds the rule.
 */
export const COMMANDER_DAMAGE_LETHAL = 21;

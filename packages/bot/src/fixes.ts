/**
 * ADR 0043's bot fixes, each behind its own switch so the bot league can play a fix against the
 * bot without it (ADR 0043 decision 3.3). Everything here is policy: none of it changes which
 * actions are legal, only how the bot ranks the engine's menu.
 */
export const POLICY_FIXES = [
  /** Only an opponent's stack object counts as "responding"; damage already on the stack counts. */
  'ownStack',
  /** Never yield the turn while holding a usable instant-speed action. */
  'neverYield',
  /** Count lethal before aiming: remove the attacker that kills you, pump the unblocked one, clear the blocker. */
  'lethalTargets',
  /** A spell that makes lethal this turn is worth more than card draw. */
  'lethalValue',
  /** Try the casting orders of the castable spells on a mana model of the view. */
  'castOrder',
  /** Count coloured sources when choosing a land. */
  'landColors',
  /** Before attacking, compare the opponents' power next turn with life and the blockers kept. */
  'attackReserve',
  /** Keep the last counterspell or hard removal in hand for a real threat unless lethal is at stake. */
  'scarceAnswer',
  /** Damage at a player that does not kill is worth the damage, not a flat player value. */
  'faceDamage',
  /** A permanent sacrificed to pay a cost is the least valuable one, not a seeded coin flip. */
  'costChoices',
  /** A commander, ours or theirs, is worth more than its body: never fed to a cost, first to answer. */
  'commanderValue',
  /**
   * An ability that only strips keywords (Shadowspear) is pointless when no opponent's permanent it
   * affects has one of them, or while this seat's activation is still on the stack.
   */
  'keywordStrip',
] as const;
export type PolicyFix = (typeof POLICY_FIXES)[number];

/**
 * The fixes the production bot plays with: every one that passed its gate (ADR 0043 decision 3).
 * `docs/reviews/` records each fix's seed and league results.
 */
export const DEFAULT_POLICY_FIXES: readonly PolicyFix[] = POLICY_FIXES;

/** Parse a list of fix names, refusing an unknown one. */
export function parsePolicyFixes(names: readonly string[]): PolicyFix[] {
  for (const name of names)
    if (!(POLICY_FIXES as readonly string[]).includes(name))
      throw new Error(`unknown bot policy fix "${name}"; choose from ${POLICY_FIXES.join(', ')}`);
  return [...new Set(names)] as PolicyFix[];
}

/**
 * The authored-override registry (ADR 0004 increment 2, ADR 0010).
 *
 * Some cards are printed templates that recur across every deck — conditional-enters-tapped
 * lands, basic-land tutors, "damage to each creature without flying". Those belong in the text
 * grammar, where one regex pays off forever. But ~94% of unparsed oracle lines occur on exactly
 * ONE card (ADR 0009): for those, a regex would be written once, fire once, and add permanent
 * maintenance surface to the interpreter's cascade. Those get a hand-authored `Ability` here.
 *
 * ## The drift guard — the reason this is not a card-scripting escape hatch
 *
 * An override does NOT declare "this card is fine". The interpreter still parses every line;
 * an override then names the specific lines it implements, **byte-exactly**, and only those
 * lines' reasons are cleared. Two consequences follow, and both are the point:
 *
 * - If Wizards errata a card, the printed line stops matching `handledLines`. The reason
 *   survives, the card reverts to `modeled: false`, and the engine halts loudly at the next
 *   `requireModeled` (brief §6.3) instead of playing stale behavior.
 * - If an override claims a line the card no longer has, that is reported too. A silent no-op
 *   would mean the override's `def` is being applied to a card it was never written for.
 *
 * ## Three rules for adding one
 *
 * 1. It may only compose `Effect`/`Ability` primitives that already exist and have tests. If an
 *    override needs a new executor case, that case belongs in an earlier increment.
 * 2. `handledLines` entries must be copied from the actual `unmodeledReasons` output, not typed
 *    from the card face — the interpreter rewrites text before reporting it (reminder text
 *    stripped, the card's own name replaced by `~`).
 * 3. Every override gets a *behavioral* test, never a `modeled === true` test.
 */

import type { OracleId } from '@mtg/shared';
import type { CardDefinition } from '../definition';

export interface CardOverride {
  oracleId: OracleId;
  /** The card's name — documentation, and a mismatch check against the oracle data. */
  name: string;
  /**
   * Oracle lines this override implements, exactly as the interpreter reports them in
   * `unmodeledReasons`. Either the quoted body of a reason, or a whole reason string.
   */
  handledLines: string[];
  /** The authored behavior, merged over the interpreted definition. */
  def: Partial<CardDefinition>;
}

/**
 * Every authored override, keyed by oracle id.
 *
 * Empty by design at introduction: a registry with no primitives underneath it is the wrong
 * tool, so the increment that adds this mechanism deliberately closes zero cards.
 */
const OVERRIDES = new Map<OracleId, CardOverride>();

/** Register an override. Exported for the per-card modules and for tests. */
export function registerOverride(override: CardOverride): void {
  OVERRIDES.set(override.oracleId, override);
}

export function getOverride(oracleId: OracleId): CardOverride | undefined {
  return OVERRIDES.get(oracleId);
}

/** Test seam: drop a registration so a fixture override cannot leak between tests. */
export function unregisterOverride(oracleId: OracleId): void {
  OVERRIDES.delete(oracleId);
}

/** The quoted body of a reason like `unrecognized rules text: "…"`, or null. */
function quotedBody(reason: string): string | null {
  const m = /^[a-z ]+: "([\s\S]*)"$/.exec(reason);
  return m === null ? null : (m[1] as string);
}

/**
 * Apply an override to a freshly interpreted definition.
 *
 * Returns the definition unchanged when no override is registered, so this is safe to call
 * unconditionally at the end of `interpretCard`.
 */
export function applyOverride(def: CardDefinition): CardDefinition {
  const override = getOverride(def.oracleId);
  if (override === undefined) return def;

  // Clear one reason per handled line. One-for-one rather than a filter, so a card printing the
  // same unparsed line twice needs the override to claim it twice.
  const remaining = [...def.unmodeledReasons];
  const unmatched: string[] = [];
  for (const line of override.handledLines) {
    const index = remaining.findIndex((r) => r === line || quotedBody(r) === line);
    if (index === -1) unmatched.push(line);
    else remaining.splice(index, 1);
  }

  // An override that claims a line the card does not have is stale — its `def` was authored
  // against different text, so applying it would be guessing.
  for (const line of unmatched) {
    remaining.push(
      `override for "${override.name}" claims a line this card no longer has: "${line}"`,
    );
  }

  const merged: CardDefinition = { ...def, ...override.def };
  merged.unmodeledReasons = remaining;
  merged.modeled = remaining.length === 0;
  return merged;
}

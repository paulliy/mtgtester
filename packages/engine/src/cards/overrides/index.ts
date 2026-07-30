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
import { registerURDRAGONOverrides } from './urdragon';
import { registerDRACONIC_DESTRUCTIONOverrides } from './draconic-destruction';
import { registerTOKEN_TRIUMPHOverrides } from './token-triumph';
import { registerLIVING_ENERGYOverrides } from './living-energy';
import { registerSILVERQUILL_INFLUENCEOverrides } from './silverquill-influence';
import { registerCOUNTER_INTELLIGENCEOverrides } from './counter-intelligence';
import { registerNECRON_DYNASTIESOverrides } from './necron-dynasties';

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
 */
const OVERRIDES = new Map<OracleId, CardOverride>();

// Register all deck overrides
registerURDRAGONOverrides();
registerDRACONIC_DESTRUCTIONOverrides();
registerTOKEN_TRIUMPHOverrides();
registerLIVING_ENERGYOverrides();
registerSILVERQUILL_INFLUENCEOverrides();
registerCOUNTER_INTELLIGENCEOverrides();
registerNECRON_DYNASTIESOverrides();

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

function normalizeLine(line: string): string {
  return line.replace(
    /\bthis (?:creature|artifact|enchantment|land|permanent|token|Vehicle|Equipment|Saga|planeswalker)\b/gi,
    '~',
  );
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

  // A registration must add executable card behavior. An empty patch is ignored so it cannot
  // clear an unsupported-rule reason and turn missing rules into a silent no-op.
  if (Object.keys(override.def).length === 0) {
    // A previously-needed override may become obsolete after a parser/engine primitive lands.
    // It must not turn an otherwise complete definition back into an unmodeled card; there is
    // no behavior to merge and the interpreted definition is already the executable source.
    if (def.modeled) return def;
    return {
      ...def,
      modeled: false,
      unmodeledReasons: [
        ...def.unmodeledReasons,
        `override for "${override.name}" has no executable behavior`,
      ],
    };
  }
  // Clear one reason per handled line. One-for-one rather than a filter, so a card printing the
  // same unparsed line twice needs the override to claim it twice.
  const remaining = [...def.unmodeledReasons];
  const unmatched: string[] = [];
  for (const line of override.handledLines) {
    const index = remaining.findIndex((r) => {
      if (r === line || quotedBody(r) === line) return true;
      const q = quotedBody(r);
      const rBody = q ?? r;
      return normalizeLine(rBody) === normalizeLine(line);
    });
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

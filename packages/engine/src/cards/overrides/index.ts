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
 * ## Rules for adding one
 *
 * 1. It may only compose `Effect`/`Ability` primitives that already exist and have tests. If an
 *    override needs a new executor case, that case belongs in an earlier increment.
 * 2. `handledLines` entries must be copied from the actual `unmodeledReasons` output, not typed
 *    from the card face — the interpreter rewrites text before reporting it (reminder text
 *    stripped, the card's own name replaced by `~`).
 * 3. Every override gets a *behavioral* test, never a `modeled === true` test.
 * 4. `def` merges over the interpreted definition with a shallow spread (`applyOverride` below) —
 *    it does not know which ability arrays are "the same line, read differently." If the override
 *    changes how a line is modeled (e.g. forcing a true mana ability where the generic grammar
 *    reads a stack-based activated ability instead, because the printed cost includes mana and
 *    CR 605.1a disqualifies it), the `def` must ALSO clear the interpreted array it is overriding
 *    away from (`activatedAbilities: []`, here), or both versions ship side by side. See Desolate
 *    Mire in `silverquill-influence-remaining.ts` for a worked example and the failure it avoids.
 * 5. Before writing a `handledLines: []` override just to pin a `def` the interpreter already
 *    derives correctly on its own (a token-catalog near-miss, a formatting fix now handled by
 *    `canonicalizeToken`, …) — check whether it's still needed at all. `handledLines: []` claims
 *    nothing, so it disables the drift guard for that card with nothing watching in return: a
 *    stale hardcoded `def` would keep silently overriding the interpreted definition forever, with
 *    no diagnostic if the card's text or the interpreter's own reading of it ever changes. If the
 *    override's `def` is now identical to what plain `interpretCard` already produces, delete the
 *    override — the interpreter, not a frozen copy of its own output, should be the source of
 *    truth. (Beast Within in `draconic-destruction.ts` was exactly this once `parseTokenFace`
 *    started canonicalizing; removed rather than kept as a no-op.)
 */

import type { OracleId } from '@mtg/shared';
import type { CardDefinition } from '../definition';
import { registerURDRAGONOverrides } from './urdragon';
import { registerDRACONIC_DESTRUCTIONOverrides } from './draconic-destruction';
import { registerTOKEN_TRIUMPHOverrides } from './token-triumph';
import { registerLIVING_ENERGYOverrides } from './living-energy';
import { registerSILVERQUILL_INFLUENCEOverrides } from './silverquill-influence';
import { registerSILVERQUILL_INFLUENCE_REMAININGOverrides } from './silverquill-influence-remaining';
import { registerCOUNTER_INTELLIGENCEOverrides } from './counter-intelligence';
import { registerNECRON_DYNASTIESOverrides } from './necron-dynasties';
import { registerNECRON_DYNASTIES_REMAININGOverrides } from './necron-dynasties-remaining';
import { registerQUEEN_MARCHESA_QUEENS_GAMBITOverrides } from './queen-marchesa-queens-gambit';
import { registerQUEEN_MARCHESA_QUEENS_GAMBIT_REMAININGOverrides } from './queen-marchesa-queens-gambit-remaining';
import { registerMARCHESA_THE_BLACK_ROSEOverrides } from './marchesa-the-black-rose';
import { registerW1RemainingOverrides } from './w1-remaining';
import { registerW2RemainingOverrides } from './w2-remaining';
import { registerReviewedFiveOverrides } from './reviewed-five';
import { registerUnsupportedSpellFaces } from './unsupported-spell-faces';
import { registerCoveragePr01Overrides } from './coverage-pr01';
import { registerCoveragePr02Overrides } from './coverage-pr02';
import { registerCoveragePr03Overrides } from './coverage-pr03';

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
  /** A confirmed incorrect implementation contained until its faithful replacement lands. */
  unsupportedReason?: string;
  /**
   * `'append'` (registered by `extendCard`): the ability lists in `def` are appended to the
   * interpreted lists instead of replacing them, so the lines the interpreter already parses keep
   * their parsed abilities. Every other field still merges with the shallow spread.
   */
  compose?: 'append';
}

/**
 * The `CardDefinition` lists an `'append'` override extends rather than replaces. These are the
 * per-line ability lists: each printed ability line contributes its own entries, so an override
 * that models some lines must not erase the entries for the lines it does not claim.
 */
export const APPENDABLE_LISTS = [
  'manaAbilities',
  'activatedAbilities',
  'triggers',
  'staticEffects',
  'ruleStatics',
  'keywords',
] as const satisfies readonly (keyof CardDefinition)[];

/**
 * Every authored override, keyed by oracle id.
 */
const OVERRIDES = new Map<OracleId, CardOverride>();

/** Differing duplicate registrations that would otherwise be silently resolved last-write-wins. */
export const conflictingRegistrations: {
  oracleId: OracleId;
  previous: CardOverride;
  incoming: CardOverride;
}[] = [];
export const explicitReplacements: {
  oracleId: OracleId;
  name: string;
  reason: string;
}[] = [];

/**
 * Deck registrations (`registerXOverrides`) that threw during module init, one entry per failed
 * deck file, in registration order. Exported so a startup check or a test can assert this is
 * empty — `mana()` and friends throw on purpose (templates.ts) rather than silently degrading a
 * single card, but this file loads at import time, statically, from `interpret.ts`: an uncaught
 * throw here would crash loading of the ENTIRE card-interpretation module, taking every deck's
 * overrides down with the one that has the typo. Isolating each deck's registration keeps a bad
 * mana string in one file from failing cards in every other file too.
 *
 * The engine is I/O-free (CLAUDE.md), so a failure here is not logged from this package — it is
 * surfaced by `overrides.test.ts` asserting this array is empty (so a broken registration fails
 * CI loudly, at the file that has the bug, rather than shipping silently) and is available to any
 * I/O-capable caller (e.g. server startup) that wants to report it.
 */
export const failedRegistrations: { deck: string; error: unknown }[] = [];

function registerDeck(deck: string, register: () => void): void {
  try {
    register();
  } catch (error) {
    failedRegistrations.push({ deck, error });
  }
}

// Register all deck overrides
registerDeck('urdragon', registerURDRAGONOverrides);
registerDeck('draconic-destruction', registerDRACONIC_DESTRUCTIONOverrides);
registerDeck('token-triumph', registerTOKEN_TRIUMPHOverrides);
registerDeck('living-energy', registerLIVING_ENERGYOverrides);
registerDeck('silverquill-influence', registerSILVERQUILL_INFLUENCEOverrides);
registerDeck('silverquill-influence-remaining', registerSILVERQUILL_INFLUENCE_REMAININGOverrides);
registerDeck('counter-intelligence', registerCOUNTER_INTELLIGENCEOverrides);
registerDeck('necron-dynasties', registerNECRON_DYNASTIESOverrides);
registerDeck('necron-dynasties-remaining', registerNECRON_DYNASTIES_REMAININGOverrides);
registerDeck('queen-marchesa-queens-gambit', registerQUEEN_MARCHESA_QUEENS_GAMBITOverrides);
registerDeck(
  'queen-marchesa-queens-gambit-remaining',
  registerQUEEN_MARCHESA_QUEENS_GAMBIT_REMAININGOverrides,
);
registerDeck('marchesa-the-black-rose', registerMARCHESA_THE_BLACK_ROSEOverrides);
registerDeck('w1-remaining', registerW1RemainingOverrides);
registerDeck('w2-remaining', registerW2RemainingOverrides);
registerDeck('reviewed-five', registerReviewedFiveOverrides);
registerDeck('coverage-pr01', registerCoveragePr01Overrides);
registerDeck('coverage-pr02', registerCoveragePr02Overrides);
registerDeck('coverage-pr03', registerCoveragePr03Overrides);
registerDeck('unsupported-spell-faces', registerUnsupportedSpellFaces);

/** Register an override. Exported for the per-card modules and for tests. */
export function registerOverride(override: CardOverride): void {
  const existing = OVERRIDES.get(override.oracleId);
  // A legacy fixture registration may still exist for a card whose authored implementation was
  // moved into a later increment. Never let that empty placeholder erase executable behavior.
  // Checked by CONTENT (isEmptyPatch), not by key count: `{ manaAbilities: [] }` has one key but
  // patches in no more behavior than `{}` — the same distinction `applyOverride` makes below.
  if (
    existing !== undefined &&
    override.unsupportedReason === undefined &&
    !isEmptyPatch(existing.def) &&
    isEmptyPatch(override.def)
  ) {
    return;
  }
  if (existing !== undefined && registrationsConflict(existing, override)) {
    conflictingRegistrations.push({
      oracleId: override.oracleId,
      previous: existing,
      incoming: override,
    });
  }
  OVERRIDES.set(override.oracleId, override);
}

/** Exact duplicate data is harmless; any differing second definition needs explicit resolution. */
export function registrationsConflict(previous: CardOverride, incoming: CardOverride): boolean {
  // Backlog placeholders are intentionally superseded by later implementation increments and
  // executable definitions are already protected from later empty placeholders above.
  if (isEmptyPatch(previous.def) || isEmptyPatch(incoming.def)) return false;
  return JSON.stringify(previous) !== JSON.stringify(incoming);
}

export function getOverride(oracleId: OracleId): CardOverride | undefined {
  return OVERRIDES.get(oracleId);
}

/**
 * The fixture oracle id a card is ALSO registered under.
 *
 * `tests/fixtures.ts::oracle()` derives an oracle id from the card name by this exact rule, so a
 * unit test can build a card by name alone and still pick up its override. Both registrations are
 * required and they must agree — writing them out separately is how a card ended up with real
 * behavior under its Scryfall id and an empty patch under its slug.
 */
export function fixtureOracleId(name: string): string {
  return `oracle-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
}

/**
 * Register one card's authored behavior — the single entry point for an override.
 *
 * Registers under both the real Scryfall id and the derived fixture id, so a card is written once
 * instead of twice.
 *
 * `handledLines` must be copied verbatim from the card's `unmodeledReasons` output, not typed from
 * the card face: the interpreter strips reminder text and replaces the card's own name with `~`
 * before reporting a line, and the drift guard matches byte-exactly.
 */
export function defineCard(
  oracleId: string,
  name: string,
  handledLines: string[],
  def: Partial<CardDefinition>,
): void {
  registerOverride({ oracleId, name, handledLines, def });
  registerOverride({ oracleId: fixtureOracleId(name), name, handledLines, def });
}

/**
 * Register authored abilities for the lines the interpreter cannot parse, KEEPING the abilities it
 * did parse from the card's other lines (`compose: 'append'`). Use this rather than `defineCard`
 * when a card mixes parsed and unparsed lines that land in the same ability list — Aether Hub's
 * parsed `{T}: Add {C}` beside an authored energy mana ability — so the authored list cannot drop
 * a parsed ability the way a shallow spread would (overrides rule 4).
 */
export function extendCard(
  oracleId: string,
  name: string,
  handledLines: string[],
  def: Partial<CardDefinition>,
): void {
  registerOverride({ oracleId, name, handledLines, def, compose: 'append' });
  registerOverride({ oracleId: fixtureOracleId(name), name, handledLines, def, compose: 'append' });
}

/**
 * Deliberately supersede an earlier executable registration. This is intentionally noisy and
 * requires a reason; ordinary `defineCard` calls with differing data are reported as conflicts.
 */
export function replaceCard(
  oracleId: string,
  name: string,
  handledLines: string[],
  def: Partial<CardDefinition>,
  reason: string,
): void {
  const replace = (id: string): void => {
    const override = { oracleId: id, name, handledLines, def };
    if (OVERRIDES.has(id)) {
      explicitReplacements.push({ oracleId: id, name, reason });
      OVERRIDES.set(id, override);
    } else {
      registerOverride(override);
    }
  };
  replace(oracleId);
  replace(fixtureOracleId(name));
}

/**
 * A card whose unparsed lines are catalogued but whose behavior is not authored yet.
 *
 * This registers an empty patch, which `applyOverride` deliberately refuses to honor: the card
 * stays `modeled: false` and gains an "override has no executable behavior" reason. So it is a
 * visible backlog marker, not a way to make a card count as handled — the engine still halts
 * loudly if such a card's behavior is ever needed.
 */
export function unimplemented(oracleId: string, name: string, handledLines: string[]): void {
  defineCard(oracleId, name, handledLines, {});
}

/**
 * Contain behavior known to be wrong even when the generic parser would otherwise call the card
 * modeled. Unlike `unimplemented`, this is an explicit negative support declaration and therefore
 * takes precedence over an older executable registration for the same Oracle/fixture ids.
 */
export function unsupportedCard(oracleId: string, name: string, reason: string): void {
  const register = (id: string): void =>
    registerOverride({
      oracleId: id,
      name,
      handledLines: [],
      def: {},
      unsupportedReason: reason,
    });
  register(oracleId);
  register(fixtureOracleId(name));
}

/**
 * Every registration currently in the registry, sorted by oracle id.
 *
 * This exists for the golden snapshot (`scripts/snapshot-override-defs.ts`), which serializes the
 * whole registry so a refactor of the *authoring* layer can be proven to leave the authored DATA
 * byte-identical. Reads the post-load state, so it reflects the last-write-wins resolution of the
 * cards registered from more than one deck file.
 */
export function listOverrides(): CardOverride[] {
  return [...OVERRIDES.values()].sort((a, b) => a.oracleId.localeCompare(b.oracleId));
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
    /\bthis (?:creature|artifact|enchantment|land|permanent|token|Vehicle|Equipment|Saga|planeswalker|Aura)\b/gi,
    '~',
  );
}

/**
 * Apply an override to a freshly interpreted definition.
 *
 * Returns the definition unchanged when no override is registered, so this is safe to call
 * unconditionally at the end of `interpretCard`.
 */
/**
 * `CardDefinition` fields where `false`/absent are NOT interchangeable, unlike every other
 * boolean field on the type. Both are required fields the interpreter always fills in with a real
 * (possibly `true`) value — an override setting one to `false` is overriding that interpreted
 * value, not leaving a template field unfilled, and `isEmptyPatch` must not treat it as a no-op.
 * Every other boolean field (`commanderFreeCast`, `cantBlock`, …) is optional and `false`-shaped
 * when absent, so an explicit `false` there really does patch in nothing beyond the default.
 */
const REQUIRED_BOOLEAN_FIELDS: ReadonlySet<string> = new Set([
  'entersTapped',
  'hasUnsupportedCost',
]);

/**
 * Does this patch actually change anything the executor reads? `{}` obviously doesn't, but
 * neither does `{ manaAbilities: [] }`, `{ staticEffects: [] }`, `{ entersWithCounters: {} }`, or
 * `{ commanderFreeCast: false }` — an empty array, empty plain object, or `false` on an optional
 * flag is the same "nothing here" as an absent key, and a def carrying only such fields patches in
 * no more behavior than `{}` would. Two real registrations shipped exactly that shape (a leftover
 * field from a template that was never filled in) and, because `Object.keys(...).length` saw one
 * key and called it "non-empty," slipped past the check below entirely — reporting `modeled: true`
 * for a card with zero executable abilities.
 *
 * `REQUIRED_BOOLEAN_FIELDS` is the one exception: `entersTapped: false` is a legitimate, meaningful
 * override (correcting an interpreted `entersTapped: true`), not a leftover, because that field is
 * never merely absent — the interpreted def always has some real value there already. Treating it
 * as empty would make `applyOverride` silently drop that exact fix and keep shipping the wrong
 * interpreted value.
 */
function isEmptyPatch(patch: Partial<CardDefinition>): boolean {
  return Object.entries(patch).every(([key, value]) => {
    if (value === undefined || value === null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'boolean') return value === false && !REQUIRED_BOOLEAN_FIELDS.has(key);
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
  });
}

export function applyOverride(def: CardDefinition): CardDefinition {
  const override = getOverride(def.oracleId);
  if (override === undefined) return def;

  if (override.unsupportedReason !== undefined) {
    return {
      ...def,
      modeled: false,
      unmodeledReasons: [
        ...def.unmodeledReasons,
        `explicitly unsupported: ${override.unsupportedReason}`,
      ],
    };
  }

  // A registration must add executable card behavior. An empty patch is ignored so it cannot
  // clear an unsupported-rule reason and turn missing rules into a silent no-op.
  if (isEmptyPatch(override.def)) {
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
  if (override.compose === 'append') {
    const target = merged as unknown as Record<string, unknown[] | undefined>;
    const parsed = def as unknown as Record<string, unknown[] | undefined>;
    const authored = override.def as unknown as Record<string, unknown[] | undefined>;
    for (const key of APPENDABLE_LISTS) {
      if (authored[key] === undefined) continue;
      target[key] = [...(parsed[key] ?? []), ...authored[key]];
    }
  }
  merged.unmodeledReasons = remaining;
  merged.modeled = remaining.length === 0;
  return merged;
}

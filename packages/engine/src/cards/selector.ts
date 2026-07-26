/**
 * `Selector` — a predicate over permanents (ADR 0005, extended by ADR 0008). One abstraction
 * covers targeting, "each", and the *affected set* of a continuous effect (Blood Moon's
 * "nonbasic lands", Glorious Anthem's "creatures you control").
 *
 * The grammar is compositional — leaf predicates over a permanent's characteristics, combined
 * with `allOf` / `anyOf` / `not` — rather than a closed list of named sets. Forge's `Affected`
 * language is the same shape. A closed list needs a new engine case per card ("nonbasicLands",
 * "artifacts", …); a grammar needs a new *parse*, and the engine never changes. That matters
 * most for anthems and lords, where the subject differs on every card ("Elves you control",
 * "creatures your opponents control") but the mechanic is identical.
 *
 * Selectors are evaluated against a candidate's CURRENT characteristics — the working values
 * produced by the layers applied so far (ADR 0006). That is what makes one continuous effect
 * able to change another's affected set, and therefore what makes CR 613.8 dependency ordering
 * meaningful. The candidate is passed as plain fields rather than `Characteristics` to keep
 * this module free of engine imports.
 *
 * Note what a selector deliberately CANNOT read: toughness, tapped-ness, damage. That is what
 * keeps sublayer 7d free of dependency analysis (ADR 0007) — a pump effect cannot change any
 * selector's answer, so pumps can never depend on one another.
 *
 * Two leaves break that and are therefore **event-only**: legal in a trigger's subject, a
 * `Condition`, or a resolving spell's "each", and illegal inside a continuous effect.
 * `selectorIsEventOnly` marks them and `gatherEffects` enforces the ban.
 *
 * - `powerAtLeast` reads sublayer 7d's own output. Allowing it in a layer would mean one pump
 *   effect could change another's affected set, reinstating the dependency analysis 7d skips.
 * - `hasKeyword` reads layer 6's output. Allowing it in a layer-6 effect would let one keyword
 *   grant change another's affected set.
 *
 * The distinction is real, not bookkeeping: "5 damage to each creature without flying" asks its
 * question once, at a moment when keywords are already fully computed; a static ability would
 * have to ask it *during* the computation that produces them.
 */

import type { Color } from '@mtg/shared';

/** The subset of a permanent's current characteristics a selector can read. */
export interface SelectorCandidate {
  cardId: string;
  controllerId: string;
  types: readonly string[];
  supertypes: readonly string[];
  subtypes: readonly string[];
  colors: readonly Color[];
  /** Current power. Only `powerAtLeast` reads it — see the module comment. */
  power: number;
  /** Current keywords. Only `hasKeyword` reads them — see the module comment. */
  keywords: readonly string[];
  /** Token-ness (CR 111.1). NOT event-only: no layer can change it. */
  isToken: boolean;
  /**
   * Did this permanent enter the battlefield during the CURRENT turn (Neriv, Heart of the
   * Storm)? NOT event-only: no CR 613 layer can change when an object entered.
   */
  enteredThisTurn: boolean;
}

/** The object a relative selector ("self", "you control") is resolved against. */
export interface SelectorSource {
  cardId: string;
  controllerId: string;
  /** For an Aura/Equipment: the card id of the permanent it is attached to, if any. */
  attachedToCardId?: string | null;
}

export type Selector =
  /** The effect's own source (a CDA or self-buff). */
  | { kind: 'self' }
  /** Every permanent other than the source ("each other …"). */
  | { kind: 'other' }
  /** The permanent the source is attached to — "equipped creature", "enchanted creature". */
  | { kind: 'attachedToSource' }
  | { kind: 'type'; value: string }
  | { kind: 'subtype'; value: string }
  | { kind: 'supertype'; value: string }
  | { kind: 'color'; value: Color }
  /** Controlled by the source's controller, or by any of their opponents. */
  | { kind: 'controller'; who: 'you' | 'opponents' }
  /** EVENT-ONLY (see the module comment): "with power 4 or greater". */
  | { kind: 'powerAtLeast'; n: number }
  /** EVENT-ONLY (see the module comment): "with flying" / (negated) "without flying". */
  | { kind: 'hasKeyword'; keyword: string }
  /**
   * "another **nontoken** Dragon you control" (Miirym), as `not(IS_TOKEN)`.
   *
   * Deliberately NOT event-only, unlike the two leaves above: nothing in CR 613 can make a
   * permanent become or stop being a token, so no layer's output can change this answer.
   */
  | { kind: 'isToken' }
  /** "a creature you control that entered this turn" (Neriv, Heart of the Storm). */
  | { kind: 'enteredThisTurn' }
  | { kind: 'allOf'; of: Selector[] }
  | { kind: 'anyOf'; of: Selector[] }
  | { kind: 'not'; of: Selector };

export const SELF: Selector = { kind: 'self' };
export const OTHER: Selector = { kind: 'other' };
export const YOURS: Selector = { kind: 'controller', who: 'you' };
export const OPPONENTS: Selector = { kind: 'controller', who: 'opponents' };

export const ofType = (value: string): Selector => ({ kind: 'type', value });
export const ofSubtype = (value: string): Selector => ({ kind: 'subtype', value });
export const ofSupertype = (value: string): Selector => ({ kind: 'supertype', value });
export const ofColor = (value: Color): Selector => ({ kind: 'color', value });

export const allOf = (...of: Selector[]): Selector => ({ kind: 'allOf', of });
export const anyOf = (...of: Selector[]): Selector => ({ kind: 'anyOf', of });
export const not = (of: Selector): Selector => ({ kind: 'not', of });

/** Blood Moon's subject — a land without the Basic supertype. */
export const NONBASIC_LANDS: Selector = allOf(ofType('Land'), not(ofSupertype('Basic')));

export const powerAtLeast = (n: number): Selector => ({ kind: 'powerAtLeast', n });
export const withKeyword = (keyword: string): Selector => ({ kind: 'hasKeyword', keyword });

/** Miirym's subject leaf — see the  variant. */
export const IS_TOKEN: Selector = { kind: 'isToken' };

/** Neriv's subject leaf. */
export const ENTERED_THIS_TURN: Selector = { kind: 'enteredThisTurn' };

/**
 * Does this selector read a layer's own output anywhere inside it?
 *
 * A `true` answer means the selector may only be evaluated at event or resolution time, never
 * as a continuous effect's affected set — see the module comment. `gatherEffects` is the
 * enforcement point.
 */
export function selectorIsEventOnly(selector: Selector): boolean {
  switch (selector.kind) {
    case 'powerAtLeast':
    case 'hasKeyword':
      return true;
    case 'allOf':
    case 'anyOf':
      return selector.of.some(selectorIsEventOnly);
    case 'not':
      return selectorIsEventOnly(selector.of);
    default:
      return false;
  }
}

/** Does `candidate` match `selector` for an effect whose source is `source`? */
export function selectMatches(
  candidate: SelectorCandidate,
  selector: Selector,
  source: SelectorSource,
): boolean {
  switch (selector.kind) {
    case 'self':
      return candidate.cardId === source.cardId;
    case 'other':
      return candidate.cardId !== source.cardId;
    case 'attachedToSource':
      // Nothing attached ⇒ matches nothing, which is exactly right: an unattached Equipment's
      // "equipped creature has …" applies to no creature at all.
      return source.attachedToCardId != null && candidate.cardId === source.attachedToCardId;
    case 'type':
      return candidate.types.includes(selector.value);
    case 'subtype':
      return candidate.subtypes.includes(selector.value);
    case 'supertype':
      return candidate.supertypes.includes(selector.value);
    case 'color':
      return candidate.colors.includes(selector.value);
    case 'controller':
      return selector.who === 'you'
        ? candidate.controllerId === source.controllerId
        : candidate.controllerId !== source.controllerId;
    case 'powerAtLeast':
      return candidate.power >= selector.n;
    case 'hasKeyword':
      return candidate.keywords.includes(selector.keyword);
    case 'isToken':
      return candidate.isToken;
    case 'enteredThisTurn':
      return candidate.enteredThisTurn;
    case 'allOf':
      return selector.of.every((s) => selectMatches(candidate, s, source));
    case 'anyOf':
      return selector.of.some((s) => selectMatches(candidate, s, source));
    case 'not':
      return !selectMatches(candidate, selector.of, source);
  }
}

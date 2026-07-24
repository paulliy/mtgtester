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
 * Note what a selector deliberately CANNOT read: power, toughness, tapped-ness, damage. That
 * is what keeps sublayer 7d free of dependency analysis (ADR 0007) — a pump effect cannot
 * change any selector's answer, so pumps can never depend on one another.
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
}

/** The object a relative selector ("self", "you control") is resolved against. */
export interface SelectorSource {
  cardId: string;
  controllerId: string;
}

export type Selector =
  /** The effect's own source (a CDA or self-buff). */
  | { kind: 'self' }
  /** Every permanent other than the source ("each other …"). */
  | { kind: 'other' }
  | { kind: 'type'; value: string }
  | { kind: 'subtype'; value: string }
  | { kind: 'supertype'; value: string }
  | { kind: 'color'; value: Color }
  /** Controlled by the source's controller, or by any of their opponents. */
  | { kind: 'controller'; who: 'you' | 'opponents' }
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
    case 'allOf':
      return selector.of.every((s) => selectMatches(candidate, s, source));
    case 'anyOf':
      return selector.of.some((s) => selectMatches(candidate, s, source));
    case 'not':
      return !selectMatches(candidate, selector.of, source);
  }
}

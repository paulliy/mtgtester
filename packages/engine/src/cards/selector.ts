/**
 * `Selector` — a predicate over permanents (ADR 0005). One abstraction covers targeting,
 * "each", and the *affected set* of a continuous effect (e.g. Blood Moon's "nonbasic lands").
 *
 * Selectors are evaluated against a candidate's CURRENT characteristics — the working values
 * produced by the layers applied so far (ADR 0006). That is what makes one continuous effect
 * able to change another's affected set, and therefore what makes CR 613.8 dependency
 * ordering meaningful. The candidate is passed as plain fields rather than `Characteristics`
 * to keep this module free of engine imports.
 */

/** The subset of a permanent's current characteristics a selector can read. */
export interface SelectorCandidate {
  cardId: string;
  types: readonly string[];
  supertypes: readonly string[];
}

export type Selector =
  /** The effect's own source (a CDA or self-buff). */
  | { kind: 'self' }
  /** Every land (Urborg, Tomb of Yawgmoth / Yavimaya, Cradle of Growth). */
  | { kind: 'lands' }
  /** Nonbasic lands (Blood Moon, Magus of the Moon). */
  | { kind: 'nonbasicLands' }
  /** Every artifact (animation effects). */
  | { kind: 'artifacts' }
  /** Every permanent other than the source ("each other …"). */
  | { kind: 'others' };

/** Does `candidate` match `selector` for an effect whose source is `sourceCardId`? */
export function selectMatches(
  candidate: SelectorCandidate,
  selector: Selector,
  sourceCardId: string,
): boolean {
  switch (selector.kind) {
    case 'self':
      return candidate.cardId === sourceCardId;
    case 'others':
      return candidate.cardId !== sourceCardId;
    case 'lands':
      return candidate.types.includes('Land');
    case 'nonbasicLands':
      return candidate.types.includes('Land') && !candidate.supertypes.includes('Basic');
    case 'artifacts':
      return candidate.types.includes('Artifact');
  }
}

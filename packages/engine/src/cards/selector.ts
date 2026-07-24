/**
 * `Selector` — a predicate over permanents (ADR 0005). One abstraction covers targeting,
 * "each", and the *affected set* of a continuous effect (e.g. Blood Moon's "nonbasic lands").
 *
 * Selectors are evaluated against a candidate's BASE characteristics (printed types), not its
 * layer-computed ones — so an effect never depends on another effect's output yet. Full CR
 * 613.8 dependency ordering is a documented follow-up (ADR 0005).
 */

import type { EnginePermanent, GameContext } from '../state/types';

export type Selector =
  | { kind: 'self' }
  /** Nonbasic lands (Blood Moon). */
  | { kind: 'nonbasicLands' };

/** Does `candidate` match `selector`, given the effect's `source` permanent? */
export function selectMatches(
  ctx: GameContext,
  candidate: EnginePermanent,
  selector: Selector,
  source: EnginePermanent,
): boolean {
  switch (selector.kind) {
    case 'self':
      return candidate.id === source.id;
    case 'nonbasicLands': {
      const def = ctx.defs.get(candidate.oracleId);
      if (def === undefined) return false;
      return def.types.includes('Land') && !def.supertypes.includes('Basic');
    }
  }
}

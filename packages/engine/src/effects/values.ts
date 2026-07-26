/**
 * Resolution-time `Value` evaluation — the half that reads *current* characteristics.
 *
 * Separate from `cards/value.ts` on purpose: this module calls `selectPermanents` and
 * `effectivePT`, both of which run the CR 613 layer pass. That is safe here because effects
 * resolve after the pass has finished, and unsafe inside the pass itself, which is why the
 * layer engine keeps its own narrower evaluator. See the comment in `cards/value.ts`.
 */

import type { Value, ValueScope } from '../cards/value';
import { cardTypesInAllGraveyards } from '../cards/value';
import type { Selector } from '../cards/selector';
import type { EnginePermanent, GameContext } from '../state/types';
import { selectPermanents } from './continuous';
import { effectivePT } from '../state/queries';

function scopedPermanents(
  ctx: GameContext,
  scope: ValueScope,
  selector: Selector,
  who: 'you' | 'opponents' | 'all',
): EnginePermanent[] {
  const source = { cardId: scope.sourceCardId ?? '', controllerId: scope.controllerId };
  return selectPermanents(ctx, selector, source).filter((perm) => {
    if (who === 'you') return perm.controllerId === scope.controllerId;
    if (who === 'opponents') return perm.controllerId !== scope.controllerId;
    return true;
  });
}

/** Evaluate any `Value` in the context of a resolving spell or ability. */
export function evaluateValueIn(ctx: GameContext, value: Value, scope: ValueScope): number {
  switch (value.kind) {
    case 'const':
      return value.n;
    case 'plus':
      return evaluateValueIn(ctx, value.of, scope) + value.n;
    case 'times':
      return evaluateValueIn(ctx, value.of, scope) * value.n;
    case 'cardTypesInAllGraveyards':
      return cardTypesInAllGraveyards(ctx);
    case 'countPermanents':
      return scopedPermanents(ctx, scope, value.selector, value.scope).length;
    case 'greatestToughnessAmong':
      return scopedPermanents(ctx, scope, value.selector, value.scope).reduce(
        (best, perm) => Math.max(best, effectivePT(ctx, perm).toughness),
        0,
      );
    case 'totalPowerOfAttackers':
      return ctx.state.battlefield
        .filter((perm) => perm.attacking !== null)
        .reduce((total, perm) => total + effectivePT(ctx, perm).power, 0);
    case 'xValue':
      // A spell announced with no X is X=0 (CR 601.2b), which is a legal announcement.
      return scope.x ?? 0;
    case 'damageDealt':
      return scope.damageDealt ?? 0;
    case 'triggerCount':
      // An aggregate trigger always fired because at least one object matched, so the absent
      // case is a scope that was never populated — 1 is the honest floor, not 0.
      return scope.triggerCount ?? 1;
    case 'spellManaValue':
      return scope.spellManaValue ?? 0;
  }
}

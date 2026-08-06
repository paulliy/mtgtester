import type { LegalAction } from '@mtg/shared';

/**
 * Structural mirror of `packages/engine/src/cards/ability.ts`'s `AbilityCost` union — only the
 * fields the veto layer and cost model read. Duck-typed rather than imported: `@mtg/bot`
 * depends only on `@mtg/shared` (ADR 0023 item 1), and `LegalAction.data` is untyped JSON by
 * design (it is what the engine already hands to the LLM prompt as plain data).
 */
interface DuckAbilityCost {
  kind: string;
  amount?: number;
  count?: number;
}

function abilityCostsOf(action: LegalAction): DuckAbilityCost[] {
  const raw = action.data?.['abilityCosts'];
  return Array.isArray(raw) ? (raw as DuckAbilityCost[]) : [];
}

/**
 * The hard floor (ADR 0023 item 5): a scoring bug must never be able to kill its own player.
 * `payLife` for at least the player's current life is never a choosable action, independent of
 * whatever score the rest of the evaluator would otherwise assign it. This is the direct fix for
 * the original bug report — a permanent with a life-payment ability that gets reactivated until
 * its controller dies.
 */
export function passesVeto(action: LegalAction, life: number): boolean {
  return abilityCostsOf(action).every((cost) => {
    if (cost.kind === 'payLife') return (cost.amount ?? 0) < life;
    return true;
  });
}

/** Total life this action's costs would spend, in LEP before weighting (see `weights.ts`). */
export function totalLifeCost(action: LegalAction): number {
  return abilityCostsOf(action)
    .filter((cost) => cost.kind === 'payLife')
    .reduce((sum, cost) => sum + (cost.amount ?? 0), 0);
}

/** Count of permanents this action's costs would sacrifice. */
export function totalSacrificeCount(action: LegalAction): number {
  return abilityCostsOf(action).reduce((sum, cost) => {
    if (cost.kind === 'sacrificeSelf') return sum + 1;
    if (cost.kind === 'sacrificeOther') return sum + (cost.count ?? 1);
    return sum;
  }, 0);
}

/** Count of cards this action's costs would discard, given the deciding player's hand size. */
export function totalDiscardCount(action: LegalAction, handSize: number): number {
  return abilityCostsOf(action).reduce((sum, cost) => {
    if (cost.kind === 'discardSelf') return sum + 1;
    if (cost.kind === 'discardHand') return sum + handSize;
    return sum;
  }, 0);
}

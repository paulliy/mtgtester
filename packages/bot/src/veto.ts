import type { LegalAction } from '@mtg/shared';
import type { CardKnowledge } from './card-knowledge';

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
export function passesVeto(action: LegalAction, life: number, knowledge?: CardKnowledge): boolean {
  if (!survivesEachPlayerDamage(action, life, knowledge)) return false;
  return abilityCostsOf(action).every((cost) => {
    if (cost.kind === 'payLife') return (cost.amount ?? 0) < life;
    return true;
  });
}

/** The X the engine shows for a cast: `data.x` when present, else the ` with X=N` description suffix. */
function shownX(action: LegalAction): number | undefined {
  const data = action.data?.['x'];
  if (typeof data === 'number') return data;
  const match = /\bwith X=(\d+)/.exec(action.description);
  return match === null ? undefined : Number(match[1]);
}

/**
 * A spell that damages each player (Earthquake) is never cast for at least the caster's own life:
 * that is a self-kill, and with every player dying at once a draw. Damage prevention and life
 * that cannot drop are ignored (conservative); the view does not expose either.
 */
function survivesEachPlayerDamage(
  action: LegalAction,
  life: number,
  knowledge: CardKnowledge | undefined,
): boolean {
  if (action.type !== 'castSpell' || knowledge === undefined) return true;
  const name = action.data?.['sourceName'];
  if (typeof name !== 'string') return true;
  const damage = knowledge(name)?.damagesEachPlayer;
  if (damage === undefined) return true;
  const amount = damage === 'X' ? shownX(action) : damage;
  return amount === undefined || amount < life;
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

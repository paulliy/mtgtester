/**
 * The continuous-effect layer engine (CR 613, ADR 0005). `computeCharacteristics` returns a
 * permanent's current types/subtypes/keywords/power/toughness by applying every applicable
 * continuous effect in layer order:
 *
 *   layer 4 (type) → layer 6 (abilities) → 7a CDA → 7b set P/T → 7c counters → 7d modify P/T
 *
 * ordered within a (sub)layer by timestamp (CR 613.7). Sources of continuous effects:
 *   - static abilities / CDAs of battlefield permanents (Blood Moon, Tarmogoyf),
 *   - until-end-of-turn effects (Giant Growth → 7d, keyword grant → 6),
 *   - +1/+1 / -1/-1 counters (7c, applied inline).
 *
 * Dependency reordering (CR 613.8) is deferred: selectors read base characteristics, so no
 * effect yet depends on another's output (ADR 0005).
 */

import type { ManaUnit } from '../mana/cost';
import type { ContinuousOp, Characteristics } from '../cards/continuous-types';
import { selectMatches } from '../cards/selector';
import { evaluateValue } from '../cards/value';
import type { EnginePermanent, GameContext } from '../state/types';

/** Basic-land subtype → intrinsic mana unit (CR 305.6), for Blood Moon's mana override. */
const BASIC_LAND_MANA: Record<string, ManaUnit> = {
  Plains: ['W'],
  Island: ['U'],
  Swamp: ['B'],
  Mountain: ['R'],
  Forest: ['G'],
  Wastes: ['C'],
};

interface AppliedOp {
  op: ContinuousOp;
  timestamp: number;
}

/** All continuous effects applying to `perm`, unsorted. */
function gatherFor(ctx: GameContext, perm: EnginePermanent): AppliedOp[] {
  const applied: AppliedOp[] = [];

  // Static abilities / CDAs of every battlefield permanent (including `perm` itself).
  for (const source of ctx.state.battlefield) {
    const def = ctx.defs.get(source.oracleId);
    if (def === undefined) continue;
    for (const s of def.staticEffects) {
      if (selectMatches(ctx, perm, s.affects, source)) {
        applied.push({ op: s.op, timestamp: source.timestamp });
      }
    }
  }

  // Until-end-of-turn effects (pump → 7d, keyword grant → 6).
  for (const eff of ctx.state.effects) {
    if (eff.targetCardId !== perm.cardId) continue;
    if (eff.kind === 'ptDelta') {
      applied.push({
        op: { layer: 7, sublayer: 'd', power: eff.power ?? 0, toughness: eff.toughness ?? 0 },
        timestamp: eff.timestamp,
      });
    } else if (eff.kind === 'grantKeyword' && eff.keyword !== undefined) {
      applied.push({ op: { layer: 6, addKeyword: eff.keyword }, timestamp: eff.timestamp });
    }
  }

  return applied;
}

const SUBLAYER_ORDER: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 };

/** Compute a permanent's current characteristics through the layer system. */
export function computeCharacteristics(ctx: GameContext, perm: EnginePermanent): Characteristics {
  const def = ctx.defs.get(perm.oracleId);
  if (def === undefined) throw new Error(`engine bug: no def for ${perm.name}`);

  const types = [...def.types];
  let subtypes = [...def.subtypes];
  let keywords = [...def.keywords];
  let loseAbilities = false;
  let manaOverride: ManaUnit[] | null = null;

  const ops = gatherFor(ctx, perm).sort((a, b) => {
    const la = a.op.layer;
    const lb = b.op.layer;
    if (la !== lb) return la - lb;
    const sa = 'sublayer' in a.op ? (SUBLAYER_ORDER[a.op.sublayer] ?? 0) : 0;
    const sb = 'sublayer' in b.op ? (SUBLAYER_ORDER[b.op.sublayer] ?? 0) : 0;
    if (sa !== sb) return sa - sb;
    return a.timestamp - b.timestamp;
  });

  // Layer 4 — type-changing.
  for (const { op } of ops) {
    if (op.layer !== 4) continue;
    if (op.addTypes) for (const t of op.addTypes) if (!types.includes(t)) types.push(t);
    if (op.setLandSubtype !== undefined) subtypes = [op.setLandSubtype];
    if (op.loseAbilities) loseAbilities = true;
  }
  if (loseAbilities) {
    keywords = [];
    for (const st of subtypes) {
      const unit = BASIC_LAND_MANA[st];
      if (unit !== undefined) manaOverride = [unit];
    }
  }

  // Layer 6 — ability add.
  for (const { op } of ops) {
    if (op.layer === 6 && !keywords.includes(op.addKeyword)) keywords.push(op.addKeyword);
  }

  // Layer 7 — power/toughness. Base is the permanent's own printed value (equals def.power
  // today; a copy effect would set it on the permanent — a later layer-1 increment).
  let power = perm.power ?? 0;
  let toughness = perm.toughness ?? 0;
  // 7a CDA, then 7b set (both replace the running value).
  for (const { op } of ops) {
    if (op.layer === 7 && op.sublayer === 'a') {
      power = evaluateValue(ctx, op.power);
      toughness = evaluateValue(ctx, op.toughness);
    }
  }
  for (const { op } of ops) {
    if (op.layer === 7 && op.sublayer === 'b') {
      power = evaluateValue(ctx, op.power);
      toughness = evaluateValue(ctx, op.toughness);
    }
  }
  // 7c counters.
  const plus = perm.counters['+1/+1'] ?? 0;
  const minus = perm.counters['-1/-1'] ?? 0;
  power += plus - minus;
  toughness += plus - minus;
  // 7d modify.
  for (const { op } of ops) {
    if (op.layer === 7 && op.sublayer === 'd') {
      power += op.power;
      toughness += op.toughness;
    }
  }

  return { types, subtypes, keywords, power, toughness, loseAbilities, manaOverride };
}

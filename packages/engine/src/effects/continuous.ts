/**
 * The continuous-effect layer engine (CR 613, ADR 0005 + ADR 0006). `computeCharacteristics`
 * returns a permanent's current types/subtypes/keywords/power/toughness by applying every
 * applicable continuous effect in layer order:
 *
 *   layer 4 (type) → layer 6 (abilities) → 7a CDA → 7b set P/T → 7c counters → 7d modify P/T
 *
 * Sources of continuous effects:
 *   - static abilities / CDAs of battlefield permanents (Blood Moon, Tarmogoyf),
 *   - until-end-of-turn effects (Giant Growth → 7d, keyword grant → 6),
 *   - +1/+1 / -1/-1 counters (7c, applied inline).
 *
 * Within a layer the order is dependency-then-timestamp (CR 613.8, then 613.7):
 *
 *   613.8a  effect X depends on effect Y when applying Y first would change whether X exists,
 *           which objects X applies to, or what X does to them. (The "neither/both are
 *           characteristic-defining" clause is automatic here: CDAs live alone in 7a, and
 *           dependency is only ever computed between effects in the same sublayer.)
 *   613.8b  repeatedly apply the earliest-timestamped effect that depends on nothing still
 *           unapplied, recalculating after each application.
 *   613.8c  if every remaining effect depends on another — a loop — apply them all in plain
 *           timestamp order instead.
 *
 * Dependency is detected empirically rather than by static analysis: apply the candidate to a
 * throwaway copy of the working state and see whether the other effect's behavior changed.
 * That is exactly the question 613.8a asks, and it stays correct as new ops and selectors are
 * added rather than needing a hand-maintained table of which effects can affect which.
 *
 * Because all of this is relative to *current* characteristics, the whole battlefield is
 * computed in one pass: a selector like Blood Moon's "nonbasic lands" must see the types a
 * previous layer produced, not the printed ones.
 */

import type { Characteristics, ContinuousOp, StaticEffect } from '../cards/continuous-types';
import type { Selector } from '../cards/selector';
import { selectMatches } from '../cards/selector';
import { evaluateValue } from '../cards/value';
import type { ManaUnit } from '../mana/cost';
import type { EnginePermanent, GameContext } from '../state/types';

/** Basic-land subtype → intrinsic mana ability (CR 305.6), for Blood Moon's mana override. */
const BASIC_LAND_MANA: Record<string, ManaUnit> = {
  Plains: ['W'],
  Island: ['U'],
  Swamp: ['B'],
  Mountain: ['R'],
  Forest: ['G'],
  Wastes: ['C'],
};

/** What an effect applies to: a selector relative to its source, or one fixed card. */
type Applicability =
  | { kind: 'selector'; selector: Selector; sourceCardId: string }
  /** An until-end-of-turn effect, pinned to the object it resolved against. */
  | { kind: 'fixed'; cardId: string };

interface LayerEffect {
  applies: Applicability;
  op: ContinuousOp;
  timestamp: number;
}

/** Mutable per-permanent state threaded through the layers. */
interface Working {
  perm: EnginePermanent;
  chars: Characteristics;
}

type WorkMap = Map<string, Working>;

/** Layer/sublayer bucket an op belongs to, in application order. */
function groupOf(op: ContinuousOp): string {
  return op.layer === 7 ? `7${op.sublayer}` : String(op.layer);
}

/** Every continuous effect in play, from static abilities and until-end-of-turn effects. */
function gatherEffects(ctx: GameContext): LayerEffect[] {
  const out: LayerEffect[] = [];

  for (const source of ctx.state.battlefield) {
    const def = ctx.defs.get(source.oracleId);
    if (def === undefined) continue;
    for (const s of def.staticEffects as StaticEffect[]) {
      out.push({
        applies: { kind: 'selector', selector: s.affects, sourceCardId: source.cardId },
        op: s.op,
        timestamp: source.timestamp,
      });
    }
  }

  for (const eff of ctx.state.effects) {
    if (eff.kind === 'ptDelta') {
      out.push({
        applies: { kind: 'fixed', cardId: eff.targetCardId },
        op: { layer: 7, sublayer: 'd', power: eff.power ?? 0, toughness: eff.toughness ?? 0 },
        timestamp: eff.timestamp,
      });
    } else if (eff.kind === 'grantKeyword' && eff.keyword !== undefined) {
      out.push({
        applies: { kind: 'fixed', cardId: eff.targetCardId },
        op: { layer: 6, addKeyword: eff.keyword },
        timestamp: eff.timestamp,
      });
    }
  }

  return out;
}

/**
 * Does this effect still exist? A static ability stops contributing the moment its source
 * loses the abilities generated from its rules text (CR 305.7) — a nonbasic land under Blood
 * Moon is a Mountain with nothing but "{T}: Add {R}". This is the hinge of CR 613.8: it lets
 * one layer-4 effect delete another's, so the deleted one is *dependent* and must wait.
 */
function effectExists(work: WorkMap, effect: LayerEffect): boolean {
  if (effect.applies.kind === 'fixed') return true;
  const source = work.get(effect.applies.sourceCardId);
  return source !== undefined && !source.chars.loseAbilities;
}

function affects(effect: LayerEffect, entry: Working): boolean {
  if (effect.applies.kind === 'fixed') return entry.perm.cardId === effect.applies.cardId;
  return selectMatches(
    {
      cardId: entry.perm.cardId,
      types: entry.chars.types,
      supertypes: entry.chars.supertypes,
    },
    effect.applies.selector,
    effect.applies.sourceCardId,
  );
}

function applyOpTo(ctx: GameContext, chars: Characteristics, op: ContinuousOp): void {
  switch (op.layer) {
    case 4:
      for (const t of op.addTypes ?? []) if (!chars.types.includes(t)) chars.types.push(t);
      for (const s of op.addSubtypes ?? []) if (!chars.subtypes.includes(s)) chars.subtypes.push(s);
      // CR 305.7: *setting* a land's subtype replaces its land types outright.
      if (op.setLandSubtype !== undefined) chars.subtypes = [op.setLandSubtype];
      if (op.loseAbilities === true) chars.loseAbilities = true;
      break;
    case 6:
      if (!chars.keywords.includes(op.addKeyword)) chars.keywords.push(op.addKeyword);
      break;
    case 7:
      if (op.sublayer === 'd') {
        chars.power += op.power;
        chars.toughness += op.toughness;
      } else {
        // 7a (characteristic-defining) and 7b (set) both replace the running value.
        chars.power = evaluateValue(ctx, op.power);
        chars.toughness = evaluateValue(ctx, op.toughness);
      }
      break;
  }
}

function applyOne(ctx: GameContext, work: WorkMap, effect: LayerEffect): void {
  if (!effectExists(work, effect)) return;
  for (const entry of work.values()) {
    if (affects(effect, entry)) applyOpTo(ctx, entry.chars, effect.op);
  }
}

/**
 * A canonical summary of everything CR 613.8a asks about an effect: whether it exists, which
 * objects it applies to, and what it would do to them. Two fingerprints differing means the
 * effect's behavior changed.
 */
function fingerprint(ctx: GameContext, work: WorkMap, effect: LayerEffect): string {
  if (!effectExists(work, effect)) return '<nonexistent>';
  const targets: string[] = [];
  for (const entry of work.values()) {
    if (affects(effect, entry)) targets.push(entry.perm.cardId);
  }
  const op = effect.op;
  // Resolve any `Value`s, so an effect whose *magnitude* changes counts as changed too.
  const action =
    op.layer === 7 && op.sublayer !== 'd'
      ? `7${op.sublayer}:${evaluateValue(ctx, op.power)}/${evaluateValue(ctx, op.toughness)}`
      : JSON.stringify(op);
  return `${targets.sort().join(',')}|${action}`;
}

function cloneWork(work: WorkMap): WorkMap {
  const out: WorkMap = new Map();
  for (const [cardId, entry] of work) {
    out.set(cardId, {
      perm: entry.perm,
      chars: {
        supertypes: [...entry.chars.supertypes],
        types: [...entry.chars.types],
        subtypes: [...entry.chars.subtypes],
        keywords: [...entry.chars.keywords],
        power: entry.chars.power,
        toughness: entry.chars.toughness,
        loseAbilities: entry.chars.loseAbilities,
        manaOverride: entry.chars.manaOverride,
      },
    });
  }
  return out;
}

/** CR 613.8a: would applying `other` first change what `effect` does? */
function dependsOn(
  ctx: GameContext,
  work: WorkMap,
  effect: LayerEffect,
  other: LayerEffect,
): boolean {
  const before = fingerprint(ctx, work, effect);
  const trial = cloneWork(work);
  applyOne(ctx, trial, other);
  return fingerprint(ctx, trial, effect) !== before;
}

/** Apply one layer/sublayer's effects in CR 613.8 dependency order, then 613.7 timestamp. */
function applyGroup(ctx: GameContext, work: WorkMap, group: LayerEffect[]): void {
  // One effect cannot depend on anything; skip the analysis entirely (the common case).
  if (group.length === 0) return;
  if (group.length === 1) {
    applyOne(ctx, work, group[0] as LayerEffect);
    return;
  }

  const remaining = [...group].sort((a, b) => a.timestamp - b.timestamp);
  while (remaining.length > 0) {
    // 613.8b: the earliest-timestamped effect that depends on nothing still unapplied.
    const next = remaining.findIndex((effect, i) =>
      remaining.every((other, j) => j === i || !dependsOn(ctx, work, effect, other)),
    );
    if (next === -1) {
      // 613.8c: a dependency loop — ignore dependency, use timestamp order.
      for (const effect of remaining) applyOne(ctx, work, effect);
      return;
    }
    applyOne(ctx, work, remaining.splice(next, 1)[0] as LayerEffect);
  }
}

/**
 * After layer 4: rules-text abilities lost to a subtype change disappear, and a land's mana
 * abilities follow its *current* basic land types (CR 305.6/305.7).
 */
function finishLayer4(ctx: GameContext, work: WorkMap): void {
  for (const entry of work.values()) {
    const chars = entry.chars;
    const def = ctx.defs.get(entry.perm.oracleId);
    if (def === undefined) continue;

    if (chars.loseAbilities) chars.keywords = [];

    const printedBasics = def.subtypes.filter((s) => BASIC_LAND_MANA[s] !== undefined);
    const currentBasics = chars.subtypes.filter((s) => BASIC_LAND_MANA[s] !== undefined);
    const subtypesChanged =
      [...currentBasics].sort().join(',') !== [...printedBasics].sort().join(',');
    if (!chars.loseAbilities && !subtypesChanged) continue;

    const intrinsic = (types: string[]): ManaUnit[][] =>
      types.map((s) => [BASIC_LAND_MANA[s] as ManaUnit]);
    chars.manaOverride = chars.loseAbilities
      ? // Rules text gone: only the intrinsic ability of each current basic land type.
        intrinsic(currentBasics)
      : // Types added "in addition": printed mana abilities plus the new intrinsic ones.
        [
          ...def.manaAbilities.map((a) => a.units),
          ...intrinsic(currentBasics.filter((s) => !printedBasics.includes(s))),
        ];
  }
}

/** Layer 7c: +1/+1 and -1/-1 counters. */
function applyCounters(work: WorkMap): void {
  for (const entry of work.values()) {
    const net = (entry.perm.counters['+1/+1'] ?? 0) - (entry.perm.counters['-1/-1'] ?? 0);
    entry.chars.power += net;
    entry.chars.toughness += net;
  }
}

/** Run the full layer pass over `perms` as the candidate set. */
function runLayers(ctx: GameContext, perms: EnginePermanent[]): Map<string, Characteristics> {
  const work: WorkMap = new Map();
  for (const perm of perms) {
    const def = ctx.defs.get(perm.oracleId);
    if (def === undefined) throw new Error(`engine bug: no def for ${perm.name}`);
    work.set(perm.cardId, {
      perm,
      chars: {
        supertypes: [...def.supertypes],
        types: [...def.types],
        subtypes: [...def.subtypes],
        keywords: [...def.keywords],
        // Base P/T comes from the permanent (a copy effect would set it there — layer 1).
        power: perm.power ?? 0,
        toughness: perm.toughness ?? 0,
        loseAbilities: false,
        manaOverride: null,
      },
    });
  }

  const effects = gatherEffects(ctx);
  const group = (key: string): LayerEffect[] => effects.filter((e) => groupOf(e.op) === key);

  applyGroup(ctx, work, group('4'));
  finishLayer4(ctx, work);
  applyGroup(ctx, work, group('6'));
  applyGroup(ctx, work, group('7a'));
  applyGroup(ctx, work, group('7b'));
  applyCounters(work); // 7c
  applyGroup(ctx, work, group('7d'));

  const out = new Map<string, Characteristics>();
  for (const [cardId, entry] of work) out.set(cardId, entry.chars);
  return out;
}

/**
 * Compute current characteristics for every permanent on the battlefield in one layered pass.
 * `extra` includes a permanent that has left (or not yet joined) the battlefield, so it can
 * still be measured; it is a candidate for continuous effects but contributes none.
 */
export function computeAllCharacteristics(
  ctx: GameContext,
  extra?: EnginePermanent,
): Map<string, Characteristics> {
  const perms = [...ctx.state.battlefield];
  if (extra !== undefined && !perms.some((p) => p.cardId === extra.cardId)) perms.push(extra);
  return runLayers(ctx, perms);
}

/** Does any permanent in play contribute a static ability / CDA? */
function anyStaticAbilityInPlay(ctx: GameContext): boolean {
  for (const perm of ctx.state.battlefield) {
    const def = ctx.defs.get(perm.oracleId);
    if (def !== undefined && def.staticEffects.length > 0) return true;
  }
  return false;
}

/**
 * Compute one permanent's current characteristics through the layer system.
 *
 * Fast path: with no static ability anywhere in play, the only continuous effects are
 * until-end-of-turn ones, and each is pinned to a single object — so no permanent can
 * influence another's characteristics and only `perm` itself needs computing. This keeps the
 * per-call cost independent of battlefield size for the ordinary case; the whole-battlefield
 * pass (and with it dependency analysis) engages exactly when something in play could matter.
 */
export function computeCharacteristics(ctx: GameContext, perm: EnginePermanent): Characteristics {
  const all = anyStaticAbilityInPlay(ctx)
    ? computeAllCharacteristics(ctx, perm)
    : runLayers(ctx, [perm]);
  const chars = all.get(perm.cardId);
  if (chars === undefined) throw new Error(`engine bug: no characteristics for ${perm.name}`);
  return chars;
}

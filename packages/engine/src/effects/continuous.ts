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

import type { Color } from '@mtg/shared';
import { selectedPermanentDefinition } from '../cards/spell-faces';
import { counterCount, KEYWORD_COUNTERS } from '../state/counters';
import { evaluateCondition } from '../cards/condition';
import type { Condition } from '../cards/condition';
import type { ManaAbilitySpec } from '../cards/ability';
import type { Characteristics, ContinuousOp, StaticEffect } from '../cards/continuous-types';
import type { Selector, SelectorCandidate, SelectorSource } from '../cards/selector';
import { selectMatches, selectorIsEventOnly } from '../cards/selector';
import { CREATURE_TYPES } from '../cards/creature-types';
import { evaluateValue, isDynamicValue } from '../cards/value';
import type { LayerValueScope } from '../cards/value';
import type { ManaUnit } from '../mana/cost';
import { manaValueOf, parseManaCost } from '../mana/cost';
import type { EnginePermanent, GameContext } from '../state/types';
import { digestOf, getCached, setCached } from './layer-cache';

/** Basic-land subtype → intrinsic mana ability (CR 305.6), for Blood Moon's mana override. */
const BASIC_LAND_MANA: Record<string, ManaUnit> = {
  Plains: ['W'],
  Island: ['U'],
  Swamp: ['B'],
  Mountain: ['R'],
  Forest: ['G'],
  Wastes: ['C'],
};

/**
 * What an effect applies to. A static ability re-evaluates its selector every pass, against
 * current characteristics. An until-end-of-turn effect from a resolved spell does NOT: CR
 * 611.2c fixes its affected set at resolution, so it carries the resulting card ids instead.
 */
type Applicability =
  | { kind: 'selector'; selector: Selector; source: SelectorSource }
  /** An until-end-of-turn effect, pinned to the objects it resolved against (CR 611.2c). */
  | { kind: 'fixed'; cardIds: readonly string[]; objectIds?: readonly string[] };

interface LayerEffect {
  applies: Applicability;
  op: ContinuousOp;
  timestamp: number;
  /**
   * "As long as you control four or more creature tokens" (Toby): a count of permanents, judged on
   * the characteristics the layers have produced so far (CR 613.8a: it can change whether this
   * effect exists), so it cannot be read before the pass the way other static conditions are.
   */
  condition?: Extract<Condition, { kind: 'countPermanents' }>;
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

/** The card id of whatever `perm` is attached to, for `attachedToSource`. */
function attachedCardId(ctx: GameContext, perm: EnginePermanent): string | null {
  if (perm.attachedTo === null) return null;
  return ctx.state.battlefield.find((p) => p.id === perm.attachedTo)?.cardId ?? null;
}

/** Every continuous effect in play, from static abilities and until-end-of-turn effects. */
function gatherEffects(ctx: GameContext): LayerEffect[] {
  const out: LayerEffect[] = [];

  for (const source of ctx.state.battlefield) {
    for (const [counter, keyword] of Object.entries(KEYWORD_COUNTERS)) {
      if (counterCount(source.counters, counter) <= 0) continue;
      out.push({
        applies: { kind: 'fixed', cardIds: [source.cardId], objectIds: [source.id] },
        op: { layer: 6, addKeyword: keyword },
        timestamp: source.counterTimestamps?.[counter] ?? source.timestamp,
      });
    }
    if (source.faceDown) continue;
    const printed = ctx.defs.get(source.oracleId);
    if (printed === undefined) continue;
    const def = selectedPermanentDefinition(printed, source.face);
    // A bestowed Aura "becomes an Aura enchantment" (CR 702.103b): a type-changing effect that
    // replaces its card types and the creature types that went with them (CR 205.1a), in its
    // own timestamp order.
    if (source.bestowed === true)
      out.push({
        applies: { kind: 'fixed', cardIds: [source.cardId], objectIds: [source.id] },
        op: { layer: 4, setTypes: ['Enchantment'], setSubtypes: ['Aura'] },
        timestamp: source.timestamp,
      });
    const printedStatics =
      source.transformed && def.backFace !== undefined
        ? def.backFace.staticEffects
        : def.staticEffects;
    for (const s of printedStatics as StaticEffect[]) {
      // A selector that reads power cannot be a continuous effect's affected set: it would make
      // one 7d effect able to change another's, reinstating the dependency analysis `applyGroup`
      // deliberately skips for 7d. Event-only selectors are legal in triggers and conditions
      // (see `cards/selector.ts`), so this is a modeling error, not an unmodeled card.
      if (selectorIsEventOnly(s.affects)) {
        throw new Error(
          `engine bug: ${def.name} has a static effect whose selector reads power or keywords — event-only selectors cannot be a continuous effect's affected set`,
        );
      }
      const boardCondition = s.condition?.kind === 'countPermanents' ? s.condition : undefined;
      if (
        s.condition !== undefined &&
        boardCondition === undefined &&
        !evaluateCondition(ctx, s.condition, {
          cardId: source.cardId,
          controllerId: source.controllerId,
        })
      ) {
        continue;
      }
      // "Protection from the chosen color" (Flickering Ward): the concrete color lives on the
      // permanent, not the static op, so resolve it here — the one place both are in scope.
      if ('addProtectionFromChosenColor' in s.op) {
        if (source.chosenOption === undefined) continue;
        out.push({
          applies: {
            kind: 'selector',
            selector: s.affects,
            source: {
              cardId: source.cardId,
              controllerId: source.controllerId,
              attachedToCardId: attachedCardId(ctx, source),
            },
          },
          op: { layer: 6, addProtection: [source.chosenOption as Color] },
          timestamp: source.timestamp,
          ...(boardCondition !== undefined ? { condition: boardCondition } : {}),
        });
        continue;
      }
      // "Is the chosen type in addition to its other types" (Roaming Throne): the concrete type
      // lives on the permanent, so it is resolved here as well.
      if ('addChosenSubtype' in s.op && s.op.addChosenSubtype === true) {
        if (source.chosenOption === undefined) continue;
        const { addChosenSubtype: _chosen, ...rest } = s.op;
        out.push({
          applies: {
            kind: 'selector',
            selector: s.affects,
            source: { cardId: source.cardId, controllerId: source.controllerId },
          },
          op: { ...rest, addSubtypes: [...(rest.addSubtypes ?? []), source.chosenOption] },
          timestamp: source.timestamp,
          ...(boardCondition !== undefined ? { condition: boardCondition } : {}),
        });
        continue;
      }
      out.push({
        applies: {
          kind: 'selector',
          selector: s.affects,
          source: {
            cardId: source.cardId,
            controllerId: source.controllerId,
            // Equipment/Auras: `attachedTo` is an ObjectId, and selectors work in card ids.
            attachedToCardId: attachedCardId(ctx, source),
            ...(source.chosenOption !== undefined ? { chosenOption: source.chosenOption } : {}),
            sourceName: source.name,
          },
        },
        op: s.op,
        timestamp: source.timestamp,
        ...(boardCondition !== undefined ? { condition: boardCondition } : {}),
      });
    }
    if (!source.transformed && def.artifactGraveyardAbilities === true) {
      const controller = ctx.state.players.find((p) => p.id === source.controllerId);
      for (const card of controller?.graveyard ?? []) {
        const graveyardDef = ctx.defs.get(card.oracleId);
        if (graveyardDef === undefined || !graveyardDef.types.includes('Artifact')) continue;
        for (const ability of graveyardDef.activatedAbilities) {
          out.push({
            applies: {
              kind: 'selector',
              selector: { kind: 'self' },
              source: { cardId: source.cardId, controllerId: source.controllerId },
            },
            op: { layer: 6, addActivatedAbility: ability },
            timestamp: source.timestamp,
          });
        }
      }
    }
  }

  for (const eff of ctx.state.effects) {
    const applies = {
      kind: 'fixed',
      cardIds: eff.targetCardIds,
      ...(eff.targetObjectIds !== undefined ? { objectIds: eff.targetObjectIds } : {}),
    } as const;
    if (eff.kind === 'ptDelta') {
      out.push({
        applies,
        op: { layer: 7, sublayer: 'd', power: eff.power ?? 0, toughness: eff.toughness ?? 0 },
        timestamp: eff.timestamp,
      });
    } else if (eff.kind === 'grantKeyword' && eff.keyword !== undefined) {
      out.push({ applies, op: { layer: 6, addKeyword: eff.keyword }, timestamp: eff.timestamp });
    } else if (eff.kind === 'grantProtection' && eff.protectionFrom !== undefined) {
      out.push({
        applies,
        op: { layer: 6, addProtection: eff.protectionFrom },
        timestamp: eff.timestamp,
      });
    } else if (eff.kind === 'grantAbility' && eff.ability !== undefined) {
      out.push({ applies, op: { layer: 6, addTrigger: eff.ability }, timestamp: eff.timestamp });
    } else if (eff.kind === 'becomeCreature' && eff.becomeCreature !== undefined) {
      const bc = eff.becomeCreature;
      if (bc.setColors !== undefined) {
        out.push({ applies, op: { layer: 5, setColors: bc.setColors }, timestamp: eff.timestamp });
      }
      out.push({
        applies,
        op:
          bc.replaceTypes !== undefined
            ? {
                layer: 4,
                setTypes: bc.replaceTypes,
                setSubtypes: bc.addSubtypes,
                ...(bc.supertypes === undefined ? {} : { setSupertypes: bc.supertypes }),
              }
            : {
                layer: 4,
                addTypes: ['Creature'],
                addSubtypes: bc.addSubtypes,
                ...(bc.supertypes === undefined ? {} : { addSupertypes: bc.supertypes }),
              },
        timestamp: eff.timestamp,
      });
      out.push({
        applies,
        op: {
          layer: 7,
          sublayer: 'b',
          power: { kind: 'const', n: bc.power },
          toughness: { kind: 'const', n: bc.toughness },
        },
        timestamp: eff.timestamp,
      });
      for (const keyword of bc.addKeywords) {
        out.push({ applies, op: { layer: 6, addKeyword: keyword }, timestamp: eff.timestamp });
      }
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
function effectExists(ctx: GameContext, work: WorkMap, effect: LayerEffect): boolean {
  // CR 611.2c: a resolved spell's effect is independent of its source, which may be long gone.
  if (effect.applies.kind === 'fixed') return true;
  const source = work.get(effect.applies.source.cardId);
  if (source === undefined || source.chars.loseAbilities) return false;
  if (effect.condition === undefined) return true;
  const count = scopeOf(ctx, work, effect)?.countPermanents?.(
    effect.condition.selector,
    effect.condition.scope,
  );
  return (
    count !== undefined &&
    (effect.condition.cmp === '>=' ? count >= effect.condition.n : count <= effect.condition.n)
  );
}

/**
 * A permanent's mana value (CR 202.3), or `undefined` when its def can't be found. Mana value is
 * a printed characteristic, not a layer's derived output, and reads X as 0 off the stack (202.3e).
 *
 * Two kinds of "back face" must not be confused here:
 * - A modal DFC played as its land face (`face: 'back'`) has only that face's characteristics
 *   (CR 712.8f), and a land face has no mana cost: mana value 0.
 * - A transformed nonmodal DFC (`transformed`) uses its FRONT face's mana cost (CR 202.3b,
 *   712.8e), so transforming never changes its mana value. A copy of a back face has mana
 *   value 0.
 *
 * A face-down permanent has no mana cost, so its mana value is 0 whatever card it is (CR 708.2).
 */
function printedManaValue(ctx: GameContext, perm: EnginePermanent): number | undefined {
  const def = ctx.defs.get(perm.oracleId);
  if (def === undefined) return undefined;
  if (perm.faceDown) return 0;
  if (perm.face === 'back') {
    const landFace = def.alternativeCasts?.find((alt) => alt.kind === 'mdfc')?.landFace;
    if (landFace !== undefined) return 0;
  }
  // A copy takes the copied object's mana cost (CR 707.2), not its def's: `applyCopy` keeps the
  // target's front-face `oracleId` but its CURRENT cost, which for a transformed target is the
  // back face's — so a copy of a back face reads 0 (CR 712.8e).
  if (perm.copyOriginal !== undefined) return manaValueOf(parseManaCost(perm.manaCost).cost);
  return manaValueOf(selectedPermanentDefinition(def, perm.face).manaCost);
}

/** The one place a `SelectorCandidate` is built, so every selector reads the same fields. */
export function candidateOf(
  ctx: GameContext,
  perm: EnginePermanent,
  chars: Characteristics,
  includeCombatDefender = false,
): SelectorCandidate {
  let isEnchanted = false;
  let isEquipped = false;
  const auraControllerIds: string[] = [];
  for (const other of ctx.state.battlefield) {
    if (other.attachedTo === perm.id) {
      const def = ctx.defs.get(other.oracleId);
      if (def !== undefined) {
        // A bestowed permanent is an Aura while bestowed (CR 702.103b), though printed a creature.
        const isAura = def.subtypes.includes('Aura') || other.bestowed === true;
        if (isAura) auraControllerIds.push(other.controllerId);
        if (isAura || def.types.includes('Enchantment')) {
          isEnchanted = true;
        }
        if (def.subtypes.includes('Equipment') || def.types.includes('Artifact')) {
          isEquipped = true;
        }
      }
    }
  }
  // Absent (not 0) when the def can't be found, so `manaValueAtMost`/`manaValueAtLeast`
  // correctly never match rather than matching everything as mana value 0. Off the battlefield,
  // `cardZoneCandidate` applies the same rule via `spellManaValue(def, undefined)`.
  const manaValue = printedManaValue(ctx, perm);
  // The defending player when this attacks the player, or a planeswalker that is still in combat
  // (CR 506.4). Only event-time selector matching asks (`includeCombatDefender`): reading another
  // permanent's characteristics here would recurse while the layers are being computed.
  const attackedWalker =
    perm.attackingPlaneswalker === null
      ? undefined
      : ctx.state.battlefield.find((permanent) => permanent.id === perm.attackingPlaneswalker);
  const defendingPlayer =
    perm.attacking === null
      ? undefined
      : perm.attackingPlaneswalker === null ||
          (includeCombatDefender &&
            !perm.attackedPlaneswalkerRemoved &&
            attackedWalker !== undefined &&
            attackedWalker.controllerId === perm.attacking &&
            computeCharacteristics(ctx, attackedWalker).types.includes('Planeswalker'))
        ? perm.attacking
        : undefined;

  return {
    cardId: perm.cardId,
    controllerId: perm.controllerId,
    types: chars.types,
    supertypes: chars.supertypes,
    subtypes: chars.subtypes,
    colors: chars.colors,
    power: chars.power,
    toughness: chars.toughness,
    ...(chars.basePower === undefined ? {} : { basePower: chars.basePower }),
    ...(chars.baseToughness === undefined ? {} : { baseToughness: chars.baseToughness }),
    keywords: chars.keywords,
    ...(manaValue === undefined ? {} : { manaValue }),
    isToken: perm.isToken,
    enteredThisTurn: perm.enteredTurnNumber === ctx.state.turnNumber,
    isCommander: perm.isCommander,
    ownerId: perm.ownerId,
    // A face-down permanent has no name (CR 708.2); otherwise this is the current name, which a
    // copy effect has already rewritten (CR 707.2).
    ...(perm.faceDown ? {} : { name: perm.name }),
    isEnchanted,
    ...(auraControllerIds.length === 0 ? {} : { auraControllerIds }),
    isEquipped,
    inCombat: perm.attacking !== null || perm.blocking !== null,
    combatRole: perm.attacking !== null ? 'attacking' : perm.blocking !== null ? 'blocking' : null,
    // The player attacked itself: null when it attacks a planeswalker, so "attacking you / an
    // opponent / that player" selectors don't match an attack on their planeswalker.
    attackedThisTurn: perm.attackedThisTurn === true,
    controlledSinceTurnStart: !perm.summoningSick,
    attackingDefenderId: perm.attackingPlaneswalker === null ? perm.attacking : null,
    ...(defendingPlayer === undefined ? {} : { attackingDefendingPlayerId: defendingPlayer }),
    hasAnyCounter: Object.values(perm.counters).some((c) => c > 0),
    counters: perm.counters,
  };
}

/**
 * Does `perm` match `selector` right now? The event-time counterpart to `selectPermanents`:
 * a trigger asks about one specific object ("whenever a Dragon YOU CONTROL attacks") rather
 * than enumerating the board.
 */
export function matchesSelector(
  ctx: GameContext,
  perm: EnginePermanent,
  selector: Selector,
  source: SelectorSource,
): boolean {
  return selectMatches(
    candidateOf(ctx, perm, computeCharacteristics(ctx, perm), true),
    selector,
    source,
  );
}

function affects(ctx: GameContext, effect: LayerEffect, entry: Working): boolean {
  if (effect.applies.kind === 'fixed') {
    return (
      effect.applies.cardIds.includes(entry.perm.cardId) &&
      (effect.applies.objectIds === undefined || effect.applies.objectIds.includes(entry.perm.id))
    );
  }
  return selectMatches(
    candidateOf(ctx, entry.perm, entry.chars),
    effect.applies.selector,
    effect.applies.source,
  );
}

/** The static effect source's controller — the only scope the layer engine can offer a `Value`. */
/** The static effect scope, including counts over the current layer working set. */
function scopeOf(
  ctx: GameContext,
  work: WorkMap,
  effect: LayerEffect,
): LayerValueScope | undefined {
  if (effect.applies.kind !== 'selector') return undefined;
  const source = effect.applies.source;
  return {
    controllerId: source.controllerId,
    sourceCounters: work.get(source.cardId)?.perm.counters ?? {},
    countPermanents: (selector, who) => {
      let count = 0;
      for (const entry of work.values()) {
        if (!selectMatches(candidateOf(ctx, entry.perm, entry.chars), selector, source)) continue;
        if (who === 'you' && entry.perm.controllerId !== source.controllerId) continue;
        if (who === 'opponents' && entry.perm.controllerId === source.controllerId) continue;
        count += 1;
      }
      return count;
    },
    countAurasYouControlAttachedToCreatures: () => {
      let count = 0;
      for (const entry of work.values()) {
        if (entry.perm.controllerId !== source.controllerId) continue;
        if (!entry.chars.subtypes.includes('Aura')) continue;
        if (entry.perm.attachedTo === null) continue;
        const attached = [...work.values()].find(
          (candidate) => candidate.perm.id === entry.perm.attachedTo,
        );
        if (attached?.chars.types.includes('Creature') === true) count += 1;
      }
      return count;
    },
    countAurasAttachedToSource: () => {
      const host = work.get(source.cardId)?.perm;
      if (host === undefined) return 0;
      let count = 0;
      for (const entry of work.values()) {
        if (entry.perm.attachedTo === host.id && entry.chars.subtypes.includes('Aura')) count += 1;
      }
      return count;
    },
  };
}
function applyOpTo(
  ctx: GameContext,
  chars: Characteristics,
  op: ContinuousOp,
  scope: LayerValueScope | undefined,
): void {
  switch (op.layer) {
    case 4:
      if (op.setTypes !== undefined) chars.types = [...op.setTypes];
      if (op.setSubtypes !== undefined) chars.subtypes = [...op.setSubtypes];
      if (op.setSupertypes !== undefined) chars.supertypes = [...op.setSupertypes];
      for (const t of op.addSupertypes ?? [])
        if (!chars.supertypes.includes(t)) chars.supertypes.push(t);
      for (const t of op.addTypes ?? []) if (!chars.types.includes(t)) chars.types.push(t);
      for (const s of op.addSubtypes ?? []) if (!chars.subtypes.includes(s)) chars.subtypes.push(s);
      // Changeling (CR 702.73): every creature type, always — a characteristic-defining ability
      // that lives in layer 4 with the other type changes.
      if (op.addAllCreatureTypes === true) {
        for (const t of CREATURE_TYPES) if (!chars.subtypes.includes(t)) chars.subtypes.push(t);
      }
      // CR 305.7: *setting* a land's subtype replaces its land types outright.
      if (op.setLandSubtype !== undefined) chars.subtypes = [op.setLandSubtype];
      if (op.loseAbilities === true) chars.loseAbilities = true;
      break;
    case 5:
      chars.colors = [...op.setColors];
      break;
    case 6:
      if ('loseAllAbilities' in op) {
        // Strip everything the permanent generates from its own rules text. Anything granted
        // by a later-applied layer-6 effect survives, which is the whole point of the order.
        chars.keywords = [];
        chars.triggers = [];
        chars.manaAbilities = [];
        if (chars.activatedAbilities) chars.activatedAbilities = [];
        chars.ward = null;
        chars.protectionFrom = [];
        chars.loseAbilities = true;
      } else if ('addManaAbility' in op) {
        chars.manaAbilities.push(op.addManaAbility);
      } else if ('addActivatedAbility' in op) {
        if (!chars.activatedAbilities) chars.activatedAbilities = [];
        chars.activatedAbilities.push(op.addActivatedAbility);
      } else if ('addWard' in op) {
        chars.ward = op.addWard;
      } else if ('addProtection' in op) {
        for (const c of op.addProtection)
          if (!chars.protectionFrom.includes(c)) {
            chars.protectionFrom.push(c);
          }
      } else if ('addTrigger' in op) {
        chars.triggers.push(op.addTrigger);
      } else if ('addKeyword' in op) {
        if (!chars.keywords.includes(op.addKeyword)) {
          chars.keywords.push(op.addKeyword);
        }
      } else if ('setCantBeBlocked' in op) {
        chars.cantBeBlocked = true;
      } else if ('setMustAttackEachCombat' in op) {
        chars.mustAttackEachCombat = true;
      } else if ('addGoad' in op) {
        const controllerId = scope?.controllerId;
        if (controllerId !== undefined) {
          chars.staticGoadedBy = [...(chars.staticGoadedBy ?? []), controllerId];
        }
      }
      break;
    case 7:
      if (op.sublayer === 'd') {
        const pDelta =
          typeof op.power === 'number' ? op.power : evaluateValue(ctx, op.power, scope);
        const tDelta =
          typeof op.toughness === 'number' ? op.toughness : evaluateValue(ctx, op.toughness, scope);
        chars.power += pDelta;
        chars.toughness += tDelta;
      } else {
        // 7a (characteristic-defining) and 7b (set) both replace the running value.
        chars.power = evaluateValue(ctx, op.power, scope);
        chars.toughness = evaluateValue(ctx, op.toughness, scope);
      }
      break;
  }
}

function applyOne(ctx: GameContext, work: WorkMap, effect: LayerEffect): void {
  if (!effectExists(ctx, work, effect)) return;
  const scope = scopeOf(ctx, work, effect);
  // "For each time it has attacked this turn" reads the affected object, not the source.
  const op = effect.op;
  const perObject =
    scope !== undefined &&
    op.layer === 7 &&
    ((typeof op.power !== 'number' && op.power.kind === 'timesAttackedThisTurn') ||
      (typeof op.toughness !== 'number' && op.toughness.kind === 'timesAttackedThisTurn'));
  for (const entry of work.values()) {
    if (!affects(ctx, effect, entry)) continue;
    applyOpTo(
      ctx,
      entry.chars,
      effect.op,
      perObject
        ? { ...scope, affectedTimesAttacked: entry.perm.timesAttackedThisTurn ?? 0 }
        : scope,
    );
  }
}

/**
 * A canonical summary of everything CR 613.8a asks about an effect: whether it exists, which
 * objects it applies to, and what it would do to them. Two fingerprints differing means the
 * effect's behavior changed.
 */
function fingerprint(ctx: GameContext, work: WorkMap, effect: LayerEffect): string {
  if (!effectExists(ctx, work, effect)) return '<nonexistent>';
  const targets: string[] = [];
  for (const entry of work.values()) {
    if (affects(ctx, effect, entry)) targets.push(entry.perm.cardId);
  }
  const op = effect.op;
  // Resolve any `Value`s, so an effect whose *magnitude* changes counts as changed too.
  const action =
    op.layer === 7 && op.sublayer !== 'd'
      ? `7${op.sublayer}:${evaluateValue(ctx, op.power, scopeOf(ctx, work, effect))}/${evaluateValue(ctx, op.toughness, scopeOf(ctx, work, effect))}`
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
        colors: [...entry.chars.colors],
        keywords: [...entry.chars.keywords],
        ward: entry.chars.ward,
        protectionFrom: [...entry.chars.protectionFrom],
        cantBeBlocked: entry.chars.cantBeBlocked,
        ...(entry.chars.staticGoadedBy === undefined
          ? {}
          : { staticGoadedBy: [...entry.chars.staticGoadedBy] }),
        ...(entry.chars.mustAttackEachCombat === undefined
          ? {}
          : { mustAttackEachCombat: entry.chars.mustAttackEachCombat }),
        ...(entry.chars.activatedAbilities === undefined
          ? {}
          : { activatedAbilities: [...entry.chars.activatedAbilities] }),
        triggers: [...entry.chars.triggers],
        manaAbilities: [...entry.chars.manaAbilities],
        power: entry.chars.power,
        toughness: entry.chars.toughness,
        loseAbilities: entry.chars.loseAbilities,
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

/**
 * Apply one layer/sublayer's effects in CR 613.8 dependency order, then 613.7 timestamp.
 *
 * `dependencyPossible` mirrors Forge's `CONTINUOUS_LAYERS_WITH_DEPENDENCY`: some layers are
 * excluded because no effect in them can change another's existence, affected set, or
 * magnitude. Sublayer 7d (pump) is ours, and it stays excluded now that anthems put many
 * effects in it: 7d ops only change power and toughness, `Selector` cannot read power or
 * toughness (see `cards/selector.ts`), and existence turns on `loseAbilities`, which only
 * layers 4 and 6 set. So no 7d effect can change what another 7d effect does.
 *
 * The justification is that reasoning, not speed: measured on a 40-creature board with eight
 * anthems, turning the probing back on costs less than the run-to-run noise. What the
 * exclusion buys is that the quadratic probe count cannot start mattering as boards grow,
 * in the one sublayer most likely to accumulate effects.
 */
function applyGroup(
  ctx: GameContext,
  work: WorkMap,
  group: LayerEffect[],
  dependencyPossible = true,
): void {
  // One effect cannot depend on anything; skip the analysis entirely (the common case).
  if (group.length === 0) return;
  if (group.length === 1 || !dependencyPossible) {
    for (const effect of [...group].sort((a, b) => a.timestamp - b.timestamp)) {
      applyOne(ctx, work, effect);
    }
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

    if (chars.loseAbilities) {
      chars.keywords = [];
      chars.triggers = [];
      chars.ward = null;
      chars.protectionFrom = [];
    }

    const printedBasics = def.subtypes.filter((s) => BASIC_LAND_MANA[s] !== undefined);
    const currentBasics = chars.subtypes.filter((s) => BASIC_LAND_MANA[s] !== undefined);
    const subtypesChanged =
      [...currentBasics].sort().join(',') !== [...printedBasics].sort().join(',');
    if (!chars.loseAbilities && !subtypesChanged) continue;

    const intrinsic = (types: string[]): ManaAbilitySpec[] =>
      types.map((s) => ({ units: [BASIC_LAND_MANA[s] as ManaUnit] }));
    chars.manaAbilities = chars.loseAbilities
      ? // Rules text gone: only the intrinsic ability of each current basic land type.
        intrinsic(currentBasics)
      : // Types added "in addition": printed mana abilities plus the new intrinsic ones.
        [
          ...def.manaAbilities,
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

/** Did any effect in play read state beyond the permanent itself (for the cache key)? */
function readsGameState(effects: LayerEffect[]): boolean {
  return effects.some(
    (e) =>
      e.op.layer === 7 &&
      e.op.sublayer !== 'd' &&
      (isDynamicValue(e.op.power) || isDynamicValue(e.op.toughness)),
  );
}

/** Run the full layer pass over `perms` as the candidate set. */
function runLayers(
  ctx: GameContext,
  perms: EnginePermanent[],
): { map: Map<string, Characteristics>; usedGraveyards: boolean } {
  const work: WorkMap = new Map();
  for (const perm of perms) {
    const printed = ctx.defs.get(perm.oracleId);
    if (printed === undefined) throw new Error(`engine bug: no def for ${perm.name}`);
    const def = selectedPermanentDefinition(printed, perm.face);
    const landFace =
      perm.face === 'back'
        ? def.alternativeCasts?.find((alt) => alt.kind === 'mdfc')?.landFace
        : undefined;
    const transformFace = perm.transformed ? def.backFace : undefined;
    const activeFace = transformFace ?? landFace;
    let types = [...(activeFace?.types ?? def.types)];
    let subtypes = [...(activeFace?.subtypes ?? def.subtypes)];
    let supertypes = [...(activeFace?.supertypes ?? def.supertypes)];
    let colors = [...(activeFace?.colors ?? def.colors)];
    let power = transformFace?.power ?? perm.power ?? 0;
    let toughness = transformFace?.toughness ?? perm.toughness ?? 0;
    let keywords = landFace === undefined ? [...(transformFace?.keywords ?? def.keywords)] : [];
    let triggers = landFace === undefined ? [...(transformFace?.triggers ?? def.triggers)] : [];
    let manaAbilities = [...(activeFace?.manaAbilities ?? def.manaAbilities)];
    if (perm.faceDown === true) {
      supertypes = [];
      types = ['Creature'];
      subtypes = [];
      colors = [];
      power = 2;
      toughness = 2;
      keywords = [];
      triggers = [];
      manaAbilities = [];
    } else {
      if (perm.copyAddTypes !== undefined)
        for (const type of perm.copyAddTypes) if (!types.includes(type)) types.push(type);
      if (perm.copyAddKeywords !== undefined)
        for (const kw of perm.copyAddKeywords) if (!keywords.includes(kw)) keywords.push(kw);
      if (perm.copyRemoveSupertypes !== undefined && perm.copyRemoveSupertypes.length > 0) {
        const removed = perm.copyRemoveSupertypes;
        supertypes = supertypes.filter((st) => !removed.includes(st));
      }
      if (perm.copyAddSupertypes !== undefined)
        for (const st of perm.copyAddSupertypes) if (!supertypes.includes(st)) supertypes.push(st);
      if (perm.copyAddTriggers !== undefined) triggers = [...triggers, ...perm.copyAddTriggers];
      if (def.copyLastExiledCreature === true && (perm.exiledCardIds?.length ?? 0) > 0) {
        const lastId = perm.exiledCardIds?.[perm.exiledCardIds.length - 1];
        const exiled = ctx.state.exile.find((card) => card.cardId === lastId);
        const exiledDef = exiled === undefined ? undefined : ctx.defs.get(exiled.oracleId);
        if (exiledDef?.types.includes('Creature')) {
          subtypes = [...exiledDef.subtypes, 'Shapeshifter'];
          power = exiledDef.power ?? 0;
          toughness = exiledDef.toughness ?? 0;
        }
      }
    }
    work.set(perm.cardId, {
      perm,
      chars: {
        supertypes,
        types,
        subtypes,
        // Layer 5 is not implemented — printed color, read from here so it has one home.
        colors,
        keywords,
        ward:
          !perm.faceDown && landFace === undefined
            ? transformFace !== undefined
              ? (transformFace.ward ?? null)
              : (def.ward ?? null)
            : null,
        protectionFrom:
          !perm.faceDown && landFace === undefined
            ? [
                ...(transformFace !== undefined
                  ? (transformFace.protectionFrom ?? [])
                  : (def.protectionFrom ?? [])),
              ]
            : [],
        cantBeBlocked:
          !perm.faceDown &&
          landFace === undefined &&
          (transformFace !== undefined
            ? transformFace.cantBeBlocked === true
            : def.cantBeBlocked === true),
        activatedAbilities:
          !perm.faceDown && landFace === undefined
            ? [...(transformFace?.activatedAbilities ?? def.activatedAbilities)]
            : [],
        triggers,
        manaAbilities,
        // Base P/T comes from the permanent (a copy effect would set it there — layer 1).
        power,
        toughness,
        loseAbilities: false,
      },
    });
  }

  const effects = gatherEffects(ctx);
  // Trazyn-style abilities are sourced from graveyard contents even though their layer op
  // itself is static. Keep those card identities in the layer-cache digest so an artifact
  // entering or leaving the graveyard immediately changes the computed ability list.
  const usedGraveyards =
    readsGameState(effects) ||
    ctx.state.battlefield.some(
      (perm) => ctx.defs.get(perm.oracleId)?.artifactGraveyardAbilities === true,
    );
  const group = (key: string): LayerEffect[] => effects.filter((e) => groupOf(e.op) === key);

  applyGroup(ctx, work, group('4'));
  finishLayer4(ctx, work);
  applyGroup(ctx, work, group('5'));
  applyGroup(ctx, work, group('6'));
  applyGroup(ctx, work, group('7a'));
  applyGroup(ctx, work, group('7b'));
  for (const entry of work.values()) {
    entry.chars.basePower = entry.chars.power;
    entry.chars.baseToughness = entry.chars.toughness;
  }
  applyCounters(work); // 7c
  applyGroup(ctx, work, group('7d'), false);

  const out = new Map<string, Characteristics>();
  for (const [cardId, entry] of work) out.set(cardId, entry.chars);
  return { map: out, usedGraveyards };
}

/** Set `MTG_VERIFY_LAYER_CACHE=1` to recompute on every cache hit and assert they agree. */
const VERIFY_CACHE =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    'MTG_VERIFY_LAYER_CACHE'
  ] === '1';

/**
 * Serialize characteristics for the verification oracle with SET-LIKE fields order-normalized.
 *
 * `subtypes`, `keywords` and friends are sets that layer passes append to; two passes over the
 * same state can legitimately produce the same set in a different order (a land granted Forest
 * and Island by two effects is one example). Comparing raw `JSON.stringify` output reported
 * those as stale-cache bugs, which made the oracle too noisy to run as a gate.
 *
 * Only arrays of primitives are sorted. Arrays of objects — `manaAbilities`, `triggers`,
 * `activatedAbilities` — keep their order, because a genuine reordering there WOULD change
 * which ability an index refers to and is worth failing on.
 */
function canonicalJson(map: ReadonlyMap<string, Characteristics>): string {
  return JSON.stringify([...map.entries()], (_key, value: unknown) =>
    Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? [...(value as string[])].sort()
      : value,
  );
}

/**
 * Compute current characteristics for every permanent on the battlefield in one layered pass,
 * memoized on a digest of the state the pass reads (ADR 0007). `extra` includes a permanent
 * that has left (or not yet joined) the battlefield, so it can still be measured; it is a
 * candidate for continuous effects but contributes none.
 */
export function computeAllCharacteristics(
  ctx: GameContext,
  extra?: EnginePermanent,
): Map<string, Characteristics> {
  const extraCardId = extra?.cardId ?? null;
  const cached = getCached(ctx);
  // On the first pass nothing is known, so include graveyards; thereafter follow what the
  // last pass actually read.
  const includeGraveyards = cached?.usedGraveyards ?? true;
  const digest = digestOf(ctx, extra, includeGraveyards);

  if (cached !== undefined && cached.digest === digest && cached.extraCardId === extraCardId) {
    if (!VERIFY_CACHE) return cached.map;
    const fresh = runLayers(ctx, permsFor(ctx, extra));
    const a = canonicalJson(cached.map);
    const b = canonicalJson(fresh.map);
    if (a !== b) {
      throw new Error(
        `engine bug: stale layer cache — digest collided or an input is missing from it.\ncached: ${a}\nfresh:  ${b}`,
      );
    }
    return cached.map;
  }

  const { map, usedGraveyards } = runLayers(ctx, permsFor(ctx, extra));
  setCached(ctx, {
    // Re-digest with the flag this pass actually established, so the next comparison matches.
    digest: usedGraveyards === includeGraveyards ? digest : digestOf(ctx, extra, usedGraveyards),
    usedGraveyards,
    extraCardId,
    map,
  });
  return map;
}

function permsFor(ctx: GameContext, extra: EnginePermanent | undefined): EnginePermanent[] {
  const perms = [...ctx.state.battlefield];
  if (extra !== undefined && !perms.some((p) => p.cardId === extra.cardId)) perms.push(extra);
  return perms;
}

/**
 * Battlefield permanents matching `selector`, judged on their CURRENT characteristics — an
 * animated Mutavault is a creature here, and a land under Blood Moon is a Mountain.
 *
 * This is the "each" half of `Selector` (ADR 0005): a resolving spell uses it once to fix its
 * affected set (CR 611.2c), where a static ability's set is re-derived every layer pass.
 */
export function selectPermanents(
  ctx: GameContext,
  selector: Selector,
  source: SelectorSource,
): EnginePermanent[] {
  const all = computeAllCharacteristics(ctx);
  return ctx.state.battlefield.filter((perm) => {
    const chars = all.get(perm.cardId);
    return chars !== undefined && selectMatches(candidateOf(ctx, perm, chars), selector, source);
  });
}

/** Compute one permanent's current characteristics through the layer system. */
export function computeCharacteristics(ctx: GameContext, perm: EnginePermanent): Characteristics {
  // Only pass `extra` when the permanent is genuinely off the battlefield — otherwise every
  // query for a different permanent would be a distinct cache key and never hit.
  const onBattlefield = ctx.state.battlefield.some((p) => p.cardId === perm.cardId);
  const all = computeAllCharacteristics(ctx, onBattlefield ? undefined : perm);
  const chars = all.get(perm.cardId);
  if (chars === undefined) throw new Error(`engine bug: no characteristics for ${perm.name}`);
  return chars;
}

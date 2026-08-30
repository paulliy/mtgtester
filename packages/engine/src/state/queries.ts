/**
 * Read-only state queries: definitions, effective characteristics (computed through the CR
 * 613 layer engine — see `effects/continuous.ts`), players in the game, and mana sources.
 */

import type { Color, ObjectId, OracleId, PlayerId } from '@mtg/shared';
import type { ManaRestriction, PaymentPurpose } from '../cards/ability';
import type {
  Ability,
  AbilityCost,
  CardDefinition,
  KeywordAbility,
  ManaAbilitySpec,
} from '../cards/definition';
import { TAP_COST } from '../cards/definition';
import type { RuleStatic } from '../cards/rule-statics';
import { evaluateCondition } from '../cards/condition';
import { evaluateValue } from '../cards/value';
import type { Selector, SelectorCandidate, SelectorSource } from '../cards/selector';
import { selectMatches } from '../cards/selector';
import { computeCharacteristics, matchesSelector } from '../effects/continuous';
import { UnmodeledCardError } from '../errors';
import type { ManaAllowance, ManaSource, ManaUnit, ParsedManaCost } from '../mana/cost';
import type {
  EngineCardObject,
  EngineObject,
  EnginePermanent,
  EnginePlayerState,
  GameContext,
} from './types';
import { spellManaValue } from './objects';

export function getDefByOracleId(
  ctx: GameContext,
  oracleId: OracleId,
  nameForError: string,
): CardDefinition {
  const def = ctx.defs.get(oracleId);
  if (def === undefined) {
    throw new Error(`engine bug: no CardDefinition for ${nameForError} (${oracleId})`);
  }
  return def;
}

/**
 * A representative Scryfall printing id for image lookup; null for cards with none (tokens).
 * The one lookup every image-carrying projection (`view/spectator.ts`, `present.ts`) must share
 * — a second copy of this line is how the board and a decision panel would end up disagreeing
 * on what a card looks like.
 */
export function scryfallIdOf(ctx: GameContext, oracleId: OracleId): string | null {
  return ctx.defs.get(oracleId)?.scryfallId ?? null;
}

/** Halt loudly when a card whose behavior is needed is not modeled (brief §6.3). */
export function requireModeled(def: CardDefinition, situation: string): void {
  if (!def.modeled) {
    throw new UnmodeledCardError(def.name, def.unmodeledReasons, situation);
  }
}

export function findPermanent(ctx: GameContext, id: ObjectId): EnginePermanent | undefined {
  return ctx.state.battlefield.find((p) => p.id === id);
}

/** Current card types include Creature after the layer system (Mutavault, etc.). */
export function isCreaturePermanent(ctx: GameContext, perm: EnginePermanent): boolean {
  return computeCharacteristics(ctx, perm).types.includes('Creature');
}

/** Effective power/toughness through the CR 613 layer engine. */
export function effectivePT(
  ctx: GameContext,
  perm: EnginePermanent,
): { power: number; toughness: number } {
  const c = computeCharacteristics(ctx, perm);
  return { power: c.power, toughness: c.toughness };
}

/**
 * Triggered abilities the permanent currently has, through the layer system. Reading these
 * from the `CardDefinition` instead would mean a permanent that lost its abilities still
 * triggered, and a granted trigger could never fire (ADR 0007).
 */
export function triggersOf(ctx: GameContext, perm: EnginePermanent): Ability[] {
  return computeCharacteristics(ctx, perm).triggers;
}

/** Effective keywords through the CR 613 layer engine (grants in layer 6). */
export function hasKeyword(ctx: GameContext, perm: EnginePermanent, kw: KeywordAbility): boolean {
  return computeCharacteristics(ctx, perm).keywords.includes(kw);
}

/** Effective ward cost (CR 702.21), or null. */
export function wardCostOf(ctx: GameContext, perm: EnginePermanent): ParsedManaCost | null {
  return computeCharacteristics(ctx, perm).ward;
}

/**
 * Protection (CR 702.16): does `perm` have protection from `source`'s colors?
 *
 * One predicate for all four consequences (DEBT — can't be Damaged, Enchanted/Equipped, Blocked
 * or Targeted), so a new consequence cannot be added on one path and forgotten on another.
 */
export function hasProtectionFrom(
  ctx: GameContext,
  perm: EnginePermanent,
  colors: readonly Color[],
): boolean {
  const from = computeCharacteristics(ctx, perm).protectionFrom;
  return colors.some((c) => from.includes(c));
}

/** The current colors of a permanent, through the layer engine. */
export function colorsOf(ctx: GameContext, perm: EnginePermanent): Color[] {
  return computeCharacteristics(ctx, perm).colors;
}

/** Players still in the game, in turn order starting from the active player (APNAP). */
export function playersInApnapOrder(ctx: GameContext): EnginePlayerState[] {
  const s = ctx.state;
  const order: EnginePlayerState[] = [];
  for (let i = 0; i < s.turnOrder.length; i++) {
    const id = s.turnOrder[(s.activePlayerIndex + i) % s.turnOrder.length] as PlayerId;
    const p = s.players.find((pl) => pl.id === id);
    if (p !== undefined && !p.hasLost) order.push(p);
  }
  return order;
}

export function activePlayer(ctx: GameContext): EnginePlayerState {
  const id = ctx.state.turnOrder[ctx.state.activePlayerIndex] as PlayerId;
  const p = ctx.state.players.find((pl) => pl.id === id);
  if (p === undefined) throw new Error('engine bug: active player not found');
  return p;
}

export function opponentsOf(ctx: GameContext, playerId: PlayerId): EnginePlayerState[] {
  return playersInApnapOrder(ctx).filter((p) => p.id !== playerId);
}

export function controlledPermanents(ctx: GameContext, playerId: PlayerId): EnginePermanent[] {
  return ctx.state.battlefield.filter((p) => p.controllerId === playerId);
}

/**
 * The candidate a selector is matched against for a card that is NOT on the battlefield — a
 * library, graveyard, or hand card. Reads the PRINTED definition: nothing continuous applies
 * outside the battlefield, so there is nothing to layer. `self`/`other` are meaningless here.
 *
 * Shared by every zone-qualified target and search (`searchLibrary`, `lookAtTopN`,
 * `graveyardTargets`, `handToBattlefield`) so this projection has exactly one implementation.
 */
export function cardZoneCandidate(
  ctx: GameContext,
  card: EngineCardObject,
  ownerId: PlayerId,
): SelectorCandidate {
  const def = getDefByOracleId(ctx, card.oracleId, card.name);
  return {
    cardId: card.cardId,
    controllerId: ownerId,
    types: def.types,
    supertypes: def.supertypes,
    subtypes: def.subtypes,
    colors: def.colors,
    power: def.power ?? 0,
    keywords: def.keywords,
    manaValue: spellManaValue(def, undefined),
    // A card off the battlefield is never a token: tokens cease to exist on leaving it
    // (CR 704.5d), so nothing this function is handed can be one.
    isToken: false,
    // Not a permanent at all — "entered this turn" is meaningless here.
    enteredThisTurn: false,
    isCommander: card.isCommander,
  };
}

/**
 * Does a CR 106.6 restriction permit paying for `purpose`?
 *
 * The engine-state half of restricted mana; the payment solver takes the resulting boolean and
 * never learns what the restriction said (see `mana/cost.ts::ManaAllowance`). A purpose the
 * restriction does not list fails closed, which is what makes `{kind:'other'}` — a ward tax, the
 * companion {3} — unpayable with "spend only to cast a Dragon spell" mana.
 */
export function manaRestrictionAllows(
  ctx: GameContext,
  restriction: ManaRestriction,
  purpose: PaymentPurpose,
  /** Whose "your commander" this is — the player making the payment. */
  playerId: PlayerId,
): boolean {
  if (purpose.kind === 'other') return false;
  if (!restriction.purposes.includes(purpose.kind)) return false;

  const oracleId = (
    purpose.kind === 'castSpell' ? purpose.oracleId : purpose.sourceOracleId
  ) as OracleId;
  const def = ctx.defs.get(oracleId);
  if (def === undefined) return false;

  // Matched on PRINTED characteristics: a spell is on the stack and an ability's source is
  // named by oracle id, so in neither case is there a layered permanent to read.
  const candidate: SelectorCandidate = {
    cardId: '',
    controllerId: '',
    types: def.types,
    supertypes: def.supertypes,
    subtypes: def.subtypes,
    colors: def.colors,
    power: def.power ?? 0,
    keywords: def.keywords,
    isToken: false,
    enteredThisTurn: false,
  };
  const source: SelectorSource = { cardId: '', controllerId: '' };
  if (restriction.filter !== undefined && !selectMatches(candidate, restriction.filter, source)) {
    return false;
  }
  if (restriction.sharesCreatureTypeWithCommander === true) {
    // Path of Ancestry. Read from the commander's PRINTED subtypes for the same reason: it may
    // be sitting in the command zone, where no continuous effect reaches it.
    const owner = ctx.state.players.find((p) => p.id === playerId);
    if (owner === undefined) return false;
    const commanderTypes = new Set<string>();
    for (const cardId of owner.commanderCardIds) {
      const commander = findObjectByCardId(ctx, cardId);
      if (commander === undefined) continue;
      for (const t of ctx.defs.get(commander.oracleId)?.subtypes ?? []) commanderTypes.add(t);
    }
    if (!def.subtypes.some((t) => commanderTypes.has(t))) return false;
  }
  return true;
}

/**
 * The `ManaAllowance` closure for one payment: binds the deciding context and player so the
 * payment solver can ask about a restriction without knowing what restrictions mean.
 *
 * Used by `computePriorityOptions` to decide affordability and by `payManaCost` to make the
 * payment. Both must use the SAME purpose for the same action, or the engine offers a cast it
 * then cannot pay for — the option-menu contract in `actions/legal.ts`.
 */
export function allowanceFor(
  ctx: GameContext,
  playerId: PlayerId,
  purpose: PaymentPurpose,
): ManaAllowance {
  return (restriction) => manaRestrictionAllows(ctx, restriction, purpose, playerId);
}

/**
 * Cards in `casterId`'s own graveyard matching a `cardInGraveyard` target's filter.
 *
 * Shared by `computeTargetOptions` (`actions/legal.ts`) and `isTargetStillLegal`
 * (`effects/resolve.ts`) so the kind cannot be read by one and not the other — see the
 * `TargetKind` doc for why drift here is exactly the class of bug this guards against.
 */
export function graveyardTargets(
  ctx: GameContext,
  casterId: PlayerId,
  filter: Selector | undefined,
): EngineCardObject[] {
  const owner = ctx.state.players.find((p) => p.id === casterId);
  if (owner === undefined) return [];
  if (filter === undefined) return owner.graveyard;
  const source: SelectorSource = { cardId: '', controllerId: casterId };
  return owner.graveyard.filter((card) =>
    selectMatches(cardZoneCandidate(ctx, card, casterId), filter, source),
  );
}

/** Any object with this stable `cardId`, in whatever zone it currently occupies. */
export function findObjectByCardId(ctx: GameContext, cardId: string): EngineObject | undefined {
  const s = ctx.state;
  const zones: EngineObject[][] = [s.battlefield, s.exile];
  for (const player of s.players) {
    zones.push(player.hand, player.library, player.graveyard, player.commandZone);
  }
  for (const zone of zones) {
    const found = zone.find((o) => o.cardId === cardId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The only `EnginePermanent` fields `resolveDynamicUnits`/`resolveConditionalUnits` actually
 * read. Widened from `EnginePermanent` so a card still in hand — which has no permanent yet —
 * can be previewed with a lightweight stub (`previewLandManaSymbols`) instead of needing a
 * fabricated battlefield object. Every real `EnginePermanent` already satisfies this shape, so
 * existing call sites are unaffected.
 */
export type ManaAbilityContext = Pick<EnginePermanent, 'id' | 'cardId' | 'controllerId'> &
  Partial<Pick<EnginePermanent, 'chosenOption'>>;

/**
 * Derive the symbols of a state-dependent mana ability (`ManaAbilitySpec.dynamic`).
 *
 * Returned as a spec with concrete `units` so everything downstream — the payment solver's
 * per-unit backtracking most of all — sees an ordinary multi-choice source and needs no
 * knowledge that the symbols were computed.
 */
export function resolveDynamicUnits(
  ctx: GameContext,
  spec: ManaAbilitySpec,
  perm: ManaAbilityContext,
  visited: Set<ObjectId> = new Set(),
): ManaAbilitySpec {
  if (spec.dynamic === undefined) return spec;
  if (visited.has(perm.id)) return { ...spec, units: [] };

  visited.add(perm.id);

  const symbols: (Color | 'C')[] = [];
  const add = (sym: Color | 'C'): void => {
    if (!symbols.includes(sym)) symbols.push(sym);
  };

  if (spec.dynamic === 'commanderIdentity') {
    // CR 903.4 identity of the controller's commander(s), wherever they currently are — the
    // ability reads the commander's identity, not its presence. A colorless identity yields
    // no symbols, which correctly makes the source produce nothing.
    const owner = ctx.state.players.find((p) => p.id === perm.controllerId);
    for (const cardId of owner?.commanderCardIds ?? []) {
      const commander = findObjectByCardId(ctx, cardId);
      if (commander === undefined) continue;
      const def = ctx.defs.get(commander.oracleId);
      for (const color of def?.colorIdentity ?? []) add(color);
    }
  } else if (spec.dynamic === 'chosenColor') {
    // A modal DFC land's ETB face choice (`entersChoosingOption`), stored as the color's letter.
    // Undefined for a card still in hand (previewed before it has entered, so it hasn't chosen
    // yet) — correctly produces nothing rather than guessing.
    const chosen = perm.chosenOption;
    if (chosen === 'W' || chosen === 'U' || chosen === 'B' || chosen === 'R' || chosen === 'G') {
      add(chosen);
    }
  } else {
    // "any color that a land an opponent controls could produce" — union over opponents'
    // lands, read through the layer engine so a Blood Moon'd land contributes {R}.
    for (const opponent of opponentsOf(ctx, perm.controllerId)) {
      for (const land of controlledPermanents(ctx, opponent.id)) {
        const chars = computeCharacteristics(ctx, land);
        if (!chars.types.includes('Land')) continue;
        for (const ability of chars.manaAbilities) {
          for (const unit of resolveDynamicUnits(ctx, ability, land, visited).units) {
            for (const sym of unit) if (sym !== 'C') add(sym);
          }
        }
      }
    }
  }

  return { ...spec, units: symbols.length > 0 ? [symbols] : [] };
}

/**
 * "If you control a creature with power 4 or greater, add two mana of any one color INSTEAD"
 * (Ilysian Caryatid) — a conditional AMOUNT, distinct from `condition` (which gates whether the
 * ability is offered at all). When the condition holds, `units`/`linked` are REPLACED, not
 * unioned: the base production is not also on offer, matching "instead".
 */
export function resolveConditionalUnits(
  ctx: GameContext,
  spec: ManaAbilitySpec,
  perm: ManaAbilityContext,
): ManaAbilitySpec {
  if (spec.conditionalUnits === undefined) return spec;
  const { condition, units, linked } = spec.conditionalUnits;
  const holds = evaluateCondition(ctx, condition, {
    cardId: perm.cardId,
    controllerId: perm.controllerId,
  });
  if (!holds) return spec;
  const { conditionalUnits, ...rest } = spec;
  void conditionalUnits;
  return { ...rest, units, ...(linked === true ? { linked: true } : {}) };
}

/**
 * Can this permanent pay the NON-mana components of an activation cost right now?
 *
 * The `mana` component is deliberately excluded and always answers true: deciding it needs the
 * pool and the full source list, which is the caller's job (`canPay`). Folding it in here would
 * make mana-source enumeration recursive.
 */
export function canPayNonManaCosts(
  ctx: GameContext,
  perm: EnginePermanent,
  costs: readonly AbilityCost[],
  announcedX?: number,
): boolean {
  for (const cost of costs) {
    switch (cost.kind) {
      case 'tap':
        if (perm.tapped) return false;
        // CR 302.6 — summoning sickness blocks {T} costs on creatures, nothing else.
        if (
          computeCharacteristics(ctx, perm).types.includes('Creature') &&
          perm.summoningSick &&
          !hasKeyword(ctx, perm, 'haste')
        ) {
          return false;
        }
        break;
      case 'sacrificeSelf':
        break;
      case 'exileSelf':
        break;
      case 'unattachSelf':
        if (perm.attachedTo === null) return false;
        break;
      case 'sacrificeOther': {
        const count = cost.count ?? 1;
        const payable = ctx.state.battlefield.filter((candidate) =>
          candidate.id !== perm.id && candidate.controllerId === perm.controllerId &&
          matchesSelector(ctx, candidate, cost.selector, { cardId: perm.cardId, controllerId: perm.controllerId }),
        );
        if (payable.length < count) return false;
        break;
      }
      case 'tapOther': {
        const payable = ctx.state.battlefield.some((candidate) =>
          candidate.id !== perm.id && candidate.controllerId === perm.controllerId && !candidate.tapped &&
          matchesSelector(ctx, candidate, cost.selector, { cardId: perm.cardId, controllerId: perm.controllerId }),
        );
        if (!payable) return false;
        break;
      }
      case 'tapOthers': {
        const payable = ctx.state.battlefield.filter((candidate) =>
          candidate.id !== perm.id && candidate.controllerId === perm.controllerId && !candidate.tapped &&
          matchesSelector(ctx, candidate, cost.selector, { cardId: perm.cardId, controllerId: perm.controllerId }),
        );
        if (payable.length < cost.count) return false;
        break;
      }
      case 'tapXOthers': {
        // The first pass happens before X is announced; the per-X pass below supplies it.
        if (announcedX === undefined) break;
        const payable = ctx.state.battlefield.filter((candidate) =>
          candidate.id !== perm.id && candidate.controllerId === perm.controllerId && !candidate.tapped &&
          matchesSelector(ctx, candidate, cost.selector, { cardId: perm.cardId, controllerId: perm.controllerId }),
        );
        if (payable.length < announcedX) return false;
        break;
      }
      case 'removeCounters': {
        const count = typeof cost.count === 'number' ? cost.count : evaluateValue(ctx, cost.count);
        if ((perm.counters[cost.counter] ?? 0) < count) return false;
        break;
      }
      case 'payLife': {
        // CR 118.8: a player may pay life only down to 0, never into a negative total.
        const controller = ctx.state.players.find((p) => p.id === perm.controllerId);
        if (controller === undefined || controller.life < cost.amount) return false;
        break;
      }
      case 'payEnergy': {
        const controller = ctx.state.players.find((p) => p.id === perm.controllerId);
        if (controller === undefined || controller.energy < cost.amount) return false;
        break;
      }
      case 'loyalty':
        if (cost.delta < 0 && (perm.counters['loyalty'] ?? 0) < Math.abs(cost.delta)) return false;
        break;
      case 'tapCreaturesTotalPower': {
        const available = ctx.state.battlefield.filter((candidate) =>
          candidate.id !== perm.id && candidate.controllerId === perm.controllerId && !candidate.tapped &&
          isCreaturePermanent(ctx, candidate),
        );
        const totalPower = available.reduce((sum, candidate) => sum + effectivePT(ctx, candidate).power, 0);
        if (totalPower < cost.minPower) return false;
        break;
      }
      case 'discardCard': {
        const controller = ctx.state.players.find((p) => p.id === perm.controllerId);
        if (controller === undefined || controller.hand.length < (cost.count ?? 1)) return false;
        break;
      }
      case 'mana':
        break;
    }
  }
  return true;
}

/**
 * A stable key grouping mana abilities whose PRODUCTION is interchangeable: same activation
 * cost, same CR 106.6 restriction, same spend trigger, same persistence. Two abilities in one
 * group differ only in which symbols they make.
 */
function interchangeableSignature(ability: ManaAbilitySpec): string {
  return JSON.stringify([
    ability.costs ?? TAP_COST,
    ability.restriction ?? null,
    ability.spendTrigger ?? null,
    ability.persistent ?? false,
    ability.linked ?? false,
  ]);
}

/**
 * Untapped mana sources `playerId` could activate right now. A creature's {T} mana
 * ability is unavailable while summoning-sick without haste (CR 302.6).
 *
 * Two levels of structure, and the distinction between them is load-bearing:
 *
 * - **Collapsed.** Mana abilities that are interchangeable — same cost, same restriction, same
 *   rider, one mana each — become ONE source whose single unit offers every symbol as a choice.
 *   A dual-typed land, or a basic given a second type by Urborg, is exactly this: the permanent
 *   can only be tapped once, so N one-mana abilities are indistinguishable from one mana chosen
 *   among their symbols, and `planPayment`'s per-unit backtracking already solves that.
 * - **Alternatives.** Everything else is emitted as several sources SHARING the permanent's
 *   `cardId`, and `planPayment` taps at most one of them. Haven of the Spirit Dragon's plain
 *   {C} and its Dragons-only any-color are not interchangeable — collapsing them would let the
 *   restricted mana pay for anything — and neither are two abilities with different costs or
 *   different amounts.
 *
 * Alternatives replace what used to be two `UnmodeledCardError` halts here (different costs,
 * different amounts). Those halts were correct while the solver could only see one source per
 * permanent; they were never a statement that the CARD was unmodelable, and Sachi, Daughter of
 * Seshiro granting "{T}: Add {G}{G}" to a Shaman that already taps for any color used to halt a
 * real pool game on exactly that.
 */
export function manaSourcesFor(ctx: GameContext, playerId: PlayerId): ManaSource[] {
  const sources: ManaSource[] = [];
  const permanents = controlledPermanents(ctx, playerId)
    .map((perm, index) => ({ perm, index, chars: computeCharacteristics(ctx, perm) }))
    .sort((a, b) => {
      // Preserve creatures for combat whenever a land or noncreature source can do the job.
      // Equal-priority permanents retain battlefield order, preserving determinism.
      const priority = (types: readonly string[]): number =>
        types.includes('Land') ? 0 : types.includes('Creature') ? 2 : 1;
      return priority(a.chars.types) - priority(b.chars.types) || a.index - b.index;
    });
  for (const { perm, chars } of permanents) {
    // Mana abilities are computed, not printed: a layer-4 subtype change replaces them
    // (Blood Moon → a Mountain that taps for R), layer 6 can remove them outright, and layer 6
    // can also GRANT them (Chromatic Lantern).
    const abilities = chars.manaAbilities
      // "Activate only if you control a Dragon" — an unavailable source is not a source.
      .filter(
        (a) =>
          a.condition === undefined ||
          evaluateCondition(ctx, a.condition, {
            cardId: perm.cardId,
            controllerId: perm.controllerId,
          }),
      )
      .map((a) => resolveConditionalUnits(ctx, a, perm))
      .map((a) => resolveDynamicUnits(ctx, a, perm))
      // A dynamic source can resolve to nothing at all — Fellwar Stone with no opposing
      // lands taps for no mana, so it must not be offered as a payment source.
      .filter((a) => a.units.length > 0)
      // Not every mana ability costs {T}: "Sacrifice this creature: Add {R}{R}" is available
      // from a tapped, summoning-sick creature. Availability is per ability, not per permanent.
      .filter((a) => canPayNonManaCosts(ctx, perm, a.costs ?? TAP_COST));
    if (abilities.length === 0) continue;

    // Group interchangeable abilities, preserving first-seen order for determinism.
    const groups = new Map<string, ManaAbilitySpec[]>();
    for (const ability of abilities) {
      const key = interchangeableSignature(ability);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [ability]);
      else group.push(ability);
    }

    for (const group of groups.values()) {
      const first = group[0] as ManaAbilitySpec;
      const rider = {
        costs: first.costs ?? TAP_COST,
        ...(first.restriction !== undefined ? { restriction: first.restriction } : {}),
        ...(first.spendTrigger !== undefined ? { spendTrigger: first.spendTrigger } : {}),
        ...(first.persistent === true ? { persistent: true } : {}),
        ...(first.linked === true ? { linked: true as const } : {}),
      };
      // Collapse only when every member makes exactly one mana; otherwise the members differ in
      // AMOUNT, which is a real choice and belongs to the alternatives path below.
      if (group.length > 1 && group.every((a) => a.units.length === 1)) {
        const symbols: (Color | 'C')[] = [];
        for (const ability of group) {
          for (const symbol of ability.units[0] as ManaUnit) {
            if (!symbols.includes(symbol)) symbols.push(symbol);
          }
        }
        sources.push({ cardId: perm.cardId, units: [symbols], ...rider });
        continue;
      }
      for (const ability of group) {
        sources.push({ cardId: perm.cardId, units: ability.units, ...rider });
      }
    }
  }
  return sources;
}

/** Best-effort preview of mana symbols produced by a set of mana abilities. */
export function previewManaAbilities(
  ctx: GameContext,
  abilities: readonly ManaAbilitySpec[],
  playerId: PlayerId,
  sourceKey = 'preview',
): (Color | 'C')[] {
  const stub: ManaAbilityContext = {
    id: `${sourceKey}-${playerId}` as ObjectId,
    cardId: `${sourceKey}-${playerId}`,
    controllerId: playerId,
  };
  const symbols: (Color | 'C')[] = [];
  const add = (sym: Color | 'C'): void => {
    if (!symbols.includes(sym)) symbols.push(sym);
  };
  for (const ability of abilities) {
    if (
      ability.condition !== undefined &&
      !evaluateCondition(ctx, ability.condition, { cardId: stub.cardId, controllerId: playerId })
    ) continue;
    const resolved = resolveDynamicUnits(ctx, resolveConditionalUnits(ctx, ability, stub), stub);
    for (const unit of resolved.units) for (const sym of unit) add(sym);
  }
  return symbols;
}

/** Best-effort preview of what a land card WOULD produce if played right now. */
export function previewLandManaSymbols(
  ctx: GameContext,
  def: CardDefinition,
  playerId: PlayerId,
): (Color | 'C')[] {
  return previewManaAbilities(ctx, def.manaAbilities, playerId, `preview-${def.oracleId}`);
}
/** One card's `RuleStatic` plus who contributes it, for `gatherRuleStatics`. */
export interface RuleStaticEntry {
  static: RuleStatic;
  sourceCardId: string;
  sourceOracleId: OracleId;
  controllerId: PlayerId;
}

/**
 * Every active rule-modifying static in the game right now (`RuleStatic` — cost reduction,
 * "can't be countered", "can't cast spells", casting from a non-hand zone; see `rule-statics.ts`).
 *
 * Battlefield permanents always contribute theirs. A card in a COMMAND ZONE contributes only a
 * cost reduction marked `alsoFromCommandZone` (Eminence, CR 702.114) — the one shape any printed
 * Eminence card in this pool uses; a card can never be in both zones at once, so this never
 * double-counts a permanent that is also on the battlefield.
 */
export function gatherRuleStatics(ctx: GameContext): RuleStaticEntry[] {
  const out: RuleStaticEntry[] = [];
  for (const perm of ctx.state.battlefield) {
    const def = ctx.defs.get(perm.oracleId);
    if (def === undefined) continue;
    for (const rs of def.ruleStatics) {
      if (rs.kind === 'costReduction' && rs.selfOnly === true) continue;
      out.push({
        static: rs,
        sourceCardId: perm.cardId,
        sourceOracleId: perm.oracleId,
        controllerId: perm.controllerId,
      });
    }
  }
  for (const player of ctx.state.players) {
    for (const obj of player.commandZone) {
      const def = ctx.defs.get(obj.oracleId);
      if (def === undefined) continue;
      for (const rs of def.ruleStatics) {
        if (rs.kind === 'costReduction' && rs.alsoFromCommandZone === true) {
          out.push({
            static: rs,
            sourceCardId: obj.cardId,
            sourceOracleId: obj.oracleId,
            controllerId: obj.ownerId,
          });
        }
      }
    }
  }
  return out;
}

/** Does this player currently have no maximum hand size? */
export function hasNoMaximumHandSize(ctx: GameContext, playerId: PlayerId): boolean {
  return gatherRuleStatics(ctx).some(
    (entry) => entry.static.kind === 'noMaximumHandSize' && entry.controllerId === playerId,
  );
}
/** Does an active `cantCastSpells` rule static currently forbid `playerId` from casting? */
export function castingSpellsBlockedFor(ctx: GameContext, playerId: PlayerId): boolean {
  return gatherRuleStatics(ctx).some((entry) => {
    if (entry.static.kind !== 'cantCastSpells') return false;
    // "Your OPPONENTS can't cast spells" — the source's own controller is never blocked by it.
    if (entry.controllerId === playerId) return false;
    return entry.static.yourTurnOnly !== true || ctx.state.currentTurnPlayer === entry.controllerId;
  });
}

/**
 * Does an active `cantBeCountered` rule static protect a spell (printed as `spellOracleId`, cast
 * by `casterId`) right now? Distinct from `Ability.cantBeCountered`, which is fixed at cast time
 * (Last March of the Ents) — this is re-checked at the moment of countering (CR 611.2), since the
 * source (Rhythm of the Wild) could have left the battlefield since the spell was cast.
 */
export function spellProtectedFromCounter(
  ctx: GameContext,
  casterId: PlayerId,
  spellOracleId: OracleId,
): boolean {
  const def = getDefByOracleId(ctx, spellOracleId, spellOracleId);
  const candidate: SelectorCandidate = {
    cardId: '',
    controllerId: casterId,
    types: def.types,
    supertypes: def.supertypes,
    subtypes: def.subtypes,
    colors: def.colors,
    power: def.power ?? 0,
    keywords: def.keywords,
    isToken: false,
    enteredThisTurn: false,
  };
  const source: SelectorSource = { cardId: '', controllerId: casterId };
  return gatherRuleStatics(ctx).some((entry) => {
    if (entry.static.kind !== 'cantBeCountered') return false;
    // Only the CASTER's own such statics apply — every printed template here reads "you control".
    if (entry.controllerId !== casterId) return false;
    return (
      entry.static.filter === undefined ||
      selectMatches(candidate, entry.static.filter, source)
    );
  });
}

/**
 * Cards `playerId` may cast from the top of their library right now (Korlessa, Scale Singer).
 * Always at most one card — the printed template names the top card specifically, never "a card
 * in your library".
 */
export function castFromLibraryTopCandidates(
  ctx: GameContext,
  playerId: PlayerId,
): EngineCardObject[] {
  const player = ctx.state.players.find((p) => p.id === playerId);
  const top = player?.library[0];
  if (player === undefined || top === undefined) return [];
  const candidate = cardZoneCandidate(ctx, top, playerId);
  const source: SelectorSource = { cardId: '', controllerId: playerId };
  const eligible = gatherRuleStatics(ctx).some((entry) => {
    if (entry.static.kind !== 'castFromZone' || entry.static.zone !== 'libraryTop') return false;
    if (entry.controllerId !== playerId) return false;
    return (
      entry.static.filter === undefined ||
      selectMatches(candidate, entry.static.filter, source)
    );
  });
  return eligible ? [top] : [];
}

/**
 * The damage multiplier in effect for damage about to be dealt BY `sourceCardId` (Neriv, Heart
 * of the Storm — CR 616 replacement, not a layer op). Multiplicative across every matching
 * `damageDoubled` static: two such statics double twice, matching CR 616.1's "apply both" for
 * independent replacement effects.
 *
 * Returns 1 (and does nothing) when the source has already left the battlefield — a replacement
 * effect is a property of the event as it's about to happen, and there is nothing left here to
 * read "entered this turn" from.
 */
export function damageMultiplierFor(ctx: GameContext, sourceCardId: string): number {
  const sourcePerm = ctx.state.battlefield.find((p) => p.cardId === sourceCardId);
  if (sourcePerm === undefined) return 1;
  let multiplier = 1;
  for (const entry of gatherRuleStatics(ctx)) {
    if (entry.static.kind !== 'damageDoubled') continue;
    const from: SelectorSource = { cardId: entry.sourceCardId, controllerId: entry.controllerId };
    if (matchesSelector(ctx, sourcePerm, entry.static.sourceFilter, from)) multiplier *= 2;
  }
  return multiplier;
}

/** Apply every active target-aware damage replacement to one damage event. */
export function damageAmountAfterReplacements(
  ctx: GameContext,
  sourceCardId: string,
  targetControllerId: PlayerId,
  amount: number,
): number {
  const sourcePerm = ctx.state.battlefield.find((p) => p.cardId === sourceCardId);
  for (const entry of gatherRuleStatics(ctx)) {
    if (entry.static.kind === 'damageDoubled') {
      if (sourcePerm === undefined) continue;
      const from: SelectorSource = { cardId: entry.sourceCardId, controllerId: entry.controllerId };
      if (matchesSelector(ctx, sourcePerm, entry.static.sourceFilter, from)) amount *= 2;
    } else if (entry.static.kind === 'damageDoubledToOpponents') {
      if (targetControllerId !== entry.controllerId) amount *= 2;
    } else if (entry.static.kind === 'damageHalvedToYou') {
      if (targetControllerId === entry.controllerId) amount = Math.floor(amount / 2);
    }
  }
  return amount;
}

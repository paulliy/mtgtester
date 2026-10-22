import { playerLifeLocked } from './phasing';
import { counterCount } from './counters';
import { assertNever } from '../utils/assert-never';
import { assertManaRiders } from '../cards/mana-riders';
import { activationInvariantProduction } from '../cards/mana-production';
/**
 * Read-only state queries: definitions, effective characteristics (computed through the CR
 * 613 layer engine — see `effects/continuous.ts`), players in the game, and mana sources.
 */

import type { Color, ObjectId, OracleId, PlayerId } from '@mtg/shared';
import type { ManaRestriction, PaymentPurpose, WardCost } from '../cards/ability';
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
import {
  candidateOf,
  computeCharacteristics,
  matchesSelector,
  selectPermanents,
} from '../effects/continuous';
import { UnmodeledCardError } from '../errors';
import type { ManaAllowance, ManaSource, ManaUnit, ParsedManaCost } from '../mana/cost';
import { manaCostComponent } from '../mana/cost';
import type {
  DamageKeyword,
  EngineCardObject,
  EngineObject,
  EnginePermanent,
  EnginePlayerState,
  EngineStackObject,
  GameContext,
} from './types';
import { spellManaValue } from './objects';
import { selectedPermanentDefinition } from '../cards/spell-faces';

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

/**
 * The planeswalker this attacker is attacking, or null when it attacks the player or attacks
 * nothing. CR 506.4: an attacked planeswalker is removed from combat when it leaves the
 * battlefield, changes controller (away from the defending player), or stops being a planeswalker;
 * that is recorded on the attacker (sticky), so a planeswalker that comes back is not attacked
 * again. The creature stays an attacking creature either way (CR 506.4c).
 */
export function attackedPlaneswalker(
  ctx: GameContext,
  perm: EnginePermanent,
): EnginePermanent | null {
  if (perm.attackingPlaneswalker === null || perm.attackedPlaneswalkerRemoved) return null;
  const walker = findPermanent(ctx, perm.attackingPlaneswalker);
  if (
    walker === undefined ||
    walker.controllerId !== perm.attacking ||
    !computeCharacteristics(ctx, walker).types.includes('Planeswalker')
  ) {
    perm.attackedPlaneswalkerRemoved = true;
    return null;
  }
  return walker;
}

/** Is this creature attacking `playerId` itself, not a planeswalker that player controls? */
export function isAttackingPlayer(perm: EnginePermanent, playerId: PlayerId): boolean {
  return perm.attacking === playerId && perm.attackingPlaneswalker === null;
}

/**
 * Is this creature attacking `playerId` or a planeswalker `playerId` controls ("attacking you
 * and/or planeswalkers you control")? One whose planeswalker was removed from combat attacks
 * neither (CR 506.4c).
 */
export function isAttackingPlayerOrTheirPlaneswalker(
  ctx: GameContext,
  perm: EnginePermanent,
  playerId: PlayerId,
): boolean {
  if (perm.attacking !== playerId) return false;
  return perm.attackingPlaneswalker === null || attackedPlaneswalker(ctx, perm) !== null;
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
/** The damage keywords a permanent has now, for last known information on the stack. */
export function damageKeywordsOf(ctx: GameContext, perm: EnginePermanent): DamageKeyword[] {
  return (['deathtouch', 'lifelink', 'infect'] as const).filter((kw) => hasKeyword(ctx, perm, kw));
}

export function hasKeyword(ctx: GameContext, perm: EnginePermanent, kw: KeywordAbility): boolean {
  return computeCharacteristics(ctx, perm).keywords.includes(kw);
}

/** Effective ward cost (CR 702.21), or null. */
export function wardCostOf(ctx: GameContext, perm: EnginePermanent): WardCost | null {
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

/** Selected printed characteristics of a stack spell, including copies. */
export function spellDefinitionOf(ctx: GameContext, entry: EngineStackObject): CardDefinition {
  return entry.spellDefinition ?? getDefByOracleId(ctx, entry.sourceOracleId, entry.description);
}

/**
 * The colors of whatever a spell or ability comes from, for protection (CR 702.16): a source
 * still on the battlefield has its current colors; anything else (a spell on the stack, a card in
 * hand activating channel/cycling, a source that has since left) uses its printed colors as last
 * known information. Emblems and other cardless sources have no definition and are colorless.
 */
export function sourceColorsOf(
  ctx: GameContext,
  cardId: string,
  oracleId: string,
  /** Colors captured while the source was still on the battlefield (last known information). */
  lastKnown?: readonly Color[],
): Color[] {
  const perm = ctx.state.battlefield.find((p) => p.cardId === cardId);
  if (perm !== undefined) return colorsOf(ctx, perm);
  if (lastKnown !== undefined) return [...lastKnown];
  return [...(ctx.defs.get(oracleId as OracleId)?.colors ?? [])];
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

/** A direction around the table (CR 101.4: turn order passes to the left). */
export type SeatDirection = 'left' | 'right';

/**
 * The nearest opponent of `playerId` in `direction`, skipping players who have left the game:
 * the next player in turn order to the left, the previous one to the right. With two players it
 * is the other one either way. Undefined when `playerId` has no opponent left.
 */
export function nearestOpponentInDirection(
  ctx: GameContext,
  playerId: PlayerId,
  direction: SeatDirection,
): EnginePlayerState | undefined {
  const order = ctx.state.turnOrder;
  const start = order.indexOf(playerId);
  if (start < 0) return undefined;
  const step = direction === 'left' ? 1 : -1;
  for (let i = 1; i < order.length; i++) {
    const id = order[
      (((start + step * i) % order.length) + order.length) % order.length
    ] as PlayerId;
    const candidate = ctx.state.players.find((p) => p.id === id);
    if (candidate !== undefined && !candidate.hasLost) return candidate;
  }
  return undefined;
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
  definition?: CardDefinition,
): SelectorCandidate {
  const def = definition ?? getDefByOracleId(ctx, card.oracleId, card.name);
  return {
    cardId: card.cardId,
    controllerId: ownerId,
    types: def.types,
    supertypes: def.supertypes,
    subtypes: def.subtypes,
    colors: def.colors,
    power: def.power ?? 0,
    ...(def.power === null ? { powerUnknown: true } : {}),
    keywords: def.keywords,
    manaValue: spellManaValue(def, undefined),
    // A card off the battlefield is never a token: tokens cease to exist on leaving it
    // (CR 704.5d), so nothing this function is handed can be one.
    isToken: false,
    // Not a permanent at all — "entered this turn" is meaningless here.
    enteredThisTurn: false,
    isCommander: card.isCommander,
    ownerId: card.ownerId,
    name: card.name,
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
  const def =
    purpose.kind === 'castSpell'
      ? (purpose.spellDefinition ?? ctx.defs.get(oracleId))
      : ctx.defs.get(oracleId);
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
    isCommander: purpose.kind === 'castSpell' && purpose.isCommander === true,
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
  Partial<Pick<EnginePermanent, 'chosenOption' | 'counters'>>;

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
  } else if (
    spec.dynamic === 'colorsAmongPermanents' ||
    spec.dynamic === 'oneColorAmongPermanents'
  ) {
    // The source sees current colors, including color-changing continuous effects.
    for (const permanent of controlledPermanents(ctx, perm.controllerId)) {
      for (const color of computeCharacteristics(ctx, permanent).colors) add(color);
    }
  } else if (spec.dynamic === 'legendaryPermanentColors') {
    // Mox Amber. "Among legendary creatures and planeswalkers you control" — read through the
    // layer engine, so a permanent that has BECOME legendary (or lost legendary) counts as it
    // currently is. Mox Amber itself is a legendary artifact, not a creature, so it never
    // feeds its own ability.
    for (const permanent of controlledPermanents(ctx, perm.controllerId)) {
      const chars = computeCharacteristics(ctx, permanent);
      if (!chars.supertypes.includes('Legendary')) continue;
      if (!chars.types.includes('Creature') && !chars.types.includes('Planeswalker')) continue;
      for (const color of chars.colors) add(color);
    }
  } else if (spec.dynamic === 'ownLandTypes') {
    // Reflecting Pool — the mirror of `opponentLandColors` over your own lands, with one real
    // difference: "any TYPE that a land could produce" is broader than "any color", so {C} is
    // included rather than filtered out. `visited` is what stops two Reflecting Pools (or a Pool
    // and an Exotic Orchard) recursing into each other forever.
    for (const land of controlledPermanents(ctx, perm.controllerId)) {
      const chars = computeCharacteristics(ctx, land);
      if (!chars.types.includes('Land')) continue;
      for (const ability of chars.manaAbilities) {
        for (const unit of resolveDynamicUnits(ctx, ability, land, visited).units) {
          for (const sym of unit) add(sym);
        }
      }
    }
  } else if (spec.dynamic === 'chosenColor') {
    // A modal DFC land's ETB face choice (`entersChoosingOption`), stored as the color's letter.
    // Undefined for a card still in hand (previewed before it has entered, so it hasn't chosen
    // yet) — correctly produces nothing rather than guessing.
    const chosen = perm.chosenOption;
    if (chosen === 'W' || chosen === 'U' || chosen === 'B' || chosen === 'R' || chosen === 'G') {
      add(chosen);
    }
  } else if (spec.dynamic === 'opponentLandColors') {
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
  } else {
    assertNever(spec.dynamic, 'dynamic mana kind');
  }

  return {
    ...spec,
    units:
      symbols.length === 0
        ? []
        : spec.dynamic === 'colorsAmongPermanents'
          ? symbols.map((symbol) => [symbol])
          : [symbols],
  };
}

/**
 * "Add {G} for each creature you control" (Gaea's Cradle, Itlimoc) - expand a state-derived
 * AMOUNT into concrete units.
 *
 * The symbol is fixed here and the COUNT is computed, which is the mirror of `resolveDynamicUnits`
 * (computed symbols, fixed count). Run after it, so a spec could in principle use both.
 *
 * Zero is a real answer, not a failure: Gaea's Cradle with no creatures produces nothing, and
 * `manaSourcesFor`'s `units.length > 0` filter then correctly declines to offer it as a payment
 * source rather than offering a source that makes no mana.
 */
export function resolveDynamicAmount(
  ctx: GameContext,
  spec: ManaAbilitySpec,
  perm: ManaAbilityContext,
): ManaAbilitySpec {
  if (spec.amount === undefined) return spec;
  const { amount, ...rest } = spec;
  const count = Math.max(
    0,
    evaluateValue(ctx, amount, {
      controllerId: perm.controllerId,
      sourceCounters: perm.counters ?? {},
      // Counted through the layer engine, so a permanent that has BECOME a creature (or lost
      // the type) counts as it currently is — the same rule `landPlayLimitFor` uses.
      countPermanents: (selector, scope) =>
        selectPermanents(ctx, selector, {
          cardId: perm.cardId,
          controllerId: perm.controllerId,
          // Three Tree City counts creatures "of the chosen type", which is a `chosenSubtype`
          // clause resolved against the SOURCE's own as-enters choice.
          ...(perm.chosenOption !== undefined ? { chosenOption: perm.chosenOption } : {}),
        }).filter(
          (candidate) =>
            scope === 'all' ||
            (scope === 'you'
              ? candidate.controllerId === perm.controllerId
              : candidate.controllerId !== perm.controllerId),
        ).length,
    }),
  );
  return { ...rest, units: Array.from({ length: count }, () => spec.units).flat() };
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
/** May `candidate` pay `cost` (a sacrifice) for an ability of `source`? */
export function sacrificeCandidateAllowed(
  ctx: GameContext,
  cost: { allowSelf?: boolean; onlyCardId?: string },
  source: EnginePermanent,
  candidate: EnginePermanent,
): boolean {
  if (!canBeSacrificed(ctx, candidate)) return false;
  if (cost.onlyCardId !== undefined && candidate.cardId !== cost.onlyCardId) return false;
  return cost.allowSelf === true || candidate.id !== source.id;
}

/** Rules prohibition applies to both costs and effects, and disappears with the ability. */
export function canBeSacrificed(ctx: GameContext, permanent: EnginePermanent): boolean {
  return !gatherRuleStatics(ctx).some(
    (entry) => entry.sourceCardId === permanent.cardId && entry.static.kind === 'cantBeSacrificed',
  );
}

/**
 * Expand a mana ability whose amount is the sacrificed permanent's mana value into one variant
 * per sacrifice candidate (Illuminor Szeras). Each variant pins its sacrifice (`onlyCardId`) and
 * makes exactly that candidate's mana value of `units[0]`; a 0-mana-value candidate makes nothing
 * and is dropped. Every variant keeps the ability's {T}, so the solver uses at most one.
 */
function expandSacrificedManaValue<T extends ManaAbilitySpec>(
  ctx: GameContext,
  perm: EnginePermanent,
  ability: T,
): T[] {
  if (ability.amountFromSacrificedManaValue !== true) return [ability];
  const costs = ability.costs ?? TAP_COST;
  const sacrifice = costs.find((cost) => cost.kind === 'sacrificeOther');
  const unit = ability.units[0];
  if (sacrifice === undefined || sacrifice.kind !== 'sacrificeOther' || unit === undefined)
    return [];
  const { amountFromSacrificedManaValue: _dropped, ...base } = ability;
  return ctx.state.battlefield
    .filter(
      (candidate) =>
        candidate.controllerId === perm.controllerId &&
        sacrificeCandidateAllowed(ctx, sacrifice, perm, candidate) &&
        matchesSelector(ctx, candidate, sacrifice.selector, {
          cardId: perm.cardId,
          controllerId: perm.controllerId,
        }),
    )
    .flatMap((candidate) => {
      const manaValue =
        candidateOf(ctx, candidate, computeCharacteristics(ctx, candidate)).manaValue ?? 0;
      if (manaValue <= 0) return [];
      return [
        {
          ...base,
          units: Array.from({ length: manaValue }, () => unit),
          costs: costs.map((cost) =>
            cost === sacrifice ? { ...sacrifice, onlyCardId: candidate.cardId } : cost,
          ),
        } as T,
      ];
    });
}

/**
 * May a "tap an untapped … you control" cost tap the ability's own source? Only when the cost says
 * so (`allowSelf`) and the same ability does not also tap the source with {T}: a permanent tapped
 * for {T} is no longer untapped (CR 601.2h pays the costs in any order, never one object twice).
 */
export function selfMayTap(cost: AbilityCost, costs: readonly AbilityCost[]): boolean {
  return 'allowSelf' in cost && cost.allowSelf === true && !costs.some((c) => c.kind === 'tap');
}

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
        if (!canBeSacrificed(ctx, perm)) return false;
        break;
      case 'exileSelf':
        break;
      case 'unattachSelf':
        if (perm.attachedTo === null) return false;
        break;
      case 'sacrificeOther': {
        const count = cost.count ?? 1;
        const payable = ctx.state.battlefield.filter(
          (candidate) =>
            sacrificeCandidateAllowed(ctx, cost, perm, candidate) &&
            candidate.controllerId === perm.controllerId &&
            matchesSelector(ctx, candidate, cost.selector, {
              cardId: perm.cardId,
              controllerId: perm.controllerId,
            }),
        );
        if (payable.length < count) return false;
        break;
      }
      case 'tapOther': {
        const payable = ctx.state.battlefield.some(
          (candidate) =>
            (selfMayTap(cost, costs) || candidate.id !== perm.id) &&
            candidate.controllerId === perm.controllerId &&
            !candidate.tapped &&
            matchesSelector(ctx, candidate, cost.selector, {
              cardId: perm.cardId,
              controllerId: perm.controllerId,
            }),
        );
        if (!payable) return false;
        break;
      }
      case 'tapOthers': {
        const payable = ctx.state.battlefield.filter(
          (candidate) =>
            (selfMayTap(cost, costs) || candidate.id !== perm.id) &&
            candidate.controllerId === perm.controllerId &&
            !candidate.tapped &&
            matchesSelector(ctx, candidate, cost.selector, {
              cardId: perm.cardId,
              controllerId: perm.controllerId,
            }),
        );
        if (payable.length < cost.count) return false;
        break;
      }
      case 'tapXOthers': {
        // The first pass happens before X is announced; the per-X pass below supplies it.
        if (announcedX === undefined) break;
        const payable = ctx.state.battlefield.filter(
          (candidate) =>
            candidate.id !== perm.id &&
            candidate.controllerId === perm.controllerId &&
            !candidate.tapped &&
            matchesSelector(ctx, candidate, cost.selector, {
              cardId: perm.cardId,
              controllerId: perm.controllerId,
            }),
        );
        if (payable.length < announcedX) return false;
        break;
      }
      case 'removeCounters': {
        const count = typeof cost.count === 'number' ? cost.count : evaluateValue(ctx, cost.count);
        if (counterCount(perm.counters, cost.counter) < count) return false;
        break;
      }
      case 'removeCountersFromAmong': {
        const payable = ctx.state.battlefield.some(
          (candidate) =>
            candidate.controllerId === perm.controllerId &&
            (candidate.counters[cost.counter] ?? 0) >= cost.count &&
            matchesSelector(ctx, candidate, cost.selector, {
              cardId: perm.cardId,
              controllerId: perm.controllerId,
            }),
        );
        if (!payable) return false;
        break;
      }
      case 'payLife': {
        // CR 119.4 / 119.4b: positive life payments need enough life; zero is always payable.
        const controller = ctx.state.players.find((p) => p.id === perm.controllerId);
        if (
          controller === undefined ||
          (cost.amount > 0 &&
            (controller.life < cost.amount || playerLifeLocked(ctx, controller.id)))
        )
          return false;
        break;
      }
      case 'payLifeValue': {
        const controller = ctx.state.players.find((p) => p.id === perm.controllerId);
        const amount = evaluateValue(ctx, cost.amount, { controllerId: perm.controllerId });
        if (
          controller === undefined ||
          (amount > 0 && (controller.life < amount || playerLifeLocked(ctx, controller.id)))
        )
          return false;
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
        const available = ctx.state.battlefield.filter(
          (candidate) =>
            candidate.id !== perm.id &&
            candidate.controllerId === perm.controllerId &&
            !candidate.tapped &&
            isCreaturePermanent(ctx, candidate),
        );
        const totalPower = available.reduce(
          (sum, candidate) => sum + effectivePT(ctx, candidate).power,
          0,
        );
        if (totalPower < cost.minPower) return false;
        break;
      }
      case 'discardCard': {
        const controller = ctx.state.players.find((p) => p.id === perm.controllerId);
        if (controller === undefined || controller.hand.length < (cost.count ?? 1)) return false;
        break;
      }
      case 'discardHand':
        // Discarding the entire hand is payable even when that hand is empty.
        break;
      case 'exileOtherCardsFromGraveyard':
        // Supported only by the spell-cost path, not battlefield activations.
        return false;
      case 'exileCardFromHand':
        return false;
      case 'discardSelf':
      case 'exileSelfFromGraveyard':
        // Paid by moving the SOURCE CARD out of hand / out of the graveyard. A battlefield
        // permanent is in neither zone, so it can never pay one. This function is only ever
        // asked about battlefield permanents; the hand and graveyard activation paths in
        // `computePriorityOptions`/`applyPriorityAction` pay these directly and never call it.
        // Falling through to the permissive `true` below is what let a battlefield creature
        // claim it could pay for its own cycling.
        return false;
      case 'mana':
        break;

      default:
        assertNever(cost, 'activation affordability');
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
    ability.uncounterableSpell ?? false,
    ability.persistent ?? false,
    ability.linked ?? false,
    // Two abilities that differ only in their ON-ACTIVATE rider are NOT interchangeable:
    // collapsing them would let the payment path apply the wrong permanent-side effect (or
    // apply a rider to an ability that has none). See `payManaCost`.
    ability.onActivate ?? null,
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
export function manaSourcesFor(
  ctx: GameContext,
  playerId: PlayerId,
  includeZeroProduction = false,
): ManaSource[] {
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
    // Grand Abolisher bars opponents from activating abilities of artifacts, creatures and
    // enchantments during its controller's turn — and a mana ability is an activated ability
    // (CR 605.1a), so the restriction reaches Sol Ring and Birds of Paradise too. Checked here
    // rather than only in `computePriorityOptions`, because a source that cannot be activated
    // is not available to pay for anything either.
    if (activatingAbilitiesBlockedFor(ctx, playerId, perm)) continue;
    // Mana abilities are computed, not printed: a layer-4 subtype change replaces them
    // (Blood Moon → a Mountain that taps for R), layer 6 can remove them outright, and layer 6
    // can also GRANT them (Chromatic Lantern).
    for (const ability of chars.manaAbilities) assertManaRiders(perm.name, ability.onActivate);
    let abilities = chars.manaAbilities
      /*
       * A mana ability whose cost includes {X} still cannot be honoured. There is nobody to
       * announce X for a mana ability — it is activated by the payment solver, not by a player
       * at priority — so the cost has no value and would go uncharged. No printed card does
       * this; the guard is here because an override could author one.
       *
       * The rest of the mana-in-cost family IS honoured now: `ManaSource.manaCost` carries it
       * and `planPayment`'s second pass pays for its own sources. See `mana/cost.ts`.
       */
      .filter((a) => !(a.costs ?? []).some((c) => c.kind === 'mana' && (c.cost.x ?? 0) > 0))
      // "Activate only if you control a Dragon" — an unavailable source is not a source.
      .filter(
        (a) =>
          a.condition === undefined ||
          evaluateCondition(ctx, a.condition, {
            cardId: perm.cardId,
            controllerId: perm.controllerId,
          }),
      )
      .map((a) => ({
        ...resolveDynamicAmount(
          ctx,
          resolveDynamicUnits(ctx, resolveConditionalUnits(ctx, a, perm), perm),
          perm,
        ),
        ...(!activationInvariantProduction(a)
          ? { stateDependentProduction: true as const, productionSpec: a }
          : {}),
      }))
      .flatMap((a) => expandSacrificedManaValue(ctx, perm, a))
      // A dynamic source can resolve to nothing at all — Fellwar Stone with no opposing
      // lands taps for no mana, so it must not be offered as a payment source.
      .filter(
        (a) => a.units.length > 0 || (includeZeroProduction && a.productionSpec !== undefined),
      )
      // Not every mana ability costs {T}: "Sacrifice this creature: Add {R}{R}" is available
      // from a tapped, summoning-sick creature. Availability is per ability, not per permanent.
      .filter((a) => canPayNonManaCosts(ctx, perm, a.costs ?? TAP_COST));

    for (const entry of gatherRuleStatics(ctx)) {
      const rider = entry.static;
      if (rider.kind !== 'manaActivationRider') continue;
      const riderSource = ctx.state.battlefield.find(
        (candidate) => candidate.cardId === entry.sourceCardId,
      );
      const attachedToCardId =
        riderSource?.attachedTo === undefined
          ? undefined
          : ctx.state.battlefield.find((candidate) => candidate.id === riderSource.attachedTo)
              ?.cardId;
      if (
        !matchesSelector(ctx, perm, rider.source, {
          cardId: entry.sourceCardId,
          controllerId: entry.controllerId,
          ...(attachedToCardId !== undefined ? { attachedToCardId } : {}),
        })
      )
        continue;

      abilities = abilities.map((ability) => {
        const { productionSpec: _productionSpec, ...fixedProduction } = ability;
        if (rider.add.kind === 'fixed') {
          return {
            ...fixedProduction,
            stateDependentProduction: true as const,
            units: [...ability.units, ...rider.add.units],
          };
        }
        const producedTypes = [...new Set(ability.units.flat())];
        if (producedTypes.length === 0)
          return { ...fixedProduction, stateDependentProduction: true as const };
        return {
          ...fixedProduction,
          stateDependentProduction: true as const,
          units: [...ability.units, producedTypes],
          ...(ability.linked === true || ability.units.length === 1
            ? { linked: true as const }
            : {}),
        };
      });
    }
    if (abilities.length === 0) continue;

    // Group interchangeable abilities, preserving first-seen order for determinism.
    const groups = new Map<
      string,
      (ManaAbilitySpec & { stateDependentProduction?: true; productionSpec?: ManaAbilitySpec })[]
    >();
    for (const ability of abilities) {
      const key =
        interchangeableSignature(ability) +
        String(ability.stateDependentProduction ?? false) +
        JSON.stringify(ability.productionSpec);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [ability]);
      else group.push(ability);
    }

    for (const group of groups.values()) {
      const first = group[0]!;
      const rider = {
        costs: first.costs ?? TAP_COST,
        ...(group.some((a) => a.stateDependentProduction)
          ? { stateDependentProduction: true as const }
          : {}),
        ...(first.productionSpec === undefined ? {} : { productionSpec: first.productionSpec }),
        // Lifted out of `costs` so the payment solver can see it without knowing what an
        // `AbilityCost` is — a filter land's `{W/B}`, Cabal Coffers' `{2}`.
        ...(manaCostComponent(first.costs ?? TAP_COST) !== undefined
          ? { manaCost: manaCostComponent(first.costs ?? TAP_COST) as ParsedManaCost }
          : {}),
        ...(first.restriction !== undefined ? { restriction: first.restriction } : {}),
        ...(first.spendTrigger !== undefined ? { spendTrigger: first.spendTrigger } : {}),
        ...(first.uncounterableSpell === true ? { uncounterableSpell: true as const } : {}),
        ...(first.persistent === true ? { persistent: true } : {}),
        ...(first.linked === true ? { linked: true as const } : {}),
        ...(first.onActivate !== undefined ? { onActivate: first.onActivate } : {}),
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
  return sources.flatMap((source) => {
    if (source.costs.every((cost) => cost.kind === 'tap' || cost.kind === 'mana')) return [source];
    const perm = ctx.state.battlefield.find((p) => p.cardId === source.cardId)!;
    const player = ctx.state.players.find((p) => p.id === playerId)!;
    const resources: NonNullable<ManaSource['resources']>[number][] = [];
    const sacrifices: string[][] = [];
    const taps: string[][] = [];
    let limit = Infinity;
    for (const cost of source.costs) {
      if (cost.kind === 'tap' || cost.kind === 'sacrificeSelf' || cost.kind === 'exileSelf')
        limit = 1;
      if (cost.kind === 'payLife' || cost.kind === 'payLifeValue') {
        const amount =
          cost.kind === 'payLife'
            ? cost.amount
            : evaluateValue(ctx, cost.amount, { controllerId: playerId });
        resources.push({ key: 'life', amount, available: Math.max(0, player.life) });
        if (amount > 0) limit = Math.min(limit, Math.floor(player.life / amount));
      }
      if (cost.kind === 'payEnergy') {
        resources.push({ key: 'energy', amount: cost.amount, available: player.energy });
        if (cost.amount > 0) limit = Math.min(limit, Math.floor(player.energy / cost.amount));
      }
      if (cost.kind === 'removeCounters') {
        const amount = typeof cost.count === 'number' ? cost.count : evaluateValue(ctx, cost.count);
        const available = counterCount(perm.counters, cost.counter);
        resources.push({ key: `${perm.cardId}:counter:${cost.counter}`, amount, available });
        if (amount > 0) limit = Math.min(limit, Math.floor(available / amount));
      }
      if (cost.kind === 'sacrificeOther') {
        const candidates = ctx.state.battlefield
          .filter(
            (p) =>
              p.controllerId === playerId &&
              sacrificeCandidateAllowed(ctx, cost, perm, p) &&
              matchesSelector(ctx, p, cost.selector, {
                cardId: perm.cardId,
                controllerId: playerId,
              }),
          )
          .map((p) => p.cardId);
        const count = cost.count ?? 1;
        for (let i = 0; i < count; i++) sacrifices.push(candidates);
        limit = Math.min(limit, Math.floor(candidates.length / count));
      }
      if (cost.kind === 'tapOther' || cost.kind === 'tapOthers') {
        const candidates = ctx.state.battlefield
          .filter(
            (p) =>
              (selfMayTap(cost, source.costs) || p.id !== perm.id) &&
              p.controllerId === playerId &&
              !p.tapped &&
              matchesSelector(ctx, p, cost.selector, {
                cardId: perm.cardId,
                controllerId: playerId,
              }),
          )
          .map((p) => p.cardId);
        const count = cost.kind === 'tapOthers' ? cost.count : 1;
        for (let i = 0; i < count; i++) taps.push(candidates);
      }
    }
    const shared = {
      ...(resources.length > 0 ? { resources } : {}),
      ...(sacrifices.length > 0 ? { sacrifices } : {}),
      ...(taps.length > 0 ? { taps } : {}),
    };
    if (!Number.isFinite(limit) || limit <= 1) return [{ ...source, ...shared }];
    return Array.from({ length: limit }, (_, activation) => ({ ...source, ...shared, activation }));
  });
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
    )
      continue;
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
    if (perm.faceDown) continue;
    const printed = ctx.defs.get(perm.oracleId);
    if (printed === undefined) continue;
    const def = selectedPermanentDefinition(printed, perm.face);
    const printedRuleStatics =
      perm.transformed && def.backFace !== undefined ? def.backFace.ruleStatics : def.ruleStatics;
    if (printedRuleStatics.length === 0 || computeCharacteristics(ctx, perm).loseAbilities)
      continue;
    for (const rs of printedRuleStatics) {
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

/** Cost increases apply before reductions, including a zero alternative mana cost. */
export function nonHandSpellCostIncreaseFor(
  ctx: GameContext,
  casterId: PlayerId,
  zone: string,
): number {
  if (zone !== 'graveyard' && zone !== 'exile') return 0;
  return gatherRuleStatics(ctx).reduce(
    (total, entry) =>
      total +
      (entry.static.kind === 'opponentNonHandSpellCostIncrease' && entry.controllerId !== casterId
        ? entry.static.amount
        : 0),
    0,
  );
}

/** Number of land plays available to a player this turn, including the normal play. */
export function landPlayLimitFor(ctx: GameContext, playerId: PlayerId): number {
  return (
    1 +
    gatherRuleStatics(ctx).reduce(
      (total, entry) =>
        entry.controllerId === playerId && entry.static.kind === 'additionalLandDrops'
          ? total +
            evaluateValue(ctx, entry.static.count, {
              controllerId: entry.controllerId,
              countPermanents: (selector, scope) =>
                selectPermanents(ctx, selector, {
                  cardId: entry.sourceCardId,
                  controllerId: entry.controllerId,
                }).filter(
                  (permanent) =>
                    scope === 'all' ||
                    (scope === 'you'
                      ? permanent.controllerId === entry.controllerId
                      : permanent.controllerId !== entry.controllerId),
                ).length,
            })
          : total,
      0,
    )
  );
}

/** Does this player currently have no maximum hand size? */
export function hasNoMaximumHandSize(ctx: GameContext, playerId: PlayerId): boolean {
  return gatherRuleStatics(ctx).some(
    (entry) => entry.static.kind === 'noMaximumHandSize' && entry.controllerId === playerId,
  );
}
/** Does an active `cantCastSpells` rule static currently forbid `playerId` from casting? */
export function castingSpellsBlockedFor(
  ctx: GameContext,
  playerId: PlayerId,
  definition?: Pick<CardDefinition, 'types'>,
): boolean {
  if (ctx.state.spellsProhibitedTurn === ctx.state.turnNumber) return true;
  return gatherRuleStatics(ctx).some((entry) => {
    if (entry.static.kind === 'spellCastLimit') {
      const player = ctx.state.players.find((candidate) => candidate.id === playerId);
      if (player === undefined) return true;
      if (entry.static.category === 'noncreature')
        return (
          definition !== undefined &&
          !definition.types.includes('Creature') &&
          player.noncreatureSpellsCastThisTurn >= entry.static.limit
        );
      return player.spellsCastThisTurn >= entry.static.limit;
    }
    if (entry.static.kind !== 'cantCastSpells') return false;
    // "Your OPPONENTS can't cast spells" — the source's own controller is never blocked by it.
    // "PLAYERS can't cast spells" (Basandra) binds everyone, its controller included.
    if (entry.static.who !== 'all' && entry.controllerId === playerId) return false;
    if (entry.static.duringCombatOnly === true && ctx.state.phase !== 'combat') return false;
    return entry.static.yourTurnOnly !== true || ctx.state.currentTurnPlayer === entry.controllerId;
  });
}

/**
 * Does an active `cantBeCountered` rule static protect a spell (printed as `spellOracleId`, cast
 * by `casterId`) right now? Distinct from `Ability.cantBeCountered`, which is fixed at cast time
 * (Last March of the Ents) — this is re-checked at the moment of countering (CR 611.2), since the
 * source (Rhythm of the Wild) could have left the battlefield since the spell was cast.
 */
/** Does a rule static currently forbid this player from activating this permanent's ability? */
export function activatingAbilitiesBlockedFor(
  ctx: GameContext,
  playerId: PlayerId,
  permanent: EnginePermanent,
): boolean {
  return gatherRuleStatics(ctx).some((entry) => {
    if (entry.static.kind !== 'cantActivateAbilities') return false;
    if (entry.static.who !== 'all' && entry.controllerId === playerId) return false;
    if (entry.static.yourTurnOnly && ctx.state.currentTurnPlayer !== entry.controllerId)
      return false;
    return matchesSelector(ctx, permanent, entry.static.filter, {
      cardId: entry.sourceCardId,
      controllerId: entry.controllerId,
    });
  });
}

export function spellProtectedFromCounter(
  ctx: GameContext,
  casterId: PlayerId,
  spellOracleId: OracleId,
  spellDefinition?: CardDefinition,
): boolean {
  const def = spellDefinition ?? getDefByOracleId(ctx, spellOracleId, spellOracleId);
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
      entry.static.filter === undefined || selectMatches(candidate, entry.static.filter, source)
    );
  });
}

/**
 * Cards `playerId` may cast from the top of their library right now (Korlessa, Scale Singer).
 * Always at most one card — the printed template names the top card specifically, never "a card
 * in your library".
 */
const PERMANENT_TYPES = [
  'Artifact',
  'Battle',
  'Creature',
  'Enchantment',
  'Land',
  'Planeswalker',
] as const;

/**
 * A card off the battlefield as a cast permission sees it. A permission is checked against the
 * spell the card would become, so a bestowed card is judged as the Aura enchantment spell it is
 * cast as, not as the creature card it is (CR 601.3e, 702.103b).
 */
function spellZoneCandidate(
  ctx: GameContext,
  card: EngineCardObject,
  ownerId: PlayerId,
  spellDefinition: CardDefinition | undefined,
): SelectorCandidate {
  const candidate = cardZoneCandidate(ctx, card, ownerId);
  return spellDefinition === undefined
    ? candidate
    : { ...candidate, types: spellDefinition.types, subtypes: spellDefinition.subtypes };
}

/**
 * The currently available permission for a non-hand play. `budgetTypes` is absent for an
 * unlimited permission; otherwise the action must choose one of those still-unused permanent
 * types and consume it. Keeping that choice in the action payload handles multitype cards.
 */
export function playFromZonePermission(
  ctx: GameContext,
  playerId: PlayerId,
  card: EngineCardObject,
  zone: 'libraryTop' | 'graveyard',
  /** The spell the card would be cast as (a bestowed Aura), when that differs (CR 601.3e). */
  spellDefinition?: CardDefinition,
): { budgetTypes?: string[] } | null {
  const player = ctx.state.players.find((candidate) => candidate.id === playerId);
  if (player === undefined) return null;
  const candidate = spellZoneCandidate(ctx, card, playerId, spellDefinition);
  const source: SelectorSource = { cardId: '', controllerId: playerId };
  const matching = gatherRuleStatics(ctx).filter((entry) => {
    if (entry.static.kind !== 'playFromZone' || entry.static.zone !== zone) return false;
    if (entry.controllerId !== playerId) return false;
    if (entry.static.yourTurnOnly === true && ctx.state.currentTurnPlayer !== playerId)
      return false;
    return (
      entry.static.filter === undefined || selectMatches(candidate, entry.static.filter, source)
    );
  });
  if (matching.length === 0) return null;
  if (
    matching.some(
      (entry) =>
        entry.static.kind === 'playFromZone' && entry.static.permanentTypeBudget === undefined,
    )
  ) {
    return {};
  }

  const budgetTypes = PERMANENT_TYPES.filter((type) => {
    if (!candidate.types.includes(type)) return false;
    return matching.some(
      (entry) =>
        entry.static.kind === 'playFromZone' &&
        entry.static.permanentTypeBudget !== undefined &&
        (player.playFromZoneTypeUsesThisTurn[type] ?? 0) < entry.static.permanentTypeBudget,
    );
  });
  return budgetTypes.length > 0 ? { budgetTypes: [...budgetTypes] } : null;
}

/** Does this spell have convoke (CR 702.51)? */
export function spellHasConvoke(def: CardDefinition): boolean {
  return def.ruleStatics.some((rule) => rule.kind === 'convoke');
}

/**
 * The creatures a convoke spell's controller may tap to help pay for it (CR 702.51a): each
 * untapped creature they control pays for {1} or one mana of one of its colors. A colorless
 * creature pays generic mana only; its unit is {C}, which a spell's generic cost accepts.
 */
export function convokeSourcesFor(ctx: GameContext, playerId: PlayerId): ManaSource[] {
  return ctx.state.battlefield.flatMap((perm) => {
    if (perm.controllerId !== playerId || perm.tapped) return [];
    const chars = computeCharacteristics(ctx, perm);
    if (!chars.types.includes('Creature')) return [];
    const colors = COLOR_ORDER_FOR_CONVOKE.filter((color) => chars.colors.includes(color));
    return [
      {
        cardId: perm.cardId,
        units: [colors.length > 0 ? colors : ['C']],
        costs: [{ kind: 'tap' }],
        convoke: true as const,
      },
    ];
  });
}
const COLOR_ORDER_FOR_CONVOKE = ['W', 'U', 'B', 'R', 'G'] as const;

/** Does `playerId` currently have a static permission to play `card` from `zone`? */
export function canPlayFromZone(
  ctx: GameContext,
  playerId: PlayerId,
  card: EngineCardObject,
  zone: 'libraryTop' | 'graveyard',
): boolean {
  return playFromZonePermission(ctx, playerId, card, zone) !== null;
}
export function castFromLibraryTopCandidates(
  ctx: GameContext,
  playerId: PlayerId,
  /** The spell the top card would be cast as (a bestowed Aura), when that differs (CR 601.3e). */
  spellDefinition?: CardDefinition,
): EngineCardObject[] {
  const player = ctx.state.players.find((p) => p.id === playerId);
  const top = player?.library[0];
  if (player === undefined || top === undefined) return [];
  const candidate = spellZoneCandidate(ctx, top, playerId, spellDefinition);
  const source: SelectorSource = { cardId: '', controllerId: playerId };
  const eligible = gatherRuleStatics(ctx).some((entry) => {
    if (entry.static.kind !== 'castFromZone' || entry.static.zone !== 'libraryTop') return false;
    if (entry.controllerId !== playerId) return false;
    return (
      entry.static.filter === undefined || selectMatches(candidate, entry.static.filter, source)
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

/** The multiplicative token replacement effects active for tokens created under `controllerId`. */
export function tokenCreationMultiplierFor(ctx: GameContext, controllerId: PlayerId): number {
  return gatherRuleStatics(ctx).reduce((multiplier, entry) => {
    if (entry.static.kind !== 'tokenCountMultiplier' || entry.controllerId !== controllerId)
      return multiplier;
    return multiplier * entry.static.multiplier;
  }, 1);
}

function applyCounterReplacements(
  ctx: GameContext,
  counter: string,
  amount: number,
  matches: (filter: Selector, source: SelectorSource) => boolean,
  excludedSources?: ReadonlySet<string>,
): number {
  if (amount <= 0) return amount;
  let adjusted = amount;
  for (const entry of gatherRuleStatics(ctx)) {
    if (entry.static.kind !== 'counterPlacementReplacement') continue;
    if (excludedSources?.has(entry.sourceCardId) === true) continue;
    if (entry.static.counter !== undefined && entry.static.counter !== counter) continue;
    const source: SelectorSource = { cardId: entry.sourceCardId, controllerId: entry.controllerId };
    if (!matches(entry.static.filter, source)) continue;
    adjusted = adjusted * entry.static.multiplier + entry.static.addition;
  }
  return adjusted;
}

/** Apply active counter replacements to counters placed on an existing permanent. */
export function counterAmountAfterReplacements(
  ctx: GameContext,
  perm: EnginePermanent,
  counter: string,
  amount: number,
): number {
  return applyCounterReplacements(ctx, counter, amount, (filter, source) =>
    matchesSelector(ctx, perm, filter, source),
  );
}

/**
 * Apply active counter replacements to a permanent while it is still entering. A fellow entrant
 * of the same simultaneous event was not on the battlefield before it (CR 614.12).
 */
export function counterAmountAfterReplacementsForCandidate(
  ctx: GameContext,
  candidate: SelectorCandidate,
  counter: string,
  amount: number,
): number {
  return applyCounterReplacements(
    ctx,
    counter,
    amount,
    (filter, source) => selectMatches(candidate, filter, source),
    ctx.enteringTogether,
  );
}

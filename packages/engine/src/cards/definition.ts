/**
 * The engine's internal card model (brief §6). An `OracleCard` (raw Scryfall projection)
 * is interpreted once into a `CardDefinition`: parsed cost, implemented keywords, mana
 * abilities, spell effects, and triggered abilities. Anything the interpreter cannot fully
 * account for marks the definition `modeled: false` with a reason — the engine halts
 * loudly when such a card's behavior is actually needed, never guesses (brief §6.3).
 */

import type { Color, OracleId } from '@mtg/shared';
import type { ParsedManaCost } from '../mana/cost';
import type {
  Ability,
  AbilityCost,
  ActivatedAbility,
  KeywordAbility,
  ManaAbilitySpec,
  WardCost,
} from './ability';
import type { Condition } from './condition';
import type { StaticEffect } from './continuous-types';
import type { RuleStatic } from './rule-statics';

export type { Condition } from './condition';
export type { StaticEffect, ContinuousOp, Characteristics } from './continuous-types';
export type { Value } from './value';
export type { Selector } from './selector';
export type { RuleStatic } from './rule-statics';

// The card model's behavior lives in the ability IR (ADR 0004); re-export the pieces
// consumers reference so existing imports from `definition` keep working.
export { IMPLEMENTED_KEYWORDS, TAP_COST } from './ability';
export type {
  AlternativeCast,
  MdfcLandFace,
  Ability,
  AbilityCost,
  ActivatedAbility,
  Effect,
  EffectRef,
  KeywordAbility,
  ManaAbilitySpec,
  SearchDestination,
  TargetKind,
  TargetSpec,
  TriggerHead,
  TriggerSpec,
  TriggerSubject,
  TriggerWhen,
} from './ability';

/** Fully interpreted back face of a transforming double-faced permanent. */
export interface BackFace {
  name: string;
  typeLine: string;
  oracleText: string;
  manaCostText: string | null;
  frontOracleText: string;
  frontManaCostText: string | null;
  manaCost: ParsedManaCost | null;
  hasUnsupportedCost: boolean;
  supertypes: string[];
  types: string[];
  subtypes: string[];
  colors: Color[];
  power: number | null;
  toughness: number | null;
  loyalty: number | null;
  defense: number | null;
  /** Interpreted second face for a transforming double-faced permanent. */
  backFace?: BackFace;
  keywords: KeywordAbility[];
  ward?: WardCost;
  protectionFrom?: Color[];
  manaAbilities: ManaAbilitySpec[];
  activatedAbilities: ActivatedAbility[];
  entersTapped: boolean;
  entersTappedUnless?: Condition;
  entersWithCounters?: Record<string, number | import('./value').Value>;
  triggers: Ability[];
  staticEffects: StaticEffect[];
  ruleStatics: RuleStatic[];
  cantBlock?: boolean;
  cantBeBlocked?: boolean;
}
/** Interpreted card. Immutable; one per oracle id per game. */
export interface CardDefinition {
  oracleId: OracleId;
  /**
   * A representative Scryfall printing id, for image lookup in the UI (Phase 4). Absent for
   * synthetic token definitions (`registerTokenDef`), which have no real printing.
   */
  scryfallId?: string;
  name: string;
  typeLine: string;
  supertypes: string[];
  types: string[];
  subtypes: string[];
  colors: Color[];
  /**
   * Color identity (CR 903.4), verbatim from Scryfall. Distinct from `colors`: it includes mana
   * symbols in rules text, which is why a commander's identity — what "your commander's color
   * identity" mana abilities read — cannot be derived from `colors`.
   */
  colorIdentity: Color[];
  /** Parsed cost; null for lands / cost-less cards (and for unmodeled costs). */
  manaCost: ParsedManaCost | null;
  /** True if the printed cost contains symbols we cannot pay ({2/W}, snow, …). */
  hasUnsupportedCost: boolean;
  /** Parsed printed P/T; null for non-creatures. `*` values are unmodeled. */
  power: number | null;
  toughness: number | null;
  /** Parsed starting loyalty (planeswalkers, CR 306.5b); null otherwise. `*` is unmodeled. */
  loyalty: number | null;
  /** Parsed starting defense (battles, CR 310.6); null otherwise. `*` is unmodeled. */
  defense: number | null;
  /** Interpreted second face for a transforming double-faced permanent. */
  backFace?: BackFace;
  keywords: KeywordAbility[];
  /** Printed ward cost (CR 702.21), or absent. Parameterized, so not in `keywords`. */
  ward?: WardCost;
  /** Printed "protection from `<colors>`" (CR 702.16). */
  protectionFrom?: Color[];
  manaAbilities: ManaAbilitySpec[];
  /** "`<costs>`: `<effect>`" abilities that use the stack (CR 602). */
  activatedAbilities: ActivatedAbility[];
  entersTapped: boolean;
  /**
   * "enters tapped unless <condition>" / "as this enters, you may pay 2 life; if you don't, it
   * enters tapped" — a replacement effect applied as the permanent enters (CR 614.1c), NOT a
   * trigger. When present it decides tapped-ness and `entersTapped` is ignored: the permanent
   * enters tapped exactly when the condition is FALSE.
   */
  entersTappedUnless?: Condition;
  /**
   * "As this enters, choose a color/type/mode" (CR 614.1c-style replacement, not a trigger) —
   * Caged Sun's color, Cloud Key's card type, Frontier Siege's mode. The chosen `key` is stored
   * on the permanent (`EnginePermanent.chosenOption`) for later statics/triggers to read back
   * via the `chosenColor` selector or a `chosenOptionIs` condition, rather than each card
   * inventing its own memory field.
   */
  entersChoosingOption?: {
    prompt: string;
    /** A printed, closed list — Caged Sun's five colors, Frontier Siege's two modes. */
    options?: { key: string; label: string }[];
    /**
     * "As this enters, choose a creature type" — the domain is not printed and cannot be, so it
     * is computed as the permanent enters (see `moveObject`). Mutually exclusive with `options`.
     */
    domain?: 'creatureType';
  };
  /**
   * Counters the permanent enters the battlefield with (CR 614.1c) — a replacement effect,
   * NOT a triggered ability. The distinction is load-bearing: as a trigger, a 0/0 that
   * "enters with three +1/+1 counters" would briefly exist at 0 toughness and die to a
   * state-based action before its own trigger could resolve.
   */
  entersWithCounters?: Record<string, number | import('./value').Value>;
  /** Additional counters applied by static replacement effects as another permanent enters. */
  additionalCountersOnEntry?: {
    affects: import('./selector').Selector;
    counter: string;
    count: import('./value').Value;
  }[];
  /** Additional 1/1 token replacement generated whenever a creature token is created. */
  tokenCreationReplacement?: import('./ability').TokenSpec;
  /**
   * Duplicant: "As long as a card exiled with this creature is a creature card, this creature
   * has the power, toughness, and creature types of the last creature card exiled with it. It's
   * still a Shapeshifter." A layer 4 and layer 7b effect over `exiledWithIds` (CR 607.2a).
   */
  copyLastExiledCreature?: boolean;
  /** Grants an energy alternative cost to permanent spells while this permanent is controlled. */
  energyAlternativeCost?: number;
  /** Triggered ability fired when a named counter crosses a threshold on this permanent. */
  counterThresholdTriggers?: { counter: string; threshold: number; ability: Ability }[];
  /** For instants/sorceries: the spell's ability (kind 'spell'), or null. */
  spellAbility: Ability | null;
  /**
   * "This spell can't be countered" (CR 601), surfaced independent of `spellAbility` because a
   * PERMANENT card can print it too (Dragonlord Dromoka) — meaning the spell that becomes that
   * permanent, which has no `spellAbility` to carry the flag on. `apply.ts` reads this to give
   * such a cast a minimal (zero-effect) stack `Ability` so `protectedFromCounter` can see it.
   */
  spellCantBeCountered?: boolean;
  /** Alternative casting costs/modes (e.g. Overload). */
  alternativeCasts?: import('./ability').AlternativeCast[];
  /**
   * "You may cast this card from your graveyard" (Their Number Is Legion): the card's own
   * permission, paid at its normal cost (X included). Unlike a `playFromZone` static, nothing is
   * consumed when it is used.
   */
  castFromGraveyard?: true;
  /**
   * Costs added when the card is cast from the graveyard under its own `castFromGraveyard`
   * permission ("by discarding a card in addition to paying its other costs" — Dragon Man).
   */
  castFromGraveyardCosts?: AbilityCost[];
  /**
   * "Cast this spell only during an opponent's turn" (Delirium): a condition on the caster that
   * must hold to cast the spell at all, checked when offering the cast and again as it is cast.
   */
  castRestriction?: Condition;
  /** "You may cast this spell without paying its mana cost if you control a commander." */
  commanderFreeCast?: boolean;
  /** "This spell can't be copied" (Display of Power): copy effects create no copy of it. */
  cantBeCopied?: true;
  /** Additional costs paid while announcing a spell (CR 601.2h), apart from its mana cost. */
  spellAdditionalCosts?: AbilityCost[];
  /** A promise made during announcement, fulfilled before resolving spell effects. */
  gift?: 'treasure' | 'card' | 'extraTurn';
  /** The spell announces an X used by an additional cost even though its mana cost has no X. */
  announcesX?: boolean;
  /** An optional announced additional mana cost such as kicker, squad, or offspring. */
  optionalAdditionalCost?: {
    mechanic: 'kicker' | 'squad' | 'offspring' | 'replicate';
    cost: ParsedManaCost;
    repeatable?: true;
  };
  /** Ravenous uses the spell's announced X for entry counters and its X>=5 draw trigger. */
  ravenous?: true;
  /**
   * "You may have this enter the battlefield as a copy of …" (CR 707.2, as-enters
   * replacement — Dack's Duplicate, Spark Double, Sculpting Steel). `selector` is a
   * `Selector`, not a `TargetKind`: this is a replacement-effect choice resolved as the
   * permanent enters, not an announced stack target.
   */
  entersAsCopy?: {
    /** Eligible copy candidates, e.g. `ofType('Creature')` or `allOf(YOURS, anyOf(ofType('Creature'), ofType('Planeswalker')))`. */
    selector: import('./selector').Selector;
    /** "…except it's also an artifact" (Phyrexian Metamorph)-style additions. */
    addTypes?: string[];
    /** Keywords granted beyond what the copy itself has (Dack's Duplicate's "and has haste"). */
    addKeywords?: import('./ability').KeywordAbility[];
    /** Triggered abilities granted beyond what the copy itself has, for mechanics with no
     * generic keyword representation (Dack's Duplicate's "and has dethrone"). */
    addTriggers?: import('./ability').Ability[];
    /** Supertypes stripped from the copy ("except it isn't legendary" — Spark Double). */
    removeSupertypes?: string[];
    /** Static abilities the copy has beyond the copied object's (Mocking Doppelganger's "Other
     * creatures with the same name as this creature are goaded"). Part of the copiable values
     * (CR 707.9b), so a copy of the copy has them too. */
    addStaticEffects?: StaticEffect[];
    /** A counter added on entry, chosen by the copy's own resulting type (Spark Double). */
    addCounterByType?: { creatureCounter: string; planeswalkerCounter: string; count: number };
  };
  /** Morph is represented as a face-down cast/activation marker in the authored model. */
  morphCost?: ParsedManaCost;
  /** The printed "can't block" characteristic. */
  cantBlock?: boolean;
  /** The printed "can't be blocked" characteristic. */
  cantBeBlocked?: boolean;
  /** Trazyn-style dynamic abilities copied from artifact cards in the controller’s graveyard. */
  artifactGraveyardAbilities?: boolean;
  /** Replaces an empty-library draw with a creature return, as on Out of the Tombs. */
  emptyLibraryCreatureReplacement?: boolean;
  /** Triggered abilities (kind 'triggered'). */
  triggers: Ability[];
  /** Continuous effects this card contributes while a permanent (static abilities / CDAs). */
  staticEffects: StaticEffect[];
  /**
   * Rule-modifying statics — cost reduction, "can't be countered", "can't cast spells", casting
   * from a non-hand zone. Distinct from `staticEffects`: those are CR 613 layer ops over
   * permanents, these modify the rules of casting/countering itself (see `rule-statics.ts`).
   */
  ruleStatics: RuleStatic[];
  /**
   * False when any behavior of this card is beyond the Phase 2 engine. The engine halts
   * with `UnmodeledCardError` the moment such a card's behavior is needed (brief §6.3).
   */
  modeled: boolean;
  unmodeledReasons: string[];
}

export function isCreature(def: CardDefinition): boolean {
  return def.types.includes('Creature');
}

export function isLand(def: CardDefinition): boolean {
  return def.types.includes('Land');
}

export function isInstantOrSorcery(def: CardDefinition): boolean {
  return def.types.includes('Instant') || def.types.includes('Sorcery');
}

export function isLegendary(def: CardDefinition): boolean {
  return def.supertypes.includes('Legendary');
}

/** Card types that resolve/play onto the battlefield as permanents (CR 110.4a). */
export const PERMANENT_CARD_TYPES = [
  'Creature',
  'Artifact',
  'Enchantment',
  'Land',
  'Planeswalker',
  'Battle',
] as const;

/** Permanent card types castable/playable onto the battlefield. */
export function isPermanentCard(def: CardDefinition): boolean {
  return def.types.some((t) => (PERMANENT_CARD_TYPES as readonly string[]).includes(t));
}

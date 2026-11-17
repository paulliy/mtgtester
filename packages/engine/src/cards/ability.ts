/**
 * The card ability IR — the data-driven DSL the engine executes (ADR 0004). A card's
 * behavior is structured data: `Ability`s made of atomic `Effect` primitives that reference
 * declared target slots by index. The interpreter (text → IR) and an authored-override
 * registry both produce these; one executor (`effects/resolve.ts::executeAbility`) runs them.
 *
 * This module is self-contained (no imports from `definition.ts`) so the card model can
 * depend on it without a cycle.
 */

import type { Color, ManaCostString, PlayerId, ObjectId } from '@mtg/shared';
import type { ManaUnit, ParsedManaCost } from '../mana/cost';
import type { Condition } from './condition';
import type { Selector } from './selector';
import type { Value } from './value';
import type { StaticEffect } from './continuous-types';
import type { RuleStatic } from './rule-statics';
import type { ObjectFacts } from './source-identity';
import type { DamageKeyword } from '../state/types';

/** A ward payment (CR 702.21b). Target legality never depends on ability to pay it. */
export type WardCost = { kind: 'mana'; cost: ParsedManaCost } | { kind: 'life'; amount: number };

/**
 * One component of an activation cost (CR 602.1b). A cost is a *list* of these, all paid
 * together as one indivisible act at announcement (CR 601.2h) — before the ability goes on the
 * stack, and irrespective of whether it ever resolves.
 *
 * `sacrificeSelf` is the reason this cannot be folded into `ParsedManaCost`: paying it removes
 * the ability's own source from the battlefield, and the ability still resolves.
 */
export type AbilityCost =
  /** Sneak's exact additional cost; only an unblocked attacker you control can be returned. */
  | { kind: 'returnUnblockedAttacker' }
  /** `{T}` — requires untapped, and (for creatures) not summoning-sick without haste. */
  | { kind: 'tap' }
  /**
   * Tap an untapped controlled permanent, selected while paying the cost. `allowSelf`: the
   * source itself may be the one tapped ("Tap an untapped creature you control" on a creature);
   * that is not the {T} symbol, so summoning sickness does not apply (CR 302.6).
   */
  | {
      kind: 'tapOther';
      selector: Selector;
      capturePowerForStation?: boolean;
      allowSelf?: boolean;
    }
  /** Tap several distinct untapped controlled permanents selected while paying the cost. */
  | { kind: 'tapOthers'; selector: Selector; count: number; allowSelf?: boolean }
  /** Tap X distinct untapped controlled permanents, where X is the announced activation value. */
  | { kind: 'tapXOthers'; selector: Selector }
  /** "Sacrifice this creature" — available even while tapped or summoning-sick. */
  | { kind: 'sacrificeSelf' }
  /** "Exile this permanent" — a battlefield-only activation cost. */
  | { kind: 'exileSelf' }
  /**
   * Sacrifice one or more other controlled permanents matching the filter. `onlyCardId` is set
   * only by the engine, never by a card: it pins the sacrifice to one permanent when a mana
   * source's output depends on which permanent is sacrificed (Illuminor Szeras).
   */
  | {
      kind: 'sacrificeOther';
      selector: Selector;
      count?: number;
      allowSelf?: boolean;
      onlyCardId?: string;
    }
  /** "Discard this card". */
  | { kind: 'discardSelf' }
  /** "Discard a card" from the controller's hand as a spell or activation cost. */
  | { kind: 'discardCard'; count?: number }
  | { kind: 'discardHand' }
  /** "Tap any number of untapped creatures you control with total power N or greater". */
  | { kind: 'tapCreaturesTotalPower'; minPower: number }
  /** "Remove a gold counter from this artifact". */
  | { kind: 'removeCounters'; counter: string; count: Value | number }
  /**
   * "Remove a +1/+1 counter from a creature you control" (Sage of Fables): the counters come off
   * one controlled permanent matching `selector`, chosen while paying, which may be the source.
   */
  | { kind: 'removeCountersFromAmong'; counter: string; count: number; selector: Selector }
  /** "Pay 10 life" (CR 118.8) — payable only if the controller's life is at least this much. */
  | { kind: 'payLife'; amount: number }
  /** Pay a state-derived amount of life, evaluated when the cost is checked and paid. */
  | { kind: 'payLifeValue'; amount: Value }
  /** Pay energy counters (CR 122.8). */
  | { kind: 'payEnergy'; amount: number }
  | { kind: 'loyalty'; delta: number }
  | { kind: 'mana'; cost: ParsedManaCost }
  /** "Exile this card from your graveyard" (Runehorn Hellkite) — a graveyard-only cost. */
  | { kind: 'exileSelfFromGraveyard' }
  /** Exile other cards from the controller's graveyard as an Escape-style casting cost. */
  | { kind: 'exileOtherCardsFromGraveyard'; count: number }
  /** Exile a matching card from the controller's hand as a casting cost (Force of Will). */
  | { kind: 'exileCardFromHand'; selector: Selector; count?: number }
  /** "Unattach this Equipment" (Sunforger) — payable only while attached; unattaches as the
   * cost is paid. Distinct from `attachSelfTo`, which is an EFFECT (equipping), not a cost. */
  | { kind: 'unattachSelf' };

export interface AlternativeCast {
  kind: 'overload' | 'adventure' | 'omen' | 'mdfc' | 'nonMana' | 'bestow' | 'split';
  /**
   * `split`: both halves cast fused (CR 702.102), from hand only. The face then has the combined
   * characteristics and resolves the left half's instructions, then the right's.
   */
  fused?: true;
  /** Explicit zone restriction/permission. Omitted alternatives use normal casting permissions. */
  from?: 'hand' | 'graveyard' | 'exile';
  manaCost: ParsedManaCost;
  /** Non-mana components of a cost that replaces the spell's printed mana cost. */
  costs?: AbilityCost[];
  /** State condition required to choose this alternative cost at announcement. */
  condition?: Condition;
  /** Explicit instant timing for a conditionally permitted alternative such as Sneak. */
  instantTiming?: true;
  description: string;
  name?: string;
  typeLine?: string;
  ability?: Ability;
  /** Back-face characteristics for a modal DFC that may be played as a land. */
  landFace?: MdfcLandFace;
  /** Fully interpreted Adventure/Omen spell or modal permanent face, independent of the front. */
  spellFace?: import('./definition').CardDefinition;
  /** Printed face text needed to restore the front when a modal permanent leaves. */
  spellFaceText?: Pick<
    MdfcLandFace,
    'oracleText' | 'manaCost' | 'frontOracleText' | 'frontManaCost'
  >;
  /** Flashback/escape-style replacement: exile the card after it leaves the stack. */
  exileOnResolution?: boolean;
  /** The alternative is Escape and marks the resulting stack/permanent object as escaped. */
  escaped?: true;
  /**
   * Dash (CR 702.109a): the permanent this spell becomes gains haste, and it's returned from the
   * battlefield to its owner's hand at the beginning of the next end step.
   */
  dashed?: true;
}

export interface MdfcLandFace {
  name: string;
  typeLine: string;
  oracleText: string;
  manaCost: string | null;
  frontOracleText: string;
  frontManaCost: string | null;
  colors: Color[];
  supertypes: string[];
  types: string[];
  subtypes: string[];
  manaAbilities: ManaAbilitySpec[];
  entersTapped: boolean;
  entersTappedUnless?: Condition;
}

/** The `{T}` cost every mana ability has unless it says otherwise. */
export const TAP_COST: readonly AbilityCost[] = [{ kind: 'tap' }];

/**
 * An activated ability: "`<costs>`: `<effect>`" (CR 602). Unlike a mana ability it uses the
 * stack, so it takes targets, can be responded to, and can be countered.
 */
export interface ActivatedAbility {
  costs: AbilityCost[];
  ability: Ability;
  /** An activation restriction checked while legal options are generated and applied. */
  condition?: Condition;
  /** Sorcery requires main/empty stack/your turn; yourTurn only requires the active player. */
  timing: 'any' | 'sorcery' | 'yourTurn';
  /**
   * "Activate only once each turn" (CR 602.5f). Tracked per *permanent*, not per card: two
   * copies of Beledros each get their own activation.
   */
  oncePerTurn?: boolean;
  /** Zone from which the ability is activated (default: battlefield). */
  zone?: 'hand' | 'battlefield' | 'graveyard';
  /** Boast (CR 702.146): "Activate only if this creature attacked this turn." */
  requiresAttackedThisTurn?: true;
  /**
   * A Boast ability (CR 702.142), for effects that name Boast abilities (Dragonkin Berserker's
   * reduction). Other "activate only if this attacked" abilities are not Boast abilities.
   */
  boast?: true;
  /**
   * Exhaust (CR 702.177): "Activate each exhaust ability only once." Tracked per permanent and
   * never reset, so a permanent that leaves and returns is a new object that may exhaust again.
   */
  exhaust?: true;
}

/**
 * Production whose symbol set is not printed on the card but derived from game state. Resolved
 * at query time (`manaSourcesFor`), because the answer changes as the board does — Fellwar
 * Stone taps for nothing at all until an opponent has a land.
 */
export type DynamicManaKind =
  /** "one mana of any color in your commander's color identity" (Command Tower). */
  | 'commanderIdentity'
  /** "one mana of any color that a land an opponent controls could produce" (Fellwar Stone). */
  | 'opponentLandColors'
  /**
   * A modal DFC land (Pathway lands): produces whichever single color this specific permanent
   * chose as it entered (`EnginePermanent.chosenOption`, via `CardDefinition.entersChoosingOption`
   * — the same field Caged Sun's color pick and Frontier Siege's mode pick already use). Empty
   * (no mana at all) if the permanent hasn't recorded a choice, which should never actually
   * happen for a card this ability is put on — `entersChoosingOption` resolves before anything
   * else can observe the permanent.
   */
  | 'chosenColor'
  | 'colorsAmongPermanents'
  | 'oneColorAmongPermanents'
  /**
   * "one mana of any type that a land YOU control could produce" (Reflecting Pool) - the same
   * union as `opponentLandColors` over the other side of the table, and it keeps {C}: "any TYPE"
   * is broader than "any color", so a Wastes contributes colorless.
   */
  | 'ownLandTypes'
  /** "…any color among legendary creatures and planeswalkers you control" (Mox Amber). */
  | 'legendaryPermanentColors'
  /** "one mana of any of the exiled card's colors" (Chrome Mox): cards still exiled with it. */
  | 'exiledWithSourceColors';

/**
 * What a payment is *for*, so restricted mana can decide whether it may pay (CR 106.6).
 *
 * A restriction is a property of the **payment as a whole**, never of an individual pip: "spend
 * this mana only to cast a Dragon creature spell" is answered once, before any mana moves. That
 * is what lets `planPayment` treat restricted mana as a plain filter — see `ManaRestriction`.
 */
export type PaymentPurpose =
  /** Casting a spell. `card` is the spell's *printed* candidate — it is not on the battlefield. */
  | {
      kind: 'castSpell';
      oracleId: string;
      isCommander?: boolean;
      spellDefinition?: import('./definition').CardDefinition;
    }
  /** Activating an ability of a permanent. */
  | { kind: 'activateAbility'; sourceOracleId: string }
  /**
   * Anything else that charges mana — a ward tax, the companion {3}, an equip cost paid as part
   * of an activation the engine did not model as one. NO restricted mana may pay for this: an
   * unrecognized purpose must fail closed, or "spend only on X" silently becomes "spend on
   * anything" (brief §6.3).
   */
  | { kind: 'other' };

/**
 * "Spend this mana only to cast a Dragon creature spell" (CR 106.6).
 *
 * Deliberately a predicate over the *purpose*, not over individual pips. Because a purpose is
 * fixed for the whole payment, resolving a restriction yields one boolean per payment, and
 * restricted mana is then either fully usable or entirely unusable. That is what keeps the
 * payment solver's exactness argument intact: restrictions filter its inputs rather than adding
 * a dimension to its search.
 */
export interface ManaRestriction {
  /** Which kinds of payment this mana may be spent on. */
  purposes: ('castSpell' | 'activateAbility')[];
  /**
   * A filter over the spell's / ability source's printed characteristics — "a Dragon creature
   * spell". Absent means any object of the listed purposes ("spend this mana only to cast
   * spells", Klauth).
   */
  filter?: Selector;
  /** "…that shares a creature type with your commander" (Path of Ancestry). */
  sharesCreatureTypeWithCommander?: boolean;
  /** Printed text, for prompts and the event log. */
  description: string;
}

/**
 * "When you spend this mana to cast a Dragon creature spell, you gain 2 life" (Scaled Nurturer)
 * — a *reflexive* trigger that fires as the mana is consumed, not as it is produced.
 *
 * `when` reuses `ManaRestriction` rather than defining a parallel predicate type: "spend only
 * on X" and "when spent on X" ask exactly the same question, and the only difference is whether
 * a false answer forbids the payment or merely declines to fire.
 */
export interface ManaSpendTrigger {
  when: ManaRestriction;
  ability: Ability;
}

/** Executable immediate mana riders; scope-free operands are validated before activation. */
export type ManaRider =
  | Extract<Effect, { op: 'damageController' | 'gainLife' }>
  | (Omit<Extract<Effect, { op: 'putCounters' }>, 'target'> & { target: 'source' });

/** A mana ability: "{T}: Add …". Never uses the stack (CR 605). */
export interface ManaAbilitySpec {
  /** Fixed symbol units. Each unit is one mana; several symbols in a unit are a choice. */
  units: ManaUnit[];
  /**
   * Activation cost. Absent means the overwhelmingly common `{T}` (see `TAP_COST`), which is
   * what every land and mana rock the interpreter produced before non-tap costs existed.
   * A `mana` component is supported: the planner orders earlier production so it can pay
   * this activation's mana cost before this source produces anything.
   */
  costs?: AbilityCost[];
  /** When set, `units` is ignored and the symbols are derived from state at query time. */
  dynamic?: DynamicManaKind;
  /** "Activate only if you control a Dragon." Evaluated when listing available sources. */
  condition?: Condition;
  /**
   * A rider applied when this ability is activated — "This land deals 1 damage to you"
   * (painlands). Mana abilities never use the stack (CR 605.3a), so the rider applies
   * immediately as the mana is produced, which is exactly the printed behavior.
   */
  onActivate?: ManaRider[];
  /** "Spend this mana only to cast a Dragon creature spell" — rides on the mana produced. */
  restriction?: ManaRestriction;
  /** "When you spend this mana to cast a Dragon creature spell, you gain 2 life." */
  spendTrigger?: ManaSpendTrigger;
  /** Mana spent on a spell makes that spell uncounterable. */
  uncounterableSpell?: true;
  /** "Until end of turn, you don't lose this mana as steps and phases end" (Klauth). */
  persistent?: boolean;
  /**
   * "…add two mana of any ONE color" — several units of `units` that must all resolve to the
   * SAME symbol, unlike an ordinary multi-unit production where each unit is an independent
   * choice. A separate flag rather than a new `ManaUnit` shape: it changes how the payment
   * solver assigns symbols across units of one source, not what any single unit can produce.
   */
  linked?: true;
  /**
   * "If you control a creature with power 4 or greater, add two mana of any one color instead"
   * (Ilysian Caryatid) — a conditional AMOUNT, not an activation gate like `condition`. When
   * `condition` holds, `units` (and `linked`) are REPLACED by this, not added to it: the base
   * production is not also on offer, matching "instead".
   */
  conditionalUnits?: { condition: Condition; units: ManaUnit[]; linked?: true };
  /**
   * "Add {G} for each creature you control" (Gaea's Cradle, Itlimoc) - a state-derived AMOUNT
   * with a fixed symbol, which is the opposite of `dynamic` (a state-derived symbol set with a
   * fixed amount).
   *
   * `units` describes ONE repetition and the whole of it is repeated this many times, resolved
   * at query time by `resolveDynamicAmount`. Zero repetitions produces no units at all, which
   * correctly stops the source being offered - Gaea's Cradle with no creatures taps for nothing.
   *
   * There is no other amount channel: `units.length` IS the mana count everywhere else, and
   * that is what this expands into, so nothing downstream needs to know the count was computed.
   */
  amount?: Value;
  /**
   * "Add an amount of {B} equal to the sacrificed creature's mana value" (Illuminor Szeras): the
   * ability makes one `units[0]` per point of mana value of the permanent its `sacrificeOther`
   * cost sacrifices. `manaSourcesFor` offers one source per sacrifice candidate, each pinned to
   * that permanent, so the payment solver sees exactly what each choice produces.
   */
  amountFromSacrificedManaValue?: true;
}

/**
 * One mana in a player's pool (CR 106.4). The engine-side pool is a LIST of these rather than
 * the shared `ManaPool`'s per-symbol counts, because two mana of the same color are no longer
 * interchangeable once one of them is restricted, carries a spend trigger, or survives the step.
 *
 * `PlayerState.manaPool` remains the flat count summary, derived from this — see `mana/pool.ts`.
 */
export interface ManaEntry {
  symbol: Color | 'C';
  /** CR 106.6 spending restriction, if any. */
  restriction?: ManaRestriction;
  /** Fires when this specific mana is consumed (Scaled Nurturer, Path of Ancestry). */
  spendTrigger?: ManaSpendTrigger;
  /** If consumed to cast a spell, that spell becomes uncounterable. */
  uncounterableSpell?: true;
  /** This mana was produced by a permanent with the Treasure subtype. */
  fromTreasure?: true;
  /** Survives `emptyManaPools` at the end of a step/phase (CR 500.4 exception — Klauth). */
  persistent?: boolean;
  /**
   * Stands for a creature tapped for convoke, not real mana (CR 702.51b): it pays the spell's
   * cost like mana but is never counted as mana spent.
   */
  convoked?: true;
}

/**
 * CR 702 keywords with real engine implementations (brief §6.1).
 *
 * Only the *unparameterized* ones live here. Ward and protection take an argument, so they are
 * separate `Characteristics` fields rather than members of this list — squeezing them in would
 * mean either stringly-typed keywords ("ward {2}") or a union that every `includes()` call site
 * has to destructure.
 */
export const IMPLEMENTED_KEYWORDS = [
  'flying',
  'reach',
  'trample',
  'deathtouch',
  'lifelink',
  'first strike',
  'double strike',
  'vigilance',
  'haste',
  'defender',
  'indestructible',
  'hexproof',
  'shroud',
  'menace',
  'flash',
  'changeling',
  'riot',
  'convoke',
  'improvise',
  'infect',
  'cascade',
  'storm',
  'rebound',
  'split second',
  // Evasion (CR 509.1b): checked in `canBlock` as blockers are declared.
  'fear',
  'intimidate',
  'skulk',
  'shadow',
  'plainswalk',
  'islandwalk',
  'swampwalk',
  'mountainwalk',
  'forestwalk',
  'nonbasic landwalk',
] as const;
export type KeywordAbility = (typeof IMPLEMENTED_KEYWORDS)[number];

/**
 * An activated or triggered ability on the stack as a copy effect needs it: everything decided
 * for it, so it can be copied from last known information after it has left the stack.
 */
export interface StackAbilitySnapshot {
  stackObjectId: string;
  kind: 'activatedAbility' | 'triggeredAbility';
  description: string;
  ability: Ability;
  targets: string[];
  countTargets?: Record<number, string[]>;
  divisionAmounts?: Record<string, number>;
  announcedX?: number;
  sourceId: string;
  sourceOracleId: string;
  sourceCardId: string;
  sourceColors?: Color[];
  /** The source's last known facts and damage keywords, if it had left (CR 707.10, 113.7a). */
  sourceFacts?: ObjectFacts;
  sourceDamageKeywords?: DamageKeyword[];
  /** The original's event facts, carried unchanged (CR 707.10). */
  triggerScope?: import('./value').TriggerScope;
  triggerObjectCardId?: string;
}

/** What a target slot may point at. Slot options are computed at cast/announcement time. */
export type TargetKind =
  | 'creature'
  | 'artifact'
  | 'enchantment'
  | 'land'
  | 'planeswalker'
  | 'permanent'
  | 'nonlandPermanent'
  | 'artifactOrEnchantment'
  /** "target artifact, enchantment, or planeswalker" (Fracture). */
  | 'artifactEnchantmentOrPlaneswalker'
  | 'player'
  | 'anyTarget' // creature, player, planeswalker, or battle (CR 115.4)
  | 'playerOrPlaneswalker' // "target player or planeswalker" (Clan Defiance)
  | 'spell'
  /** A spell on the stack or a nonland permanent. */
  | 'spellOrNonlandPermanent'
  /** Any object currently on the stack: spells, activated abilities, or triggered abilities. */
  | 'stackObject'
  /**
   * A card in a graveyard, not a permanent (CR 111.2). Defaults to the ability controller's
   * graveyard; TargetSpec can specify another player slot or controller/opponent/any scope.
   */
  | 'cardInGraveyard'
  /**
   * "Counter target noncreature spell" (Stubborn Denial) — a spell on the stack whose card is
   * NOT a creature. This common adjective retains its existing kind. General stack-spell
   * filters use the selected spell frame through shared target legality; a stack spell is
   * not a battlefield permanent and may have different characteristics from its physical card.
   */
  | 'noncreatureSpell'
  | 'commanderInCommandZone';

/** One declared target slot of an ability. Effects reference it by its index. */
export interface TargetSpec {
  kind: TargetKind;
  /** Select a uniformly random legal target as the trigger is put on the stack (Power Pack). */
  random?: true;
  /**
   * "Another target" (Saheeli, Sublime Artificer): an object or player chosen for one of these
   * earlier ordinary slots is not a legal choice here (CR 115.3).
   */
  differentFromSlots?: number[];
  /** These ordinary target slots must name different players. Inactive mode slots are absent. */
  differentPlayerTargetSlots?: number[];
  /** A stack spell must currently target a permanent controlled by you. */
  spellTargetsPermanentYouControl?: true;
  /** A stack spell or ability has exactly one targeting occurrence (CR 115.9a, Bolt Bend). */
  spellHasSingleTarget?: true;
  /**
   * A stack spell or ability that targets the ability's controller or a creature they control
   * (Siren Stormtamer). Checked as it is chosen and again on resolution (CR 608.2b).
   */
  stackTargetsYouOrCreatureYouControl?: true;
  /** Only this kind of stack object: "target triggered ability" (Mister Fantastic). */
  stackKind?: 'spell' | 'activatedAbility' | 'triggeredAbility';
  /**
   * "target creature you control" / "target creature an opponent controls". Omitted for an
   * unrestricted slot. Kept as a field rather than more `TargetKind` literals, which would
   * multiply combinatorially with every kind above.
   */
  controller?: 'you' | 'opponent' | 'eventPlayer' | 'activePlayer';
  /**
   * Additional characteristics after the target domain/kind check. Supports battlefield
   * permanents, stack spells, and graveyard cards (for example "Dragon permanent card").
   */
  filter?: Selector;
  /**
   * "up to two other targets" (Drakuseth) / "any number of target creatures" (Ureni) — a
   * VARIABLE number of objects chosen together at announcement (CR 601.2b/603.3d), instead of
   * the ordinary case of exactly one. Absent means the ordinary case, unchanged.
   *
   * A count slot's chosen ids live on `EngineStackObject.countTargets`, keyed by this slot's
   * index — the flat `targets` array a single-target slot uses has nothing sensible to hold
   * when a slot may end up with zero, one, or several objects. By convention every count slot
   * is allocated AFTER all of an ability's ordinary slots, so `targets` stays a dense array
   * covering exactly the ordinary slots and never needs a placeholder for the rest.
   */
  count?: { min: number; max: number };
  /**
   * "Any number of target nonland permanents with total mana value 6 or less" (Kairi) — a
   * budget on a `count` slot: each further choice must fit what the earlier ones left.
   */
  totalManaValueAtMost?: number;
  /**
   * "Target cards from THEIR graveyard" (Loaming Shaman) — for a `cardInGraveyard` slot, the
   * index of an EARLIER ordinary slot holding the player whose graveyard this searches, instead
   * of the ability's own controller. By the same "count slots are allocated after ordinary
   * slots" convention `count` relies on, that earlier slot is always already chosen by the time
   * this one is computed.
   */
  graveyardOwnerSlot?: number;
  graveyardOwnerScope?: 'controller' | 'opponent' | 'any';
  /**
   * "For each player, … up to one target creature that player controls" (Nils, Discipline
   * Enforcer): when the triggered ability is put on the stack this one spec becomes one optional
   * slot (`count` 0 to 1, which it must declare itself) for each player still in the game, in
   * turn order starting with the ability's controller (CR 603.3d), each limited to that
   * player's permanents. It must be the LAST target spec of a triggered ability; an effect that
   * names its slot (`…EachChosen`) acts on every slot of the group.
   */
  perPlayer?: true;
  /** Set when a `perPlayer` spec is expanded: only permanents this player controls may be chosen. */
  controllerPlayer?: PlayerId;
  /** Set when a `perPlayer` spec is expanded: the index of the spec this slot was expanded from. */
  slotGroup?: number;
  /**
   * "Target untapped creature" (Backlash) — the tapped state a battlefield permanent must have
   * when chosen and again as the spell or ability resolves (CR 608.2b). Selectors deliberately
   * cannot read tapped-ness (see selector.ts), so it lives on the target spec.
   */
  tapState?: 'untapped' | 'tapped';
}

/** One requirement an `addAttackRequirement` effect makes, with the players it names as references. */
export type AttackRequirementSpec =
  | { kind: 'anyAttack' }
  /** "a player other than you" */
  | { kind: 'notPlayer'; player: 'you' }
  /** "that player" */
  | { kind: 'player'; player: 'eventPlayer' };

/**
 * The declarative duration on `gainControl`/`gainControlTarget` IR. `'whileSourceOnBattlefield'`
 * stays a bare enum here (IR carries no object ids); the runtime resolves it to the source's
 * exact ObjectId when the effect resolves (CR 611.2b).
 */
export type GainControlIRDuration = 'permanent' | 'untilEndOfTurn' | 'whileSourceOnBattlefield';

/**
 * What a "targeted" primitive acts on.
 *
 * A number is the index into the owning `Ability.targets` whose chosen object is used — a real
 * target, announced and rechecked for legality (CR 608.2b).
 *
 * `'triggerObject'` is the object whose event fired the trigger: the "it" in "whenever a Dragon
 * you control attacks, IT gains double strike". That is explicitly NOT a target (CR 115.10a) —
 * it is never chosen, hexproof does not stop it, and the ability cannot fizzle on it. It simply
 * does nothing if that object has left the battlefield by resolution.
 *
 * A card's reference to its own source ("put a counter on this artifact") does not need a
 * referent at all: it is the one-element case of a `Selector`, and the `…Each` primitives
 * already express it as `{kind:'self'}`.
 */
export type EffectRef =
  | number
  | 'triggerObject'
  | 'attachedToSource'
  | 'source'
  /**
   * "deals 3 damage to THAT PLAYER" (Thunderbreak Regent) — the player involved in the firing
   * event (`ValueScope.eventPlayerId`), referenced directly rather than through a target slot
   * (CR text never says "target player" here — it is a reference, like `'triggerObject'`).
   */
  | 'eventPlayer'
  /**
   * "its controller" / "that creature's controller" (Backlash) — the player who controls the
   * permanent in the named target slot as the ability resolves, referenced directly rather than
   * through a player target slot.
   */
  | { controllerOf: number };

/**
 * One atomic mechanical primitive. Targeted primitives carry `target`: an `EffectRef` naming
 * the object they act on. Untargeted primitives affect the ability's controller / each
 * opponent.
 *
 * The `…EachUntilEot` primitives take a `Selector` instead of a target slot — "creatures you
 * control", not "target creature". They choose no targets and so are never announced; the
 * selector is evaluated once, when the spell resolves, and the resulting set is then fixed
 * (CR 611.2c).
 */
export type Effect =
  /**
   * "Amass Orcs 1" (CR 701.47a): if the controller controls no Army creature, they create a 0/0
   * black `subtype` Army creature token; then they choose an Army creature they control, put
   * `count` +1/+1 counters on it, and it becomes a `subtype` in addition to its other types if it
   * isn't one. The token is created before the counters, so state-based actions never see it
   * as 0/0.
   */
  | { op: 'amass'; subtype: string; count: Value }
  /**
   * "Choose two cards in your hand drawn this turn. For each of those cards, pay 4 life or put the
   * card on top of your library." (Sylvan Library): the controller chooses `count` cards in hand
   * that were drawn this turn (as many as there are, if fewer), then for each, in the order
   * chosen, pays `life` or puts it on top. Life can be paid only with at least that much life
   * (CR 119.4); a card that has left the hand meanwhile is skipped.
   */
  | { op: 'payLifeOrTopDrawnCards'; count: Value; life: Value }
  /**
   * "Return a creature or planeswalker card from your graveyard to your hand" (Takenuma): the
   * controller chooses one card matching `filter` in their graveyard as the effect resolves and
   * puts it into their hand. Not a target (CR 115.10), so it may be a card an earlier effect of the
   * same ability just put there; mandatory whenever one exists.
   */
  | { op: 'returnCardFromGraveyardToHand'; filter: Selector }
  | { op: 'pumpUntilEot'; target: EffectRef; power: Value | number; toughness: Value | number }
  | { op: 'grantKeywordUntilEot'; target: EffectRef; keyword: KeywordAbility }
  /** Target creature cannot be blocked this turn. */
  | { op: 'cantBeBlockedUntilEot'; target: EffectRef }
  /** "Creatures can't be blocked this turn" — every creature, including later arrivals. */
  | { op: 'creaturesCantBeBlockedThisTurn' }
  /** A resolution-time choice between effects (for example Pemmin's Aura's two stat modes). */
  | { op: 'chooseOne'; options: { effects: Effect[]; description: string }[] }
  /** Two creatures deal damage equal to their power to each other simultaneously (CR 701.12). */
  | { op: 'fight'; first: EffectRef; second: EffectRef }
  | {
      op: 'pumpEachUntilEot';
      selector: Selector;
      power: Value | number;
      toughness: Value | number;
      /** "each other creature" beside a trigger's subject (Martial Impetus): not that object. */
      exceptTriggerObject?: true;
    }
  /** Snapshot each matching creature's current P/T and add that much again until end of turn. */
  | { op: 'doublePowerAndToughnessEachUntilEot'; selector: Selector }
  | { op: 'grantKeywordEachUntilEot'; selector: Selector; keyword: KeywordAbility }
  /**
   * "Until end of turn, creatures your opponents control lose hexproof and shroud and can't have
   * hexproof or shroud" (Arcane Lighthouse). The affected set is fixed at resolution (CR 611.2c);
   * "can't have" beats any grant of those keywords, whatever its timestamp.
   */
  | { op: 'denyKeywordsEachUntilEot'; selector: Selector; keywords: KeywordAbility[] }
  /**
   * "Permanents your opponents control lose hexproof and indestructible until end of turn"
   * (Shadowspear): the permanents are fixed as it resolves (CR 611.2c) and lose the keywords in
   * layer 6 at this effect's timestamp, so a later grant restores them (CR 613.7).
   */
  | { op: 'loseKeywordsEachUntilEot'; selector: Selector; keywords: KeywordAbility[] }
  /**
   * "Those creatures gain `keyword` until end of turn" for an `attackDeclared` trigger (Frontier
   * Warmonger): exactly the creatures of the firing's attack group, bound when it fired and still
   * on the battlefield as the same objects (CR 400.7); the set is fixed at resolution (CR 611.2c).
   */
  | { op: 'grantKeywordToAttackGroupUntilEot'; keyword: KeywordAbility }
  /**
   * "You put `count` `counter` counters on a creature you control" (Breena): chosen as it
   * resolves, not targeted; nothing happens if you control no creature.
   */
  | { op: 'putCountersOnCreatureOfChoice'; counter: string; count: number }
  /**
   * "Return that creature to its owner's hand at end of combat" for a `blocks` trigger (Wall of
   * Tears): creates a delayed trigger for the end of combat step (CR 511) that returns the
   * creature this blocker blocked, remembered by object, so one that left and came back as a new
   * object is not returned (CR 400.7). The delayed trigger does not depend on the blocker.
   */
  | { op: 'returnBlockedCreatureAtEndOfCombat' }
  /**
   * "Creatures you control gain protection from each color until end of turn" (Akroma's Will).
   * Separate from `grantKeywordEachUntilEot` because protection carries an ARGUMENT: it is not a
   * `KeywordAbility` name, and layer 6 applies it through `addProtection`, not `addKeyword`.
   */
  | { op: 'grantProtectionEachUntilEot'; selector: Selector; colors: Color[] }
  | { op: 'grantChosenColorProtectionUntilEot'; target: EffectRef }
  | { op: 'returnSpellToOwnerHand'; target: EffectRef }
  /** "Change the target of target spell or ability with a single target" (CR 115.7a). */
  | { op: 'changeSingleTarget'; target: EffectRef }
  /** "You may choose new targets for target spell or ability" (CR 115.7d); not a copy. */
  | { op: 'chooseNewTargets'; target: EffectRef }
  /** Exile the exact graveyard incarnation that fired this card-zone trigger. */
  | { op: 'exileGraveyardEventCard' }
  | { op: 'sacrificeTargetPlayerCreature'; target: EffectRef }
  | { op: 'eachPlayerKeepsCreatureWithVow' }
  | { op: 'separatePermanentsIntoPilesThenSacrifice'; target: EffectRef }
  /**
   * "Separate all creatures that player controls into two piles. Only creatures in the pile of
   * their choice can attack this turn" (Fight or Flight): the effect's controller separates the
   * event player's creatures, that player chooses a pile, and a restriction until the end of the
   * turn lets only the creatures in it attack. It is a rules modification (CR 611.2c), so a
   * creature that arrives later is in neither pile and can't attack.
   */
  | { op: 'separateIntoPilesLimitAttackers' }
  | { op: 'dealDamage'; target: EffectRef; amount: Value; source?: EffectRef } // to the slot's creature or player
  /**
   * "deals N damage to target opponent unless that player sacrifices a creature of their
   * choice" (Demanding Dragon, Tomb Blade) — the choice belongs to the TARGET, not the
   * controller, unlike every other "unless" effect in this file (`counterUnlessPays` etc.),
   * which is why it needs its own op rather than composing with an existing one.
   */
  | { op: 'dealDamageUnlessSacrifice'; target: EffectRef; amount: Value }
  | { op: 'destroy'; target: EffectRef; cantRegenerate?: boolean } // target creature
  /** Create one "next destruction this turn" replacement shield (CR 701.19a). */
  | { op: 'regenerate'; target: EffectRef }
  | { op: 'destroyAndCreateTokenForController'; target: EffectRef; spec: TokenSpec; count: Value }
  | { op: 'exileAndGainLifeTargetController'; target: EffectRef }
  | { op: 'damageEachCreatureController'; amount: Value }
  | { op: 'sacrificeAndDrawForPower' }
  | {
      op: 'sacrificeGreatestEachOpponent';
      selector: 'creature' | 'creatureOrPlaneswalker';
      metric: 'power' | 'manaValue';
      action: 'sacrifice' | 'exile';
      /** After exile, deal each player its creature's last-known power if spell mastery holds. */
      damageIfGraveyardSpellsAtLeast?: number;
    }
  | { op: 'transferCountersFromTriggerObject'; target: EffectRef }
  | { op: 'transferCountersFromTriggerObjectToChosenCreatures'; targetSlot: number }
  | { op: 'mayForgoTriggerObjectCombatDamageForRandomDiscard' }
  | { op: 'gainClassLevel'; level: number }
  | { op: 'drawForOpponentsWithSmallHands'; maximum: number }
  | { op: 'phaseOutAndProtectControllerUntilNextTurn' }
  /** The One Ring: protection from everything until your next turn, without the life lock. */
  | { op: 'controllerProtectionFromEverythingUntilNextTurn' }
  /** Clever Concealment: each chosen permanent phases out until its controller's next turn. */
  | { op: 'phaseOutEachChosen'; targetSlot: number }
  | { op: 'prohibitSpellsThisTurn' }
  | { op: 'controllerHexproofUntilEot' }
  | { op: 'exileSpellAndPlot'; target: EffectRef }
  | { op: 'sacrificeNonlandOrDiscardOrLoseLife'; target: EffectRef; amount: Value }
  /**
   * "When this creature dies, ... put those counters on target creature you control" (Iron
   * Apprentice): every counter the ability's own source last had (CR 603.10a), each kind and
   * number, through counter-placement replacements.
   */
  | {
      op: 'transferCountersFromSource';
      target: EffectRef;
      /**
       * Only this kind (Modular, CR 702.43a: "a +1/+1 counter … for each +1/+1 counter on this
       * permanent"); absent, every kind moves.
       */
      counter?: string;
    }
  /**
   * "Move a +1/+1 counter from this creature onto it" (Graft, CR 702.58a): remove up to `count`
   * counters of the kind from `from` and put that many on `to` (CR 122.5), so counter-placement
   * replacements apply to the second half. If either object is gone, nothing moves.
   */
  | { op: 'moveCounters'; from: EffectRef; to: EffectRef; counter: string; count: number }
  /**
   * "Move all counters from ~ onto target creature" (The Ozolith): every counter of every kind on
   * `from` is removed and that many of each kind put on `to` (CR 122.5), so counter-placement
   * replacements apply to the second half. If either object is gone, or they are the same object,
   * nothing moves.
   */
  | { op: 'moveAllCounters'; from: EffectRef; to: EffectRef }
  /**
   * "Bolster N" (CR 701.39a): as it resolves, the controller chooses a creature with the least
   * toughness among creatures they control and puts N +1/+1 counters on it. Not a target.
   */
  | { op: 'bolster'; count: number }
  /**
   * "Move any number of +1/+1 counters from this creature onto other creatures" (Forgotten
   * Ancient): the controller divides as many of the source's counters as they like among
   * permanents matching `selector`, then they all move at once — one placement per recipient, so
   * a counter-placement replacement applies once to each creature, not once per counter.
   */
  | { op: 'distributeCountersFromSource'; counter: string; selector: Selector }
  | { op: 'mayPayLifeForTriggerPowerAndCounter' }
  | { op: 'vindictiveLichModes' }
  | { op: 'returnExiledAttachedCard' }
  | { op: 'sacrificeOneCreatureEachPlayer' }
  | { op: 'sacrificeOtherForMana' }
  | { op: 'livingDeath' }
  | { op: 'exileGraveyardCreateTokens'; target: EffectRef; spec: TokenSpec }
  | { op: 'millAndCreateTokensForCreatures'; spec: TokenSpec }
  | { op: 'returnArtifactCreaturesUpToManaValue'; maxManaValue: number }
  | { op: 'halfLifeDrainTargetOpponent' }
  /**
   * "target opponent loses half their life, rounded up" (Shard of the Nightbringer): the half is
   * computed from the target's life as it resolves; the loss is banked for a following "life
   * lost this way".
   */
  | { op: 'loseHalfLifeTarget'; target: EffectRef }
  | { op: 'tombBladeHit'; target: EffectRef }
  | { op: 'emptyLibraryCreatureOrLose' }
  | { op: 'exileResolvingSpell' }
  | { op: 'millTargetPlayer'; target: EffectRef; count: number }
  | { op: 'millAndChooseArtifact' }
  | { op: 'dealDamageNonbasicLands'; target: EffectRef }
  | { op: 'sacrificeOneEachOpponent'; filter: 'creature' | 'nonland' | Selector }
  | { op: 'sacrificeEachPlayer'; count: number; filter: 'creature' | 'any' }
  /**
   * Annihilator N (CR 702.86a): "defending player sacrifices N permanents" of their choice — the
   * attack trigger's event player, all at once.
   */
  /** Smokestack: "that player sacrifices a permanent … for each soot counter". */
  | { op: 'eventPlayerSacrificesPermanents'; count: Value | number }
  /**
   * "Each opponent attacking that player untaps all nonland permanents they control" (Curse of
   * Bounty): the attacking player (the event player), only if they are an opponent of this
   * ability's controller.
   */
  | { op: 'attackingOpponentUntapsNonland' }
  /**
   * Animate Dead's enters trigger, "if it's on the battlefield": it now enchants only the creature
   * put onto the battlefield with it; the creature card it enchants, if still in a graveyard,
   * returns under this ability's controller and this Aura attaches to it with a new timestamp
   * (CR 613.7e); and "when this Aura leaves the battlefield, that creature's controller
   * sacrifices it" is set up as a delayed trigger on this Aura object (CR 603.7).
   */
  | { op: 'reanimateEnchantedCardAndAttach' }
  /** The delayed half: that exact object, if it is still on the battlefield, is sacrificed. */
  | { op: 'sacrificeRememberedPermanent'; objectId: string }
  | {
      op: 'putCounterByPermanentType';
      target: EffectRef;
      creatureCounter: string;
      planeswalkerCounter: string;
      count: Value | number;
    }
  | { op: 'drawRevealTopLoseManaValue' }
  /** Reveal both players' top cards, lose the other's mana value, then put each into hand. */
  | { op: 'mutualRevealTopLoseManaValue'; target: EffectRef }
  /** CR 701.57: exile to a bounded hit, cast it or put it into hand, randomly bottom the rest. */
  | { op: 'discover'; count: Value }
  | { op: 'revealUntilAura' }
  | { op: 'exileEachUntilNonlandCast' }
  | { op: 'revealCreatureOrBottom' }
  /** CR 701.44: the permanent's current (or last) controller performs the exploration. */
  | { op: 'explore'; target: EffectRef }
  /**
   * Exile the top card of a library. `player: 'each'` exiles the top card of each player's library;
   * with `castFree`, "then you may cast any number of spells from among those cards without paying
   * their mana costs" (Etali, Primal Storm), chosen one at a time.
   */
  | {
      op: 'exileLibraryTop';
      player: 'you' | 'eventPlayer' | 'each';
      castFree?: true;
      grantCastUntilEot?: true;
      spendAsAnyColor?: true;
    }
  | { op: 'partitionLibrary'; count: number; mode: 'handBottomExile' | 'permanentsAndHand' }
  | { op: 'recruit' }
  | { op: 'trickery'; target: EffectRef }
  | { op: 'exileAndCastNextUpkeep'; target: EffectRef }
  | { op: 'castRememberedExile'; objectId: ObjectId; exileSpell: true }
  | { op: 'capstoneParadigm'; minimumManaValue: number }
  | {
      op: 'castParadigmCopy';
      template: {
        definition: import('./definition').CardDefinition;
        oracleText: string;
        manaCost: ManaCostString | null;
      };
    }
  | { op: 'goadEachOpponent' }
  | { op: 'createTreasureForDeaths' }
  | { op: 'preventCombatDamageAll' }
  /**
   * "Prevent all damage that would be dealt to you this turn" (Selfless Squire): a shield that
   * lasts until the turn's cleanup step. It applies to damage that would be dealt after it is
   * created, combat or not, from any source.
   */
  | {
      op: 'createDamageShield';
      /** Whose damage the shield prevents. Omitted for a shield on the creature `target` names. */
      player?: 'you';
      /**
       * "Prevent all combat damage that would be dealt to and dealt by that creature this turn"
       * (Delirium): the shield is on this one permanent, by object, not on a player.
       */
      target?: EffectRef;
      /** Object shield: the damage it prevents is damage dealt to the permanent. */
      dealtTo?: true;
      /** Object shield: the damage it prevents is damage dealt by the permanent. */
      dealtBy?: true;
      /** Only combat damage is prevented. */
      combatOnly?: true;
      /**
       * "A source of your choice" (Deflecting Palm, CR 609.7a): as it resolves its controller
       * chooses any permanent on the battlefield or spell on the stack, and only damage from that
       * object is prevented.
       */
      chosenSource?: true;
      /** "The next time ... would deal damage": the shield ends when it first prevents damage. */
      oneShot?: true;
      /** "... deals that much damage to that source's controller": dealt as the damage is prevented. */
      reflect?: 'toSourceController' | 'toSourceCreatureElseController';
      /** "... dealt to you and planeswalkers you control": the shield covers those too. */
      andPlaneswalkersYouControl?: true;
      /** "... by sources you don't control", checked as the damage would be dealt. */
      sources?: 'youDontControl';
    }
  /** "Copy target … spell" (CR 707.10); `newTargets`: "you may choose new targets for the copy". */
  | { op: 'copyTargetSpell'; target: number; newTargets?: true }
  /**
   * Replicate's cast trigger (CR 702.56a): copy the spell `count` times, each copy's controller
   * choosing to keep or change its targets (CR 707.10c). `spell` is the cast spell as it was put
   * on the stack — the last known information the copies use if it has left (CR 707.10).
   */
  /**
   * "Copy that spell" / "you may copy it" in a cast trigger (Cosmic Crucible, Galvanic
   * Iteration), with "you may choose new targets for the copy" (CR 707.10c). Bound to the cast
   * spell when the trigger is put on the stack: it becomes a one-copy `replicateCopies`, which
   * copies the spell's last known information if it has left the stack (CR 707.10).
   */
  | { op: 'copyCastSpell'; optional?: true; oncePerTurn?: true }
  /**
   * "When you next cast a [filter] spell this turn, [ability]" (Galvanic Iteration): a delayed
   * cast trigger that fires once, for its controller's next matching cast, and lapses at cleanup.
   */
  | { op: 'nextCastThisTurn'; filter: Selector; ability: Ability }
  /**
   * "Copy that ability" in an activation trigger (Verrak, Rowan Kenrith's emblem), with "you may
   * choose new targets for the copy" (CR 707.10c). Bound to the activated ability when the
   * trigger is put on the stack: it becomes a `copyStackAbility` of that ability's last known
   * information. `mayPayLifeAgain`: "you may pay that much life again. If you do, copy it."
   */
  | { op: 'copyActivatedAbility'; mayPayLifeAgain?: true }
  /**
   * A bound `copyActivatedAbility`: copy `stackAbility`, even if it has left the stack (CR
   * 707.10), with new targets chosen by the copy's controller. `lifeCost` is paid first, and
   * nothing is copied unless the controller chooses to and can pay it.
   */
  | { op: 'copyStackAbility'; stackAbility: StackAbilitySnapshot; lifeCost?: number }
  /**
   * "Copy target triggered ability you control twice. You may choose new targets for the
   * copies." (Mister Fantastic, CR 707.10).
   */
  | { op: 'copyTargetAbility'; target: EffectRef; count: number; newTargets?: true }
  /**
   * "Create a token that's a copy of one of them" (Twilight Diviner): the controller chooses one
   * permanent of the aggregate group that fired this trigger. One that has left the battlefield
   * is copied from its last known information (CR 707.2, 608.2h).
   */
  | { op: 'createTokenCopyOfEventGroupMember'; count: Value }
  /**
   * "You may return one of those Dragons to its owner's hand" (Zurgo and Ojutai): the controller
   * may choose one permanent of the aggregate group that fired this trigger. Only a member still on
   * the battlefield as the same object can be returned (CR 400.7).
   */
  | { op: 'mayReturnEventGroupMemberToHand' }
  | {
      op: 'replicateCopies';
      count: number;
      /** "You may copy it": the controller decides on resolution. */
      optional?: true;
      /** "Do this only once each turn": at most one resolution per source object per turn. */
      oncePerTurn?: true;
      spell: {
        stackObjectId: string;
        oracleId: string;
        name: string;
        targets: string[];
        oracleText: string;
        manaCost: string | null;
        /** Complete cast decisions used if the original has left the stack. */
        definition?: import('./definition').CardDefinition;
        ability?: Ability;
        announcedX?: number;
        /** The opponent promised a gift as it was cast (CR 702.174); a copy keeps the promise. */
        giftRecipientId?: PlayerId;
        countTargets?: Record<number, string[]>;
        divisionAmounts?: Record<string, number>;
        optionalCostCounts?: Partial<
          Record<'kicker' | 'squad' | 'offspring' | 'replicate', number>
        >;
        wasKicked?: boolean;
        kicked?: boolean;
        targetNames?: Record<string, string>;
      };
    }
  | { op: 'copyEachTargetedSpell'; targetSlot: number; newTargets?: true }
  | { op: 'angelGrace' }
  /** "You may cast spells this turn as though they had flash" (Borne Upon a Wind, CR 601.3b):
   * the controller's timing permission until the turn ends (CR 514.2). */
  | { op: 'castAsThoughFlashThisTurn' }
  | { op: 'drawForEachOpponent' }
  | { op: 'drawTargetAndController'; target: EffectRef }
  | { op: 'inkshield' }
  | { op: 'gisela' }
  | { op: 'humbleDefector'; target: EffectRef }
  | { op: 'shadrixModes' }
  | { op: 'masterOfCeremonies' }
  | { op: 'drawTargetAndControllerN'; target: EffectRef; count: number }
  /** Each chosen player searches, shuffles, then puts the found card on top without a zone change. */
  | { op: 'schemingSymmetry'; targetSlot: number }
  | { op: 'kambal' }
  | { op: 'destroyAndCreateTokensEqualToManaValue'; target: EffectRef; spec: TokenSpec }
  | { op: 'exile'; target: EffectRef } // target creature
  | { op: 'exileCard'; target: EffectRef }
  | {
      op: 'counter';
      target: number;
      exileIfCountered?: boolean;
      addManaAtNextMainPhase?: boolean;
      /**
       * "If [condition], add an amount of {C} equal to the amount of mana spent to cast that
       * spell at the beginning of your next main phase" (Mana Sculpt). Checked once as this
       * resolves; the delayed trigger is created whether or not the spell could be countered.
       */
      manaSpentAtNextMainPhase?: { condition: Condition };
    }
  /** Counter a spell, then create tokens for that spell's controller (Offer/Swan Song). */
  | { op: 'counterAndCreateTokenForController'; target: number; spec: TokenSpec; count: Value } // target spell — always a real target
  | { op: 'sacrifice'; target: EffectRef }
  /** Sacrifice one matching controlled permanent, then perform linked effects only if it happened. */
  | { op: 'sacrificeOneThen'; selector: Selector; then: Effect[] }
  /**
   * "Sacrifice it. When you do, …" (Brokers Hideout) — a reflexive trigger (CR 603.12). If the
   * source is sacrificed, `then` triggers and goes on the stack as its own ability, with a
   * priority window in between; if it could not be sacrificed, nothing triggers.
   */
  | { op: 'sacrificeSourceThenReflexive'; then: Ability }
  /**
   * "You may pay {R}{G}{W}{U}. When you do, …" (The Thing) — a reflexive trigger (CR 603.12) on a
   * payment made while this ability resolves. Paying fires `then`, which goes on the stack as its
   * own ability and announces its own targets then (CR 603.3d); declining fires nothing.
   */
  | { op: 'mayPayManaThenReflexive'; cost: ParsedManaCost; then: Ability }
  /**
   * "You may pay one or more {E}. When you do, …" (Territorial Aetherkite) — a reflexive trigger
   * (CR 603.12) on an energy payment of any amount from `min` up to all the energy you have,
   * made while this ability resolves. Paying fires `then`, which goes on the stack as its own
   * ability and reads the amount paid as `energyPaid`; declining fires nothing.
   */
  | {
      op: 'mayPayEnergyThenReflexive';
      min: number;
      then: Ability;
      /** "You may pay {E}{E}{E}" (Saheeli, Radiant Creator): exactly `min`, not more. */
      exact?: true;
    }
  /**
   * "Put a +1/+1 counter on Lockjaw. When you do, …" (CR 603.12): `then` triggers only if the
   * counters were actually put on the source — not if it left the battlefield first.
   */
  | { op: 'putCountersOnSourceThenReflexive'; counter: string; count: number; then: Ability }
  /**
   * "Gain control of target creature" — optionally until end of turn or for as long as a
   * source-bound grant lasts (`duration: 'whileSourceOnBattlefield'`, resolved to the exact
   * source ObjectId at runtime; a source off the battlefield at that moment gives no effect,
   * CR 611.2b). Omitted, the steal is permanent.
   */
  | {
      op: 'gainControlTarget';
      target: EffectRef;
      duration?: GainControlIRDuration;
      /**
       * Who ends up controlling the permanent. Omitted: the ability's controller.
       *
       * `{ targetPlayer: n }` names an ORDINARY player target slot chosen when the ability was
       * announced (Humble Defector). `{ chooseOpponent: true }` instead makes the recipient
       * itself a choice made as the effect resolves (CR 608.2d — the ability's controller chooses,
       * the player who cast the spell), among the living opponents of that controller at that
       * moment. The choice is NOT a target, so nothing about it is a targeting restriction: a
       * player with hexproof or shroud is still eligible, and there is no target slot to announce.
       * It is asked in instruction order, so it happens after any earlier instruction of the same
       * resolution (Wishclaw Talisman searches and shuffles before the gift).
       */
      recipient?: { targetPlayer: number } | { chooseOpponent: true };
    }
  | { op: 'putCounters'; target: EffectRef; counter: string; count: Value | number }
  | { op: 'putCountersEach'; selector: Selector; counter: string; count: Value | number }
  | {
      op: 'putCountersOnCreaturesTargetPlayerControls';
      target: EffectRef;
      counter: string;
      count: Value | number;
    }
  | { op: 'doubleCountersTarget'; target: EffectRef }
  | { op: 'doublePlayerCountersTarget'; target: EffectRef }
  | { op: 'doubleCountersEach'; selector: Selector }
  | { op: 'giveTargetPoisonCounters'; target: EffectRef | 'eachOpponent'; count: Value | number }
  | { op: 'removeCounters'; target: EffectRef; counter: string; count: Value | number }
  | { op: 'removeCountersEach'; selector: Selector; counter: string; count: Value | number }
  | { op: 'crewVehicle'; minPower: number }
  /**
   * "This Vehicle becomes an artifact creature until end of turn" from an ability other than
   * crew (Bespoke Battlewagon's energy ability). Same layer-4 effect as `crewVehicle`, but the
   * Vehicle does not become crewed (CR 702.122e), so "becomes crewed" triggers do not fire.
   */
  | { op: 'becomeArtifactCreature' }
  | { op: 'exileEach'; selector: Selector }
  | { op: 'exileEachOpponentGraveyard' }
  | { op: 'exileAllGraveyards' }
  /** Put the currently resolving spell card on the bottom of its owner's library. */
  | { op: 'resolvingSpellToLibraryBottom' }
  /**
   * "Exile Their Number Is Legion" as an instruction of the resolving spell itself: the card
   * goes from the stack to exile instead of its owner's graveyard. A spell that fizzles never
   * reaches this instruction (CR 608.2b) and goes to the graveyard as usual.
   */
  | { op: 'resolvingSpellExile' }
  /**
   * "Shuffle this card into your library from your graveyard" (Kogla and Yidaro): the ability's
   * source card, if it is still in its owner's graveyard, goes into that library, which is then
   * shuffled. If the card has left the graveyard, nothing happens.
   */
  | { op: 'shuffleSourceFromGraveyardIntoLibrary' }
  /**
   * "Shuffle ~ into its owner's library" on a resolving spell (Beacon of Unrest): the card goes
   * from the stack into its owner's library, which that player then shuffles. A spell that
   * fizzles never reaches this instruction and goes to its owner's graveyard as usual.
   */
  | { op: 'resolvingSpellShuffleIntoLibrary' }
  | { op: 'exileTargetPlayerGraveyard'; target: EffectRef }
  | { op: 'returnToHandEach'; selector: Selector }
  | { op: 'graveyardToBattlefieldEach'; filter: Selector; scope?: 'you' | 'all' }
  /**
   * "Return a creature card from your graveyard to the battlefield" with no target (Tomb
   * Fortress): the card is chosen as the effect resolves, after any earlier mill in the same
   * ability, from the cards then in your graveyard. Mandatory when one matches.
   */
  | { op: 'returnOneFromYourGraveyardToBattlefield'; filter: Selector }
  | { op: 'graveyardToHandEach'; filter: Selector; scope?: 'you' | 'all' }
  | { op: 'unearth' }
  | { op: 'grantUnearthToArtifactCreaturesInGraveyard'; cost: ParsedManaCost }
  | { op: 'exileSource' }
  | { op: 'draw'; count: Value; player?: 'controller' | 'eventPlayer' }
  /**
   * "You may play an additional land this turn" (Explore): the controller may play `count` more
   * lands this turn than the rules otherwise allow (CR 305.2). It grants the permission and
   * plays nothing; the extra plays lapse at end of turn.
   */
  | { op: 'additionalLandPlaysThisTurn'; count: Value }
  | { op: 'discard'; count: number } // controller chooses cards to discard
  /**
   * "You may discard a card. If you do, draw a card. If a creature card was discarded this way,
   * draw two cards instead" (Lukka, Wayward Bonder): `instead` replaces the draw count when the
   * discarded card matched its filter as it was discarded.
   */
  | {
      op: 'mayDiscardThenDraw';
      count: number;
      instead?: { filter: Selector; count: number };
    }
  /**
   * "This creature connives" (CR 701.50): draw a card, then discard a card; a nonland discard
   * puts a +1/+1 counter on the source, if it is still the same object on the battlefield.
   */
  | { op: 'connive' }
  /** Put a chosen number of cards from hand on top of the library, optionally ordering them. */
  | { op: 'putFromHandOnLibraryTop'; count: Value; anyOrder: boolean }
  /**
   * "Put any number of cards from your hand on the bottom of your library, then draw that many
   * cards plus one" (Valakut Awakening): the controller picks any subset of their hand, orders it
   * on the bottom (CR 401.4), then draws the number actually put there plus `extra`.
   */
  | { op: 'putAnyFromHandOnBottomThenDraw'; extra: number }
  /** Discard cards using the game PRNG rather than a player choice. */
  | { op: 'discardAtRandom'; count: Value }
  /** A specified player discards; random selection uses only the seeded game PRNG. */
  | { op: 'discardTarget'; target: EffectRef; count: Value; atRandom?: true }
  /** The affected player may discard a card; otherwise they lose the specified life. */
  | { op: 'discardOrLoseLife'; target: EffectRef; amount: Value }
  | { op: 'millEachPlayer'; scope: 'all' | 'opponents'; count: Value }
  /**
   * "Each player draws a card" (Faerie Mastermind), "Each opponent draws two cards": every
   * player in scope who has not lost draws, in APNAP order (CR 101.4).
   */
  | { op: 'eachPlayerDraws'; scope: 'all' | 'opponents'; count: Value }
  | { op: 'eachPlayerLosesLifeAndDraws'; amount: Value; count: Value }
  | { op: 'discardChosenPlayers'; targetSlot: number; count: Value }
  | { op: 'millAndLoseLifeChosenPlayers'; targetSlot: number; count: Value; amount: Value }
  /** Reveal a player's hand, then the resolving ability's controller chooses a matching discard. */
  | { op: 'revealHandAndDiscard'; target: EffectRef; filter: Selector }
  /** Players choose hidden cards in APNAP order before any chosen cards are discarded. */
  | {
      op: 'discardEachPlayer';
      scope: 'all' | 'opponents';
      count: Value;
      atRandom?: true;
      drawForDiscarded?: true;
      opponentsUnableLoseLife?: Value;
      nonlandMaySatisfyCount?: true;
    }
  | { op: 'mill'; count: Value } // controller mills
  | { op: 'gainEnergy'; amount: Value }
  /** Create a player-owned emblem containing abilities but no targetable characteristics. */
  | {
      op: 'createEmblem';
      name: string;
      abilities: Ability[];
      /** "Target player gets an emblem" (Rowan Kenrith): that player owns it, not the controller. */
      forPlayer?: EffectRef;
    }
  | { op: 'gainLife'; amount: Value } // controller gains
  /** "Each player gains N life", in APNAP order (CR 101.4). */
  | { op: 'eachPlayerGainsLife'; amount: Value }
  /** "Each player loses N life", in APNAP order (CR 101.4). */
  | { op: 'eachPlayerLosesLife'; amount: Value }
  /**
   * "Each player looks at the top N cards of their library and may reveal a land card and/or an
   * instant or sorcery card from among them. Each player puts the cards they revealed this way
   * into their hand and the rest on the bottom of their library in a random order" (Explore the
   * Vastlands): up to one card for each of `picks`, chosen in APNAP order (CR 101.4).
   */
  | { op: 'eachPlayerLooksAtTopRevealsToHand'; count: number; picks: Selector[] }
  | { op: 'loseLife'; amount: Value } // controller loses life (not damage)
  | { op: 'loseLifeTarget'; target: EffectRef; amount: Value }
  /** "Target player draws two cards." (Sign in Blood) — the target draws, not the controller
   * (contrast `drawTargetAndController`, where both do). */
  | { op: 'drawTarget'; target: EffectRef; count: Value }
  /**
   * "Target player gains 3 life" / "Its controller gains 4 life" (Nature's Claim): a player other
   * than the ability's controller gains life (CR 119.10).
   */
  | { op: 'gainLifeTarget'; target: EffectRef; amount: Value }
  /** Cascade — reveal until a lower-mana-value nonland, then optionally cast it for free. */
  | { op: 'cascade' }
  /** Rebound's optional next-upkeep cast from exile. */
  | { op: 'reboundCastFromExile' }
  | { op: 'eachOpponentLosesLife'; amount: Value | number; emptyHandOnly?: true }
  /**
   * "You gain life equal to the life lost this way" (Gray Merchant of Asphodel, Exsanguinate).
   * Reads back the life ACTUALLY lost by earlier life-loss effects of the SAME resolution —
   * which a life-loss floor can make smaller than the amount asked for — so it is scoped to one
   * `executeAbility` call and is 0 if nothing in this ability lost anyone life.
   */
  | { op: 'gainLifeEqualToLifeLostThisWay' }
  | { op: 'eachOpponentDamage'; amount: number | Value } // damage from source to each opponent
  /** "This land deals 1 damage to you" — damage from the source to its own controller. */
  | { op: 'damageController'; amount: number }
  /** "It deals 5 damage to each creature without flying" — the untargeted mass form. */
  | {
      op: 'damageEach';
      selector: Selector;
      amount: Value;
      source?: EffectRef;
      exceptSource?: true;
      /** "each tapped creature target player controls" (Rowan Kenrith): only that player's. */
      controlledBy?: EffectRef;
    }
  /** "~ deals X damage to each creature without flying AND EACH PLAYER" (Earthquake). */
  | { op: 'damageEachPlayer'; amount: Value; source?: EffectRef }
  /**
   * "It deals that much damage to each other opponent" (Human Torch): the source deals `amount`
   * to each opponent of the ability's controller except the event player, the opponent it just
   * dealt combat damage to.
   */
  | { op: 'damageEachOtherOpponent'; amount: Value }
  /**
   * "Search your library for a Forest card, put it onto the battlefield" (CR 701.19). One
   * `destinations` entry per card. A stated quality permits finding nothing; an unrestricted
   * quantity must find as many as possible. `count` (Harvest Season's "up to X, where X is...") repeats
   * `destinations[0]` that many times instead of a fixed-length array, since the number of
   * cards that may be found isn't known until resolution.
   */
  | {
      op: 'searchLibrary';
      filter: Selector;
      destinations: SearchDestination[];
      count?: Value;
      differentNames?: boolean;
      /** Preserve the found cards' stable identities for later effects in this resolution. */
      bind?: string;
      /** An explicitly optional unrestricted search; stated-quality searches may always fail to find. */
      allowFailToFind?: boolean;
      /**
       * "…, reveal it, …" (CR 701.16a): each found card is shown to every player, even when its
       * destination is a hidden zone such as the hand.
       */
      reveal?: boolean;
    }
  /**
   * "You may sacrifice an artifact, creature, enchantment, land, or planeswalker. If you do, each
   * opponent may sacrifice a permanent of their choice that shares a card type with it. For each
   * opponent who doesn't, that player loses 2 life and you draw a card." (Braids, Arisen
   * Nightmare): the controller's optional sacrifice of a permanent matching `selector`; then each
   * opponent, in APNAP order (CR 101.4), chooses a permanent sharing a card type with the
   * sacrificed one as it last existed, or none. The chosen ones are sacrificed together, and each
   * opponent who did not sacrifice loses `life` and the controller draws a card.
   */
  | { op: 'sacrificeThenOpponentsShareTypeOrPunish'; selector: Selector; life: Value }
  /**
   * "Take an extra turn after this one" (Plea for Power, CR 500.7): the controller's extra turn
   * comes directly after this one, ahead of extra turns created earlier.
   */
  | { op: 'takeExtraTurn' }
  /**
   * Will of the council: "Starting with you, each player votes for A or B. If A gets more votes,
   * …. If B gets more votes or the vote is tied, …." (Plea for Power, CR 701.38). Each player
   * who has not lost votes once, in turn order starting with the controller (CR 701.38a); the
   * votes are public. `more` runs when `choices[0]` has strictly more votes, `otherwise` on any
   * other result. No extra-vote effects exist in the engine, so each player votes once.
   */
  | {
      op: 'councilVote';
      choices: [string, string];
      more: Effect[];
      otherwise: Effect[];
    }
  /**
   * "Search your library and/or graveyard for a creature card with mana value X or less and put
   * it onto the battlefield. If you search your library this way, shuffle." (Finale of
   * Devastation): the controller chooses which of the two zones to search, may find nothing
   * (CR 701.19b), and shuffles only when the library was searched. `maxManaValue` is read as it
   * resolves.
   */
  | {
      op: 'searchLibraryAndOrGraveyardToBattlefield';
      filter: Selector;
      maxManaValue: Value;
    }
  /**
   * Choose a set of cards in one private-library decision, then validate the set as a whole.
   * This is distinct from repeated `searchLibrary` destinations: relations such as “share a
   * land type” constrain the final group, not each card independently.
   */
  | {
      op: 'searchLibraryGroup';
      filter: Selector;
      min: number;
      max: number;
      relation?: 'shareLandType';
      destination: SearchDestination;
      bind?: string;
    }
  /** Hunting Wilds: search two Forests and permanently animate only those found this way. */
  | { op: 'huntingWilds' }
  /** Etali's linked per-player exile and optional free-cast sequence. */
  /**
   * "Search your library for a `<filter>` card and cast that card without paying its mana
   * cost" (Sunforger) — like `searchLibrary`, but the found card is cast for free instead of
   * moved to a zone. Does not shuffle; pair with a `shuffle` op, as every printed search does.
   */
  | { op: 'searchLibraryCastFree'; filter: Selector }
  | { op: 'shuffle' }
  | { op: 'scry'; count: Value | number }
  | { op: 'surveil'; count: number }
  /** Choose any number of eligible players and permanents, then add one of each counter they have. */
  | { op: 'proliferate' }
  /**
   * Ward's payoff (CR 702.21b): counter the spell or ability that triggered this, unless its
   * controller pays. Not `counter`, which targets — this acts on the object below it on the
   * stack, which ward's own trigger recorded.
   */
  | { op: 'counterUnlessPays'; cost: WardCost; stackObjectId: string }
  /** Equip (CR 702.6): attach the ability's source to the target permanent. */
  | { op: 'attachSelfTo'; target: EffectRef }
  /**
   * "Create a … token. When you do, …" (Forum Filibuster): the reflexive trigger (CR 603.12)
   * fires only if a token was created, and "that token" is the one this ability just created
   * (its controller picks one if a replacement made several).
   */
  | { op: 'reflexiveOnCreatedToken'; then: Ability }
  /**
   * "Return up to one target Aura or Equipment card from your graveyard to the battlefield
   * attached to that token" (Forum Filibuster): each chosen card still in the graveyard enters
   * under the ability's controller attached to the trigger object. An Aura that can't enchant it,
   * or finds it gone, stays in the graveyard (CR 303.4i); an Equipment that can't equip it enters
   * unattached (CR 301.5e).
   */
  | { op: 'returnChosenCardsAttachedTo'; targetSlot: number; to: 'triggerObject' }
  /**
   * "You may attach it to the token" (Ajani's Chosen, `requireAura` for "if that enchantment is
   * an Aura") / "attach this Aura to that creature" (Shielded by Faith): move an Aura or
   * Equipment on the battlefield onto a permanent (CR 701.3). It doesn't move where it can't be
   * attached (CR 701.3b). `createdToken` is a token this ability created; if a replacement made
   * several, the controller picks one. `optional` asks first, offering only legal hosts.
   */
  | {
      op: 'attach';
      what: 'source' | 'triggerObject';
      to: 'triggerObject' | 'createdToken';
      requireAura?: true;
      optional?: true;
    }
  /** "Create a 1/1 black and green Pest creature token …" (CR 111.1). */
  | {
      op: 'createToken';
      spec: TokenSpec;
      count: Value;
      powerOverride?: number | Value;
      toughnessOverride?: number | Value;
      /** "Create N tapped … tokens" — they enter tapped, not enter then tap. */
      tapped?: boolean;
    }
  /**
   * Create a batch of tokens tapped and attacking a defending player chosen on resolution. They
   * were never declared as attackers (CR 506.3, 508.4): no attack trigger, no attack restriction
   * or cost applies to them.
   *
   * `player: 'eventPlayer'` makes the event player (the attacking player) the tokens' controller
   * instead of the ability's controller (Combat Calligrapher: "that attacking player creates …"),
   * and `defender: 'attackedPlayer'` names the player they attack, the one an `attackDeclared`
   * `perDefender` firing is about, instead of letting their controller choose.
   */
  | {
      op: 'createTokenAttacking';
      spec: TokenSpec;
      count: Value;
      powerOverride?: number | Value;
      toughnessOverride?: number | Value;
      player?: 'eventPlayer';
      defender?: 'attackedPlayer';
    }
  /** Create one token already attached to an announced permanent target. */
  | { op: 'createAttachedToken'; spec: TokenSpec; target: EffectRef }
  /** Create one token for each opponent, optionally attacking that opponent. */
  | {
      op: 'createTokenForEachOpponent';
      spec: TokenSpec;
      attacking?: boolean;
      /** "...attacking that player or a planeswalker they control" (Adeline). */
      orPlaneswalker?: boolean;
    }
  | {
      op: 'createTokenForPlayer';
      target: EffectRef;
      spec: TokenSpec;
      count: Value;
      opponentsOnly?: true;
    }
  | { op: 'createTokenForEachPlayerExceptTarget'; target: EffectRef; spec: TokenSpec; count: Value }
  /** Each living opponent creates these tokens under their own control. */
  | { op: 'eachOpponentCreatesTokens'; spec: TokenSpec; count: Value }
  /** Resolution-time non-target opponent choice, followed by both players creating tokens. */
  | { op: 'shareTokensWithChosenOpponent'; spec: TokenSpec; count: Value }
  /** A fresh opponent choice; both players gain life based on their own current creatures. */
  | { op: 'shareCreatureLifeWithChosenOpponent'; amount: Value }
  /**
   * "Create a token that's a copy of it, except the token isn't legendary" (Miirym).
   *
   * Copies the referent's **printed** characteristics (CR 707.2), not its current ones: a copy
   * of a pumped Dragon is not pumped, and a copy of one wearing an Equipment is unequipped.
   */
  | {
      op: 'createTokenCopyOf';
      ref: EffectRef;
      count: Value;
      exceptNonLegendary?: boolean;
      addTypes?: string[];
      powerOverride?: number | Value;
      toughnessOverride?: number | Value;
      addKeywords?: KeywordAbility[];
      sacrificeAt?: 'endStep';
      /**
       * "Each opponent creates a token that's a copy of it" (Life of the Party): each opponent of
       * the ability's controller is the creator and controls their own copies, and any
       * replacement of THEIR token creation applies.
       */
      eachOpponent?: true;
      /**
       * "The tokens are goaded for the rest of the game": the ability's controller goads each copy
       * and the goad never expires on its own (CR 701.15, 800.4a).
       */
      goadedForRestOfGame?: true;
    }
  /**
   * Embalm and eternalize (CR 702.128a, 702.129a): "Create a token that's a copy of it, except
   * it's a white Zombie [with base power and toughness 4/4] and has no mana cost." "It" is the
   * ability's source CARD, already exiled as the cost, so the copy takes the card's printed values
   * whatever happened to the exiled card since. `setColors` replaces its colors, `addSubtypes`
   * joins its creature types, and the token has no mana cost (mana value 0).
   */
  | {
      op: 'createTokenCopyOfSourceCard';
      setColors: Color[];
      addSubtypes: string[];
      basePower?: number;
      baseToughness?: number;
    }
  /** Source permanent becomes a copy of the referent's copiable values (CR 707.2). */
  | {
      op: 'becomeCopyOf';
      ref: EffectRef;
      untilEot?: boolean;
      addTypes?: string[];
      addSupertypes?: string[];
      nameOverride?: string;
    }
  | {
      op: 'becomeCopyOfTarget';
      target: EffectRef;
      ref: EffectRef;
      untilEot?: boolean;
      addTypes?: string[];
      addSupertypes?: string[];
      nameOverride?: string;
    }
  /** "Untap all lands you control" (Beledros). */
  | { op: 'untapEach'; selector: Selector }
  /** Untap the exact permanents stored by an earlier bound effect if the condition is true. */
  | { op: 'untapBoundIf'; binding: string; condition: Condition }
  /**
   * "Gain control of all Dragons" (Karrthus, Tyrant of Jund). Every touched permanent records a
   * control-change entry, even one already answering to the same controller: an effect expiring
   * later falls back to the surviving record underneath it (`refreshControlEffects`). Each
   * entry takes a fresh effect timestamp; the permanent's own layer timestamp is untouched.
   *
   * `duration` follows `gainControlTarget` (omitted = permanent). `untap`/`grantHaste` are the
   * generic “gain control, untap them, give them haste until end of turn” riders (Mob Rule,
   * Reins of Power style): the FROZEN CR 611.2c set is captured before any control changes and
   * all three clauses apply to that same set.
   */
  | {
      op: 'gainControl';
      selector: Selector;
      duration?: GainControlIRDuration;
      untap?: true;
      grantHaste?: true;
    }
  /** "Return target Dragon permanent card from your graveyard to the battlefield" (Bladewing). */
  | {
      op: 'graveyardToBattlefield';
      target: EffectRef;
      /** "under its owner's control" (Gift of Immortality); the ability's controller otherwise. */
      under?: 'owner';
      gainsHaste?: true;
    }
  /**
   * "Put target creature card from a graveyard onto the battlefield under your control. You
   * lose life equal to its mana value." (Reanimate) — combined into one effect rather than a
   * `graveyardToBattlefield` followed by a `loseLife` reading `manaValueOfTarget`, because
   * `manaValueOfTarget` only ever searches the BATTLEFIELD: the card has no mana value the
   * engine can read once it's already been moved, and it isn't on the battlefield yet before
   * the move. Reading it while the card is still located, then moving it, is the only order
   * that works — the same reason `destroyAndCreateTokenForController` is one effect instead of
   * two (Beast Within).
   */
  | { op: 'reanimateAndLoseLife'; target: EffectRef }
  /** "Return target Dragon creature card from your graveyard to your hand" (Haven). */
  | { op: 'graveyardToHand'; target: EffectRef }
  /** Put target card from your graveyard on top of your library. */
  | { op: 'graveyardToLibraryTop'; target: EffectRef }
  /** "Put target card from your graveyard on the bottom of your library" (Mistveil Plains). */
  | { op: 'graveyardToLibraryBottom'; target: EffectRef }
  /** "Return target creature to its owner's hand" — the general permanent-to-hand bounce. */
  | { op: 'returnToHand'; target: EffectRef }
  /** Return one permanent matching a selector; used by bounce lands' mandatory ETB. */
  | { op: 'returnOneToHand'; selector: Selector }
  /**
   * "Put a/any number of `<filter>` cards from your hand onto the battlefield" — Broodcaller
   * Scourge's single bounded pick and Last March of the Ents' unbounded "any number" share one
   * op because both are the same decision loop, asked once or repeated to a decline.
   */
  /**
   * "Mill five cards, then return a creature card milled this way to your hand" (Zoological
   * Study): mill `count`, then return one card matching `filter` from among the milled cards still
   * in the graveyard they went to. Mandatory when one exists (CR 701.17c follows a milled card).
   */
  | { op: 'millThenReturnMilledCard'; count: number; filter: Selector }
  | {
      op: 'handToBattlefield';
      filter: Selector;
      /** "with mana value less than or equal to that damage" (Broodcaller). Omitted ⇒ unbounded. */
      maxManaValue?: Value;
      count: 'one' | 'any';
    }
  /**
   * "Look at the top eight cards of your library. You may put a Dragon creature card from among
   * them onto the battlefield. Put the rest on the bottom of your library in a random order."
   *
   * One op rather than three, because the three sentences are not independent: the second and
   * third both act on the set the first revealed, which nothing in the IR carries between ops.
   */
  | {
      op: 'lookAtTopN';
      count: number;
      /** What may be taken from among them, and where it goes. Optional — "you may". */
      mayPut?: {
        filter: Selector;
        destination: SearchDestination;
        /** Publicly reveal only the chosen card before moving it (CR 701.16). */
        reveal?: true;
        /** After putting Equipment onto the battlefield, optionally attach it to your creature. */
        attachEquipment?: true;
        /** "Put one of them into your hand": a matching card must be taken, with no decline. */
        required?: true;
        /** "Put two of them into your hand" (Stock Up): that many picks, hand destination only. */
        count?: number;
      };
      /** Where everything not taken ends up; `graveyard`: "and the rest into your graveyard". */
      rest: 'bottomRandom' | 'topAnyOrder' | 'bottomAnyOrder' | 'graveyard';
      /** After replacing the looked-at cards, offer to shuffle the whole library. */
      mayShuffle?: true;
    }
  /** "Destroy all Dragon creatures" (Crux of Fate) — the untargeted mass form of `destroy`. */
  | { op: 'destroyEach'; selector: Selector; cantRegenerate?: boolean }
  /**
   * "3 damage to each of up to two other targets" (Drakuseth, Maw of Flames) — a FIXED amount
   * dealt independently to every object chosen in a variable-count slot (`TargetSpec.count`).
   * Distinct from `dealDamageDivided`: here each chosen target gets the full `amount`, not a
   * share of a total.
   */
  | { op: 'dealDamageEachChosen'; targetSlot: number; amount: Value }
  /**
   * "Return up to two other target nonland permanents to their owners' hands" (Marang River
   * Regent) — the return-to-hand analog of `dealDamageEachChosen`: every object chosen in a
   * variable-count slot is returned independently, no shared total to divide.
   */
  | { op: 'returnToHandEachChosen'; targetSlot: number }
  /** Toggle this transforming permanent between its front and back faces. */
  | { op: 'transformSelf' }
  /** "This creature becomes prepared" (CR 722.3a, 722.3c). */
  | { op: 'becomePrepared' }
  /**
   * "This Saga gains '{T}: Add {C}.'" (Urza's Saga): the source permanent gains the ability for
   * as long as it remains that object (CR 611.2c, 400.7). Exactly one of the two is set.
   */
  | { op: 'sourceGainsAbility'; manaAbility?: ManaAbilitySpec; activatedAbility?: ActivatedAbility }
  /**
   * "Put this artifact on top of its owner's library" (Sensei's Divining Top). Distinct from a
   * bounce: the destination is the LIBRARY of the OWNER, not the controller's hand, so a stolen
   * Top goes back to the library of the player who owns it (CR 400.3).
   */
  | { op: 'selfToLibraryTop' }
  | { op: 'putCountersEachChosen'; targetSlot: number; counter: string; count: Value | number }
  | { op: 'grantKeywordEachChosenUntilEot'; targetSlot: number; keyword: KeywordAbility }
  /**
   * "One or two target creatures can't block this turn" (Untimely Malfunction): every creature
   * chosen in the count slot that is still a legal target can't block until the turn ends.
   */
  | { op: 'cantBlockEachChosenThisTurn'; targetSlot: number }
  /** "Double the number of each kind of counter on any number of target permanents" (The Thing). */
  | { op: 'doubleCountersEachChosen'; targetSlot: number }
  /** "… and up to one other target creature you control can't be blocked this turn" (Lockjaw). */
  | { op: 'cantBeBlockedEachChosen'; targetSlot: number }
  | { op: 'untapUpTo'; selector: Selector; max: number }
  | { op: 'exileEachChosen'; targetSlot: number }
  /**
   * "Destroy up to N target …" — destroy each object chosen for a variable-count target slot
   * (possibly none), skipping any that became illegal (CR 608.2b).
   */
  | { op: 'destroyEachChosen'; targetSlot: number }
  /**
   * "Tap up to one target creature and goad it" (Killian, Decisive Mentor): each legal chosen
   * creature becomes tapped and is goaded by this ability's controller (CR 701.15a).
   */
  | { op: 'tapAndGoadEachChosen'; targetSlot: number }
  | {
      op: 'blinkEachChosen';
      targetSlot: number;
      returnUnder: 'owner' | 'sourceController';
    }
  | { op: 'regainControlOfOwnCreatures' }
  /** Untap both groups, then freeze both current creature sets and swap control with haste. */
  | { op: 'swapCreatureControlUntilEot'; target: number }
  | { op: 'exileTargetGraveyardAndBuffIfCreature'; targetSlot: number }
  | {
      op: 'pumpTargetPlayerCreaturesUntilEot';
      targetSlot: number;
      power: number;
      toughness: number;
    }
  | { op: 'untapTargetPlayerCreatures'; targetSlot: number }
  | { op: 'exileUntilSourceLeaves'; targetSlot: number }
  | { op: 'exileEachChosenUntilSourceLeaves'; targetSlot: number }
  | { op: 'destroyTargetAndControllerMaySearchBasicTypedLand'; target: EffectRef }
  | { op: 'exileCreatureAndControllerSearchBasicLand'; target: EffectRef }
  | { op: 'exileEachCreatureAndControllersSearchBasicLands'; selector: Selector }
  /** Remove a target, then let its controller search for a basic land (Path/Trophy). */
  | {
      op: 'removeTargetAndControllerMaySearchBasicLand';
      target: EffectRef;
      action: 'destroy' | 'exile';
      entersTapped: boolean;
    }
  | { op: 'populate' }
  | { op: 'untapAttackingPlayerNonlandPermanents' }
  /**
   * "X damage divided as you choose among any number of target creatures…" (Ureni, the Song
   * Unending) — CR 601.2d: the division is chosen at announcement, alongside the targets
   * themselves (every target must receive at least 1), and replayed unchanged at resolution —
   * the same "announce once, replay identically" shape `announcedX` already uses. The chosen
   * split rides on `EngineStackObject.divisionAmounts`.
   */
  | { op: 'dealDamageDivided'; targetSlot: number; total: Value }
  /**
   * "Ferocious — if you control a creature with power 4 or greater, `<do this>` instead"
   * (Stubborn Denial) — the smallest general shape that composes two already-tested effect
   * lists, rather than a card-specific op. `condition` is read at RESOLUTION (its board state
   * must be current then, not at announcement).
   */
  | {
      /**
       * "You gain 1 life if this is the first time this ability has resolved this turn. If it's
       * the second time, draw a card." (Belladonna Took) / "scry 1. If this is the second time
       * …, draw a card instead." (Rumor Gatherer): counts this resolution, then runs the case
       * for that count, or `otherwise`. `key` names the ability within its card.
       */
      op: 'byResolutionCountThisTurn';
      key: string;
      cases: { n: number; effects: Effect[] }[];
      otherwise: Effect[];
    }
  | {
      op: 'conditionalEffect';
      condition: Condition;
      then: Effect[];
      else: Effect[];
      /**
       * "If a creature is dealt damage this way" (Provoke the Trolls) — check `condition`
       * (typically `triggerObjectMatches`) against this resolved target instead of the ambient
       * trigger object, for a spell/ability whose own announced target is what needs checking.
       */
      checkTarget?: EffectRef;
    }
  /**
   * "Counter target spell unless its controller pays `<cost>`" (Stubborn Denial's base mode).
   * Unlike ward's `counterUnlessPays`, which acts on the object below it on the stack (recorded
   * by id because ward's trigger is never targeted), this reads its OWN ability's `target`
   * slot — an ordinary, announced target.
   */
  | { op: 'counterUnlessControllerPays'; target: number; cost: ParsedManaCost }
  /**
   * Execute `then` unless the designated player pays the cost (for example, Rhystic Study).
   *
   * `genericValue` is Esper Sentinel's "pays {X}, where X is this creature's power" — generic
   * mana whose amount is only known at resolution, ADDED to whatever `cost` prints. It is a
   * separate field rather than a `Value`-typed `cost` because every other user of this op pays
   * a printed cost, and `ParsedManaCost` is the shape `canPay` and `payManaCost` both take.
   *
   * `payer: 'eventObjectController'` asks the CURRENT controller of the exact original event
   * permanent — once it has departed, the controller it last had (departure LKI, CR 608.2h),
   * never the ability's `eventPlayer` and never a blinked new incarnation. It is only valid
   * with an owning permanent event-object scope (a non-self trigger subject); a payer who has
   * left the game cannot pay, so the unpaid branch runs with no prompt (CR 800.4).
   */
  | {
      op: 'unlessPays';
      payer: 'eventPlayer' | 'controller' | 'eventObjectController';
      cost: ParsedManaCost;
      genericValue?: Value;
      then: Effect[];
    }
  /**
   * "Add X mana in any combination of colors" (Klauth) — mana entering the pool from a
   * RESOLVING ability rather than an activation (CR 605 vs the stack). One color decision per
   * mana produced: a player choosing red, red, then blue for three mana ends up with exactly
   * the pool a single "distribute" choice would give, so asking per-mana is not a rules
   * deviation, only a different (and much simpler) decision shape.
   */
  | {
      op: 'addMana';
      amount: Value;
      colors: 'any' | (Color | 'C')[];
      /** Fixed symbols, e.g. Savage Ventmaw's {R}{R}{R}{G}{G}{G}; no color choice. */
      fixedSymbols?: (Color | 'C')[];
      /** "Spend this mana only to cast spells" — rides on the mana produced (CR 106.6). */
      restriction?: ManaRestriction;
      /** "Until end of turn, you don't lose this mana as steps and phases end." */
      persistent?: boolean;
    }
  | {
      op: 'registerDelayedTrigger';
      when: TriggerWhen;
      ability: Ability;
      expiry: 'endStep' | 'cleanup' | 'onFire';
      target?: EffectRef;
      controller?: 'source' | 'targetController';
      /** Player referenced as `eventPlayer` when the delayed ability resolves. */
      affectedPlayer?: 'sourceController' | 'targetController' | 'activePlayer';
      /**
       * Remember the permanent itself rather than its card: if it leaves the battlefield before
       * the delayed ability resolves, it is a new object and the effect does nothing (CR 400.7).
       */
      sameObject?: true;
    }
  | { op: 'commandZoneToBattlefield'; target: EffectRef; entersHaste?: boolean }
  /**
   * "Put your commander into your hand from the command zone" (Command Beacon) — a way OUT of
   * the command zone, and the reason the card exists: it dodges the CR 903.8 commander tax by
   * letting the commander be cast from hand instead.
   */
  | { op: 'commandZoneToHand' }
  | { op: 'returnToCommandZone'; target: EffectRef }
  | { op: 'grantAbilityUntilEot'; target: EffectRef; ability: Ability }
  | { op: 'grantHasteToResolvingSpell' }
  | { op: 'grantHasteOnResolution'; target: EffectRef }
  | { op: 'overloadBounceAllNonlandOpponents' }
  | { op: 'goad'; target: EffectRef }
  /**
   * "You choose which creatures attack this turn. You choose which creatures block this turn and
   * how those creatures block" (Master Warcraft): until the end of the turn the effect's
   * controller chooses the set of attackers and every defending player's blocks, though the
   * attacking player still chooses what each attacker attacks and pays its costs.
   */
  | { op: 'chooseAttackersAndBlockers' }
  /**
   * "Until your next turn, creatures your opponents control attack each combat if able and attack
   * a player other than you if able" (Kardur), "target creature attacks that player each combat if
   * able until the end of your next turn" (Silver Surfer). A rules modification, not a goad
   * status (CR 611.2c): `target` names a fixed object; `selector` is read live relative to the
   * ability's controller, so creatures that arrive later are covered too.
   */
  | {
      op: 'addAttackRequirement';
      target?: EffectRef;
      selector?: Selector;
      requirements: AttackRequirementSpec[];
      duration: 'untilYourNextTurn' | 'endOfYourNextTurn' | 'thisTurn' | 'duringTheirNextTurn';
      /**
       * "you" in the selector is the player whose turn it is as this resolves (`activePlayer`), or
       * the player involved in the firing event (`eventPlayer`), not the controller. For
       * `duringTheirNextTurn` it is also the player whose next turn it lasts through.
       */
      relativeTo?: 'activePlayer' | 'eventPlayer';
      /** "each creature target player controls" during that player's next turn (Rowan Kenrith). */
      relativeToPlayer?: EffectRef;
      /** "can't attack you or planeswalkers you control": the controller and what they control. */
      cantAttack?: 'you';
    }
  /**
   * "That player may draw a card. If they do, …" (Willie Lumpkin): the event player chooses, and
   * `then` resolves only if they chose to draw.
   */
  | { op: 'eventPlayerMayDraw'; then: Effect[] }
  /**
   * Partner with (CR 702.124j): "target player may search their library for a card named
   * [name], reveal it, put it into their hand, then shuffle."
   */
  | { op: 'targetPlayerMaySearchNamed'; target: EffectRef; name: string }
  /**
   * "Until your next turn, those creatures can't block" (Taunt from the Rampart): the creatures
   * matching `selector` as this resolves, a fixed set (CR 611.2c).
   */
  | { op: 'cantBlockEach'; selector: Selector; duration: 'untilYourNextTurn' }
  /**
   * "Until your next turn, each player may attack only the nearest opponent in the last chosen
   * direction and planeswalkers controlled by that opponent" (Teyo's −2, after its left/right
   * choice). It replaces any earlier effect of the same card.
   */
  | {
      op: 'limitAttacksToNearestOpponent';
      direction: 'left' | 'right';
      duration: 'untilYourNextTurn';
    }
  /**
   * "Until your next turn, creatures can't attack you or planeswalkers you control unless their
   * controller pays 2 life for each of those creatures" (Sivitri, Dragon Master's +1): a tax in
   * life, paid by the attacking player for each creature attacking this ability's controller or a
   * planeswalker they control (CR 508.1g-h). It outlasts its source and ends as the controller's
   * next turn begins.
   */
  | { op: 'attackLifeTaxUntilYourNextTurn'; amount: number }
  /**
   * "Choose an opponent" as this resolves (Triarch Stalker's Targeting Relay): the controller
   * picks one, stored on the source permanent as its chosen option so a later choice replaces it
   * ("the last chosen player") and its statics can read it back.
   */
  | { op: 'chooseOpponentForSource' }
  /**
   * "Remove all attacking creatures from combat and untap them" (Illusionist's Gambit), and, with
   * `thenCombat` (those creatures must attack if able and can't attack the controller or their
   * planeswalkers), "after this phase, there is an additional combat phase. Each of those creatures
   * attacks that combat if able. They can't attack you or planeswalkers you control that combat":
   * the removed creatures are a fixed set (CR 611.2c) bound to that one combat.
   */
  | {
      op: 'removeAttackersFromCombat';
      untap?: true;
      thenCombat?: true;
    }
  | { op: 'forceAttack'; target: EffectRef }
  | { op: 'forceAttackEach'; selector: Selector }
  | { op: 'doublePower'; selector: Selector }
  | { op: 'doublePowerTarget'; target: EffectRef }
  | { op: 'drawUpTo'; count: number }
  /** The routed player chooses an integer from zero through count, then draws that many cards. */
  | { op: 'drawUpToN'; count: number; player?: 'controller' | 'eventPlayer' }
  /**
   * "You may pay {N} and sacrifice it. If you do, …" on a resolving ability of a permanent
   * (Canoptek Wraith). Offered only while the source is still on the battlefield under the
   * ability's controller and the mana is payable: a cost that can't be paid can't be chosen.
   */
  | { op: 'mayPayManaAndSacrificeSource'; cost: ParsedManaCost; then: Effect[] }
  /**
   * "Choose a land you control. Then search your library for up to N basic land cards which
   * have the same name as the chosen land" (Canoptek Wraith). The land is chosen on resolution,
   * not targeted; only its name matters, so one option is offered per distinct land name.
   */
  | { op: 'searchBasicsNamedLikeChosenLand'; count: number; destination: SearchDestination }
  | { op: 'mayPayEnergyUpTo'; min: number; max: Value; then?: Effect[] }
  | { op: 'mayPayEnergy'; amount: Value; then?: Effect[] }
  | { op: 'doublePlayerCounters' }
  | { op: 'shuffleHandGraveyardIntoLibrary' }
  | { op: 'chaosWarp'; target: EffectRef }
  | { op: 'manifestTop'; player: 'you' | 'eventPlayer' }
  | { op: 'manifestTopForTargetController'; target: EffectRef }
  /**
   * "Look at the top four cards of target opponent's library, exile one of them face down, then
   * put the rest on the bottom of that library in a random order. You may cast that card for as
   * long as it remains exiled, and mana of any type can be spent to cast that spell." (Gonti,
   * Thief of Sanity), and "Search target opponent's library for a card and exile it face down.
   * Then that player shuffles. You may play that card for as long as it remains exiled."
   * (Praetor's Grasp). The exiled card is face down (CR 406.3), and only this ability's controller
   * may look at it; the permission lasts while it stays exiled.
   */
  | {
      op: 'exileFaceDownPlayable';
      /** Whose library: an announced player target, or the trigger's event player. */
      library: EffectRef | 'eventPlayer';
      from: { look: number; rest: 'bottomRandom' | 'graveyard' } | 'search';
      castOnly: boolean;
      anyType: boolean;
    }
  /**
   * "Manifest dread" (CR 701.62a): the player looks at the top two cards of their library, puts
   * one onto the battlefield face down as a manifested 2/2 creature and the other into their
   * graveyard. With one card left it is the one manifested.
   */
  | { op: 'manifestDread'; player: 'you' | 'eventPlayer' }
  | {
      op: 'opponentMayDrawOrMillThenDamage';
      target: EffectRef;
      drawCount: number;
      millCount: number;
    }
  | {
      op: 'lookAtTopNCastOneFree';
      count: number | Value;
      filter?: Selector;
      maxManaValue?: Value;
      visibility?: 'look' | 'reveal' | 'exile';
    }
  | { op: 'castAnyFromHandFree' }
  /**
   * "You may cast an artifact spell from your hand or graveyard by paying life equal to its mana
   * value rather than paying its mana cost" (Anrakyr the Traveller). Cast during resolution, so
   * timing permissions are ignored (CR 608.2g); the life is a cost, payable only by a player
   * with at least that much life (CR 119.4).
   */
  | { op: 'castForLifeFromZones'; selector: Selector; zones: ('hand' | 'graveyard')[] }
  | { op: 'castOneFromHandFreeUpTo'; maxManaValue: number }
  | { op: 'setMustBlockThisTurn'; target: EffectRef }
  /**
   * "After this phase, there is an additional combat phase": inserted directly after the phase
   * that is current as this resolves (CR 500.8). `additionalMain` adds the main phase some cards
   * put after it; `untapYourCreatures` untaps all creatures the controller controls as that combat
   * begins, as a triggered ability.
   */
  | { op: 'extraCombatPhase'; additionalMain?: true; untapYourCreatures?: true }
  /** Make the ability's controller the monarch (CR  monarch). */
  | { op: 'becomeMonarch' }
  | { op: 'druidPurification' }
  | { op: 'attackingCreaturesToOwnerLibraries' }
  /** The active player gains this exact source, untaps it, puts a counter and grants haste. */
  | { op: 'rotateSourceAtUpkeep' }
  /** The controller chooses one permanent of each type for each player, then all other
   * nonlands are sacrificed together. A multitype permanent can satisfy several choices. */
  | { op: 'choosePermanentTypesThenSacrificeOthers'; types: string[] }
  /**
   * "At the beginning of your end step, each player may put N `<counter>` counters on a creature
   * they control. Goad each creature that had counters put on it this way." (Agitator Ant) — one
   * op rather than `putCounters` plus `goad`, because the two sentences are not independent: the
   * goaders are exactly the creatures the counters were placed on (CR 701.15a — goading is done
   * by this ability's controller, not by each chooser).
   *
   * The choices are not targets (CR 115.10a — each player picks their own creature as the
   * ability resolves): hexproof and shroud do not matter, and "a creature they control" cannot
   * be a target slot, because every player in the game chooses, not one announced player. All
   * choices are collected before any counters move (CR 608.2d — "each player may" is one
   * instruction in one resolution), so no player's choice can see the counters another player's
   * earlier choice received. A placement whose amount survives counter-placement replacements
   * as zero is not "counters put on it this way" (a creature had counters put on it this way
   * only when it received at least one), so it is not goaded (CR 107.1f mirrors this distinction).
   */
  | { op: 'eachPlayerMayPutCountersAndGoad'; counter: string; count: Value }
  /**
   * "Starting with you, each player votes for a … permanent you don't control. Exile each
   * permanent with the most votes or tied for most votes." (Council's Judgment)
   *
   * A public, untargeted vote, not a target spec: hexproof, shroud and protection never remove a
   * candidate, and nobody may decline. The candidate set is the ability's `selector`, measured
   * against the ability's original controller; the rotation starts at that controller's own turn
   * slot and covers every living player, whoever holds priority. Every vote is recorded before
   * anything leaves, and the winners are counted by permanent object, never by card name.
   */
  | { op: 'voteAndExileMost'; selector: Selector }
  | { op: 'exileTargetWithSource'; target: EffectRef }
  /**
   * Imprint (Chrome Mox): "you may exile a nonartifact, nonland card from your hand", linked to
   * the source through `EnginePermanent.exiledWithIds` (CR 702.33, 607.2a).
   */
  | { op: 'exileFromHandWithSource'; excludeTypes: string[] }
  /**
   * "Exile target card from an opponent's graveyard. If it's a creature card, draw a card."
   * (Negative Zone Portal), linked to the source. `drawIfCardType` reads the exiled card.
   */
  | { op: 'exileGraveyardCardWithSource'; target: EffectRef; drawIfCardType?: string }
  /** CR 705: flip a coin; the controller calls it, so the result is a win or a loss. */
  | { op: 'flipCoin'; onWin: Effect[]; onLose: Effect[] }
  /** "return a card exiled with it at random to its owner's hand" (Negative Zone Portal). */
  | { op: 'returnRandomExiledWithSourceToHand' }
  | { op: 'exileAndManifestTarget'; target: EffectRef }
  /**
   * Exile the target, then return that card to the battlefield (CR 400.7: a new object). Without
   * `returnUnder` it returns under the controller it had; "under its owner's control" (Ephemerate)
   * is `owner`, "under your control" (Cloudshift) is `you`, the ability's controller.
   */
  | { op: 'blinkTarget'; target: EffectRef; returnUnder?: 'owner' | 'you' }
  | { op: 'blinkOneCreatureYouControl' }
  | { op: 'untapTarget'; target: EffectRef }
  | { op: 'tapTarget'; target: EffectRef }
  | { op: 'tapEach'; selector: Selector }
  | { op: 'bounceUpTo6MV' }
  | { op: 'millAndReturnSpells' }
  | { op: 'hideawayExileTop4' }
  | { op: 'hideaway'; count: number }
  | { op: 'playExiledCardFree' }
  /**
   * "Then it fights UP TO ONE target creature you don't control" (Primal Might) — the second
   * fighter is a variable-count slot (0 or 1, `TargetSpec.count`), not an ordinary target: an
   * unchosen "up to one" is legal to announce with nothing selected, which a plain `EffectRef`
   * (always exactly one slot) cannot express.
   */
  | { op: 'fightUpToOneChosen'; a: EffectRef; bSlot: number }
  /**
   * "Becomes a 4/4 red and green Dragon artifact creature with flying until end of turn"
   * (Atarka Monument) / "becomes a legendary 4/4 red Dragon creature with flying,
   * indestructible, and haste" (Sarkhan) — a type-changing + P/T-setting + keyword-granting
   * until-end-of-turn effect (CR 613's "becomes a creature" CDA shape).
   */
  | {
      op: 'becomeCreatureUntilEot';
      target: EffectRef;
      subtypes: string[];
      power: number;
      toughness: number;
      keywords: KeywordAbility[];
      /**
       * "Becomes a ... creature" with no "in addition to its other types" (Sarkhan) REPLACES
       * the whole type line, unlike Atarka Monument's plain additive grant — Sarkhan genuinely
       * stops being a planeswalker while this applies. Omitted keeps the additive behavior.
       */
      replaceTypes?: string[];
      /** "Red and green" (Atarka Monument): its colors become exactly these (CR 105.3). */
      colors?: Color[];
      /**
       * "Becomes a legendary …" (Sarkhan): with `replaceTypes` these are its supertypes; without,
       * they are added.
       */
      supertypes?: string[];
    }
  /** "Discard your hand" (Sarkhan's emblem) — the controller only, no draw follows. */
  | { op: 'discardHand' }
  /** "Each player discards their hand, then draws seven cards" (Dragon Mage, Runehorn Hellkite). */
  | {
      op: 'eachPlayerDiscardHandThenDraw';
      /** Fixed draw count. Omitted when `greatestDiscarded` supplies it instead. */
      count?: Value;
      /**
       * Windfall: "...draws cards equal to the greatest number of cards a player discarded this
       * way." The number is not knowable until every discard has happened, which is why the
       * executor runs in two phases rather than discarding and drawing player by player.
       */
      greatestDiscarded?: true;
    }
  /**
   * "Target player shuffles any number of target cards from their graveyard into their
   * library" (Loaming Shaman) — always shuffles, even if zero cards were chosen.
   */
  | { op: 'shuffleChosenGraveyardCardsIntoLibrary'; playerSlot: number; cardsSlot: number }
  /**
   * "You may pay {X}{R}. If you do, it deals X damage to any target" (Flameblast Dragon) — X is
   * chosen as part of the SAME decision as whether to pay at all, so this is one self-contained
   * op rather than a `conditionalEffect` composed with a choice condition.
   *
   * `templatedCost` is the PRINTED cost, `{X}` symbol and all — a cost with no `x` set would make
   * every candidate-X payability check identical, turning the affordable-X search into an
   * infinite loop.
   */
  | { op: 'mayPayXThenDealDamage'; target: EffectRef; templatedCost: ParsedManaCost }
  /**
   * "Destroy each nonland permanent with mana value X whose controller was dealt combat damage
   * by this creature this turn" (Steel Hellkite). Untargeted: "whose controller was dealt
   * combat damage by THIS" is a fact about `combatDamagePlayersBySource` keyed on the ability's
   * own source, not a `Selector`.
   */
  | { op: 'destroyEachNonlandMVFromDamagedControllers'; mv: Value }
  /**
   * "Return this card from your graveyard to your hand" (Spit Flame) — acts on the ability's
   * OWN source, already in the graveyard (`functionsInGraveyard`).
   */
  | { op: 'returnSelfFromGraveyardToHand' }
  /**
   * "Return this card from your graveyard to the battlefield [tapped] [with two +1/+1 counters on
   * it]" (Reassembling Skeleton, Retrofitted Transmogrant): acts on the ability's OWN source, and
   * only while it is the same graveyard object that the ability was activated from (CR 400.7).
   * It enters under the control of the ability's controller, who owns that graveyard.
   */
  | {
      op: 'returnSelfFromGraveyardToBattlefield';
      tapped?: true;
      /** A counter kind put on it as it enters, `counterCount` of them (default 1). */
      counter?: string;
      counterCount?: number;
    }
  /**
   * Persist and undying (CR 702.79a, 702.93a): "return it to the battlefield under its owner's
   * control with a `counter` counter on it". "It" is the card the dying source became in the
   * graveyard (CR 400.7e); if that card has left the graveyard, nothing returns. The counter is
   * on it as it enters.
   */
  | {
      op: 'returnDiedSourceToBattlefield';
      counter?: string;
      /** "Return it to the battlefield **tapped** under its owner's control" (Malakir Rebirth). */
      tapped?: true;
    }
  /**
   * "Put it into its owner's library third from the top" (God-Eternal Rhonas), after the source
   * died or was exiled: "it" is the card the source became in the graveyard or exile (CR
   * 400.7e); if that card has left that zone, nothing moves. `fromTop` is 1-based, and a library
   * too short for that position takes it on the bottom (CR 401.7).
   */
  | { op: 'putDepartedSourceIntoLibrary'; fromTop: number }
  /**
   * "Return it to its owner's hand" after the source left the battlefield (Fallen Ideal): "it" is
   * the card the source became in a graveyard or exile (CR 400.7e); if that card has left that
   * zone, nothing moves. `fromGraveyard` looks only in graveyards, for a trigger whose event puts
   * the source there (Fallen Ideal) or an Aura that follows its creature there as a state-based
   * action (Angelic Destiny, CR 704.5m).
   */
  | { op: 'returnDepartedSourceToHand'; fromGraveyard?: true }
  /**
   * "Exile <target>. Return that card to the battlefield under its owner's control at the
   * beginning of the next end step" (Flickerwisp; Venser, the Sojourner returns it under "your"
   * control). The delayed return remembers the exact card in exile (CR 400.7): a token ceases to
   * exist and nothing returns, and a card that left exile first stays where it is. "The next end
   * step" is the first one to begin after this resolves, whoever's turn it is (CR 603.7).
   */
  | {
      op: 'exileTargetReturnAtNextEndStep';
      target: EffectRef;
      returnUnder: 'owner' | 'sourceController';
    }
  /** The delayed half of `exileTargetReturnAtNextEndStep`: the remembered card, if still exiled. */
  | { op: 'returnExiledTriggerObject'; returnUnder: 'owner' | 'sourceController' }
  /**
   * "Put target creature card from an opponent's graveyard onto the battlefield under your
   * control. It gains haste. At the beginning of your next end step, exile it." (Puppeteer
   * Clique). The haste has no duration, so it lasts as long as that object stays on the
   * battlefield; the delayed exile remembers that object and skips a new one (CR 400.7).
   */
  | {
      op: 'reanimateTargetHasteExileAtYourNextEndStep';
      target: EffectRef;
      /** "Exile it at the beginning of your next upkeep" (Lukka, Wayward Bonder) instead. */
      exileAt?: 'yourNextUpkeep';
    }
  /**
   * The delayed return of "When that creature dies this turn, return it to the battlefield tapped
   * under your control" (Cryptek): the card the remembered permanent became in a graveyard
   * (CR 400.7e), if it is still there.
   */
  | { op: 'returnDiedTriggerObjectTapped' }
  /**
   * "Whenever equipped creature dies, return that card to the battlefield under its owner's
   * control at the beginning of the next end step" (Resurrection Orb). "That card" is the card
   * the trigger's subject became in a graveyard (CR 400.7e). The delayed trigger remembers that
   * exact card, so a card that has left the graveyard by then stays where it is. "The next end
   * step" is the first to begin after this resolves, whoever's turn it is (CR 603.7).
   */
  | { op: 'returnDiedTriggerObjectAtNextEndStep'; returnUnder: 'owner' }
  /**
   * "Return this card [from your graveyard] to the battlefield [attached to that creature] [at the
   * beginning of the next end step]" once the source has left the battlefield (Screams from
   * Within, Ghoulish Impetus, Gift of Immortality). "This card" is only the card this very
   * permanent became in a graveyard (CR 400.7e); `fromYourGraveyard` also requires that to be
   * the controller's graveyard. It enters under the ability's controller (CR 110.2a). An Aura
   * with no named host chooses one as it enters (CR 303.4f); with `attachTo: 'triggerObject'`
   * the host is the trigger object's card as it is on the battlefield when this resolves, and an
   * Aura that cannot be attached to it stays where it is (CR 303.4i).
   */
  | {
      op: 'returnDepartedSourceToBattlefield';
      fromYourGraveyard?: true;
      delay?: 'nextEndStep';
      attachTo?: 'triggerObject';
    }
  /** The delayed half of the next-end-step returns: the remembered graveyard card. */
  | {
      op: 'returnRememberedGraveyardCard';
      returnUnder: 'owner' | 'sourceController';
      /** The permanent it must enter attached to; gone or illegal, it stays put (CR 303.4i). */
      attachToObjectId?: string;
    }
  /**
   * "Return the chosen cards to the battlefield tapped" (Victimize): every graveyard card chosen
   * in a variable-count slot that is still a legal target enters together, tapped, under the
   * ability's controller (CR 603.6a).
   */
  | { op: 'reanimateEachChosenTapped'; targetSlot: number }
  /**
   * Return each chosen graveyard card to the battlefield under your control, together (CR
   * 603.6a), each with one `counter` on it as it enters (CR 122.6) and, from then on, with
   * `addTypes` in addition to its other types (The War in Heaven).
   */
  | { op: 'reanimateEachChosen'; targetSlot: number; counter?: string; addTypes?: string[] }
  /**
   * "Exile that many cards from the top of your library. Until end of turn, you may cast
   * spells from among those exiled cards" (Dream Pillager) — an impulse-draw of a DYNAMIC
   * count. `legal.ts` offers each exiled card back as a cast option for the rest of the turn.
   */
  | {
      op: 'exileTopNPlayableUntilEot';
      count: Value;
      castOnly?: true;
      /**
       * "Exile the top card of that player's library" (Ragavan): the event player's library, not
       * the controller's. The controller may still cast the card; its owner keeps it.
       */
      library?: 'eventPlayer';
    }
  | { op: 'noOp' };

/**
 * A token's printed face (CR 111.2) — everything a `CardDefinition` needs that a token has.
 *
 * Tokens carry their own abilities, which is why this is not just a name and a P/T: Beledros's
 * Pest has a dies trigger and Old Gnawbone's Treasure has a mana ability. Modeling those as
 * properties of the *creating* card instead would put the trigger on the wrong object.
 */
export interface TokenSpec {
  name: string;
  typeLine: string;
  supertypes?: string[];
  types: string[];
  subtypes: string[];
  colors: Color[];
  power: number | Value | null;
  toughness: number | Value | null;
  keywords?: KeywordAbility[];
  triggers?: Ability[];
  manaAbilities?: ManaAbilitySpec[];
  activatedAbilities?: ActivatedAbility[];
  /**
   * The token's own static abilities ("Creatures you control attack each combat if able."). A
   * selector in them is relative to the token's controller; they end when the token leaves.
   */
  staticEffects?: StaticEffect[];
  /** The token's own rule-modifying statics ("This token can't attack or block alone."). */
  ruleStatics?: RuleStatic[];
  legendary?: boolean;
  /** Apply haste to each token created from this spec until the current end step. */
  grantHasteUntilEot?: boolean;
  /**
   * A token copy's copied mana cost (CR 707.2), so its mana value is the original's. Ordinary
   * tokens have none and a mana value of 0.
   */
  manaCost?: ParsedManaCost | null;
  /** The copied mana cost as printed, so the board shows the copy's cost too. */
  manaCostText?: ManaCostString | null;
}

/**
 * Where one card found by a library search goes. A search has one destination per card it may
 * find, and the player picks a card for each in turn — which is also how they decide which
 * found card goes where ("put one onto the battlefield tapped and the other into your hand").
 */
export interface SearchDestination {
  zone: 'battlefield' | 'hand' | 'graveyard' | 'libraryTop';
  /** Battlefield only: "put it onto the battlefield **tapped**". */
  tapped?: boolean;
}

/**
 * Which object's event a trigger listens for.
 *
 * The split is the whole point of `TriggerSpec`: "When ~ enters" and "Whenever a Dragon you
 * control enters" are the *same* event watched from two vantage points, so they must be one
 * mechanism rather than two enum values. `selector` is resolved against the source permanent,
 * which is what makes "you control" mean the ability's controller.
 */
export type TriggerSubject =
  /** The ability's own source — "When ~ enters", "When ~ dies". */
  | { kind: 'self' }
  /** Any permanent matching the selector — "Whenever a Dragon you control attacks". */
  | { kind: 'permanent'; selector: Selector };

/**
 * The event a triggered ability listens for.
 *
 * Three shapes, not one enum: object events have a subject permanent, step events have a player
 * whose step counts, and `castsSpell` watches an object on the stack that is not a permanent at
 * all. Collapsing them would give every consumer a subject field that is meaningless two-thirds
 * of the time.
 */
export type TriggerWhen = TriggerHead['when'];

/** The object-event half of `TriggerHead`. */
export type ObjectTriggerWhen =
  | 'enters'
  | 'dies'
  | 'attacks'
  | 'blocks'
  | 'becomesBlocked'
  | 'dealsCombatDamageToPlayer'
  /** Source's own combat or noncombat damage to a player opposing its controller. */
  | 'dealsDamageToOpponent'
  | 'becomesTapped'
  /** "Whenever this Vehicle becomes crewed": a crew ability of it resolves (CR 702.122e). */
  | 'becomesCrewed'
  | 'fights'
  | 'becomesTargeted'
  | 'enchantedPlayerAttacked'
  | 'attacksUnblocked'
  | 'dealtDamage'
  | 'sacrificed'
  | 'tokenCreated'
  | 'putIntoGraveyardFromAnywhere'
  | 'leavesGraveyard'
  /**
   * "When this creature leaves the battlefield" (CR 603.6c, 603.10a): a permanent left for any
   * zone. `leavesTo` narrows it to destinations ("is put into exile from the battlefield").
   */
  | 'leavesBattlefield'
  | 'transformsInto'
  /** "When this creature is turned face up" (CR 708.8): the special action, not an entry. */
  | 'turnedFaceUp'
  /**
   * "Whenever one or more +1/+1 counters are put on this creature" (Pensive Professor): one
   * event per placement, including a permanent entering with counters (CR 122.6). `counter`
   * narrows it to one kind.
   */
  | 'countersPut';

/** The event half of a `TriggerSpec`, without the intervening-if clause. */
export type TriggerHead =
  | { when: 'discardsCard'; player: 'you' | 'each' | 'opponent'; filter?: Selector }
  | {
      when: ObjectTriggerWhen;
      subject: TriggerSubject;
      /**
       * "Whenever **one or more** Dragons you control attack, draw **that many** cards" — ONE
       * trigger carrying a count (CR 603.2c), not one trigger per matching object. Without this
       * distinction the ability fires N times and each firing draws N, so a three-Dragon attack
       * draws nine cards instead of three.
       *
       * The count reaches the effects as the `triggerCount` `Value`.
       */
      aggregate?: boolean | 'byEventPlayer';
      /** This graveyard-entry watcher includes battlefield origins, rather than Konrad's separate dies head. */
      fromAnyOrigin?: true;
      /**
       * "When this land enters **untapped**" (Mystic Sanctuary) — part of the trigger event, read
       * once as the permanent enters. Not an intervening-if (CR 603.4): tapping it in response
       * does not remove the ability.
       */
      entersUntapped?: true;
      /**
       * "When this creature enters **from a graveyard**" (Triarch Praetorian) / "enters **from
       * your graveyard**" (Flayer of the Hatebound) — part of the enters event: the zone the
       * permanent moved from (CR 603.6a, 603.10). `graveyardOwner: 'you'` requires the card to
       * have been in the ability controller's graveyard, which a card only ever is when its owner
       * is that player.
       */
      entersFrom?: {
        zone: 'graveyard';
        graveyardOwner?: 'you';
        /** "…entered or were cast from a graveyard" (Twilight Diviner): its cast record counts too. */
        orCastFrom?: true;
      };
      /**
       * "…enter, if none of them were cast or no mana was spent to cast them" (Satoru, the
       * Infiltrator): every permanent in the firing (the whole group for an aggregate head) was
       * either not cast or cast with no mana spent, read from its cast record. A fact about the
       * event, so the resolution recheck (CR 603.4) cannot change it.
       */
      entersWithoutManaSpentToCast?: true;
      /**
       * "is put into a graveyard from the battlefield or is put into exile from the battlefield"
       * (Psychomancer), "dies or is put into exile from the battlefield" (God-Eternal Rhonas): the
       * zones a `leavesBattlefield` event must have gone to.
       */
      leavesTo?: ('graveyard' | 'exile')[];
      /**
       * "Whenever ~ attacks, destroy target artifact or enchantment **defending player** controls"
       * (Kogla) — for an `attacks` trigger, `eventPlayer` is the player the creature is attacking
       * instead of the attacker's controller.
       */
      defendingPlayerIsEventPlayer?: true;
      /** Keep the attacking player as eventPlayer while grouping attacks per defender. */
      attackingPlayerIsEventPlayer?: true;
      /**
       * "Whenever a creature dies, ~ deals 2 damage to that creature's controller" (Dingus Staff):
       * for a `dies` trigger, `eventPlayer` is the dying permanent's controller as it last existed
       * on the battlefield (CR 603.10a).
       */
      subjectControllerIsEventPlayer?: true;
      /**
       * Battalion: "whenever ~ and at least two other creatures attack" — part of the attack
       * event, counted among the attackers declared with it, not an intervening-if (CR 603.4).
       */
      withOtherAttackers?: number;
      /**
       * "attacks alone" (exalted, CR 702.83a): the subject is the only creature declared as an
       * attacker this combat (CR 506.5). Part of the event, read from the declared set.
       */
      alone?: true;
      /** `countersPut`: only a placement that includes this counter kind. */
      counter?: string;
      /**
       * A chapter ability (CR 714.2b): "When one or more lore counters are put onto this Saga, if
       * the number of lore counters on it was less than N and became at least N". The crossing is
       * read from the placement itself, so it is part of the event.
       */
      chapter?: number;
      /** `countersPut`: "Whenever **you** put a counter on …" — the placing player is the controller. */
      byYou?: true;
      /**
       * `becomesTapped` only: the permanent was tapped to activate a mana ability ("taps a land for
       * mana", War's Toll), not by a tap effect or another cost. The player who tapped it is the
       * event player.
       */
      forMana?: true;
      /** "This ability triggers only once each turn." */
      oncePerTurn?: true;
    }
  /**
   * "Whenever you cast a Dragon spell" — the subject is a spell on the stack, so it is matched
   * by its *card* characteristics rather than as a permanent.
   */
  | {
      when: 'castsSpell';
      caster: 'you' | 'opponent' | 'each';
      filter?: Selector;
      /** At least one announced permanent target must match this selector. */
      targetFilter?: Selector;
      /** Fire only for this numbered spell by that caster during the current turn. */
      ordinal?: number;
      /**
       * Where the spell was cast from, read from its cast record (CR 601.2a): "casts a spell
       * from a graveyard" (River Kelpie) or "from anywhere other than your hand" (Keeper of
       * Secrets — the command zone, exile and the library all count).
       */
      castFrom?: 'graveyard' | 'notHand' | 'hand';
    }
  /**
   * "At the beginning of your/each upkeep|end step" — `player` says whose step counts.
   * `beginningOfCombat` is CR 507.1's begin combat step, queued the same way.
   */
  | {
      when: 'upkeep' | 'endStep' | 'untapStep' | 'drawStep' | 'beginningOfCombat' | 'endOfCombat';
      /**
       * `'enchanted'`: only the step of the player this Aura enchants ("at the beginning of enchanted
       * opponent's end step", Tenuous Truce); the event player is that player.
       */
      player: 'you' | 'each' | 'enchanted' | 'opponent';
    }
  /**
   * "At the beginning of each of your main phases" (Frontier Siege's Khans mode) — fires at
   * BOTH precombat and postcombat main, unlike the single-step triggers above.
   */
  | { when: 'mainPhase'; player: 'you' | 'each' }
  /**
   * "At the beginning of your first main phase" (Black Market Connections) — the PRECOMBAT main
   * only, so it is a separate event from `mainPhase`, which deliberately fires at both.
   */
  | { when: 'precombatMain'; player: 'you' | 'each' }
  | { when: 'secondMainPhase'; player: 'you' | 'each' }
  /** "Whenever you gain life" (Dawn of Hope) — player-scoped, like the step triggers above. */
  | { when: 'gainsLife'; player: 'you' | 'each' | 'opponent' }
  /**
   * "Whenever you lose life" (CR 119.3): queued once per life-loss event, damage included, with
   * the amount actually lost. `firstTimeEachTurn`: "for the first time each turn" (Intermediate
   * Chirography), part of the event — only the turn's first loss by that player fires it.
   */
  | { when: 'losesLife'; player: 'you' | 'each' | 'opponent'; firstTimeEachTurn?: true }
  | {
      when: 'drawsCard';
      player: 'you' | 'each' | 'opponent';
      /**
       * "draws their second card each turn": only the draw that makes the player's count this turn
       * exactly N. Part of the event, so the trigger is not rechecked on resolution.
       */
      ordinalThisTurn?: number;
    }
  | { when: 'foretells'; player: 'you' }
  /**
   * "Whenever you activate an ability that isn't a mana ability" (Verrak, Rowan Kenrith's emblem):
   * queued as the ability is put on the stack (CR 602.2), after its costs are paid. Mana abilities
   * never get here. `lifePaid`: "if life was paid to activate it", a fact of that activation, so
   * the CR 603.4 resolution recheck cannot change it. The amount is the `lifePaid` value.
   */
  | { when: 'activatesAbility'; player: 'you'; lifePaid?: true }
  /**
   * "Whenever damage that would be dealt to you is prevented" (Selfless Squire): queued once per
   * prevention applied to one damage event to the player, carrying the amount it prevented
   * (`damageDealt` in the ability's value scope).
   */
  | { when: 'damagePreventedToPlayer'; player: 'you' | 'each' }
  /**
   * "Whenever a source an opponent controls deals damage to you" (Michiko Konda): queued once per
   * source's damage event to a player, only if damage was actually dealt (infect counts, CR
   * 702.90b). `player` is the damaged player. The event player is the SOURCE's controller, and
   * `sourceController: 'opponent'` limits it to sources the watcher's controller's opponents control.
   */
  | { when: 'playerDealtDamage'; player: 'you' | 'each'; sourceController?: 'opponent' }
  /**
   * "Whenever a player attacks ..." (Firemane Commando, Breena, Mangara, Ever-Watching Threshold,
   * Frontier Warmonger, Tenuous Truce): queued once as an attack declaration is made (CR 508.2a),
   * for each player who declared attackers that `attacker` names, relative to the watcher's
   * controller. The event player is the attacking player.
   *
   * The attackers form a group whose size is checked when the event happens (`minAttackers`,
   * default 1 — a trigger condition, not an intervening-if) and which the ability's value scope
   * remembers by object. `attacking` narrows the group to creatures attacking a given player (and
   * optionally that player's planeswalkers); `perDefender` makes one group, and one firing, per
   * attacked player instead of one per attacking player, with `attackedPlayerId` bound to it.
   * An attack on a planeswalker is never an attack on its controller (CR 506.2).
   */
  | {
      when: 'attackDeclared';
      attacker: 'you' | 'opponent' | 'otherPlayer' | 'any' | 'enchantedPlayer';
      /**
       * Whom the attackers attack. `planeswalkers` also counts their planeswalkers;
       * `planeswalkersOnly` counts only those ("attacks one or more planeswalkers you control").
       */
      attacking?: {
        who: 'you' | 'opponent' | 'enchantedPlayer';
        planeswalkers: boolean;
        planeswalkersOnly?: true;
      };
      perDefender?: boolean;
      minAttackers?: number;
      /** Only attackers this matches form the group ("one or more non-Toy creatures"). */
      attackerFilter?: Selector;
    };

/**
 * When a triggered ability fires.
 *
 * `condition` is the *intervening-if* clause (CR 603.4) — "When ~ enters, **if you control a
 * creature with power 4 or greater**, draw a card". It is checked twice: when the ability would
 * trigger, and again as it resolves. Both checks are required, and skipping the second is a
 * classic engine bug (the board can change while the trigger sits on the stack).
 */
export type TriggerSpec = TriggerHead & {
  condition?: Condition;
  /** Attack-event qualification, checked only when attackers are declared, not on resolution. */
  eventCondition?: Condition;
};

export const SELF_SUBJECT: TriggerSubject = { kind: 'self' };

/**
 * A single ability — the unit the DSL executes. A spell is one `spell` ability; each
 * triggered line is a `triggered` ability. Mana abilities are represented separately
 * (`ManaAbilitySpec`) because they never use the stack.
 */
export interface Ability {
  kind: 'spell' | 'triggered' | 'activated';
  /** Triggered abilities only: the event that puts this on the stack. */
  trigger?: TriggerSpec;
  /** Triggered "you may …": a yes/no decision on resolution (brief §5.6). */
  optional?: boolean;
  /** Declared target slots, in order; `Effect.target` indexes into this. */
  targets: TargetSpec[];
  effects: Effect[];
  description?: string;
  /**
   * "This spell can't be countered" (Last March of the Ents, CR 601). A property of the spell
   * object itself, not something it does at resolution — checked by the `counter` executor and
   * `counterUnlessPays` before either actually removes it from the stack, the same DEBT-style
   * "still a legal target, but the consequence is prevented" pattern as `indestructible`/`destroy`.
   */
  cantBeCountered?: boolean;
  /**
   * "Choose one — •… •…" (CR 700.2, Crux of Fate). The mode is chosen at announcement
   * (CR 601.2b), before targets — so `computePriorityOptions`/`applyPriorityAction` enumerate
   * one CAST OPTION per mode (the same "the option menu is the contract" treatment `{X}`
   * already gets) rather than asking a resolution-time decision; the chosen mode's `effects`
   * are substituted for `effects` at cast time, and the executor never sees `modes` at all.
   * minChoices and maxChoices capture fixed modal counts; maxChoicesIf can raise the maximum
   * when a state condition is true at announcement.
   */
  modes?: {
    minChoices: number;
    maxChoices: number;
    /** Whether a modal choice may select the same mode more than once. */
    repeatable?: boolean;
    /** Trigger announcement may decline the entire fixed modal selection, choosing no modes. */
    optional?: true;
    /** A state-dependent maximum announced at cast time (for example, two while controlling a commander). */
    maxChoicesIf?: { condition: import('./condition').Condition; maxChoices: number };
    /** Escalate-style cost paid once for every chosen mode beyond the first. */
    additionalCostPerChoiceBeyondFirst?: AbilityCost[];
    options: {
      effects: Effect[];
      description?: string;
      additionalCost?: AbilityCost[];
      /** Global target-slot indexes announced only when this mode is chosen. */
      targetSlots?: number[];
    }[];
  };
  /**
   * "Whenever a Dragon you control enters, you may pay {R}. If you do, return this card from
   * your graveyard to your hand" (Spit Flame, CR 603.6d) — a triggered ability that functions
   * while its source sits in the graveyard rather than the battlefield.
   */
  functionsInGraveyard?: true;
}

/**
 * The card ability IR — the data-driven DSL the engine executes (ADR 0004). A card's
 * behavior is structured data: `Ability`s made of atomic `Effect` primitives that reference
 * declared target slots by index. The interpreter (text → IR) and an authored-override
 * registry both produce these; one executor (`effects/resolve.ts::executeAbility`) runs them.
 *
 * This module is self-contained (no imports from `definition.ts`) so the card model can
 * depend on it without a cycle.
 */

import type { Color } from '@mtg/shared';
import type { ManaUnit, ParsedManaCost } from '../mana/cost';
import type { Condition } from './condition';
import type { Selector } from './selector';
import type { Value } from './value';

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
  /** `{T}` — requires untapped, and (for creatures) not summoning-sick without haste. */
  | { kind: 'tap' }
  /** Tap an untapped controlled permanent, selected while paying the cost. */
  | { kind: 'tapOther'; selector: Selector; capturePowerForStation?: boolean }
  /** Tap several distinct untapped controlled permanents selected while paying the cost. */
  | { kind: 'tapOthers'; selector: Selector; count: number }
  /** Tap X distinct untapped controlled permanents, where X is the announced activation value. */
  | { kind: 'tapXOthers'; selector: Selector }
  /** "Sacrifice this creature" — available even while tapped or summoning-sick. */
  | { kind: 'sacrificeSelf' }
  /** "Exile this permanent" — a battlefield-only activation cost. */
  | { kind: 'exileSelf' }
  /** Sacrifice one or more other controlled permanents matching the filter. */
  | { kind: 'sacrificeOther'; selector: Selector; count?: number; allowSelf?: boolean }
  /** "Discard this card". */
  | { kind: 'discardSelf' }
  /** "Discard a card" from the controller's hand as a spell or activation cost. */
  | { kind: 'discardCard'; count?: number }
  | { kind: 'discardHand' }
  /** "Tap any number of untapped creatures you control with total power N or greater". */
  | { kind: 'tapCreaturesTotalPower'; minPower: number }
  /** "Remove a gold counter from this artifact". */
  | { kind: 'removeCounters'; counter: string; count: Value | number }
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
  kind: 'overload' | 'adventure' | 'omen' | 'mdfc' | 'nonMana';
  /** Zone from which this alternative may be announced. Defaults to the hand. */
  from?: 'hand' | 'graveyard' | 'exile';
  manaCost: ParsedManaCost;
  /** Non-mana components of a cost that replaces the spell's printed mana cost. */
  costs?: AbilityCost[];
  /** State condition required to choose this alternative cost at announcement. */
  condition?: Condition;
  description: string;
  name?: string;
  typeLine?: string;
  ability?: Ability;
  /** Back-face characteristics for a modal DFC that may be played as a land. */
  landFace?: MdfcLandFace;
  /** Flashback/escape-style replacement: exile the card after it leaves the stack. */
  exileOnResolution?: boolean;
  /** The alternative is Escape and marks the resulting stack/permanent object as escaped. */
  escaped?: true;
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
  /** "Activate only as a sorcery" — main phase, empty stack, your turn (CR 602.5d). */
  timing: 'any' | 'sorcery';
  /**
   * "Activate only once each turn" (CR 602.5f). Tracked per *permanent*, not per card: two
   * copies of Beledros each get their own activation.
   */
  oncePerTurn?: boolean;
  /** Zone from which the ability is activated (default: battlefield). */
  zone?: 'hand' | 'battlefield' | 'graveyard';
  /** Boast (CR 702.146): "Activate only if this creature attacked this turn." */
  requiresAttackedThisTurn?: true;
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
  | 'legendaryPermanentColors';

/**
 * What a payment is *for*, so restricted mana can decide whether it may pay (CR 106.6).
 *
 * A restriction is a property of the **payment as a whole**, never of an individual pip: "spend
 * this mana only to cast a Dragon creature spell" is answered once, before any mana moves. That
 * is what lets `planPayment` treat restricted mana as a plain filter — see `ManaRestriction`.
 */
export type PaymentPurpose =
  /** Casting a spell. `card` is the spell's *printed* candidate — it is not on the battlefield. */
  | { kind: 'castSpell'; oracleId: string; isCommander?: boolean }
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

/** A mana ability: "{T}: Add …". Never uses the stack (CR 605). */
export interface ManaAbilitySpec {
  /** Fixed symbol units. Each unit is one mana; several symbols in a unit are a choice. */
  units: ManaUnit[];
  /**
   * Activation cost. Absent means the overwhelmingly common `{T}` (see `TAP_COST`), which is
   * what every land and mana rock the interpreter produced before non-tap costs existed.
   * A `mana` component is deliberately NOT supported here: paying mana to make mana would make
   * `planPayment` recursive, so the interpreter leaves such a card unmodeled instead.
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
  onActivate?: Effect[];
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
  'rebound',
] as const;
export type KeywordAbility = (typeof IMPLEMENTED_KEYWORDS)[number];

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
  | 'anyTarget' // creature or player (CR 115.4)
  | 'playerOrPlaneswalker' // "target player or planeswalker" (Clan Defiance)
  | 'spell'
  /** A spell on the stack or a nonland permanent. */
  | 'spellOrNonlandPermanent'
  /** Any object currently on the stack: spells, activated abilities, or triggered abilities. */
  | 'stackObject'
  /**
   * "target Dragon permanent card" — a card in a graveyard, not a permanent (CR 111.2). Always
   * the ability's OWN controller's graveyard: every printed template this engine reads says
   * "from your graveyard" (Bladewing the Risen); a future "target card in a graveyard" (any
   * player's) needs its own kind rather than silently widening this one.
   */
  | 'cardInGraveyard'
  /**
   * "Counter target noncreature spell" (Stubborn Denial) — a spell on the stack whose card is
   * NOT a creature. A separate kind rather than a `filter` on `'spell'`: a spell target has no
   * permanent to run `permanentMatchesKind` over, so the filter machinery built for
   * `cardInGraveyard` does not reach it, and one closed-set adjective does not earn a whole
   * general spell-filter mechanism.
   */
  | 'noncreatureSpell'
  | 'commanderInCommandZone';

/** One declared target slot of an ability. Effects reference it by its index. */
export interface TargetSpec {
  kind: TargetKind;
  /**
   * "target creature you control" / "target creature an opponent controls". Omitted for an
   * unrestricted slot. Kept as a field rather than more `TargetKind` literals, which would
   * multiply combinatorially with every kind above.
   */
  controller?: 'you' | 'opponent' | 'eventPlayer';
  /**
   * Further restriction for a zone-qualified kind (`cardInGraveyard`) — "Dragon permanent
   * card". Unused for battlefield kinds, which use `permanentMatchesKind` instead.
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
}

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
  | 'eventPlayer';

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
  | { op: 'pumpUntilEot'; target: EffectRef; power: Value | number; toughness: Value | number }
  | { op: 'grantKeywordUntilEot'; target: EffectRef; keyword: KeywordAbility }
  /** Target creature cannot be blocked this turn. */
  | { op: 'cantBeBlockedUntilEot'; target: EffectRef }
  /** A resolution-time choice between effects (for example Pemmin's Aura's two stat modes). */
  | { op: 'chooseOne'; options: { effects: Effect[]; description: string }[] }
  /** Two creatures deal damage equal to their power to each other simultaneously (CR 701.12). */
  | { op: 'fight'; first: EffectRef; second: EffectRef }
  | { op: 'pumpEachUntilEot'; selector: Selector; power: Value | number; toughness: Value | number }
  /** Snapshot each matching creature's current P/T and add that much again until end of turn. */
  | { op: 'doublePowerAndToughnessEachUntilEot'; selector: Selector }
  | { op: 'grantKeywordEachUntilEot'; selector: Selector; keyword: KeywordAbility }
  /**
   * "Creatures you control gain protection from each color until end of turn" (Akroma's Will).
   * Separate from `grantKeywordEachUntilEot` because protection carries an ARGUMENT: it is not a
   * `KeywordAbility` name, and layer 6 applies it through `addProtection`, not `addKeyword`.
   */
  | { op: 'grantProtectionEachUntilEot'; selector: Selector; colors: Color[] }
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
    }
  | { op: 'transferCountersFromTriggerObject'; target: EffectRef }
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
  | { op: 'tombBladeHit'; target: EffectRef }
  | { op: 'emptyLibraryCreatureOrLose' }
  | { op: 'exileResolvingSpell' }
  | { op: 'millTargetPlayer'; target: EffectRef; count: number }
  | { op: 'millAndChooseArtifact' }
  | { op: 'dealDamageNonbasicLands'; target: EffectRef }
  | { op: 'sacrificeOneEachOpponent'; filter: 'creature' | 'nonland' | Selector }
  | { op: 'sacrificeEachPlayer'; count: number; filter: 'creature' | 'any' }
  | {
      op: 'putCounterByPermanentType';
      target: EffectRef;
      creatureCounter: string;
      planeswalkerCounter: string;
      count: Value | number;
    }
  | { op: 'drawRevealTopLoseManaValue' }
  | { op: 'goadEachOpponent' }
  | { op: 'createTreasureForDeaths' }
  | { op: 'preventCombatDamageAll' }
  | { op: 'preventCombatDamageToController' }
  | { op: 'copyTargetSpell'; target: number }
  | { op: 'copyEachTargetedSpell'; targetSlot: number }
  | { op: 'angelGrace' }
  | { op: 'arcbond'; target: EffectRef }
  | { op: 'arcbondDamage' }
  | { op: 'tapAndDamageController'; target: EffectRef }
  | { op: 'drawForEachOpponent' }
  | { op: 'drawTargetAndController'; target: EffectRef }
  | { op: 'combatCalligrapher' }
  | { op: 'inkshield' }
  | { op: 'delirium' }
  | { op: 'deflectingPalm'; target: EffectRef }
  | { op: 'gisela' }
  | { op: 'humbleDefector'; target: EffectRef }
  | { op: 'shadrixModes' }
  | { op: 'masterOfCeremonies' }
  | { op: 'breenaAttack'; target: EffectRef }
  | { op: 'drawTargetAndControllerN'; target: EffectRef; count: number }
  | { op: 'schemingSymmetry' }
  | { op: 'sacrificePermanentOnDamage'; target: EffectRef }
  | { op: 'kambal' }
  | { op: 'kambal' }
  | { op: 'destroyAndCreateTokensEqualToManaValue'; target: EffectRef; spec: TokenSpec }
  | { op: 'exile'; target: EffectRef } // target creature
  | { op: 'exileCard'; target: EffectRef }
  | { op: 'counter'; target: number; exileIfCountered?: boolean; addManaAtNextMainPhase?: boolean }
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
  | { op: 'gainControlTarget'; target: EffectRef }
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
  | { op: 'exileEach'; selector: Selector }
  | { op: 'exileEachOpponentGraveyard' }
  | { op: 'exileAllGraveyards' }
  /** Put the currently resolving spell card on the bottom of its owner's library. */
  | { op: 'resolvingSpellToLibraryBottom' }
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
  | { op: 'discard'; count: number } // controller chooses cards to discard
  /** Put a chosen number of cards from hand on top of the library, optionally ordering them. */
  | { op: 'putFromHandOnLibraryTop'; count: Value; anyOrder: boolean }
  /** Discard cards using the game PRNG rather than a player choice. */
  | { op: 'discardAtRandom'; count: Value }
  | { op: 'mill'; count: Value } // controller mills
  | { op: 'gainEnergy'; amount: Value }
  /** Create a player-owned emblem containing abilities but no targetable characteristics. */
  | { op: 'createEmblem'; name: string; abilities: Ability[] } // controller gets energy counters
  | { op: 'gainLife'; amount: Value } // controller gains
  | { op: 'loseLife'; amount: Value } // controller loses life (not damage)
  | { op: 'loseLifeTarget'; target: EffectRef; amount: Value }
  /** "Target player draws two cards." (Sign in Blood) — the target draws, not the controller
   * (contrast `drawTargetAndController`, where both do). */
  | { op: 'drawTarget'; target: EffectRef; count: Value }
  /** Cascade — reveal until a lower-mana-value nonland, then optionally cast it for free. */
  | { op: 'cascade' }
  /** Rebound's optional next-upkeep cast from exile. */
  | { op: 'reboundCastFromExile' }
  | { op: 'eachOpponentLosesLife'; amount: Value | number }
  /**
   * "You gain life equal to the life lost this way" (Gray Merchant of Asphodel, Exsanguinate).
   * Reads back the life ACTUALLY lost by earlier life-loss effects of the SAME resolution —
   * which a life-loss floor can make smaller than the amount asked for — so it is scoped to one
   * `executeAbility` call and is 0 if nothing in this ability lost anyone life.
   */
  | { op: 'gainLifeEqualToLifeLostThisWay' }
  | { op: 'eachOpponentDamage'; amount: number } // damage from source to each opponent
  /** "This land deals 1 damage to you" — damage from the source to its own controller. */
  | { op: 'damageController'; amount: number }
  /** "It deals 5 damage to each creature without flying" — the untargeted mass form. */
  | {
      op: 'damageEach';
      selector: Selector;
      amount: Value;
      source?: EffectRef;
      exceptSource?: true;
    }
  /** "~ deals X damage to each creature without flying AND EACH PLAYER" (Earthquake). */
  | { op: 'damageEachPlayer'; amount: Value }
  /**
   * "Search your library for a Forest card, put it onto the battlefield" (CR 701.19). One
   * `destinations` entry per card that may be found — each independently offers "find or
   * decline" (CR 701.19c). `count` (Harvest Season's "up to X, where X is...") repeats
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
      /** Surface CR 701.19c's legal failure-to-find choice even for one distinct card name. */
      allowFailToFind?: boolean;
      /**
       * "…, reveal it, …" (CR 701.16a): each found card is shown to every player, even when its
       * destination is a hidden zone such as the hand.
       */
      reveal?: boolean;
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
  | { op: 'etaliPrimalConqueror' }
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
  /** Create a batch of tokens tapped and attacking a defending player chosen on resolution. */
  | {
      op: 'createTokenAttacking';
      spec: TokenSpec;
      count: Value;
      powerOverride?: number | Value;
      toughnessOverride?: number | Value;
    }
  /** Create one token already attached to an announced permanent target. */
  | { op: 'createAttachedToken'; spec: TokenSpec; target: EffectRef }
  /** Create one token for each opponent, optionally attacking that opponent. */
  | { op: 'createTokenForEachOpponent'; spec: TokenSpec; attacking?: boolean }
  | { op: 'createTokenForPlayer'; target: EffectRef; spec: TokenSpec; count: Value }
  | { op: 'createTokenForEachPlayerExceptTarget'; target: EffectRef; spec: TokenSpec; count: Value }
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
   * "Gain control of all Dragons" (Karrthus, Tyrant of Jund) — CR 613.7's control-change
   * timestamp is a real rules event, so the affected permanents' `timestamp` is bumped too, the
   * same as a copy effect would. A permanent already under the caster's control is left alone
   * (no timestamp churn for something that didn't actually change hands).
   */
  | { op: 'gainControl'; selector: Selector }
  /** "Return target Dragon permanent card from your graveyard to the battlefield" (Bladewing). */
  | { op: 'graveyardToBattlefield'; target: EffectRef }
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
  /** "Return target creature to its owner's hand" — the general permanent-to-hand bounce. */
  | { op: 'returnToHand'; target: EffectRef }
  /** Return one permanent matching a selector; used by bounce lands' mandatory ETB. */
  | { op: 'returnOneToHand'; selector: Selector }
  /**
   * "Put a/any number of `<filter>` cards from your hand onto the battlefield" — Broodcaller
   * Scourge's single bounded pick and Last March of the Ents' unbounded "any number" share one
   * op because both are the same decision loop, asked once or repeated to a decline.
   */
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
      mayPut?: { filter: Selector; destination: SearchDestination };
      /** Where everything not taken ends up. */
      rest: 'bottomRandom' | 'topAnyOrder';
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
  /**
   * "Put this artifact on top of its owner's library" (Sensei's Divining Top). Distinct from a
   * bounce: the destination is the LIBRARY of the OWNER, not the controller's hand, so a stolen
   * Top goes back to the library of the player who owns it (CR 400.3).
   */
  | { op: 'selfToLibraryTop' }
  | { op: 'putCountersEachChosen'; targetSlot: number; counter: string; count: Value | number }
  | { op: 'grantKeywordEachChosenUntilEot'; targetSlot: number; keyword: KeywordAbility }
  | { op: 'untapUpTo'; selector: Selector; max: number }
  | { op: 'exileEachChosen'; targetSlot: number }
  /**
   * "Destroy up to N target …" — destroy each object chosen for a variable-count target slot
   * (possibly none), skipping any that became illegal (CR 608.2b).
   */
  | { op: 'destroyEachChosen'; targetSlot: number }
  | {
      op: 'blinkEachChosen';
      targetSlot: number;
      returnUnder: 'owner' | 'sourceController';
    }
  | { op: 'regainControlOfOwnCreatures' }
  | { op: 'exileTargetGraveyardAndBuffIfCreature'; targetSlot: number }
  | {
      op: 'pumpTargetPlayerCreaturesUntilEot';
      targetSlot: number;
      power: number;
      toughness: number;
    }
  | { op: 'untapTargetPlayerCreatures'; targetSlot: number }
  | { op: 'exileUntilSourceLeaves'; targetSlot: number }
  | { op: 'exileTargetAndControllerMaySearchBasicLandTapped'; targetSlot: number }
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
   */
  | {
      op: 'unlessPays';
      payer: 'eventPlayer' | 'controller';
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
      affectedPlayer?: 'sourceController' | 'targetController';
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
  | {
      op: 'opponentMayDrawOrMillThenDamage';
      target: EffectRef;
      drawCount: number;
      millCount: number;
    }
  | { op: 'lookAtTopNCastOneFree'; count: number }
  | { op: 'castAnyFromHandFree' }
  | { op: 'castOneFromHandFreeUpTo'; maxManaValue: number }
  | { op: 'setMustBlockThisTurn'; target: EffectRef }
  | { op: 'extraCombatPhase' }
  /** Make the ability's controller the monarch (CR  monarch). */
  | { op: 'becomeMonarch' }
  | { op: 'druidPurification' }
  | { op: 'exileTargetWithSource'; target: EffectRef }
  | { op: 'exileAndManifestTarget'; target: EffectRef }
  | { op: 'blinkTarget'; target: EffectRef }
  | { op: 'blinkOneCreatureYouControl' }
  | { op: 'untapTarget'; target: EffectRef }
  | { op: 'tapTarget'; target: EffectRef }
  | { op: 'tapEach'; selector: Selector }
  | { op: 'bounceUpTo6MV' }
  | { op: 'millAndReturnSpells' }
  | { op: 'hideawayExileTop4' }
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
   * "Exile that many cards from the top of your library. Until end of turn, you may cast
   * spells from among those exiled cards" (Dream Pillager) — an impulse-draw of a DYNAMIC
   * count. `legal.ts` offers each exiled card back as a cast option for the rest of the turn.
   */
  | { op: 'exileTopNPlayableUntilEot'; count: Value }
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
  legendary?: boolean;
  /** Apply haste to each token created from this spec until the current end step. */
  grantHasteUntilEot?: boolean;
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
export type TriggerWhen =
  | 'enters'
  | 'dies'
  | 'attacks'
  | 'blocks'
  | 'becomesBlocked'
  | 'dealsCombatDamageToPlayer'
  | 'becomesTapped'
  | 'fights'
  /**
   * "Becomes the target of a spell or ability an opponent controls" (Thunderbreak Regent).
   * Always opponent-sourced — CR gives no printed template for "…a spell YOU control", so
   * `queueTriggersForEvent` enforces the opponent check itself rather than a variant field.
   */
  | 'becomesTargeted'
  | 'untapStep'
  | 'drawStep'
  | 'castsSpell'
  | 'upkeep'
  | 'endStep'
  | 'mainPhase'
  | 'precombatMain'
  | 'beginningOfCombat'
  | 'gainsLife'
  | 'dealtDamage'
  | 'drawsCard';

/** The object-event half of `TriggerHead`. */
export type ObjectTriggerWhen =
  | 'enters'
  | 'dies'
  | 'attacks'
  | 'blocks'
  | 'becomesBlocked'
  | 'dealsCombatDamageToPlayer'
  | 'becomesTapped'
  | 'fights'
  | 'becomesTargeted'
  | 'enchantedPlayerAttacked'
  | 'dealtDamage'
  | 'sacrificed'
  | 'tokenCreated'
  | 'putIntoGraveyardFromAnywhere'
  | 'leavesGraveyard'
  | 'transformsInto';

/** The event half of a `TriggerSpec`, without the intervening-if clause. */
export type TriggerHead =
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
      /**
       * "When this land enters **untapped**" (Mystic Sanctuary) — part of the trigger event, read
       * once as the permanent enters. Not an intervening-if (CR 603.4): tapping it in response
       * does not remove the ability.
       */
      entersUntapped?: true;
      /**
       * "Whenever ~ attacks, destroy target artifact or enchantment **defending player** controls"
       * (Kogla) — for an `attacks` trigger, `eventPlayer` is the player the creature is attacking
       * instead of the attacker's controller.
       */
      defendingPlayerIsEventPlayer?: true;
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
    }
  /**
   * "At the beginning of your/each upkeep|end step" — `player` says whose step counts.
   * `beginningOfCombat` is CR 507.1's begin combat step, queued the same way.
   */
  | {
      when: 'upkeep' | 'endStep' | 'untapStep' | 'drawStep' | 'beginningOfCombat';
      player: 'you' | 'each';
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
  /** "Whenever you gain life" (Dawn of Hope) — player-scoped, like the step triggers above. */
  | { when: 'gainsLife'; player: 'you' | 'each' }
  | { when: 'drawsCard'; player: 'you' | 'each' | 'opponent' };

/**
 * When a triggered ability fires.
 *
 * `condition` is the *intervening-if* clause (CR 603.4) — "When ~ enters, **if you control a
 * creature with power 4 or greater**, draw a card". It is checked twice: when the ability would
 * trigger, and again as it resolves. Both checks are required, and skipping the second is a
 * classic engine bug (the board can change while the trigger sits on the stack).
 */
export type TriggerSpec = TriggerHead & { condition?: Condition };

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

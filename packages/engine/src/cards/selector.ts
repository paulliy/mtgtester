import { assertNever } from '../utils/assert-never';
/**
 * `Selector` — a predicate over permanents (ADR 0005, extended by ADR 0008). One abstraction
 * covers targeting, "each", and the *affected set* of a continuous effect (Blood Moon's
 * "nonbasic lands", Glorious Anthem's "creatures you control").
 *
 * The grammar is compositional — leaf predicates over a permanent's characteristics, combined
 * with `allOf` / `anyOf` / `not` — rather than a closed list of named sets. Forge's `Affected`
 * language is the same shape. A closed list needs a new engine case per card ("nonbasicLands",
 * "artifacts", …); a grammar needs a new *parse*, and the engine never changes. That matters
 * most for anthems and lords, where the subject differs on every card ("Elves you control",
 * "creatures your opponents control") but the mechanic is identical.
 *
 * Selectors are evaluated against a candidate's CURRENT characteristics — the working values
 * produced by the layers applied so far (ADR 0006). That is what makes one continuous effect
 * able to change another's affected set, and therefore what makes CR 613.8 dependency ordering
 * meaningful. The candidate is passed as plain fields rather than `Characteristics` to keep
 * this module free of engine imports.
 *
 * Note what a selector deliberately CANNOT read: toughness, tapped-ness, damage. That is what
 * keeps sublayer 7d free of dependency analysis (ADR 0007) — a pump effect cannot change any
 * selector's answer, so pumps can never depend on one another.
 *
 * Two leaves break that and are therefore **event-only**: legal in a trigger's subject, a
 * `Condition`, or a resolving spell's "each", and illegal inside a continuous effect.
 * `selectorIsEventOnly` marks them and `gatherEffects` enforces the ban.
 *
 * - `powerAtLeast` reads sublayer 7d's own output. Allowing it in a layer would mean one pump
 *   effect could change another's affected set, reinstating the dependency analysis 7d skips.
 * - `hasKeyword` reads layer 6's output. Allowing it in a layer-6 effect would let one keyword
 *   grant change another's affected set.
 *
 * The distinction is real, not bookkeeping: "5 damage to each creature without flying" asks its
 * question once, at a moment when keywords are already fully computed; a static ability would
 * have to ask it *during* the computation that produces them.
 */

import type { Color } from '@mtg/shared';

/** The subset of a permanent's current characteristics a selector can read. */
export interface SelectorCandidate {
  cardId: string;
  controllerId: string;
  types: readonly string[];
  supertypes: readonly string[];
  subtypes: readonly string[];
  colors: readonly Color[];
  /** Current power. Only `powerAtLeast` reads it — see the module comment. */
  power: number;
  /** Tapped status; only the event-only `tapped` selector reads it. Absent off the battlefield. */
  tapped?: boolean;
  /**
   * A card outside the battlefield whose power is not a printed number ("*", a characteristic-
   * defining ability this candidate does not evaluate). `power` then reads 0, so a comparison
   * against the source's power (`powerAtMostSource`) refuses it rather than guessing.
   */
  powerUnknown?: boolean;
  /** Current toughness. Only `toughnessAtLeast` reads it — see the module comment. */
  toughness?: number;
  /** Power and toughness after layer 7b (CR 613.4b), for `basePowerToughness`. */
  basePower?: number;
  baseToughness?: number;
  /** Current keywords. Only `hasKeyword` reads them — see the module comment. */
  keywords: readonly string[];
  /** Mana value (CR 202.3), read by `manaValueAtMost`/`manaValueAtLeast`. Absent when the
   * candidate's card definition can't be found, which is fine: an absent value simply never
   * matches a mana-value filter rather than matching as though it were 0. */
  manaValue?: number;
  /**
   * The printed mana cost's text, `null` for a card with no mana cost (CR 202.1). Only card-zone
   * candidates carry it; an absent value never matches `manaCostIs`.
   */
  manaCostText?: string | null;
  /** Token-ness (CR 111.1). NOT event-only: no layer can change it. */
  isToken: boolean;
  /** Did this permanent enter the battlefield during the CURRENT turn (Neriv)? */
  enteredThisTurn: boolean;
  /** Is this permanent/card a Commander (CR 903.3)? */
  isCommander?: boolean;
  /** Its owner (CR 108.3). Absent when a builder does not know it, which never matches `owner`. */
  ownerId?: string;
  /** Is this permanent enchanted by an Aura? */
  isEnchanted?: boolean;
  /** The controller of each Aura attached to it, one entry per Aura. */
  auraControllerIds?: readonly string[];
  /** Is this permanent equipped by an Equipment? */
  isEquipped?: boolean;
  /** EVENT-ONLY: currently attacking or blocking. */
  inCombat?: boolean;
  /** Combat status is independent of layers, so continuous statics may read it. */
  combatRole?: 'attacking' | 'blocking' | null;
  /** The player this permanent is attacking, when it attacks a player (not a planeswalker). */
  attackingDefenderId?: string | null;
  attackingDefendingPlayerId?: string;
  /** Declared as an attacker this turn. */
  attackedThisTurn?: boolean;
  /** Not summoning sick: controlled continuously since its controller's turn began (CR 302.6). */
  controlledSinceTurnStart?: boolean;
  /**
   * Its current name (CR 201.2): the name a copy effect gave it, and none at all for a face-down
   * permanent (CR 708.2). Absent when a builder does not know it, which never matches `name`.
   */
  name?: string;
  /** Does this permanent have any counter of any kind on it (Rishkar, Peema Renegade)? */
  hasAnyCounter?: boolean;
  /**
   * The permanent's counters by kind, for subjects that name one ("with a +1/+1 counter on it").
   * Absent for objects that cannot carry counters — a card in hand, a spell on the stack — which
   * is why `hasCounter` correctly never matches them.
   */
  counters?: Record<string, number>;
}

/** The object a relative selector ("self", "you control") is resolved against. */
export interface SelectorSource {
  giftPromised?: boolean;
  /** Exact identities/facts when evaluating a resolving triggered ability. */
  objectId?: string;
  sourceFacts?: import('./source-identity').ObjectFacts;
  sourceCastState?: import('./source-identity').SourceCastState;
  eventObjectId?: string;
  triggerObjectId?: string;
  triggerObjectFacts?: import('./source-identity').ObjectFacts;
  cardId: string;
  controllerId: string;
  /** For an Aura/Equipment: the card id of the permanent it is attached to, if any. */
  attachedToCardId?: string | null;
  /** Object whose event fired a trigger, when a condition refers to that object. */
  triggerObjectCardId?: string;
  /** Player whose action caused the event, for event-relative conditions. */
  eventPlayerId?: string;
  /** `attackDeclared` firing: the group's attackers by object, and the attacked player, if any. */
  attackGroupIds?: readonly string[];
  attackedPlayerId?: string;
  /** `attackDeclared` firing: whether any attacker of the whole attack attacked the watcher. */
  attackedWatcher?: boolean;
  /** Mana spent to cast the spell a cast trigger is about, for `compareValues` (Increment). */
  manaSpent?: number;
  /** The source's `chosenOption` (Caged Sun's color, …), for the `chosenColor` selector. */
  chosenOption?: string;
  /** The source's power, or its last-known power once it has left, for `powerAtMostSource`. */
  sourcePower?: number;
  /** The source permanent's current name, for `sameNameAsSource`. */
  sourceName?: string;
}

export type Selector =
  /** The effect's own source (a CDA or self-buff). */
  | { kind: 'self' }
  /** Every permanent other than the source ("each other …"). */
  | { kind: 'other' }
  /** The permanent the source is attached to — "equipped creature", "enchanted creature". */
  | { kind: 'attachedToSource' }
  | { kind: 'type'; value: string }
  | { kind: 'subtype'; value: string }
  | { kind: 'supertype'; value: string }
  /**
   * "named Lightning Rager", "a card named Galactus, Devourer of Worlds": its current name,
   * exactly (CR 201.2). Not event-only: a copy effect changes a name as game state, not through
   * a layer this selector would be read inside.
   */
  | { kind: 'name'; value: string }
  /**
   * "with the same name as this creature" (Mocking Doppelganger): the source's own current
   * name, which a copy effect may have changed, so it reads `source.sourceName`, not a value.
   */
  | { kind: 'sameNameAsSource' }
  | { kind: 'color'; value: Color }
  /**
   * "of the chosen color" (Caged Sun) — the color is per-permanent state
   * (`EnginePermanent.chosenOption`, via `CardDefinition.entersChoosingOption`), not a fixed
   * `Color` the override can write in, so it reads `source.chosenOption` instead of `value`.
   */
  | { kind: 'chosenColor' }
  /** "of the chosen type" (Cloud Key) — same idea as `chosenColor`, over card types. */
  | { kind: 'chosenType' }
  /**
   * "of the chosen type" where the chosen thing is a CREATURE TYPE (Cavern of Souls, Herald's
   * Horn, Patchwork Banner) — the same words as `chosenType`, a different domain. Card types
   * live in `types` and creature types in `subtypes`, so one selector cannot serve both:
   * `chosenType` against "Elf" would compare it to ["Creature"] and never match.
   */
  | { kind: 'chosenSubtype' }
  /** Controlled by the source's controller, or by any of their opponents. */
  | { kind: 'controller'; who: 'you' | 'opponents' | 'eventPlayer' }
  /** EVENT-ONLY (see the module comment): "with power 4 or greater". */
  | { kind: 'powerAtLeast'; n: number }
  /** EVENT-ONLY (see the module comment): "with power 2 or less". */
  | { kind: 'powerAtMost'; n: number }
  | { kind: 'toughnessAtLeast'; n: number }
  /**
   * EVENT-ONLY: "with base power and toughness 1/1" (Bess, Soul Nourisher) — power and toughness
   * after characteristic-defining and setting effects (layers 7a-7b), before counters and
   * modifications (CR 208.1, 613.4).
   */
  | { kind: 'basePowerToughness'; power: number; toughness: number }
  /**
   * EVENT-ONLY: "with power greater than its base power" (Kutzil, Malamet Exemplar) — current
   * power above the layer 7b value (CR 613.4b), so counters or a pump raised it.
   */
  | { kind: 'powerGreaterThanBase' }
  /**
   * EVENT-ONLY: "with equal or lesser power" than the ability's source (Body Launderer) — its
   * current power, or its last-known power once it has left the battlefield (CR 608.2h). An
   * unknown source power matches nothing.
   */
  | { kind: 'powerAtMostSource' }
  /** "with mana value 4 or less" (Sunforger) — not event-only: mana value is a printed
   * characteristic, not a layer's derived output. */
  | { kind: 'manaValueAtMost'; n: number }
  /** "with mana value 4 or greater" (Austere Command's other mode). Same rationale as
   * `manaValueAtMost` — not event-only. */
  | { kind: 'manaValueAtLeast'; n: number }
  /**
   * "with mana cost {0} or {1}" (Urza's Saga): the printed mana cost itself, not its mana value,
   * so {X} or no mana cost at all never matches. Not event-only, as for the mana value.
   */
  | { kind: 'manaCostIs'; manaCosts: string[] }
  /** Does the permanent have any counter of any kind on it (Rishkar, Peema Renegade)? Not
   * event-only: counters are real state, not a layer's derived output. */
  | { kind: 'hasAnyCounter' }
  /**
   * A counter of a NAMED kind — "with a +1/+1 counter on it" (Marchesa, the Black Rose; The Ooze;
   * Herald of Secret Streams). Distinct from `hasAnyCounter` on purpose: reading these subjects
   * as "any counter" makes a creature carrying only a -1/-1 counter qualify, which turns
   * Marchesa plus persist into a loop the printed cards do not support.
   */
  | { kind: 'hasCounter'; counter: string }
  /** EVENT-ONLY (see the module comment): "with flying" / (negated) "without flying". */
  | { kind: 'hasKeyword'; keyword: string }
  /**
   * "another **nontoken** Dragon you control" (Miirym), as `not(IS_TOKEN)`.
   *
   * Deliberately NOT event-only, unlike the two leaves above: nothing in CR 613 can make a
   * permanent become or stop being a token, so no layer's output can change this answer.
   */
  | { kind: 'isToken' }
  /** EVENT-ONLY (see the module comment): "each tapped creature" (Rowan Kenrith). */
  | { kind: 'tapped' }
  /** "a creature you control that entered this turn" (Neriv, Heart of the Storm). */
  | { kind: 'enteredThisTurn' }
  | { kind: 'isCommander' }
  /** "you own" (Candlekeep Sage): ownership, not control (CR 108.3); a layer cannot change it. */
  | { kind: 'owner'; who: 'you' }
  | { kind: 'isMonocolored' }
  | { kind: 'isEnchanted' }
  /** "enchanted by an Aura you control" (Killian, Decisive Mentor). */
  | { kind: 'enchantedByAuraYouControl' }
  | { kind: 'isEquipped' }
  | { kind: 'inCombat' }
  | { kind: 'combatRole'; role: 'attacking' | 'blocking' }
  /** A resolving attack trigger's "that player": compare against the event's defender. */
  | { kind: 'attackingEventPlayer' }
  /**
   * "that's attacking one of your opponents" (Martial Impetus): attacking a player other than the
   * source's controller. Attack assignment is game state, like `combatRole`.
   */
  | { kind: 'attackingOpponent' }
  | { kind: 'attackingYouOrYourPlaneswalker' }
  /**
   * "Attacking the last chosen player" (Triarch Stalker): attacking the player stored in the
   * source's `chosenOption`, not one of that player's planeswalkers. Combat assignment is game
   * state, so a static may read it like `combatRole`.
   */
  | { kind: 'attackingChosenPlayer' }
  /**
   * EVENT-ONLY: it was declared as an attacker this turn (never true of a token put onto the
   * battlefield attacking) — "creatures that didn't attack this turn" (Siren's Call).
   */
  | { kind: 'attackedThisTurn' }
  /**
   * EVENT-ONLY: its controller has controlled it continuously since their turn began (CR 302.6),
   * read during that controller's own turn — "each creature they didn't control continuously
   * since the beginning of the turn" (Siren's Call).
   */
  | { kind: 'controlledSinceTurnStart' }
  | { kind: 'allOf'; of: Selector[] }
  | { kind: 'anyOf'; of: Selector[] }
  | { kind: 'not'; of: Selector };

export const SELF: Selector = { kind: 'self' };
export const OTHER: Selector = { kind: 'other' };
export const YOURS: Selector = { kind: 'controller', who: 'you' };
export const OPPONENTS: Selector = { kind: 'controller', who: 'opponents' };

export const ofType = (value: string): Selector => ({ kind: 'type', value });
export const ofSubtype = (value: string): Selector => ({ kind: 'subtype', value });
export const ofSupertype = (value: string): Selector => ({ kind: 'supertype', value });
export const ofColor = (value: Color): Selector => ({ kind: 'color', value });
export const named = (value: string): Selector => ({ kind: 'name', value });
export const CHOSEN_COLOR: Selector = { kind: 'chosenColor' };
export const CHOSEN_TYPE: Selector = { kind: 'chosenType' };
export const CHOSEN_SUBTYPE: Selector = { kind: 'chosenSubtype' };

/**
 * `selector` with "the chosen …" replaced by what `chosen` names: a fixed `color`, `type` or
 * `subtype`. For a selector that outlives the permanent it reads from, such as a CR 106.6
 * restriction riding on mana (Cavern of Souls), which is checked with no source permanent.
 * Unbound (`chosen` absent), the selector is returned as is and still matches nothing.
 */
export function bindChosenOption(selector: Selector, chosen: string | undefined): Selector {
  if (chosen === undefined) return selector;
  switch (selector.kind) {
    case 'chosenColor':
      return { kind: 'color', value: chosen as Color };
    case 'chosenType':
      return { kind: 'type', value: chosen };
    case 'chosenSubtype':
      return { kind: 'subtype', value: chosen };
    case 'allOf':
    case 'anyOf':
      return { kind: selector.kind, of: selector.of.map((of) => bindChosenOption(of, chosen)) };
    case 'not':
      return { kind: 'not', of: bindChosenOption(selector.of, chosen) };
    default:
      return selector;
  }
}

export const allOf = (...of: Selector[]): Selector => ({ kind: 'allOf', of });
export const anyOf = (...of: Selector[]): Selector => ({ kind: 'anyOf', of });
export const not = (of: Selector): Selector => ({ kind: 'not', of });

/** Blood Moon's subject — a land without the Basic supertype. */
export const NONBASIC_LANDS: Selector = allOf(ofType('Land'), not(ofSupertype('Basic')));

export const powerAtLeast = (n: number): Selector => ({ kind: 'powerAtLeast', n });
export const powerAtMost = (n: number): Selector => ({ kind: 'powerAtMost', n });
export const HAS_ANY_COUNTER: Selector = { kind: 'hasAnyCounter' };
export const hasCounter = (counter: string): Selector => ({ kind: 'hasCounter', counter });
export const toughnessAtLeast = (n: number): Selector => ({ kind: 'toughnessAtLeast', n });
export const manaValueAtMost = (n: number): Selector => ({ kind: 'manaValueAtMost', n });
export const manaValueAtLeast = (n: number): Selector => ({ kind: 'manaValueAtLeast', n });
export const withKeyword = (keyword: string): Selector => ({ kind: 'hasKeyword', keyword });

/** Miirym's subject leaf — see the  variant. */
export const IS_TOKEN: Selector = { kind: 'isToken' };
export const IS_COMMANDER: Selector = { kind: 'isCommander' };
export const IS_MONOCOLORED: Selector = { kind: 'isMonocolored' };
export const IS_ENCHANTED: Selector = { kind: 'isEnchanted' };
export const IS_EQUIPPED: Selector = { kind: 'isEquipped' };
export const IN_COMBAT: Selector = { kind: 'inCombat' };
export const NONLAND: Selector = not(ofType('Land'));

/** Neriv's subject leaf. */
export const ENTERED_THIS_TURN: Selector = { kind: 'enteredThisTurn' };

/**
 * Does this selector read a layer's own output anywhere inside it?
 *
 * A `true` answer means the selector may only be evaluated at event or resolution time, never
 * as a continuous effect's affected set — see the module comment. `gatherEffects` is the
 * enforcement point.
 */
export function selectorIsEventOnly(selector: Selector): boolean {
  switch (selector.kind) {
    case 'powerAtLeast':
    case 'powerAtMost':
    case 'powerAtMostSource':
    case 'toughnessAtLeast':
    case 'basePowerToughness':
    case 'powerGreaterThanBase':
    case 'hasKeyword':
    case 'inCombat':
    case 'attackingEventPlayer':
    case 'attackingYouOrYourPlaneswalker':
    case 'attackedThisTurn':
    case 'controlledSinceTurnStart':
    case 'tapped':
      return true;
    case 'allOf':
    case 'anyOf':
      return selector.of.some(selectorIsEventOnly);
    case 'not':
      return selectorIsEventOnly(selector.of);
    case 'combatRole':
    case 'attackingOpponent':
    case 'attackingChosenPlayer':
      // Attack/block assignment is game state, not output from a continuous-effect layer.
      // Static effects such as attacking-creature anthems may therefore use this selector.
      return false;
    case 'self':
    case 'other':
    case 'attachedToSource':
    case 'type':
    case 'subtype':
    case 'supertype':
    case 'name':
    case 'sameNameAsSource':
    case 'color':
    case 'chosenColor':
    case 'chosenType':
    case 'chosenSubtype':
    case 'controller':
    case 'manaValueAtMost':
    case 'manaValueAtLeast':
    case 'manaCostIs':
    case 'hasAnyCounter':
    case 'hasCounter':
    case 'isToken':
    case 'enteredThisTurn':
    case 'isCommander':
    case 'owner':
    case 'isMonocolored':
    case 'isEnchanted':
    case 'enchantedByAuraYouControl':
    case 'isEquipped':
      return false;
    default:
      assertNever(selector, 'selector classification');
  }
}

/** Does `candidate` match `selector` for an effect whose source is `source`? */
export function selectMatches(
  candidate: SelectorCandidate,
  selector: Selector,
  source: SelectorSource,
): boolean {
  switch (selector.kind) {
    case 'self':
      return candidate.cardId === source.cardId;
    case 'other':
      return candidate.cardId !== source.cardId;
    case 'attachedToSource':
      // Nothing attached ⇒ matches nothing, which is exactly right: an unattached Equipment's
      // "equipped creature has …" applies to no creature at all.
      return source.attachedToCardId != null && candidate.cardId === source.attachedToCardId;
    case 'type':
      return candidate.types.includes(selector.value);
    case 'subtype':
      return candidate.subtypes.includes(selector.value);
    case 'supertype':
      return candidate.supertypes.includes(selector.value);
    case 'name':
      return candidate.name !== undefined && candidate.name === selector.value;
    case 'sameNameAsSource':
      return (
        source.sourceName !== undefined &&
        candidate.name !== undefined &&
        candidate.name === source.sourceName
      );
    case 'color':
      return candidate.colors.includes(selector.value);
    case 'chosenColor':
      return (
        source.chosenOption !== undefined && candidate.colors.includes(source.chosenOption as Color)
      );
    case 'chosenType':
      return source.chosenOption !== undefined && candidate.types.includes(source.chosenOption);
    case 'chosenSubtype':
      return source.chosenOption !== undefined && candidate.subtypes.includes(source.chosenOption);
    case 'controller':
      if (selector.who === 'eventPlayer')
        return (
          source.eventPlayerId !== undefined && candidate.controllerId === source.eventPlayerId
        );
      return selector.who === 'you'
        ? candidate.controllerId === source.controllerId
        : candidate.controllerId !== source.controllerId;
    case 'attackedThisTurn':
      return candidate.attackedThisTurn === true;
    case 'controlledSinceTurnStart':
      return candidate.controlledSinceTurnStart === true;
    case 'powerAtLeast':
      return candidate.power >= selector.n;
    case 'powerAtMost':
      return candidate.power <= selector.n;
    case 'powerAtMostSource':
      return (
        source.sourcePower !== undefined &&
        candidate.powerUnknown !== true &&
        candidate.power <= source.sourcePower
      );
    case 'hasAnyCounter':
      return candidate.hasAnyCounter === true;
    case 'hasCounter':
      // `> 0`, not presence: the counter map keeps zeroed entries once a kind has been on the
      // permanent, so a key alone does not mean the permanent still carries one.
      return (candidate.counters?.[selector.counter] ?? 0) > 0;
    case 'toughnessAtLeast':
      return candidate.toughness !== undefined && candidate.toughness >= selector.n;
    case 'basePowerToughness':
      return (
        candidate.basePower === selector.power && candidate.baseToughness === selector.toughness
      );
    case 'powerGreaterThanBase':
      return candidate.basePower !== undefined && candidate.power > candidate.basePower;
    case 'manaValueAtMost':
      return candidate.manaValue !== undefined && candidate.manaValue <= selector.n;
    case 'manaValueAtLeast':
      return candidate.manaValue !== undefined && candidate.manaValue >= selector.n;
    case 'manaCostIs':
      return (
        typeof candidate.manaCostText === 'string' &&
        selector.manaCosts.includes(candidate.manaCostText)
      );
    case 'hasKeyword':
      return candidate.keywords.includes(selector.keyword);
    case 'isToken':
      return candidate.isToken;
    case 'tapped':
      return candidate.tapped === true;
    case 'enteredThisTurn':
      return candidate.enteredThisTurn;
    case 'isCommander':
      return candidate.isCommander === true;
    case 'owner':
      return candidate.ownerId !== undefined && candidate.ownerId === source.controllerId;
    case 'isMonocolored':
      return candidate.colors.length === 1;
    case 'isEnchanted':
      return candidate.isEnchanted === true;
    case 'enchantedByAuraYouControl':
      return candidate.auraControllerIds?.includes(source.controllerId) === true;
    case 'isEquipped':
      return candidate.isEquipped === true;
    case 'inCombat':
      return candidate.inCombat === true;
    case 'combatRole':
      return candidate.combatRole === selector.role;
    case 'attackingOpponent':
      return (
        candidate.attackingDefenderId != null &&
        candidate.attackingDefenderId !== source.controllerId
      );
    case 'attackingChosenPlayer':
      return (
        source.chosenOption !== undefined && candidate.attackingDefenderId === source.chosenOption
      );
    case 'attackingYouOrYourPlaneswalker':
      // The defending player when the attack is on that player, or on a planeswalker still in combat.
      return candidate.attackingDefendingPlayerId === source.controllerId;
    case 'attackingEventPlayer':
      return (
        source.eventPlayerId !== undefined && candidate.attackingDefenderId === source.eventPlayerId
      );
    case 'allOf':
      return selector.of.every((s) => selectMatches(candidate, s, source));
    case 'anyOf':
      return selector.of.some((s) => selectMatches(candidate, s, source));
    case 'not':
      return !selectMatches(candidate, selector.of, source);

    default:
      assertNever(selector, 'selector');
  }
}

/** Does `selector` compare against its source's power (so the caller must supply it)? */
export function selectorReadsSourcePower(selector: Selector): boolean {
  switch (selector.kind) {
    case 'powerAtMostSource':
      return true;
    case 'allOf':
    case 'anyOf':
      return selector.of.some(selectorReadsSourcePower);
    case 'not':
      return selectorReadsSourcePower(selector.of);
    default:
      return false;
  }
}

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
  /** Current toughness. Only `toughnessAtLeast` reads it — see the module comment. */
  toughness?: number;
  /** Current keywords. Only `hasKeyword` reads them — see the module comment. */
  keywords: readonly string[];
  /** Mana value (CR 202.3), read by `manaValueAtMost`/`manaValueAtLeast`. Absent when the
   * candidate's card definition can't be found, which is fine: an absent value simply never
   * matches a mana-value filter rather than matching as though it were 0. */
  manaValue?: number;
  /** Token-ness (CR 111.1). NOT event-only: no layer can change it. */
  isToken: boolean;
  /** Did this permanent enter the battlefield during the CURRENT turn (Neriv)? */
  enteredThisTurn: boolean;
  /** Is this permanent/card a Commander (CR 903.3)? */
  isCommander?: boolean;
  /** Is this permanent enchanted by an Aura? */
  isEnchanted?: boolean;
  /** Is this permanent equipped by an Equipment? */
  isEquipped?: boolean;
  /** EVENT-ONLY: currently attacking or blocking. */
  inCombat?: boolean;
  /** Combat status is independent of layers, so continuous statics may read it. */
  combatRole?: 'attacking' | 'blocking' | null;
  /** The player or planeswalker this permanent is attacking, when it is an attacker. */
  attackingDefenderId?: string | null;
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
  /** The source's `chosenOption` (Caged Sun's color, …), for the `chosenColor` selector. */
  chosenOption?: string;
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
  | { kind: 'controller'; who: 'you' | 'opponents' }
  /** EVENT-ONLY (see the module comment): "with power 4 or greater". */
  | { kind: 'powerAtLeast'; n: number }
  /** EVENT-ONLY (see the module comment): "with power 2 or less". */
  | { kind: 'powerAtMost'; n: number }
  | { kind: 'toughnessAtLeast'; n: number }
  /** "with mana value 4 or less" (Sunforger) — not event-only: mana value is a printed
   * characteristic, not a layer's derived output. */
  | { kind: 'manaValueAtMost'; n: number }
  /** "with mana value 4 or greater" (Austere Command's other mode). Same rationale as
   * `manaValueAtMost` — not event-only. */
  | { kind: 'manaValueAtLeast'; n: number }
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
  /** "a creature you control that entered this turn" (Neriv, Heart of the Storm). */
  | { kind: 'enteredThisTurn' }
  | { kind: 'isCommander' }
  | { kind: 'isMonocolored' }
  | { kind: 'isEnchanted' }
  | { kind: 'isEquipped' }
  | { kind: 'inCombat' }
  | { kind: 'combatRole'; role: 'attacking' | 'blocking' }
  /** A resolving attack trigger's "that player": compare against the event's defender. */
  | { kind: 'attackingEventPlayer' }
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
export const CHOSEN_COLOR: Selector = { kind: 'chosenColor' };
export const CHOSEN_TYPE: Selector = { kind: 'chosenType' };
export const CHOSEN_SUBTYPE: Selector = { kind: 'chosenSubtype' };

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
    case 'toughnessAtLeast':
    case 'hasKeyword':
    case 'inCombat':
    case 'attackingEventPlayer':
      return true;
    case 'allOf':
    case 'anyOf':
      return selector.of.some(selectorIsEventOnly);
    case 'not':
      return selectorIsEventOnly(selector.of);
    case 'combatRole':
      // Attack/block assignment is game state, not output from a continuous-effect layer.
      // Static effects such as attacking-creature anthems may therefore use this selector.
      return false;
    case 'self':
    case 'other':
    case 'attachedToSource':
    case 'type':
    case 'subtype':
    case 'supertype':
    case 'color':
    case 'chosenColor':
    case 'chosenType':
    case 'chosenSubtype':
    case 'controller':
    case 'manaValueAtMost':
    case 'manaValueAtLeast':
    case 'hasAnyCounter':
    case 'hasCounter':
    case 'isToken':
    case 'enteredThisTurn':
    case 'isCommander':
    case 'isMonocolored':
    case 'isEnchanted':
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
      return selector.who === 'you'
        ? candidate.controllerId === source.controllerId
        : candidate.controllerId !== source.controllerId;
    case 'powerAtLeast':
      return candidate.power >= selector.n;
    case 'powerAtMost':
      return candidate.power <= selector.n;
    case 'hasAnyCounter':
      return candidate.hasAnyCounter === true;
    case 'hasCounter':
      // `> 0`, not presence: the counter map keeps zeroed entries once a kind has been on the
      // permanent, so a key alone does not mean the permanent still carries one.
      return (candidate.counters?.[selector.counter] ?? 0) > 0;
    case 'toughnessAtLeast':
      return candidate.toughness !== undefined && candidate.toughness >= selector.n;
    case 'manaValueAtMost':
      return candidate.manaValue !== undefined && candidate.manaValue <= selector.n;
    case 'manaValueAtLeast':
      return candidate.manaValue !== undefined && candidate.manaValue >= selector.n;
    case 'hasKeyword':
      return candidate.keywords.includes(selector.keyword);
    case 'isToken':
      return candidate.isToken;
    case 'enteredThisTurn':
      return candidate.enteredThisTurn;
    case 'isCommander':
      return candidate.isCommander === true;
    case 'isMonocolored':
      return candidate.colors.length === 1;
    case 'isEnchanted':
      return candidate.isEnchanted === true;
    case 'isEquipped':
      return candidate.isEquipped === true;
    case 'inCombat':
      return candidate.inCombat === true;
    case 'combatRole':
      return candidate.combatRole === selector.role;
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

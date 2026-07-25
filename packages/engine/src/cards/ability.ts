/**
 * The card ability IR — the data-driven DSL the engine executes (ADR 0004). A card's
 * behavior is structured data: `Ability`s made of atomic `Effect` primitives that reference
 * declared target slots by index. The interpreter (text → IR) and an authored-override
 * registry both produce these; one executor (`effects/resolve.ts::executeAbility`) runs them.
 *
 * This module is self-contained (no imports from `definition.ts`) so the card model can
 * depend on it without a cycle.
 */

import type { ManaUnit, ParsedManaCost } from '../mana/cost';
import type { Condition } from './condition';
import type { Selector } from './selector';

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
  /** "Sacrifice this creature" — available even while tapped or summoning-sick. */
  | { kind: 'sacrificeSelf' }
  /** "Remove a gold counter from this artifact". */
  | { kind: 'removeCounters'; counter: string; count: number }
  | { kind: 'mana'; cost: ParsedManaCost };

/** The `{T}` cost every mana ability has unless it says otherwise. */
export const TAP_COST: readonly AbilityCost[] = [{ kind: 'tap' }];

/**
 * An activated ability: "`<costs>`: `<effect>`" (CR 602). Unlike a mana ability it uses the
 * stack, so it takes targets, can be responded to, and can be countered.
 */
export interface ActivatedAbility {
  costs: AbilityCost[];
  ability: Ability;
  /** "Activate only as a sorcery" — main phase, empty stack, your turn (CR 602.5d). */
  timing: 'any' | 'sorcery';
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
  | 'opponentLandColors';

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
}

/** CR 702 keywords with real engine implementations in Phase 2 (brief §6.1). */
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
  'flash',
] as const;
export type KeywordAbility = (typeof IMPLEMENTED_KEYWORDS)[number];

/** What a target slot may point at. Slot options are computed at cast/announcement time. */
export type TargetKind =
  | 'creature'
  | 'artifact'
  | 'enchantment'
  | 'land'
  | 'permanent'
  | 'nonlandPermanent'
  | 'artifactOrEnchantment'
  | 'player'
  | 'anyTarget' // creature or player (CR 115.4)
  | 'spell';

/** One declared target slot of an ability. Effects reference it by its index. */
export interface TargetSpec {
  kind: TargetKind;
  /**
   * "target creature you control" / "target creature an opponent controls". Omitted for an
   * unrestricted slot. Kept as a field rather than more `TargetKind` literals, which would
   * multiply combinatorially with every kind above.
   */
  controller?: 'you' | 'opponent';
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
export type EffectRef = number | 'triggerObject';

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
  | { op: 'pumpUntilEot'; target: EffectRef; power: number; toughness: number }
  | { op: 'grantKeywordUntilEot'; target: EffectRef; keyword: KeywordAbility }
  | { op: 'pumpEachUntilEot'; selector: Selector; power: number; toughness: number }
  | { op: 'grantKeywordEachUntilEot'; selector: Selector; keyword: KeywordAbility }
  | { op: 'dealDamage'; target: EffectRef; amount: number } // to the slot's creature or player
  | { op: 'destroy'; target: EffectRef } // target creature
  | { op: 'exile'; target: EffectRef } // target creature
  | { op: 'counter'; target: number } // target spell — always a real target
  | { op: 'putCounters'; target: EffectRef; counter: string; count: number }
  | { op: 'putCountersEach'; selector: Selector; counter: string; count: number }
  | { op: 'draw'; count: number } // controller draws
  | { op: 'gainLife'; amount: number } // controller gains
  | { op: 'eachOpponentLosesLife'; amount: number }
  | { op: 'eachOpponentDamage'; amount: number } // damage from source to each opponent
  /** "This land deals 1 damage to you" — damage from the source to its own controller. */
  | { op: 'damageController'; amount: number }
  /** "It deals 5 damage to each creature without flying" — the untargeted mass form. */
  | { op: 'damageEach'; selector: Selector; amount: number }
  /** "Search your library for a Forest card, put it onto the battlefield" (CR 701.19). */
  | { op: 'searchLibrary'; filter: Selector; destinations: SearchDestination[] }
  | { op: 'shuffle' }
  | { op: 'scry'; count: number }
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
      mayPut: { filter: Selector; destination: SearchDestination };
      /** Where everything not taken ends up. */
      rest: 'bottomRandom';
    };

/**
 * Where one card found by a library search goes. A search has one destination per card it may
 * find, and the player picks a card for each in turn — which is also how they decide which
 * found card goes where ("put one onto the battlefield tapped and the other into your hand").
 */
export interface SearchDestination {
  zone: 'battlefield' | 'hand' | 'graveyard';
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

/** The event a triggered ability listens for. `upkeep` is a step, so it has no subject object. */
export type TriggerWhen = 'enters' | 'dies' | 'attacks' | 'upkeep';

/** The event half of a `TriggerSpec`, without the intervening-if clause. */
export type TriggerHead =
  | { when: 'enters' | 'dies' | 'attacks'; subject: TriggerSubject }
  /** "At the beginning of your/each upkeep" — `player` says whose upkeep counts. */
  | { when: 'upkeep'; player: 'you' | 'each' };

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
}

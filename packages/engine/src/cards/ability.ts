/**
 * The card ability IR — the data-driven DSL the engine executes (ADR 0004). A card's
 * behavior is structured data: `Ability`s made of atomic `Effect` primitives that reference
 * declared target slots by index. The interpreter (text → IR) and an authored-override
 * registry both produce these; one executor (`effects/resolve.ts::executeAbility`) runs them.
 *
 * This module is self-contained (no imports from `definition.ts`) so the card model can
 * depend on it without a cycle.
 */

import type { ManaUnit } from '../mana/cost';
import type { Selector } from './selector';

/** A mana ability: "{T}: Add …". Never uses the stack (CR 605). */
export interface ManaAbilitySpec {
  units: ManaUnit[];
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
export type TargetKind = 'creature' | 'anyTarget' | 'spell';

/** One declared target slot of an ability. Effects reference it by its index. */
export interface TargetSpec {
  kind: TargetKind;
}

/**
 * One atomic mechanical primitive. Targeted primitives carry `target`: the index into the
 * owning `Ability.targets` whose chosen object they act on. Untargeted primitives affect the
 * ability's controller / each opponent.
 *
 * The `…EachUntilEot` primitives take a `Selector` instead of a target slot — "creatures you
 * control", not "target creature". They choose no targets and so are never announced; the
 * selector is evaluated once, when the spell resolves, and the resulting set is then fixed
 * (CR 611.2c).
 */
export type Effect =
  | { op: 'pumpUntilEot'; target: number; power: number; toughness: number }
  | { op: 'grantKeywordUntilEot'; target: number; keyword: KeywordAbility }
  | { op: 'pumpEachUntilEot'; selector: Selector; power: number; toughness: number }
  | { op: 'grantKeywordEachUntilEot'; selector: Selector; keyword: KeywordAbility }
  | { op: 'dealDamage'; target: number; amount: number } // to the slot's creature or player
  | { op: 'destroy'; target: number } // target creature
  | { op: 'exile'; target: number } // target creature
  | { op: 'counter'; target: number } // target spell
  | { op: 'draw'; count: number } // controller draws
  | { op: 'gainLife'; amount: number } // controller gains
  | { op: 'eachOpponentLosesLife'; amount: number }
  | { op: 'eachOpponentDamage'; amount: number }; // damage from source to each opponent

/** Events a Phase 2 triggered ability can listen for. */
export type TriggerEvent =
  | 'etbSelf' // "When ~ enters the battlefield, …"
  | 'diesSelf' // "When ~ dies, …"
  | 'upkeepYours' // "At the beginning of your upkeep, …"
  | 'upkeepEach'; // "At the beginning of each upkeep, …" (controller executes each upkeep)

/**
 * A single ability — the unit the DSL executes. A spell is one `spell` ability; each
 * triggered line is a `triggered` ability. Mana abilities are represented separately
 * (`ManaAbilitySpec`) because they never use the stack.
 */
export interface Ability {
  kind: 'spell' | 'triggered';
  /** Triggered abilities only: the event that puts this on the stack. */
  trigger?: TriggerEvent;
  /** Triggered "you may …": a yes/no decision on resolution (brief §5.6). */
  optional?: boolean;
  /** Declared target slots, in order; `Effect.target` indexes into this. */
  targets: TargetSpec[];
  effects: Effect[];
  description?: string;
}

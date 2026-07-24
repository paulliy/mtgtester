/**
 * The engine's internal card model (brief §6). An `OracleCard` (raw Scryfall projection)
 * is interpreted once into a `CardDefinition`: parsed cost, implemented keywords, mana
 * abilities, spell effects, and triggered abilities. Anything the interpreter cannot fully
 * account for marks the definition `modeled: false` with a reason — the engine halts
 * loudly when such a card's behavior is actually needed, never guesses (brief §6.3).
 */

import type { Color, OracleId } from '@mtg/shared';
import type { ManaUnit, ParsedManaCost } from '../mana/cost';

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

/** What a targeted effect may target. Options are computed at cast time. */
export type TargetKind = 'creature' | 'anyTarget' | 'spell';

/**
 * One mechanical effect. Targeted effects consume target slots in order of appearance;
 * trigger effects are restricted to targetless kinds so trigger announcement never needs
 * a target decision in Phase 2.
 */
export type EffectSpec =
  | { kind: 'pump'; power: number; toughness: number } // target creature, until end of turn
  | { kind: 'grantKeyword'; keyword: KeywordAbility } // target creature, until end of turn
  | { kind: 'damageTarget'; amount: number; targetKind: 'creature' | 'anyTarget' }
  | { kind: 'destroyTarget' } // target creature
  | { kind: 'exileTarget' } // target creature
  | { kind: 'counterTarget' } // target spell
  | { kind: 'draw'; count: number } // controller draws
  | { kind: 'gainLife'; amount: number } // controller gains
  | { kind: 'eachOpponentLosesLife'; amount: number }
  | { kind: 'eachOpponentDamage'; amount: number }; // damage from source to each opponent

/** The target slot an `EffectSpec` requires, or null for targetless effects. */
export function effectTargetKind(effect: EffectSpec): TargetKind | null {
  switch (effect.kind) {
    case 'pump':
    case 'grantKeyword':
      return 'creature';
    case 'damageTarget':
      return effect.targetKind;
    case 'destroyTarget':
    case 'exileTarget':
      return 'creature';
    case 'counterTarget':
      return 'spell';
    default:
      return null;
  }
}

/** Events a Phase 2 triggered ability can listen for. */
export type TriggerEvent =
  | 'etbSelf' // "When ~ enters the battlefield, …"
  | 'diesSelf' // "When ~ dies, …"
  | 'upkeepYours' // "At the beginning of your upkeep, …"
  | 'upkeepEach'; // "At the beginning of each upkeep, …" (controller executes each upkeep)

export interface TriggerSpec {
  event: TriggerEvent;
  /** "you may …" — a yes/no AI decision on resolution (brief §5.6 optional triggers). */
  optional: boolean;
  /** Targetless effects only (Phase 2 restriction). */
  effects: EffectSpec[];
  description: string;
}

/** A mana ability: "{T}: Add …". Never uses the stack (CR 605). */
export interface ManaAbilitySpec {
  units: ManaUnit[];
}

/** Interpreted card. Immutable; one per oracle id per game. */
export interface CardDefinition {
  oracleId: OracleId;
  name: string;
  typeLine: string;
  supertypes: string[];
  types: string[];
  subtypes: string[];
  colors: Color[];
  /** Parsed cost; null for lands / cost-less cards (and for unmodeled costs). */
  manaCost: ParsedManaCost | null;
  /** True if the printed cost contains symbols we cannot pay yet ({X}, hybrid, …). */
  hasUnsupportedCost: boolean;
  /** Parsed printed P/T; null for non-creatures. `*` values are unmodeled. */
  power: number | null;
  toughness: number | null;
  /** Parsed starting loyalty (planeswalkers, CR 306.5b); null otherwise. `*` is unmodeled. */
  loyalty: number | null;
  /** Parsed starting defense (battles, CR 310.6); null otherwise. `*` is unmodeled. */
  defense: number | null;
  keywords: KeywordAbility[];
  manaAbilities: ManaAbilitySpec[];
  entersTapped: boolean;
  /** For instants/sorceries: the resolved effects, in order. */
  spellEffects: EffectSpec[];
  triggers: TriggerSpec[];
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

/**
 * What the bot knows about a card beyond its view (ADR 0039). The server derives these traits from
 * the engine's card IR and hands the bot a lookup by name, so `@mtg/bot` keeps its single
 * dependency on `@mtg/shared` and never sees a `CardDefinition`.
 *
 * A trait is a coarse role, not a rules claim: "this card's spell ability destroys a target", not
 * "this spell is legal". Legality stays with the engine's menu.
 */

/** What a card does, coarsely, from its effect ops. A card can have several roles. */
export const CARD_ROLES = [
  /** Destroys, exiles, damages, bounces or steals one target permanent. */
  'removal',
  /** Removes many permanents at once. */
  'wipe',
  /** Counters a spell or ability. */
  'counter',
  /** Draws cards or otherwise adds cards to hand. */
  'draw',
  /** Adds mana, fetches lands, or allows extra land plays. */
  'ramp',
  /** Creates tokens. */
  'tokens',
  /** Temporary or permanent boosts, keywords and counters for own creatures. */
  'pump',
  /** Hexproof, indestructible, protection, phasing or regeneration for own permanents. */
  'protection',
  /** Returns cards from graveyard. */
  'recursion',
  /** Searches the library for a nonland card. */
  'tutor',
  /** Damage or life loss to players. */
  'burn',
  /** Gains life. */
  'lifegain',
  /** Makes opponents discard. */
  'discard',
  /** Extra turns or extra combats. */
  'extraTurn',
] as const;
export type CardRole = (typeof CARD_ROLES)[number];

/** Whether a target slot's effects hurt or help what they target. */
export type TargetPolarity = 'hostile' | 'friendly' | 'neutral';

export interface CardTraits {
  manaValue: number;
  /** Card types: Creature, Instant, Land, ... */
  types: readonly string[];
  /** Roles of the spell ability, ETB triggers and static presence of the card. */
  roles: readonly CardRole[];
  /** Roles of the card's activated abilities, by ability index. */
  abilityRoles?: readonly (readonly CardRole[])[];
  /** Polarity of each target slot of the spell ability (or ETB trigger for a permanent). */
  spellTargets?: readonly TargetPolarity[];
  /** Polarity of each target slot of each activated ability, by ability index. */
  abilityTargets?: readonly (readonly TargetPolarity[])[];
  /** Printed power and toughness for creatures. */
  power?: number | null;
  toughness?: number | null;
}

/** Looks a visible card up by name. Returns undefined for a card the server has no IR for. */
export type CardKnowledge = (name: string) => CardTraits | undefined;

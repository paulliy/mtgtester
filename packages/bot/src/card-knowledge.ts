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

/**
 * A subset of the engine's permanent selector, as plain JSON. The bot evaluates the leaves it
 * understands against a `PermanentView` and treats any other leaf as unknown.
 */
export interface WipeSelector {
  kind: string;
  value?: string;
  who?: string;
  n?: number;
  keyword?: string;
  of?: WipeSelector | readonly WipeSelector[];
}

/** Keywords taken from the permanents a selector picks (`abilityKeywordStrip`). */
export interface KeywordStrip {
  selector: WipeSelector;
  /** Lower-case keyword names, as in a `PermanentView`'s `keywords`. */
  keywords: readonly string[];
}

/** A power and toughness change. */
export interface StatBoost {
  power: number;
  toughness: number;
}

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
  /** Whether each activated ability, by ability index, is limited to sorcery timing. */
  abilitySorcery?: readonly boolean[];
  /**
   * By ability index: the keywords an activated ability does nothing but take away from a set of
   * permanents until end of turn, and which permanents (Shadowspear's "permanents your opponents
   * control lose hexproof and indestructible", Arcane Lighthouse's hexproof and shroud on
   * opponents' creatures). Null for an ability that does anything else. The ability has no role,
   * so this is what lets the bot see it has nothing to act on.
   */
  abilityKeywordStrip?: readonly (KeywordStrip | null)[];
  /**
   * Fixed damage each spell target slot takes (Lightning Bolt's 3), or null where the slot takes
   * no damage or the amount is not a constant. Lets the bot tell a kill from a scratch.
   */
  spellDamage?: readonly (number | null)[];
  /** The same, per slot of each activated ability, by ability index. */
  abilityDamage?: readonly (readonly (number | null)[])[];
  /**
   * Which permanents the card's sweeper affects, as the engine's selector JSON ("nonartifact
   * creatures"). Absent when the card has no sweeper or one of its sweeps has no selector, in
   * which case every creature is assumed affected.
   */
  wipeSelector?: WipeSelector;
  /** Fixed damage a damage sweeper deals to each affected creature, when it is a constant. */
  wipeDamage?: number;
  /**
   * Damage the card's spell deals to every player, its controller included (Earthquake, Hurricane):
   * the constant, or 'X' when it is the spell's X. Absent when the spell has no such op or the
   * amount is anything else. Feeds the veto's self-lethal check.
   */
  damagesEachPlayer?: number | 'X';
  /**
   * Fixed boost each spell target slot gets (Giant Growth's +3/+3), or null where the slot gets no
   * constant boost. Lets the bot count what a pump adds to an attack (ADR 0043).
   */
  spellPump?: readonly (StatBoost | null)[];
  /**
   * A constant boost an activated ability gives its own source (firebreathing's +1/+0), by ability
   * index, or null for an ability that does not pump its source.
   */
  abilitySelfPump?: readonly (StatBoost | null)[];
  /**
   * A boost the spell gives every creature its controller controls (Overrun: +3/+3 and trample),
   * when it is constant. Absent otherwise.
   */
  massPump?: StatBoost & { keywords: readonly string[] };
  /**
   * Mana one plain `{T}` activation of the card's best mana ability makes: one entry per mana,
   * each listing the symbols it may be. Absent when the card has no such ability, or only one
   * with another cost, a condition, a restriction or state-dependent symbols.
   */
  manaUnits?: readonly (readonly string[])[];
  /**
   * The card's removal destroys or exiles its target (Swords to Plowshares, Murder), rather than
   * damaging, bouncing or shrinking it. ADR 0044's `scarce-answer` counts only this removal.
   */
  hardRemoval?: boolean;
  /**
   * The classifier cannot account for the card: at least one effect op matches no role and no
   * hostile or friendly pattern, or the engine does not model the card. Distinct from a card with
   * nothing notable (a vanilla creature, a basic land), which has no effect ops (ADR 0044).
   */
  unclassified?: boolean;
  /** The card can be cast any time it could cast an instant: the Flash keyword (CR 702.8). */
  flash?: boolean;
  /** Printed power and toughness for creatures. */
  power?: number | null;
  toughness?: number | null;
}

/** Looks a visible card up by name. Returns undefined for a card the server has no IR for. */
export type CardKnowledge = (name: string) => CardTraits | undefined;

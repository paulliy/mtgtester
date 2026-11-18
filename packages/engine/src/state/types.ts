/**
 * Engine-internal state types. These EXTEND the shared `GameState` family with fields the
 * engine needs (stable card identity, combat bookkeeping, until-end-of-turn effects) while
 * remaining structurally compatible — `getState()` returns a valid shared `GameState`.
 *
 * Identity model (brief §5.2, CR 400.7): an object changing zones becomes a NEW object
 * with a new `ObjectId`. The engine additionally assigns each physical card a stable
 * `cardId` at game creation that survives zone changes. Commander tax and commander
 * damage are keyed by `cardId` (the brief's `Record<ObjectId, number>` fields hold
 * `cardId` strings — same runtime type), because commander-ness is a property of the
 * physical card (brief §5.7) and must survive re-zoning.
 */

import type {
  Color,
  ContinuousEffect,
  GameEvent,
  GameId,
  GameObject,
  GameState,
  ObjectId,
  OracleCard,
  OracleId,
  Phase,
  PermanentState,
  PlayerId,
  PlayerState,
  StackObject,
  Zone,
} from '@mtg/shared';
import type { ManaAbilitySpec, ManaEntry, TriggerWhen } from '../cards/ability';
import type {
  Ability,
  ActivatedAbility,
  CardDefinition,
  KeywordAbility,
} from '../cards/definition';
import type { ObjectFacts } from '../cards/source-identity';
import type { Selector, SelectorCandidate } from '../cards/selector';
import type { TriggerScope } from '../cards/value';
import type { RoomDoor } from '../cards/spell-faces';
import type { EngineRng } from '../rng/engine-rng';

/** Stable physical-card identity, assigned once at game creation. */
export type CardId = string;

/** One CR 701.15 goad requirement, lasting until the goader's next turn. */
export interface GoadRequirement {
  goaderId: PlayerId;
  /** Global turn number on which this requirement was created. */
  appliedTurn: number;
  /**
   * "Goaded for the rest of the game" (Life of the Party's tokens): never expires at the goader's
   * next turn. It still ends when the creature leaves the battlefield; it outlasts a goader who
   * leaves the game.
   */
  permanent?: true;
  /**
   * Set when the goader leaves the game: the goad lasts until their next turn would have begun
   * (CR 800.4m), which is when the turn of `afterTurnOf`, seated before them, taken on or after
   * turn `fromTurn` ends.
   */
  departed?: { afterTurnOf: PlayerId; fromTurn: number };
}

/**
 * When an attack requirement made by a spell or ability ends. Both kinds count turns of one
 * player from the turn the effect was made, so "your next turn" is the first of that player's
 * turns after `setTurn`.
 */
export type EffectExpiry =
  /** "Until your next turn": ends as that player's next turn begins (the untap step). */
  | { kind: 'untilNextTurn'; playerId: PlayerId; setTurn: number }
  /** "Until the end of your next turn": ends in the cleanup step of that player's next turn. */
  | { kind: 'endOfNextTurn'; playerId: PlayerId; setTurn: number }
  /**
   * "During their next turn": applies only while `playerId` is the active player in their first
   * turn after `setTurn`, and ends in that turn's cleanup step (Willie Lumpkin).
   */
  | { kind: 'theirNextTurn'; playerId: PlayerId; setTurn: number }
  /**
   * "Until [a departed player's] next turn" or a point in it: when that player leaves the game, the
   * effect lasts until that turn would have begun (CR 800.4m), which is when the turn of
   * `afterTurnOf`, the player seated before them, taken on or after turn `fromTurn` ends.
   */
  | { kind: 'departedNextTurn'; afterTurnOf: PlayerId; fromTurn: number }
  /** "This turn": ends in the cleanup step of the turn it was made (Siren's Call). */
  | { kind: 'thisTurn'; turn: number }
  /** "That combat": ends as the named combat phase ends (Illusionist's Gambit). */
  | { kind: 'combat'; combatId: string };

/** What an attack requirement entry forbids: attacking a player or the planeswalkers they control. */
export type AttackRestrictionRule =
  | { kind: 'cantAttackPlayer'; playerId: PlayerId }
  /** "Only creatures in the chosen pile can attack": nothing outside these objects may attack at all. */
  | { kind: 'cantAttackExcept'; objectIds: ObjectId[] };

/** What attacking must achieve to obey one attack requirement (CR 508.1d). */
export type AttackRequirementRule =
  /** "Attacks each combat if able": attacking anything, a planeswalker included. */
  | { kind: 'anyAttack' }
  /** "Attacks a player other than P if able" (the goad's second half): a player, not a planeswalker. */
  | { kind: 'notPlayer'; playerId: PlayerId }
  /** "Attacks P each combat if able": that player, not one of their planeswalkers. */
  | { kind: 'player'; playerId: PlayerId };

/**
 * A requirement made by a resolving spell or ability that is not a goad or a status of one
 * permanent (Kardur, Silver Surfer). It is a rules modification, not a change to characteristics
 * (CR 611.2c): a fixed set of objects, or, when the text names no fixed set, a selector read live
 * so creatures that come under the affected players' control later are covered too.
 */
export interface AttackRequirementEntry {
  id: string;
  /** "You": the player who made the effect, and the point of view the selector is read from. */
  controllerId: PlayerId;
  sourceCardId?: CardId;
  affects:
    | { kind: 'objects'; objectIds: ObjectId[] }
    /**
     * Read live (CR 611.2c) from `viewpointId`'s point of view when it names a player other than
     * the effect's controller: "creatures the active player controls" (Siren's Call).
     */
    | { kind: 'selector'; selector: Selector; viewpointId?: PlayerId };
  requirements: AttackRequirementRule[];
  /** What the affected creatures can't attack while it lasts; it beats the requirements (CR 508.1c). */
  restrictions?: AttackRestrictionRule[];
  expires: EffectExpiry;
}

/**
 * "Until your next turn, those creatures can't block" (Taunt from the Rampart): a fixed set of
 * objects named when the effect resolved (CR 611.2c) that can't be declared as blockers until the
 * effect ends.
 */
export interface BlockRestrictionEntry {
  id: string;
  controllerId: PlayerId;
  objectIds: ObjectId[];
  expires: EffectExpiry;
}

/**
 * "You choose which creatures attack this turn" and "which creatures block this turn and how"
 * (Master Warcraft): until the end of the turn `casterId` makes the attack and block declarations
 * that the attacking and the defending players would. A newer one overrides an older one.
 */
export interface CombatChoiceEntry {
  id: string;
  casterId: PlayerId;
  sourceCardId: CardId;
  turn: number;
}

/**
 * "Until your next turn, each player may attack only the nearest opponent in the last chosen
 * direction and planeswalkers controlled by that opponent" (Teyo, Geometric Tactician). A newer
 * effect from the same card replaces the older one, so only the last choice is ever in force.
 */
/**
 * "Until your next turn, creatures can't attack you or planeswalkers you control unless their
 * controller pays 2 life for each of those creatures" (Sivitri, Dragon Master): a life tax on
 * attacks on `controllerId` and their planeswalkers, made by a resolved ability.
 */
export interface AttackLifeTaxEntry {
  id: string;
  controllerId: PlayerId;
  /** Life paid for each creature attacking. */
  amount: number;
  expires: EffectExpiry;
}

export interface AttackDirectionEntry {
  id: string;
  controllerId: PlayerId;
  /** The Teyo object that made it; a newer choice by the same object replaces its older one. */
  sourceObjectId: string;
  direction: 'left' | 'right';
  expires: EffectExpiry;
}

/**
 * "After this phase, there is an additional combat phase" (Lightning Runner, Moraug, Illusionist's
 * Gambit): a combat phase inserted directly after the phase that was current when it was created.
 * No main phase comes with it unless the text says so (`additionalMain`).
 */
export interface ExtraCombat {
  id: string;
  /** The phase it was created in; it runs as that phase ends. */
  after: Phase;
  controllerId: PlayerId;
  sourceCardId: CardId;
  sourceOracleId: OracleId;
  sourceName: string;
  /** "At the beginning of that combat, untap all creatures you control" (Moraug). */
  untapAllAtBeginning?: true;
  /** "…followed by an additional main phase" (Seize the Day). */
  additionalMain?: true;
}

export interface EngineObject extends GameObject {
  cardId: CardId;
  /** Copy of a card created in exile (CR 707.12); ceases outside stack/battlefield at SBAs. */
  isCardCopy?: true;
  /**
   * The exile copy of a prepare spell (CR 722.3c): the prepared permanent it belongs to. It stays
   * in exile, castable by that permanent's controller, while the permanent stays prepared.
   */
  preparedBy?: ObjectId;
  /** The active face while a modal DFC is on the battlefield. Non-battlefield cards use front. */
  face?: 'front' | 'back';
  /**
   * A Room permanent's unlocked designations (CR 709.5c), in printed order. Absent means both
   * doors are locked; never present off the battlefield.
   */
  unlockedDoors?: RoomDoor[];
  /** Tokens cease to exist when they leave the battlefield (CR 704.5d). */
  isToken: boolean;
  /** Commander-ness is a property of the physical card (brief §5.7). */
  isCommander: boolean;
  /** This object entered the stack/battlefield through an Escape alternative cost. */
  escaped?: boolean;
}

/**
 * How long one control-changing effect keeps hold of a permanent. `permanent` is the default;
 * `untilEndOfTurn` ends at the cleanup step (CR 514.2); `whileSourceOnBattlefield` tracks the
 * effect's source by its exact `ObjectId` — a blink is a NEW object id, so it never restores
 * an expired one (CR 400.7, 611.2b).
 */
export type ControlChangeDuration =
  | { kind: 'permanent' }
  | { kind: 'untilEndOfTurn' }
  | { kind: 'whileSourceOnBattlefield'; sourceObjectId: ObjectId };

/** One recorded control-changing effect, timestamped so ordering and expiry stay decidable. */
export interface ControlChange {
  controllerId: PlayerId;
  timestamp: number;
  duration: ControlChangeDuration;
}

export interface EnginePermanent extends PermanentState, EngineObject, CastRecord {
  /** Departure facts belong to this old object only; reincarnation never copies them. */
  lastKnownFacts?: ObjectFacts;
  /** First public destination of this departing incarnation, for CR 400.7e triggers. */
  firstDestinationObjectId?: ObjectId;
  zone: 'battlefield';
  /** Controller established by entering, distinct from later control-changing effects. */
  defaultControllerId?: PlayerId;
  /** Control-changing effects in resolution order; recipients leave, sources leave, EOT ends. */
  controlChanges?: ControlChange[];
  /** Whether a transforming double-faced permanent currently uses its back face. */
  transformed: boolean;
  /** How many times this object has transformed since it entered (CR 701.27f). */
  transformations?: number;
  /**
   * A bestowed Aura (CR 702.103b): an Aura enchantment with enchant creature, not a creature,
   * until it becomes unattached or attached to an illegal object (CR 702.103f).
   */
  bestowed?: boolean;
  /**
   * Animate Dead's enchant swap: once its enters trigger resolves, it enchants only the creature
   * put onto the battlefield with it (that object's id), or nothing (`null`) if none was.
   */
  reanimatedHostId?: ObjectId | null;
  /**
   * The DEFENDING PLAYER while in combat: the player this creature attacks, or the controller of
   * the planeswalker it attacks (CR 508.1b). Non-null exactly when this is an attacking creature.
   */
  attacking: PlayerId | null;
  /** The planeswalker this attacker attacks (CR 508.1b); null when it attacks the player. */
  attackingPlaneswalker: ObjectId | null;
  /**
   * Sticky: the attacked planeswalker has been removed from combat (CR 506.4) — it left the
   * battlefield, changed controller, or stopped being a planeswalker. The creature stays an
   * attacking creature and can be blocked, but attacks nothing and deals no combat damage
   * (CR 506.4c, 510.1b); the planeswalker returning later does not put it back into combat.
   */
  attackedPlaneswalkerRemoved: boolean;
  /**
   * Private identity of the attack this creature made most recently: the defending player
   * (attacked player, or the controller of the planeswalker it attacked, CR 508.1b) as that
   * attack stood when combat assignment for it ended. Retained at every path that clears
   * `attacking` so a CR 603.4 recheck over the exact original attacker (Kazuul) can still name
   * the last defending player of a removed-from-combat or departed attacker; a new declaration
   * overwrites it through the retain-then-clear order, so only the latest attack survives.
   * Never copied into `SelectorCandidate.attackingDefendingPlayerId`, which stays strictly
   * current-combat. Facts only for the engine; the public projections never see it.
   */
  lastAttackingDefendingPlayerId?: PlayerId;
  /** A chosen assignment prohibition lasts through all combats of this turn. */
  assignsNoCombatDamageTurn?: number;
  /** A resolved effect's fixed attack prohibition, active while the named counter remains. */
  cantAttackPlayerWhileCounter?: Array<{ playerId: PlayerId; counter: string }>;
  /** The prepared designation (CR 722.3a). */
  prepared?: true;
  /** Attacker this creature is blocking, while in combat. */
  blocking: ObjectId | null;
  /** For attackers: blockers in damage-assignment order (CR 509.2). */
  blockedByOrdered: ObjectId[];
  /** True once a deathtouch source has damaged this creature this turn (CR 704.5h). */
  damagedByDeathtouch: boolean;
  /** One-shot "next time this would be destroyed this turn" regeneration shields (CR 701.19a). */
  regenerationShields: number;
  /**
   * Set when this permanent had first or double strike as this combat's first combat damage step
   * began; without double strike it then deals no damage in the second step (CR 510.4).
   */
  dealtFirstStrikeDamage: boolean;
  /** Timestamp assigned on entry (CR 613.7 ordering of continuous effects). */
  timestamp: number;
  /** CR 613.7c: all counters of a kind use the most recent placement timestamp. */
  counterTimestamps?: Record<string, number>;
  /** Class levels are object state, not counters or copiable characteristics (CR 716). */
  classLevel?: number;
  /** `state.turnNumber` when this object entered the battlefield — "entered this turn" (Neriv). */
  enteredTurnNumber: number;
  /**
   * The zone this object moved from to enter the battlefield ("enters from a graveyard",
   * CR 603.6a): `stack` for a resolving permanent spell. Absent for a token or a permanent-spell
   * copy, which did not come from any zone.
   */
  enteredFromZone?: Zone;
  /** Independent goad requirements, one for each player that has goaded this permanent. */
  goadedBy?: GoadRequirement[];
  /** Latched during declare attackers for "had to attack this combat" triggers. */
  hadToAttackThisCombat?: boolean;
  /** A temporary requirement for this creature to attack this turn if able. */
  mustAttackThisTurn?: boolean;
  /** A temporary requirement for this creature to block if able. */
  mustBlockThisTurn?: boolean;
  /** Printed/static restriction: this creature cannot block. */
  cantBlock?: boolean;
  /** Printed/static evasion: this creature cannot be blocked. */
  cantBeBlocked?: boolean;
  /** Boast (CR 702.146): "activate only if this creature attacked this turn". */
  attackedThisTurn?: boolean;
  /** How many times it was declared as an attacker this turn; tokens put onto the battlefield attacking never count. */
  timesAttackedThisTurn?: number;
  /**
   * Indices into this permanent's `activatedAbilities` used this turn, for "activate only once
   * each turn" (CR 602.5f).
   *
   * Per PERMANENT, not per card definition: two copies of the same card each get their own
   * activation, and a permanent that leaves and returns is a new object with a clean slate.
   */
  activationsThisTurn: number[];
  /**
   * Indexes (into its triggered abilities) of "This ability triggers only once each turn"
   * abilities that have triggered this turn. Cleared every turn; a new object starts empty.
   */
  triggeredOnceThisTurn?: number[];
  /** Exhaust abilities (by index) this object has already activated (CR 702.177). */
  exhaustedAbilities?: number[];
  /**
   * Returned by unearth: "If it would leave the battlefield, exile it instead of putting it
   * anywhere else" (CR 702.84a). `moveObject` redirects every other destination to exile. A new
   * object after any zone change (CR 400.7), so the flag never outlives this permanent.
   */
  unearthed?: true;
  /** 903.9a: set when a commander arrives in graveyard/exile, cleared at the next SBA
   * check after its owner has been offered the command-zone move.
   */
  commanderSbaPending?: boolean;
  /** True if this spell/permanent was cast kicked (CR 702.33). */
  wasKicked?: boolean;
  kicked?: boolean;
  /** Counts of optional additional costs paid while this permanent was cast. */
  optionalCostCounts?: Partial<Record<'kicker' | 'squad' | 'offspring' | 'replicate', number>>;
  /** X announced for the spell that became this permanent (Ravenous). */
  announcedX?: number;
  /** The `key` chosen for `CardDefinition.entersChoosingOption`, e.g. a color or mode. */
  chosenOption?: string;
  /** Printed identity saved while a layer-1 copy effect is active. */
  copyOriginal?: {
    oracleId: OracleId;
    name: string;
    typeLine: string;
    oracleText: string;
    manaCost: string | null;
    power: number | null;
    toughness: number | null;
  };
  /** Cleanup restores temporary copy effects; permanent copies omit this flag. */
  copyUntilEot?: boolean;
  /** Printing face inherited by a copy of one exposed face, independently of physical turns. */
  copyImageFace?: 'front' | 'back';
  copyAddTypes?: string[];
  /** Keywords granted alongside a copy that the copied object doesn't itself have (Dack's
   * Duplicate's "and it has haste"). */
  copyAddKeywords?: KeywordAbility[];
  /** Triggered abilities granted alongside a copy for mechanics with no generic keyword
   * representation (Dack's Duplicate's "and it has dethrone"). */
  copyAddTriggers?: Ability[];
  /** Supertypes stripped from a copy ("except it isn't legendary" — Spark Double). */
  copyRemoveSupertypes?: string[];
  /** Supertypes granted alongside a copy that the copied object doesn't itself have
   * ("it's legendary in addition to its other types" — Sarkhan, Soul Aflame). */
  copyAddSupertypes?: string[];
  /** Name kept instead of the copied object's ("except its name is Sarkhan, Soul Aflame" —
   * Sarkhan, Soul Aflame). */
  copyNameOverride?: string;
  /**
   * Exile-zone object ids of the cards this object exiled with an `exileTargetWithSource` ability,
   * newest last. Linked to this object only (CR 607.2a): a card that leaves exile becomes a new
   * object and is no longer "exiled with" it.
   */
  exiledWithIds?: string[];
  /** A face-down manifested card is a 2/2 colorless creature. */
  faceDown?: boolean;
  /** Face down because it was manifested (CR 701.40), not cast face down. */
  manifested?: true;
  /**
   * The face-down permanent has ward {2}: it was cast face down using disguise (CR 702.168a) or
   * cloaked (CR 701.58a). Cleared as it is turned face up.
   */
  faceDownWard?: true;
}

/** Non-battlefield engine object living in graveyard/exile with 903.9a bookkeeping. */
/** One spell a player cast this turn (see `EnginePlayerState.spellsCastThisTurnRecords`). */
export interface CastSpellRecord {
  /** The spell's object id on the stack, so "other spells" can leave out exactly this one. */
  objectId: ObjectId;
  candidate: SelectorCandidate;
  manaValue: number;
}

/**
 * How a spell was cast (CR 601.2): who cast it, the zone it was cast from and the mana spent on
 * it. Carried by the spell's card and by the permanent that spell becomes, and by nothing after
 * (CR 400.7): a card put onto the battlefield any other way, or a copy of a spell, was not cast.
 */
export interface CastRecord {
  castByPlayerId?: PlayerId;
  castFromZone?: Zone;
  manaSpentToCast?: number;
}

export interface EngineCardObject extends EngineObject, CastRecord {
  /** X announced when this card was cast, retained while it resolves into a permanent. */
  announcedX?: number;
  /**
   * The turn this hand card was drawn ("cards in your hand drawn this turn", Sylvan Library). Set
   * on the hand object by a draw, so it is gone once the card leaves the hand (CR 400.7).
   */
  drawnOnTurn?: number;
  optionalCostCounts?: Partial<Record<'kicker' | 'squad' | 'offspring' | 'replicate', number>>;
  /** Mana from Treasure permanents spent to cast this card, retained until it enters. */
  treasureManaSpentToCast?: number;
  /** Counters last held while this card was a permanent, for death-triggered effects. */
  rememberedCounters?: Record<string, number>;
  /**
   * The battlefield object this card was until it moved here (CR 400.7e): an ability that
   * triggered on that permanent leaving can find this new object, and only this one. A later
   * zone change makes a new object without the link.
   */
  leftBattlefieldObjectId?: ObjectId;
  /** 903.9a flag — see `EnginePermanent.commanderSbaPending`. */
  commanderSbaPending?: boolean;
  /**
   * Exiled face down (CR 406.3): foretold, hideaway and similar. Only its owner may see it, and
   * a later zone change makes a new object without the flag.
   */
  exiledFaceDown?: true;
  /** For cards exiled by Hideaway (Spinerock Knoll, Mosswort Bridge). */
  attachedToCardId?: string;
  /**
   * The permanent object whose Hideaway exiled this card (CR 607.2a): a later incarnation of the
   * same card is a different object, with its own linked card.
   */
  attachedToObjectId?: ObjectId;
  /** For Adventure cards in exile (CR 715.3d). */
  onAdventure?: boolean;
  /**
   * "Until end of turn, you may cast spells from among those exiled cards" (Dream Pillager) —
   * which player may cast this exiled card, and only until the cleanup step clears the grant.
   */
  playableUntilEotBy?: PlayerId;
  /** A temporary cast permission never permits playing a land face. */
  castOnlyUntilEot?: true;
  /** Grenzo: only mana spent casting this exact exiled object receives this permission. */
  spendAsAnyColorUntilEot?: true;
  /**
   * "You may cast that card for as long as it remains exiled" (Gonti, Thief of Sanity, Praetor's
   * Grasp): the `playableUntilEotBy` / `castOnlyUntilEot` grant is not cleared at cleanup; it
   * lasts while this exile object exists (a zone change makes a new object without it).
   */
  playableWhileExiled?: true;
  /** "Mana of any type can be spent to cast that spell" (Gonti): every pip may be paid by any mana. */
  spendAsAnyTypeWhileExiled?: true;
  /**
   * Who may look at this face-down exiled card (CR 406.3): the player allowed to play it. When
   * set, its owner may not look unless named here.
   */
  faceDownVisibleTo?: PlayerId[];
  /** Rebound's one-shot permission to cast this card from exile at the next upkeep. */
  reboundCastBy?: PlayerId;
  /** Power Pack replaces only a move from the spell’s stack object to a graveyard. */
  exileIfGraveyardFromStack?: true;
  /**
   * Foretold (CR 702.143a): exiled face down on turn `turn`, castable by its owner on a later
   * turn for `cost`, which it keeps even if the effect that granted foretell is gone (Dream
   * Devourer). Hidden from every other player until it is cast.
   */
  foretold?: { turn: number; cost: import('../mana/cost').ParsedManaCost };
  /** A public exile incarnation plotted by an effect (CR 702.170c–d). */
  plottedTurn?: number;
}

/** The keywords that change how a source's damage is dealt (CR 702.2, 702.15, 702.90). */
export type DamageKeyword = 'deathtouch' | 'lifelink' | 'infect';

export interface EngineStackObject extends StackObject {
  giftRecipientId?: PlayerId;
  /** Addendum (Unbreakable Formation): cast during a main phase of its caster's own turn. */
  castDuringOwnMainPhase?: true;
  /** Last known rules facts of this ability's source incarnation. */
  sourceFacts?: ObjectFacts;
  /**
   * The source permanent's transform count as this activated or (non-delayed) triggered ability
   * was put on the stack: it transforms its source only if that has not changed (CR 701.27f).
   */
  sourceTransformations?: number;
  /** Internal CR 601 proposal; never triggers a cast until payment finalizes. */
  castInProgress?: true;
  /** Selected characteristics on the stack; copies retain these without changing physical card data. */
  spellDefinition?: CardDefinition;
  /** The card object being cast, for spells (moves to its destination on resolution). */
  card: EngineCardObject | null;
  /** The ability being resolved (spell or triggered) — drives the executor and fizzle. */
  ability: Ability | null;
  /** Oracle id of the source, for definition lookup. */
  sourceOracleId: OracleId;
  /** Stable card id of the source (commander damage / identity tracking). */
  sourceCardId: CardId;
  /** True when the "spell" is a commander cast from the command zone. */
  isCommanderCast: boolean;
  /**
   * The source's colors as this ability was put on the stack — last known information for
   * protection (CR 702.16) once the source has left the battlefield, where its printed colors
   * could be wrong (a red permanent made colorless).
   */
  sourceColors?: Color[];
  /**
   * The source's damage keywords (deathtouch, lifelink, infect) immediately before it left the
   * battlefield, recorded as it leaves and only when it had any — last known information for
   * damage it deals afterwards (Mordant Dragon's trigger, CR 113.7a).
   */
  sourceDamageKeywords?: DamageKeyword[];
  /** Kind of alternative cast used, if any (overload, adventure, omen). */
  alternativeCastKind?:
    | 'overload'
    | 'adventure'
    | 'omen'
    | 'mdfc'
    | 'nonMana'
    | 'energy'
    | 'commanderFree'
    | 'faceDown'
    | 'bestow'
    | 'split'
    | 'libraryTopLife';
  altIndex?: number;
  /** Triggered abilities: the object whose event fired this — the `'triggerObject'` referent. */
  triggerObjectCardId?: CardId;
  /** Numbers the firing event contributed (count, damage, spell mana value). */
  triggerScope?: TriggerScope;
  /** Kicker announcement state retained while the spell is on the stack. */
  wasKicked?: boolean;
  kicked?: boolean;
  optionalCostCounts?: Partial<Record<'kicker' | 'squad' | 'offspring' | 'replicate', number>>;
  /** The X announced when this spell was cast (CR 601.2b), for its own effects to read. */
  announcedX?: number;
  /**
   * Chosen ids for a variable-count target slot (`TargetSpec.count`), keyed by slot index —
   * "up to two other targets" (Drakuseth), "any number of … target creatures" (Ureni). A
   * single-target slot's choice lives in the inherited `targets` array at its own index
   * instead; a slot that can hold zero, one, or several objects has nothing sensible to put
   * there.
   */
  countTargets?: Record<number, ObjectId[]>;
  /**
   * The per-target division of a `dealDamageDivided` effect's total, decided at announcement
   * alongside the count-slot's targets (CR 601.2d) and replayed identically at resolution —
   * keyed by object id rather than slot, since one ability carries at most one divided effect
   * in every card this engine reads today.
   */
  divisionAmounts?: Record<ObjectId, number>;
  grantHasteOnResolution?: boolean;
  /** The original hand-cast carried Rebound and should be exiled after resolving. */
  reboundPending?: boolean;
  /**
   * A copy of a permanent spell (Replicate on an Aura): it has no card, and becomes a token
   * permanent as it resolves (CR 608.3f, 707.10f) whose `cardId` is this object's
   * `sourceCardId` and whose definition is `sourceOracleId`'s.
   */
  permanentSpellCopy?: { oracleText: string; manaCost: string | null };
  /** Flashback/Escape-style casts exile the spell after resolution or fizzle. */
  exileOnResolution?: boolean;
  /** This spell was announced for its Escape cost. */
  escaped?: boolean;
  /** This spell was announced for its Dash cost (CR 702.109a). */
  dashed?: boolean;
}

export interface EngineEmblem {
  id: string;
  name: string;
  controllerId: PlayerId;
  abilities: Ability[];
}
export interface EnginePlayerState extends PlayerState {
  /**
   * Land plays added this turn by a one-shot effect ("you may play an additional land this
   * turn", CR 305.2), for the turn numbered `turn`; a later turn ignores it.
   */
  additionalLandPlays?: { turn: number; count: number };
  hand: EngineCardObject[];
  library: EngineCardObject[];
  graveyard: EngineCardObject[];
  commandZone: EngineCardObject[];
  companion: EngineCardObject | null;
  /** Player-owned emblems are neither permanents nor cards and cannot change zones. */
  emblems: EngineEmblem[];
  /**
   * The authoritative mana pool (CR 106.4) — one entry per mana, because two mana of the same
   * color stop being interchangeable once one carries a CR 106.6 restriction, a spend trigger,
   * or an exemption from the end-of-step drain.
   *
   * The inherited `manaPool` is the per-symbol count SUMMARY of this, which is all the
   * `PlayerView`, the spectator projection and the web app need. `mana/pool.ts` is the only
   * module that writes either, so the two cannot drift.
   */
  manaEntries: ManaEntry[];
  /** Energy counters a player has (CR 122.8). */
  energy: number;
  /** Named global counters tracked by cards and exposed to player-facing views. */
  counters: Record<string, number>;
  /** Stable card ids of this player's commander(s). */
  commanderCardIds: CardId[];
  /**
   * Commander names by card id, fixed at game creation. A commander leaves the game with its
   * eliminated owner (CR 800.4a), so it cannot be named by searching the zones.
   */
  commanderNames: Record<CardId, string>;
  /**
   * Union of this player's commanders' color identities, fixed at game creation. Color identity
   * is a characteristic of the card, not of its current zone (CR 903.4), so it must not be read
   * from wherever the commander happens to be now.
   */
  commanderColorIdentity: Color[];
  /** Set when a draw was attempted from an empty library (loss at next SBA check). */
  attemptedDrawFromEmptyLibrary: boolean;
  /** Number of cards this player has drawn during the current turn. */
  cardsDrawnThisTurn: number;
  /**
   * Cards drawn since this player's own draw step began (CR 504.1). Distinct from
   * `cardsDrawnThisTurn`, which spans the whole game turn: "except the first one they draw in
   * each of their draw steps" (Orcish Bowmasters, Notion Thief) exempts exactly one draw, and
   * only the one taken in that player's own draw step.
   */
  cardsDrawnThisDrawStep: number;
  /** Number of spells this player has cast during the current turn. */
  spellsCastThisTurn: number;
  /** Of those, the ones that were not creature spells ("you've cast a noncreature spell"). */
  noncreatureSpellsCastThisTurn: number;
  /** Discard actions this turn, irrespective of a replacement's destination. */
  discardedCardsThisTurn?: number;
  /**
   * Those spells in cast order, by their characteristics as cast: "your fourth noncreature spell
   * each turn" (The Fantasticar), "the total mana value of other spells you've cast this turn"
   * (Call Forth the Tempest), "colors among … spells you've cast this turn" (First Family).
   * Cleared at the start of each turn.
   */
  spellsCastThisTurnRecords?: CastSpellRecord[];
  /** Names of spells this player has resolved this game, for Paradigm (CR 702.192). */
  resolvedSpellNames?: string[];
  /** Muldrotha-style graveyard play uses, keyed by the permanent type spent. */
  playFromZoneTypeUsesThisTurn: Record<string, number>;
  mulligansTaken: number;
  /** The player's decklist (oracle ids) — contents only; feeds the PlayerView. */
  decklistOracleIds: OracleId[];
  /** True once the companion has been moved to hand (once per game). */
  companionMovedToHand: boolean;
  /** True when player chose "Pass and yield until end of turn". */
  yieldUntilEndOfTurn?: boolean;
  /** Oracle IDs of triggered abilities the player has chosen to "Yield to this ability". */
  yieldedAbilities?: OracleId[];
  /**
   * Offer this player's mana abilities as priority actions (`mana/manual.ts`, ADR 0030). Set at
   * game creation for human seats; bots leave payment to the engine and never see them.
   */
  manualMana?: boolean;
}

/** An until-end-of-turn continuous effect (the Phase 2 subset of CR 613). */
export interface UntilEotEffect extends ContinuousEffect {
  /** Omitted means cleanup removes it; permanent supports one-shot type-changing effects. */
  duration?: 'permanent';
  /**
   * The permanents this effect applies to, fixed when the spell or ability that created it
   * resolved (CR 611.2c) and never recomputed. A single-target pump is the one-element case;
   * "creatures you control get +3/+3" snapshots the set that existed at resolution, so a
   * creature entering afterwards is not pumped and one that leaves and returns is not either.
   */
  targetCardIds: CardId[];
  /**
   * The exact objects, for an effect that outlives the turn (Hunting Wilds' animated Forests):
   * a card that leaves and returns is a new object the effect never applied to (CR 400.7). The
   * departing object keeps the effect, so last-known information still sees it (a dying
   * animated Forest is a creature dying).
   */
  targetObjectIds?: ObjectId[];
  kind:
    | 'ptDelta'
    | 'grantKeyword'
    | 'grantProtection'
    | 'denyKeywords'
    | 'loseKeywords'
    | 'grantAbility'
    | 'cantBeBlocked'
    | 'becomeCreature'
    | 'addTypes'
    | 'grantActivatedAbility'
    | 'grantManaAbility';
  power?: number;
  toughness?: number;
  keyword?: KeywordAbility;
  /**
   * "…gain protection from each color until end of turn" (Akroma's Will). Protection is not a
   * `KeywordAbility` — it carries an argument — so it needs its own field and its own layer-6
   * op (`addProtection`) rather than riding on `keyword`.
   */
  protectionFrom?: Color[];
  /** Keywords the affected permanents lose and can't have (`denyKeywords`, Arcane Lighthouse). */
  deniedKeywords?: KeywordAbility[];
  /** Keywords the affected permanents lose until end of turn (`loseKeywords`, Shadowspear). */
  lostKeywords?: KeywordAbility[];
  ability?: Ability;
  /** `grantActivatedAbility` / `grantManaAbility`: "This Saga gains '{T}: Add {C}.'" */
  activatedAbility?: ActivatedAbility;
  manaAbility?: ManaAbilitySpec;
  /** `addTypes`: "They're artifacts in addition to their other types" (layer 4). */
  addTypes?: string[];
  /** `addTypes` too: "it becomes an Orc in addition to its other types" (amass, layer 4). */
  addSubtypes?: string[];
  /**
   * "Becomes a 4/4 red and green Dragon artifact creature with flying until end of turn"
   * (Atarka Monument, Sarkhan's +1) — a type-changing CDA-shaped grant, distinct from
   * `ptDelta` (always sublayer 7d MODIFY, never a 7b SET) and from a single `grantKeyword`
   * (this can add several at once).
   */
  becomeCreature?: {
    addSubtypes: string[];
    power: number;
    toughness: number;
    addKeywords: KeywordAbility[];
    setColors?: Color[];
    /** See `Effect.becomeCreatureUntilEot.replaceTypes` — full type-line replacement, not add. */
    replaceTypes?: string[];
    /** Set alongside `replaceTypes`, added otherwise. */
    supertypes?: string[];
  };
  /** Timestamp assigned on creation (CR 613.7 within-layer ordering). */
  timestamp: number;
}

/** Per-combat bookkeeping, reset every combat phase. */
export interface CombatState {
  /** The players being attacked this combat (defending players). */
  defendingPlayers: PlayerId[];
}

/** A triggered ability that has triggered but is not yet on the stack (CR 603.3b). */
export interface PendingTrigger {
  sourceFacts?: ObjectFacts;
  /** Battlefield incarnation that generated the trigger, retained after it leaves. */
  sourceObjectId?: ObjectId;
  /** The source's colors as it left before this went on the stack (CR 113.7a). */
  sourceColors?: Color[];
  /** The source's damage keywords as it left before this went on the stack (CR 113.7a). */
  sourceDamageKeywords?: DamageKeyword[];
  controllerId: PlayerId;
  sourceCardId: CardId;
  sourceOracleId: OracleId;
  sourceName: string;
  ability: Ability;
  /**
   * The object whose event fired this trigger — the attacking Dragon, the creature that
   * entered. Absent for `self` and step triggers, where the source IS the object. Effects
   * reference it with `target: 'triggerObject'`.
   *
   * For an aggregate trigger this is the FIRST matching object. That is deliberate: aggregate
   * text ("one or more Dragons … draw that many cards") never says "it", so a single referent is
   * enough, and picking one keeps `EffectRef` from needing a set form.
   */
  triggerObjectCardId?: CardId;
  /**
   * Numbers only the event knows — how many objects matched, how much damage was dealt, the
   * mana value of the spell cast. Captured here because the event is over by the time the
   * trigger resolves, so these cannot be re-derived from the board.
   */
  scope?: TriggerScope;
}

export interface DelayedTrigger {
  id: string;
  sourceCardId: CardId;
  sourceOracleId: OracleId;
  controllerId: PlayerId;
  targetId?: CardId;
  /** With `sameObject`, the remembered object's id, so a new object of that card never matches. */
  targetObjectId?: ObjectId;
  when: TriggerWhen;
  ability: Ability;
  /**
   * `'endStep'`/`'cleanup'` are step- and turn-scoped: the trigger is swept when that boundary
   * passes, whether or not it fired. `'onFire'` is the opposite — it survives every cleanup and
   * is removed only once it has fired, which is what a delayed trigger waiting for a LATER turn
   * (Rebound's "at the beginning of your next upkeep") needs.
   */
  expiry: 'endStep' | 'cleanup' | 'onFire' | 'permanent';
  /** Player affected by/deciding the delayed effect, independent of controller and step owner. */
  affectedPlayerId?: PlayerId;
  /**
   * `'you'` restricts firing to the controller's own step. Without it a `when: 'upkeep'` delayed
   * trigger fires at the next matching step in turn order, whoever's it is — right for "the next
   * turn's upkeep" or "the next end step", wrong for "your next upkeep".
   */
  player?: 'you';
  /** A `castsSpell` delayed trigger: only its controller's spells matching this filter. */
  castFilter?: Selector;
  /** Removed as soon as it fires ("when you NEXT cast"), whatever its expiry. */
  once?: true;
}

/** "Prevent all damage that would be dealt to you this turn" and its relatives (CR 615). */
export interface DamageShield {
  id: string;
  /** The spell or ability that created it, as last known information. */
  effectSource: import('../effects/resolve').EffectSource;
  /** The player whose damage it prevents; absent for a shield on one permanent (`object`). */
  playerId?: PlayerId;
  /**
   * A shield on one permanent, by object id (Delirium): damage dealt to it, by it, or both. It
   * stops covering the permanent when it leaves, since a new object is not the same one (CR 400.7).
   */
  object?: { id: ObjectId; dealtTo: boolean; dealtBy: boolean };
  /** Only combat damage is prevented. */
  combatOnly?: true;
  /**
   * Only damage from this one object: a permanent or a spell on the stack, by its object id. A
   * source that changes zones is a new object and no longer matches (CR 400.7).
   */
  sourceObjectId?: ObjectId;
  /** "The next time ... would deal damage": removed as soon as it prevents damage. */
  oneShot?: true;
  /** Also covers damage to planeswalkers its player controls, checked as the damage would be dealt. */
  andPlaneswalkersTheyControl?: true;
  /** Only damage from sources that this player does not control, checked as it would be dealt. */
  sourceNotControlledBy?: PlayerId;
  /**
   * "If damage is prevented this way, <the effect source> deals that much damage to ...": to that
   * source's controller, or (Comeuppance) to the source itself when it is a creature as the damage
   * would be dealt and otherwise to its controller.
   */
  reflect?: 'toSourceController' | 'toSourceCreatureElseController';
}

/** Damage an effect owes because it prevented damage, dealt right after the prevented event. */
export interface DamageReflection {
  effectSource: import('../effects/resolve').EffectSource;
  /** A player or a permanent (object id) to deal the damage to. */
  toId: string;
  amount: number;
  /**
   * The (shield, recipient, amount) steps that led here from the original damage event. A step
   * that repeats is a mandatory loop with no choice in it (CR 104.4b).
   */
  chain: string[];
}

export interface EngineState extends GameState {
  players: EnginePlayerState[];
  battlefield: EnginePermanent[];
  exile: EngineCardObject[];
  stack: EngineStackObject[];
  effects: UntilEotEffect[];
  gameId: GameId;
  /** Monotonic counters for deterministic id assignment. */
  nextObjectNum: number;
  nextEventSequence: number;
  nextDecisionNum: number;
  /** Monotonic timestamp for continuous-effect ordering (CR 613.7). */
  nextTimestamp: number;
  /** Ordinal main phase begun this turn, including extra main phases. */
  mainPhasesStartedThisTurn?: number;
  combat: CombatState | null;
  /**
   * Board states for action-by-action replay, keyed by the `GameEvent.sequence` they are the
   * *result* of. Populated only for events the spectator log renders, and drained by the
   * server (`Engine.drainSpectatorSnapshots`) so a long game does not retain every board.
   */
  sequenceSnapshots?: Map<number, import('@mtg/shared').SpectatorState>;
  /** The loggable event still owed a snapshot — see `settleSpectatorSnapshot`. */
  pendingSnapshotSequence?: number | null;
  /** Fixed seating (never mutated) — `turnOrder` shrinks as players are eliminated. */
  seating: PlayerId[];
  /** The player whose turn it is, tracked by id (survives turnOrder mutation). */
  currentTurnPlayer: PlayerId;
  /** Triggers waiting to be put on the stack at the next priority checkpoint (CR 603.3b). */
  pendingTriggers: PendingTrigger[];
  delayedTriggers: DelayedTrigger[];
  /**
   * Controllers of a permanent dealt excess damage THIS TURN (Rith, Liberated Primeval) — the
   * amount by which a single hit exceeded what was needed to reduce it to 0 toughness. Reset at
   * the next untap step (CR 514.2 doesn't clear this; it is turn-scoped, not step-scoped).
   */
  excessDamageControllerIds: PlayerId[];
  /** Total damage dealt to each player THIS TURN (Spinerock Knoll). Reset at untap step. */
  damageDealtToPlayersThisTurn: Record<PlayerId, number>;
  /** Whether each player has lost life THIS TURN. */
  lifeLostThisTurn: Record<PlayerId, boolean>;
  /** Whether each player has created a token THIS TURN (Idol of Oblivion). Reset at untap step. */
  createdTokenThisTurn: Record<PlayerId, boolean>;
  /** Number of creatures put into graveyards this turn. */
  creaturesDiedThisTurn: number;
  /**
   * Players under whose control a modified creature (CR 700.9) died this turn (Intermediate
   * Chirography), judged by last-known information as it died. Reset at the start of each turn.
   */
  modifiedCreatureDiedThisTurn?: Record<PlayerId, true>;
  /**
   * "If this is the second time this ability has resolved this turn" (Rumor Gatherer): how many
   * times each counted ability has resolved this turn, keyed by the source's battlefield object
   * id and the ability's key. A source that changes zones is a new object with a fresh count
   * (CR 400.7). Cleared at the start of each turn.
   */
  abilityResolutionsThisTurn?: Record<string, number>;
  /**
   * "Do this only once each turn" (Cosmic Crucible): keys (source object id and action) of
   * once-each-turn actions already taken this turn. Cleared at the start of each turn.
   */
  onceEachTurnActionsTaken?: string[];
  /** Combat-damage replacement shields used by Darkness-style effects this turn. */
  combatDamagePrevention: {
    all: boolean;
    players: Record<PlayerId, boolean>;
    tokenSpecs?: Record<PlayerId, import('../cards/ability').TokenSpec>;
  };
  /**
   * Damage prevention shields created by resolving spells and abilities, oldest first, cleared as
   * the turn's "until end of turn" effects end (CR 514.2). Each is collected by the damage modifier
   * pipeline (`effects/damage-modifiers.ts`) for the damage it covers.
   */
  damageShields: DamageShield[];
  /** Reflections queued by prevention, drained by `flushDamageReflections` (transient). */
  damageReflections: DamageReflection[];
  /** The chain of the reflection being dealt right now, empty for an original damage event. */
  damageChain: string[];
  /** Players protected from dropping below 1 life until the end of the turn (Angel's Grace). */
  lifeFloorPlayers: Record<PlayerId, boolean>;
  /** The turn number during which each player can't lose the game (Angel's Grace, CR 104.3a). */
  cantLoseTurn?: Record<PlayerId, number>;
  spellsProhibitedTurn?: number;
  playerHexproofTurn?: Record<PlayerId, number>;
  extraTurns?: PlayerId[];
  phasedOut?: { permanent: EnginePermanent; phaseInPlayerId: PlayerId }[];
  playerProtectionUntilNextTurn?: Record<PlayerId, number>;
  /** Protection from everything without the life lock (The One Ring), keyed like the above. */
  playerProtectionFromEverythingUntilNextTurn?: Record<PlayerId, number>;
  /** Attack requirements made by resolved spells and abilities, until they expire (CR 508.1d). */
  attackRequirements?: AttackRequirementEntry[];
  /** Creatures that can't block because of a resolved spell or ability, until it expires. */
  blockRestrictions?: BlockRestrictionEntry[];
  /** Whoever chooses this turn's attackers and blockers in place of the usual players (Master Warcraft). */
  combatChoices?: CombatChoiceEntry[];
  /** Seat-direction limits on whom players may attack, until they expire (Teyo). */
  attackDirections?: AttackDirectionEntry[];
  attackLifeTaxes?: AttackLifeTaxEntry[];
  normalTurnResumeAfter?: PlayerId;
  /**
   * "Creatures can't be blocked this turn" (Venser, the Sojourner). A rule, not a characteristic,
   * so it covers creatures that arrive after it resolved too (CR 611.2c). Reset each turn.
   */
  creaturesCantBeBlockedThisTurn: boolean;
  /**
   * Cards exiled "until SOURCE leaves the battlefield" (Conclave Tribunal), keyed by the
   * source's card id, so `moveObject` can find and return them all when the source itself
   * leaves (CR 610.3c — they return under their owners' control). The exiled
   * object itself lives in `exile`; this only records which one to look for and who gets it.
   */
  exiledUntilLeaves: Record<
    CardId,
    { cardId: CardId; controllerId: PlayerId; objectId?: ObjectId }[]
  >;
  /**
   * Which players were dealt COMBAT damage by each source THIS TURN, keyed by source card id
   * (Steel Hellkite's "whose controller was dealt combat damage by this creature this turn") —
   * by SOURCE, unlike `damageDealtToPlayersThisTurn`, and combat damage only. Reset at untap.
   */
  combatDamagePlayersBySource: Record<CardId, PlayerId[]>;
  /** Safety cap: exceeding this halts the game as a probable bug (brief §4). */
  turnCap: number;
  /**
   * Additional combat phases waiting to run, most recently inserted first (CR 500.8): each runs
   * directly after the phase it was created in, ahead of anything scheduled after that phase
   * earlier. Emptied at the end of the turn.
   */
  extraCombats: ExtraCombat[];
  /** Has this turn reached the declare attackers step of a combat phase yet? Reset each turn. */
  declareAttackersReachedThisTurn?: boolean;
  /** The combat phase being run: `regular`, or the id of the `ExtraCombat` it is. */
  currentCombatId?: string;
  /** The player who is currently the monarch, or null before the mechanic appears. */
  monarchPlayerId: PlayerId | null;
  /** Until-end-of-turn activated abilities temporarily granted to cards in graveyards. */
  temporaryGraveyardAbilities: Record<CardId, ActivatedAbility[]>;
}

/** Everything the engine's flow code operates on. `defs` is immutable per game. */
export interface GameContext {
  state: EngineState;
  defs: Map<OracleId, CardDefinition>;
  rng: EngineRng;
  debugLog: DebugEntry[];
  /**
   * Resolution-local CR 400.7j transitions. Only the context executing this effect carries
   * this map; unrelated moves while a decision is suspended cannot rebind its referents.
   * A hidden-zone destination ends tracking, represented by null.
   */
  resolutionObjectMoves?: Map<ObjectId, ObjectId | null>;
  /** CR 608.2h departure information for objects moved by the resolving effect. */
  resolutionObjectFacts?: Map<ObjectId, ObjectFacts>;
  /**
   * Card ids of permanents already placed by the simultaneous entry being built. They were not
   * on the battlefield before that event, so their entry replacements do not apply to fellow
   * entrants (CR 614.12).
   */
  enteringTogether?: ReadonlySet<CardId>;
  /** Set while an activation's costs are paid: the life paid as part of them (Verrak). */
  costLifePaid?: { amount: number };
  /** Copied from `GameConfig.strictInvariants`: rethrow invariant failures instead of halting. */
  strictInvariants?: boolean;
  /** The test-only diagnostics sink (ADR 0034 decision 4); absent in production. */
  diagnostics?: import('../testing/diagnostics').DiagnosticsSink;
  /**
   * Work limits from `EngineOptions` (ADR 0031 decision 9), absent when unlimited. One shared
   * object, because effect resolution copies the context by spreading it and a plain number
   * would be copied by value; payment probes build their own context without it.
   */
  budget?: EngineBudget;
}

export interface EngineBudget {
  /** Events one `advance()` may emit; `engineHalt` is exempt. */
  maxStepWork?: number;
  /** Objects the whole game may create, counted from when the engine was built. */
  maxObjects?: number;
  /** Events emitted in the current `advance()`, reset at its start. */
  stepWork: { count: number };
  /** `nextObjectNum` when the engine was built: a game's starting cards are not counted. */
  objectsAtStart: number;
  /** Objects one turn may create; see `EngineOptions.maxTurnObjects`. */
  maxTurnObjects?: number;
  /** The turn being counted and `nextObjectNum` when its first object was created. */
  turnObjects?: { turn: number; atStart: number };
}

/** Internal debug log entry (brief §13) — separate from the replayable `GameEvent` log. */
export interface DebugEntry {
  turn: number;
  category:
    | 'sba'
    | 'priority'
    | 'stack'
    | 'legalActions'
    | 'zoneChange'
    | 'effect'
    | 'decision'
    | 'combat'
    | 'turn'
    | 'engine';
  message: string;
  data?: Record<string, unknown>;
}

/** Configuration for one seat. Cards are pre-expanded (quantities applied). */
export interface EnginePlayerConfig {
  id: PlayerId;
  deckId: string;
  /** One or two commanders (Partner — brief §5.7). */
  commanders: OracleCard[];
  /** The rest of the deck (excluding commanders and companion). */
  cards: OracleCard[];
  companion?: OracleCard | null;
  /** Offer this seat's mana abilities as priority actions (ADR 0030). Human seats only. */
  manualMana?: boolean;
}

export interface GameConfig {
  gameId: GameId;
  seed: string;
  /** Four seats in v1; the count is a parameter, but only four is tested (brief §15). */
  players: EnginePlayerConfig[];
  /** Halt-as-probable-bug turn cap (brief §4). Default 500. */
  turnCap?: number;
  /**
   * Test hook: override/augment interpreted definitions by oracle id. Lets fixture tests
   * exercise mechanics (auras, custom triggers) the oracle-text interpreter doesn't
   * produce yet. Not used in production paths.
   */
  customDefinitions?: CardDefinition[];
  /**
   * Test hook (ADR 0034 decision 2): rethrow `EngineInvariantError` instead of halting, so a
   * failing test points at the line responsible. Never set in production paths.
   */
  strictInvariants?: boolean;
  /**
   * Test hook (ADR 0034 decision 4): the sink `noop` records early exits in. Without it, a game
   * gets the default installed by `installDefaultDiagnostics`, if any. Never set in production.
   */
  diagnostics?: import('../testing/diagnostics').DiagnosticsSink;
  /**
   * The random source (ADR 0031 decision 4). `legacy` (the default) seeds `Prng` from `seed`, so
   * fixed-seed games, benchmarks and stored replays are unchanged. `chacha20` keys a ChaCha20
   * stream with `rngKey`, 32 bytes as 64 hex digits, and `seed` is only a public label. The key
   * stays in the RNG and the stored config; it never enters `EngineState`, events or snapshots.
   */
  rng?: 'legacy' | 'chacha20';
  rngKey?: string;
}

export type { GameEvent };

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
  ContinuousEffect,
  GameEvent,
  GameId,
  GameObject,
  GameState,
  ObjectId,
  OracleCard,
  OracleId,
  PermanentState,
  PlayerId,
  PlayerState,
  StackObject,
} from '@mtg/shared';
import type { ManaEntry, TriggerWhen } from '../cards/ability';
import type { Ability, ActivatedAbility, CardDefinition, KeywordAbility } from '../cards/definition';
import type { TriggerScope } from '../cards/value';
import type { Prng } from '../rng/prng';

/** Stable physical-card identity, assigned once at game creation. */
export type CardId = string;

/** One CR 701.15 goad requirement, lasting until the goader's next turn. */
export interface GoadRequirement {
  goaderId: PlayerId;
  /** Global turn number on which this requirement was created. */
  appliedTurn: number;
}

export interface EngineObject extends GameObject {
  cardId: CardId;
  /** Tokens cease to exist when they leave the battlefield (CR 704.5d). */
  isToken: boolean;
  /** Commander-ness is a property of the physical card (brief §5.7). */
  isCommander: boolean;
}

export interface EnginePermanent extends PermanentState, EngineObject {
  zone: 'battlefield';
  /** Player this creature is attacking, while in combat. */
  attacking: PlayerId | null;
  /** Attacker this creature is blocking, while in combat. */
  blocking: ObjectId | null;
  /** For attackers: blockers in damage-assignment order (CR 509.2). */
  blockedByOrdered: ObjectId[];
  /** True once a deathtouch source has damaged this creature this turn (CR 704.5h). */
  damagedByDeathtouch: boolean;
  /** Set when this permanent dealt first-strike damage this combat (CR 510.5). */
  dealtFirstStrikeDamage: boolean;
  /** Timestamp assigned on entry (CR 613.7 ordering of continuous effects). */
  timestamp: number;
  /** `state.turnNumber` when this object entered the battlefield — "entered this turn" (Neriv). */
  enteredTurnNumber: number;
  /** Independent goad requirements, one for each player that has goaded this permanent. */
  goadedBy?: GoadRequirement[];
  /** Latched during declare attackers for "had to attack this combat" triggers. */
  hadToAttackThisCombat?: boolean;
  /** A temporary requirement for this creature to block if able. */
  mustBlockThisTurn?: boolean;
  /** Printed/static restriction: this creature cannot block. */
  cantBlock?: boolean;
  /** Printed/static evasion: this creature cannot be blocked. */
  cantBeBlocked?: boolean;
  /** Boast (CR 702.146): "activate only if this creature attacked this turn". */
  attackedThisTurn?: boolean;
  /**
   * Indices into this permanent's `activatedAbilities` used this turn, for "activate only once
   * each turn" (CR 602.5f).
   *
   * Per PERMANENT, not per card definition: two copies of the same card each get their own
   * activation, and a permanent that leaves and returns is a new object with a clean slate.
   */
  activationsThisTurn: number[];
  /** 903.9a: set when a commander arrives in graveyard/exile, cleared at the next SBA
   * check after its owner has been offered the command-zone move.
   */
  commanderSbaPending?: boolean;
  /** True if this spell/permanent was cast kicked (CR 702.33). */
  wasKicked?: boolean;
  kicked?: boolean;
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
  /** Cards exiled by a Duplicant-style ability, newest card last. */
  exiledCardIds?: CardId[];
  /** A face-down manifested card is a 2/2 colorless creature. */
  faceDown?: boolean;
}

/** Non-battlefield engine object living in graveyard/exile with 903.9a bookkeeping. */
export interface EngineCardObject extends EngineObject {
  /** Counters last held while this card was a permanent, for death-triggered effects. */
  rememberedCounters?: Record<string, number>;
  /** 903.9a flag — see `EnginePermanent.commanderSbaPending`. */
  commanderSbaPending?: boolean;
  /** For cards exiled by Hideaway (Spinerock Knoll, Mosswort Bridge). */
  attachedToCardId?: string;
  /** For Adventure cards in exile (CR 715.3d). */
  onAdventure?: boolean;
  /**
   * "Until end of turn, you may cast spells from among those exiled cards" (Dream Pillager) —
   * which player may cast this exiled card, and only until the cleanup step clears the grant.
   */
  playableUntilEotBy?: PlayerId;
}

export interface EngineStackObject extends StackObject {
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
  /** Kind of alternative cast used, if any (overload, adventure, omen). */
  alternativeCastKind?: 'overload' | 'adventure' | 'omen' | 'energy' | 'commanderFree' | 'alternativeCost';
  altIndex?: number;
  /** Triggered abilities: the object whose event fired this — the `'triggerObject'` referent. */
  triggerObjectCardId?: CardId;
  /** Numbers the firing event contributed (count, damage, spell mana value). */
  triggerScope?: TriggerScope;
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
}

export interface EngineEmblem {
  id: string;
  name: string;
  controllerId: PlayerId;
  abilities: Ability[];
}
export interface EnginePlayerState extends PlayerState {
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
  /** Set when a draw was attempted from an empty library (loss at next SBA check). */
  attemptedDrawFromEmptyLibrary: boolean;
  mulligansTaken: number;
  /** The player's decklist (oracle ids) — contents only; feeds the PlayerView. */
  decklistOracleIds: OracleId[];
  /** True once the companion has been moved to hand (once per game). */
  companionMovedToHand: boolean;
  /** True when player chose "Pass and yield until end of turn". */
  yieldUntilEndOfTurn?: boolean;
  /** Oracle IDs of triggered abilities the player has chosen to "Yield to this ability". */
  yieldedAbilities?: OracleId[];
}

/** An until-end-of-turn continuous effect (the Phase 2 subset of CR 613). */
export interface UntilEotEffect extends ContinuousEffect {
  /**
   * The permanents this effect applies to, fixed when the spell or ability that created it
   * resolved (CR 611.2c) and never recomputed. A single-target pump is the one-element case;
   * "creatures you control get +3/+3" snapshots the set that existed at resolution, so a
   * creature entering afterwards is not pumped and one that leaves and returns is not either.
   */
  targetCardIds: CardId[];
  kind: 'ptDelta' | 'grantKeyword' | 'grantAbility' | 'cantBeBlocked' | 'becomeCreature';
  power?: number;
  toughness?: number;
  keyword?: KeywordAbility;
  ability?: Ability;
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
    /** See `Effect.becomeCreatureUntilEot.replaceTypes` — full type-line replacement, not add. */
    replaceTypes?: string[];
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
  when: TriggerWhen;
  ability: Ability;
  expiry: 'endStep' | 'cleanup';
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
  /** Whether each player has created a token THIS TURN (Idol of Oblivion). Reset at untap step. */
  createdTokenThisTurn: Record<PlayerId, boolean>;
  /** Number of creatures put into graveyards this turn. */
  creaturesDiedThisTurn: number;
  /** Combat-damage replacement shields used by Darkness-style effects this turn. */
  combatDamagePrevention: {
    all: boolean;
    players: Record<PlayerId, boolean>;
    tokenSpecs?: Record<PlayerId, import('../cards/ability').TokenSpec>;
  };
  /** Players protected from dropping below 1 life until the end of the turn (Angel's Grace). */
  lifeFloorPlayers: Record<PlayerId, boolean>;
  /**
   * Cards exiled "until SOURCE leaves the battlefield" (Conclave Tribunal), keyed by the
   * source's card id, so `moveObject` can find and return them all when the source itself
   * leaves (CR 610.2b — they return under the control they had when exiled). The exiled
   * object itself lives in `exile`; this only records which one to look for and who gets it.
   */
  exiledUntilLeaves: Record<CardId, { cardId: CardId; controllerId: PlayerId }[]>;
  /**
   * Which players were dealt COMBAT damage by each source THIS TURN, keyed by source card id
   * (Steel Hellkite's "whose controller was dealt combat damage by this creature this turn") —
   * by SOURCE, unlike `damageDealtToPlayersThisTurn`, and combat damage only. Reset at untap.
   */
  combatDamagePlayersBySource: Record<CardId, PlayerId[]>;
  /** Safety cap: exceeding this halts the game as a probable bug (brief §4). */
  turnCap: number;
  /** Number of additional combat phases to run after the current combat. */
  extraCombatPhases: number;
  /** The player who is currently the monarch, or null before the mechanic appears. */
  monarchPlayerId: PlayerId | null;
  /** Until-end-of-turn activated abilities temporarily granted to cards in graveyards. */
  temporaryGraveyardAbilities: Record<CardId, ActivatedAbility[]>;
}

/** Everything the engine's flow code operates on. `defs` is immutable per game. */
export interface GameContext {
  state: EngineState;
  defs: Map<OracleId, CardDefinition>;
  rng: Prng;
  debugLog: DebugEntry[];
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
}

export type { GameEvent };

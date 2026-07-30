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
import type { Ability, CardDefinition, KeywordAbility } from '../cards/definition';
import type { TriggerScope } from '../cards/value';
import type { Prng } from '../rng/prng';

/** Stable physical-card identity, assigned once at game creation. */
export type CardId = string;

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
  /** True if this permanent has been goaded during the current turn. */
  goadedThisTurn?: boolean;
  /**
   * True if this permanent attacked THIS TURN — Boast (CR 702.146): "Activate only if this
   * permanent attacked this turn and only once each turn." Unlike `attacking` (cleared at
   * `endCombatCleanup`), this survives into the postcombat main phase, which is when a Boast
   * ability is actually activated in practice.
   */
  attackedThisTurn?: boolean;
  /**
   * Indices into this permanent's `activatedAbilities` used this turn, for "activate only once
   * each turn" (CR 602.5f).
   *
   * Per PERMANENT, not per card definition: two copies of the same card each get their own
   * activation, and a permanent that leaves and returns is a new object with a clean slate.
   */
  activationsThisTurn: number[];
  /**
   * 903.9a: set when a commander arrives in graveyard/exile, cleared at the next SBA
   * check after its owner has been offered the command-zone move.
   */
  commanderSbaPending?: boolean;
}

/** Non-battlefield engine object living in graveyard/exile with 903.9a bookkeeping. */
export interface EngineCardObject extends EngineObject {
  /** 903.9a flag — see `EnginePermanent.commanderSbaPending`. */
  commanderSbaPending?: boolean;
  /** For cards exiled by Hideaway (Spinerock Knoll, Mosswort Bridge). */
  attachedToCardId?: string;
  /** For Adventure cards in exile (CR 715.3d). */
  onAdventure?: boolean;
  /**
   * "Until end of turn, you may cast spells from among those exiled cards" (Dream Pillager) —
   * the player who may cast this exiled card, until the next cleanup step clears it. Distinct
   * from `onAdventure`: that grants casting for as long as the card stays in exile; this
   * expires at end of turn while the card remains in exile permanently either way.
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
  alternativeCastKind?: 'overload' | 'adventure' | 'omen';
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

export interface EnginePlayerState extends PlayerState {
  hand: EngineCardObject[];
  library: EngineCardObject[];
  graveyard: EngineCardObject[];
  commandZone: EngineCardObject[];
  companion: EngineCardObject | null;
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
  /**
   * Emblems this player owns (CR 122.1a) — a permanent, card-less object that grants its
   * triggered abilities forever. Scanned by `queueStepTriggers` alongside battlefield
   * permanents; there is no card to attach one to, so it lives directly on the player.
   */
  emblems?: Ability[];
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
  kind: 'ptDelta' | 'grantKeyword' | 'grantAbility' | 'becomeCreature';
  power?: number;
  toughness?: number;
  keyword?: KeywordAbility;
  ability?: Ability;
  /**
   * "Becomes a 4/4 red and green Dragon artifact creature with flying until end of turn"
   * (Atarka Monument, Sarkhan's +1) — a type-changing CDA-shaped grant, distinct from
   * `ptDelta` (which is always sublayer 7d MODIFY, never a 7b SET) and from a single
   * `grantKeyword` (this can add several at once). Color is deliberately absent: layer 5
   * (color-changing) is not implemented anywhere in this engine (ADR 0007), so "red and green"
   * is a disclosed simplification, not something this op newly cuts.
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
  /**
   * Players dealt COMBAT damage by a given source permanent THIS TURN, keyed by the source's
   * `cardId` (Steel Hellkite: "destroy each nonland permanent … whose controller was dealt
   * combat damage by this creature this turn"). Reset at the next untap step, same as
   * `damageDealtToPlayersThisTurn` — CR 514.2 doesn't clear it either.
   */
  combatDamagePlayersBySource: Record<CardId, PlayerId[]>;
  /** Safety cap: exceeding this halts the game as a probable bug (brief §4). */
  turnCap: number;
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

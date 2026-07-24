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
import type { Ability, CardDefinition, KeywordAbility } from '../cards/definition';
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
}

export interface EnginePlayerState extends PlayerState {
  hand: EngineCardObject[];
  library: EngineCardObject[];
  graveyard: EngineCardObject[];
  commandZone: EngineCardObject[];
  companion: EngineCardObject | null;
  /** Stable card ids of this player's commander(s). */
  commanderCardIds: CardId[];
  /** Set when a draw was attempted from an empty library (loss at next SBA check). */
  attemptedDrawFromEmptyLibrary: boolean;
  mulligansTaken: number;
  /** The player's decklist (oracle ids) — contents only; feeds the PlayerView. */
  decklistOracleIds: OracleId[];
  /** True once the companion has been moved to hand (once per game). */
  companionMovedToHand: boolean;
}

/** An until-end-of-turn continuous effect (the Phase 2 subset of CR 613). */
export interface UntilEotEffect extends ContinuousEffect {
  targetCardId: CardId;
  kind: 'ptDelta' | 'grantKeyword';
  power?: number;
  toughness?: number;
  keyword?: KeywordAbility;
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
  combat: CombatState | null;
  /** Fixed seating (never mutated) — `turnOrder` shrinks as players are eliminated. */
  seating: PlayerId[];
  /** The player whose turn it is, tracked by id (survives turnOrder mutation). */
  currentTurnPlayer: PlayerId;
  /** Triggers waiting to be put on the stack at the next priority checkpoint (CR 603.3b). */
  pendingTriggers: PendingTrigger[];
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

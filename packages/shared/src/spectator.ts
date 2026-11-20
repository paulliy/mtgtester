/**
 * The spectator projection (brief §10.2). This is the *inverse* of `PlayerView`: the human is
 * watching, not playing, so hands are visible — clearly marked spectator-only in the UI — and
 * nothing is hidden for anti-cheat reasons.
 *
 * It is nonetheless a projection, not `GameState`, for two reasons:
 *
 *   1. Library ORDER is secret to every player including its owner (brief §7.1), and shipping
 *      four 70-card orderings to a browser would leak it to a screen a player could read.
 *      Libraries reduce to a count.
 *   2. Effective power/toughness is layer-computed inside the engine; the raw `PermanentState`
 *      carries only printed values. The UI must never re-derive rules — the engine is
 *      authoritative (brief §1.2) — so the projection carries the computed numbers.
 *
 * It is also what `game_state_snapshots.state_json` holds (ADR 0012): a snapshot exists to
 * redraw a past board, never to resume a game from it.
 */

import type { LossReason, Phase, Step } from './enums';
import type { GameId, ObjectId, PlayerId } from './ids';
import type { Color, ManaCostString, ManaPool } from './mana';
import type { PermanentStatus } from './objects';

/** A card in a visible non-battlefield zone. */
export interface SpectatorCard {
  id: ObjectId;
  name: string;
  typeLine: string;
  manaCost: ManaCostString | null;
  oracleText: string;
  /** A representative Scryfall printing id for image lookup; null for cards with none (tokens). */
  scryfallId: string | null;
  /**
   * Owning seat. Exile is one shared zone, so without this the UI cannot say whose cards are in
   * it and every seat panel reports the table's total.
   */
  owner: PlayerId;
  /**
   * Card types, from the engine rather than the printed type line (ADR 0032 decision 2): computed
   * characteristics on the battlefield, printed ones elsewhere. Optional only because snapshots
   * saved before them lack the fields; a client shows missing types as unavailable rather than
   * reading the type line.
   */
  types?: string[];
  supertypes?: string[];
  subtypes?: string[];
  /**
   * True for a token. Token type lines don't say "Token" ("Artifact Creature — Construct"), so the
   * UI can't tell from the text. Optional only because snapshots saved before it lack the field.
   */
  isToken?: boolean;
  /**
   * True for a provisional card (H1): it plays by a machine-checked patch nobody has reviewed
   * yet, and the UI marks it. Absent for every other card.
   */
  provisional?: true;
}

/**
 * Which row of a seat's board a permanent sits in, decided by the server (ADR 0032 decision 2).
 * A land creature groups with creatures, because it can attack and block.
 */
export type BoardGroup = 'lands' | 'creatures' | 'other';

/** A permanent, with engine-computed effective characteristics. */
export interface SpectatorPermanent extends SpectatorCard {
  /** Visible face for double-faced permanents; omitted for ordinary cards (front face). */
  imageFace?: 'front' | 'back';
  controller: PlayerId;
  tapped: boolean;
  /** Effective P/T after continuous effects; null for non-creatures. */
  power: number | null;
  toughness: number | null;
  damageMarked: number;
  counters: Record<string, number>;
  statuses: PermanentStatus[];
  summoningSick: boolean;
  attachedTo: ObjectId | null;
  /** Set while in combat: the player this creature is attacking (the planeswalker's controller when it attacks a planeswalker). */
  attacking: PlayerId | null;
  /** Set while in combat: the planeswalker this creature is attacking, when it attacks one. */
  attackingPlaneswalker?: ObjectId | null;
  /** Set while in combat: the attacker this creature is blocking. */
  blocking: ObjectId | null;
  /** For attackers: blockers in damage-assignment order (CR 509.2). */
  blockedBy: ObjectId[];
  /** Keyword abilities the engine currently grants this permanent. */
  keywords: string[];
  /** Board row, from computed types. Optional only because older snapshots lack it. */
  boardGroup?: BoardGroup;
  /**
   * Current colors, after effects. The UI matches a token to a printed token's art by them.
   * Optional only because snapshots saved before it lack the field.
   */
  colors?: Color[];
}

/** One commander, wherever it currently is, with its accumulated tax (brief §5.7). */
export interface SpectatorCommander {
  /** Stable physical-card id — commander damage and tax are keyed by it. */
  cardId: string;
  /** Current public object identity, when the commander is in a visible zone. */
  objectId: ObjectId | null;
  name: string;
  zone: string;
  castCount: number;
  /** The additional generic cost the next cast from the command zone would carry: {2} each. */
  taxGeneric: number;
  /** Representative printing for the player UI; null only when no printing is available. */
  scryfallId: string | null;
  /** The commander's color identity, which bounds its deck's colors. Absent in older snapshots. */
  colorIdentity?: Color[];
  /** A provisional commander (H1): machine-checked rules nobody has reviewed. */
  provisional?: true;
}

export interface SpectatorSeat {
  seat: PlayerId;
  deckId: string;
  /** Display label — the commander name(s), or the archetype tag when one was given. */
  label: string;
  life: number;
  /** Spectator-only: the actual contents of this player's hand (brief §10.2). */
  hand: SpectatorCard[];
  librarySize: number;
  graveyard: SpectatorCard[];
  commanders: SpectatorCommander[];
  manaPool: ManaPool;
  energy: number;
  poisonCounters: number;
  counters?: Record<string, number>;
  landsPlayedThisTurn: number;
  mulligansTaken: number;
  hasLost: boolean;
  lossReason: LossReason | null;
  /** "Pass and yield until end of turn" is active (brief — Workstream 2's stop-list yield). */
  yieldingUntilEndOfTurn: boolean;
}

export interface SpectatorStackObject {
  id: ObjectId;
  controller: PlayerId;
  kind: string;
  description: string;
  targets: ObjectId[];
  /** The source's Scryfall printing id, for a thumbnail; null for sources with none (tokens). */
  scryfallId: string | null;
}

/**
 * One cell of the 4×4 commander damage grid (brief §10.2). Only nonzero pairs are carried;
 * the UI fills the rest of the matrix with zeroes.
 */
export interface CommanderDamageEntry {
  victimSeat: PlayerId;
  sourceSeat: PlayerId;
  /** Stable card id of the dealing commander — a seat may have two (Partner). */
  sourceCardId: string;
  sourceName: string;
  damage: number;
  /**
   * Whether this damage alone eliminates the victim (21 from one commander, CR 903.10a), and how
   * many more points it would take (0 once lethal). Computed with the engine's own rule so no
   * client holds the number. Optional only because snapshots saved before them lack the fields.
   */
  lethal?: boolean;
  remaining?: number;
}

/** Everything the spectator UI needs to draw one moment of the game. */
export interface SpectatorState {
  gameId: GameId;
  seed: string;
  turnNumber: number;
  activePlayer: PlayerId;
  /** The current monarch, or null when no monarch has been established. */
  monarchSeat: PlayerId | null;
  /** Null when no one holds priority (untap, and cleanup with nothing to do). */
  priorityPlayer: PlayerId | null;
  phase: Phase;
  step: Step | null;
  seats: SpectatorSeat[];
  battlefield: SpectatorPermanent[];
  exile: SpectatorCard[];
  stack: SpectatorStackObject[];
  /** Seating order, survivors only (brief §5.2). */
  turnOrder: PlayerId[];
  /** Fixed seating, including eliminated players — the UI keeps their panel in place. */
  seating: PlayerId[];
  eliminatedPlayers: PlayerId[];
  commanderDamage: CommanderDamageEntry[];
}

/**
 * One line of the spectator action log (brief §10.2). Minimal by design: **never** carries AI
 * reasoning. Reasoning travels beside the log as `AiAnnotation`, never inside this shape — see
 * that type for why (ADR 0022, superseding brief §15's debug-log-only rule).
 */
export interface SpectatorLogLine {
  /** Matches `GameEvent.sequence`, so the timeline can seek to an exact point. */
  sequence: number;
  turn: number;
  /** The acting seat, or null for game-driven events (SBAs, resolutions). */
  actorSeat: PlayerId | null;
  text: string;
  /** Marks fallbacks and halts for the "prominent, unmissable" markers of brief §13. */
  emphasis?: 'warning' | 'elimination' | 'turn';
}

/**
 * One AI reasoning note, attached to the log line it explains (ADR 0022). Deliberately a separate
 * stream rather than a field on `SpectatorLogLine`, for two reasons:
 *
 *   1. The engine formats log lines from `GameEvent`s and knows nothing about the AI. Baking model
 *      text into a line would make `formatSpectatorLog` AI-aware.
 *   2. `game_events` must stay a complete replay on its own. Annotations are commentary about a
 *      replay, not part of one — a game replayed without them is not missing anything.
 *
 * Opt-in: the server sends these only while `DebugFlags.showAIResponses` is on, and in
 * single-player never sends another seat's until the game is over (ADR 0022 §3).
 */
export interface AiAnnotation {
  /** The first `GameEvent.sequence` this decision produced — the line it attaches under. */
  sequence: number;
  turn: number;
  seat: PlayerId;
  /** A per-decision note, or the once-per-turn strategist's standing intent. */
  kind: 'decision' | 'strategy';
  text: string;
  /** The `DecisionSource` that produced it: `primary` | `fallback` | `strategist` | … */
  source: string;
  model?: string;
}

/** One turn a seat calls out in its own post-game review. */
export interface ReflectionMoment {
  /** The turn it happened on, so the UI can offer a jump into the timeline. */
  turn: number;
  what: string;
  /** What the seat says it should have done instead. Only meaningful on a mistake. */
  better?: string;
}

/**
 * One AI seat's review of the game it just played (ADR 0022 §7, reversing brief §15's cut).
 *
 * Produced strictly after `Engine.getResult()`, from that seat's **own** `PlayerView` and its own
 * decision history — never from omniscient end-state data. A reflection built on everything the
 * table knew produces "I should have known about the counterspell", which is not a lesson.
 */
export interface AiReflection {
  seat: PlayerId;
  /** Finishing position, 1-based. 0 when the game did not finish (a halt). */
  position: number;
  summary: string;
  keyMistakes: ReflectionMoment[];
  keyPlays: ReflectionMoment[];
  /** How the seat read the table's threats in hindsight. */
  threatRead: string;
  model: string;
}

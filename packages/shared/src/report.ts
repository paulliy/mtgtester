/**
 * "Copy game report" — what a player pastes into a bug report (`POST /api/game-report`). Built by
 * the server from its own records, because the browser has neither the build identifier nor the
 * exact ordered decklists, and both are needed to recreate a game: a seed reproduces nothing
 * without the same decks in the same order, the same card data, and the player's choices.
 *
 * Hidden-information rule (CLAUDE.md): while the game can still change, an opponent's seat carries
 * only what the player already saw at setup — commanders, deck snapshot id, generator seed — never
 * its decklist, an imported URL or pasted text. Decklists for every seat appear once the game is
 * over. The log is the player's own log, and the pending choice is the player's own decision.
 */

import type { Phase, Step } from './enums';
import type {
  HaltKind,
  PlaybackMode,
  ProviderKind,
  StartGameMode,
  SeatControllerKind,
} from './protocol';
import type { GameId, PlayerId } from './ids';

/** The checkout the server runs from. Each field is null when it could not be read. */
export interface GameReportBuild {
  commit: string | null;
  branch: string | null;
  /** True when tracked files differ from the commit. */
  dirty: boolean | null;
}

/** How a seat's deck was chosen, with any opponent-identifying source detail withheld mid-game. */
export type GameReportDeckSource =
  | { kind: 'pool'; seed: string }
  | { kind: 'snapshot'; snapshotId: string }
  | { kind: 'url'; url: string | null }
  | { kind: 'plaintext' }
  | { kind: 'cardTestScenario' };

/**
 * The Oracle card data the server loaded. The commit does not pin it: the Scryfall bulk file is
 * gitignored and changes upstream, and Oracle text drives every card definition.
 */
export interface GameReportCardData {
  /** The file loaded, relative to the server's working directory; null when none was. */
  source: string | null;
  /** SHA-256 of that file's bytes. */
  sha256: string | null;
  /** Entries in the file. */
  entries: number;
}

/** A deck as the engine received it, each section in configured order. */
export interface GameReportDecklist {
  commanders: string[];
  companion: string | null;
  /**
   * The library in configured order (which the seeded shuffle starts from); consecutive copies
   * collapse into one "N Name" line.
   */
  library: string[];
}

export interface GameReportSeat {
  seat: PlayerId;
  controller: SeatControllerKind;
  label: string;
  commanderNames: string[];
  colorIdentity: string[];
  archetypeTag: string;
  deckSnapshotId: string | null;
  source: GameReportDeckSource;
  /** The deck exactly as the engine was given it. Null for an opponent while the game is live. */
  decklist: GameReportDecklist | null;
  /** Public state. */
  life: number;
  poisonCounters: number;
  handSize: number;
  librarySize: number;
  hasLost: boolean;
  lossReason: string | null;
}

export interface GameReport {
  schemaVersion: 2;
  generatedAt: string;
  build: GameReportBuild;
  cardData: GameReportCardData;
  game: {
    id: GameId;
    seed: string;
    gameMode: StartGameMode;
    humanSeat: PlayerId | null;
    providerKind: ProviderKind;
    playbackMode: PlaybackMode;
    paceMs: number;
    startedAt: string | null;
    /** Set only for a Card Test Lab run. */
    cardTestScenarioId: string | null;
  };
  status: {
    /** The match runner's state: running, awaitingHuman, finished, halted, abandoned, … */
    runner: string;
    over: boolean;
    winnerSeat: PlayerId | null;
    /** Kind and turn of a halt. The detailed reason stays in the server's debug log. */
    halt: { kind: HaltKind; turn: number } | null;
  };
  position: {
    turn: number;
    phase: Phase;
    step: Step | null;
    activePlayer: PlayerId;
    priorityPlayer: PlayerId | null;
  };
  seats: GameReportSeat[];
  /** The decision the player currently owes, if any. */
  pendingChoice: {
    requestId: string;
    decisionType: string;
    prompt: string;
    options: string[];
  } | null;
  /** The player's most recent submitted decision. */
  lastSubmittedAction: {
    requestId: string;
    turn: number;
    decisionType: string;
    description: string;
    targets: string[];
  } | null;
  /** The newest lines of the player's own action log, oldest first. */
  recentLog: string[];
}

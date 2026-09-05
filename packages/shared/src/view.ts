import type { ObjectId, PlayerId } from './ids';

/**
 * A card as the AI sees it. Oracle text is populated ONLY when the card is currently
 * relevant — in the deciding player's hand, on the battlefield, on the stack, or a
 * commander (brief §7.4). Cards in libraries/irrelevant graveyards carry name only.
 */
export interface CardView {
  id: ObjectId;
  name: string;
  manaCost?: string;
  typeLine?: string;
  oracleText?: string;
  power?: number | null;
  toughness?: number | null;
}

export interface CommanderView {
  name: string;
  /** Where the commander currently is: "battlefield" | "command" | "graveyard" | … */
  zone: string;
  /** Times cast from the command zone → drives tax (brief §5.7). */
  castCount: number;
}

/** A permanent as seen on any battlefield — all public state (brief §7.1, §7.3). */
export interface PermanentView {
  id: ObjectId;
  controller: PlayerId;
  name: string;
  /**
   * Printed type line and rules text. Populated for every permanent: a battlefield is
   * public information, and §7.4 names permanents on the battlefield as one of the zones
   * whose oracle text is relevant to the decision. Without it the AI can see that an
   * opponent controls "Blood Moon" but not what it does.
   *
   * These are the PRINTED characteristics, not the layer-computed ones — power/toughness
   * below already carry the computed values, and re-deriving a full text box after
   * continuous effects is not something the engine models.
   */
  typeLine?: string;
  oracleText?: string;
  power?: number | null;
  toughness?: number | null;
  /**
   * The permanent's CURRENT keywords after CR 613 layers (ADR 0023 item 20) — the granted ones
   * as well as the printed ones, which is why this cannot be re-derived from `oracleText`.
   *
   * Combat evaluation needs it: deathtouch, first strike, trample, lifelink, indestructible and
   * menace all change what a block or a damage split is worth, and `status` carries game statuses
   * (`tapped`, `summoningSick`, `faceDown`), not keywords. Evasion is not needed for legality —
   * the engine's own `canBlock` already filters the offered menu (brief §1.2).
   *
   * Absent, not empty, for a face-down permanent: keywords are part of the hidden identity
   * (§7.1), alongside `typeLine`/`oracleText` above.
   */
  keywords?: string[];
  tapped: boolean;
  status: string[];
  blockedBy?: ObjectId[];
}

export interface StackObjectView {
  id: ObjectId;
  controller: PlayerId;
  description: string;
  targets: ObjectId[];
}

/** Public info about an opponent. Never their hand contents, decklist, or library order. */
export interface OpponentView {
  seat: PlayerId;
  life: number;
  handSize: number;
  librarySize: number;
  graveyard: CardView[];
  commanders: CommanderView[];
  poisonCounters: number;
  /** Commander damage this opponent's commander(s) have dealt to the viewing player. */
  commanderDamageDealtToYou: number;
}

/**
 * The projection of `GameState` visible to ONE player (brief §7.1) — the anti-cheat
 * boundary. The context assembler builds this; the AI is handed a `PlayerView`, never
 * `GameState`. A test asserts a `PlayerView` never contains another player's hand, any
 * library order (including the viewer's own), or another player's decklist (brief §7.1, §12).
 */
export interface PlayerView {
  seat: PlayerId;
  life: number;
  /** The viewing player's OWN hand. */
  hand: CardView[];
  /** The viewing player's OWN decklist — contents only, never order (brief §7.1). */
  deck: CardView[];
  graveyard: CardView[];
  commanders: CommanderView[];
  /** Mana currently available to the viewer, e.g. `{ W: 1, G: 2, C: 0 }`. */
  availableMana: Record<string, number>;
  /** Public energy counters held by the viewing player. */
  energy?: number;
  /**
   * Per-permanent mana-production breakdown — what EACH source could make, not summed into
   * `availableMana`'s flat per-symbol counts. Lets the AI reason "this land taps for any of
   * WUBRG" instead of only seeing an aggregate. Purely descriptive.
   */
  manaSources: { name: string; symbols: string[]; count: number }[];
  opponents: OpponentView[];
  /** Library top cards made public by effects such as Oracle of Mul Daya. */
  revealedLibraryTops?: { player: PlayerId; card: CardView }[];
  /** All battlefields, public state (brief §7.1). */
  battlefield: PermanentView[];
  /**
   * All players' exile zones — public, like a graveyard, EXCEPT cards exiled face down
   * (hideaway and similar): those report as `"Face-down card"` for every viewer but their
   * owner, mirroring the same redaction the human browser view applies.
   */
  exile: CardView[];
  stack: StackObjectView[];
  /** Trimmed recent public action log — last ~15 entries (brief §7.4). */
  recentLog: string[];
}

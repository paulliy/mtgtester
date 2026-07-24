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
  power?: number | null;
  toughness?: number | null;
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
  opponents: OpponentView[];
  /** All battlefields, public state (brief §7.1). */
  battlefield: PermanentView[];
  stack: StackObjectView[];
  /** Trimmed recent public action log — last ~15 entries (brief §7.4). */
  recentLog: string[];
}

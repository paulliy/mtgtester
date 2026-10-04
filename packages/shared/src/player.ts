import type { Color } from './mana';
import type { PlayerId } from './ids';
import type { SpectatorCard, SpectatorPermanent, SpectatorSeat, SpectatorState } from './spectator';

/** A seat rendered to an active player. Only the player's own hand has card identities. */
export interface PlayerBoardSeat extends Omit<SpectatorSeat, 'hand'> {
  handSize: number;
  hand: SpectatorCard[] | null;
}

/**
 * Browser-facing active-player state. Unlike the token-trimmed AI `PlayerView`, this contains
 * the full public board needed by the UI while excluding every opponent's hidden cards.
 */
export interface PlayerBoardState extends Omit<SpectatorState, 'seats' | 'battlefield'> {
  viewerSeat: PlayerId;
  seats: PlayerBoardSeat[];
  battlefield: SpectatorPermanent[];
  /**
   * The viewer's ready mana, for the player's resource strip: floating mana plus one unit per
   * mana a currently activatable source makes without itself costing mana, and the colors those
   * units can be. Sources that need mana to activate (Cabal Coffers, filter lands) are left out,
   * so this never claims more than is free to make. Descriptive only — payment legality stays
   * with the engine's payment planner.
   */
  viewerMana: { units: number; colors: Color[] };
}

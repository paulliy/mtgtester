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
}

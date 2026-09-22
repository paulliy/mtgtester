import type { PlayerId, ObjectId } from './ids';
import type { Phase, Step } from './enums';

/** Public semantic facts, never card definitions, hidden zones, or engine state. */
export interface PublicThreatFacts {
  sequence: number;
  turn: number;
  phase: Phase;
  step: Step | null;
  activePlayer: PlayerId;
  turnOrder: PlayerId[];
  /** Whitelisted player damage only; no raw event payloads. */
  pressure: PublicPressureEvent[];
  pressureTruncated: boolean;
  players: { seat: PlayerId; poison: number; commanderDamage: Record<string, number> }[];
  rules: { poisonLoss: number; commanderDamageLoss: number };
  /** Full combo/alternative-win search is deliberately not represented as a successful check. */
  unsupported: string[];
}

export interface PublicPressureEvent {
  sequence: number;
  turn: number;
  actor: PlayerId;
  recipient: PlayerId;
  amount: number;
  kind: 'combat' | 'noncombat';
}

export interface PublicPermanentCapabilities {
  creature: boolean;
  attacking: PlayerId | null;
  cantBlock: boolean;
  cantBeBlocked: boolean;
  commanderId: string | null;
  /** Alternatives share ONE source. Counts must never be summed across alternatives. */
  mana: { units: string[][]; available: boolean; restricted: boolean }[];
  engines: { kind: 'draw' | 'tokens'; amount: number; horizon: 'controller-turn' }[];
  unsupported: string[];
}

export interface PublicStackImpact {
  source: ObjectId;
  recipient: PlayerId;
  amount: number;
  kind: 'damage' | 'life-loss';
}

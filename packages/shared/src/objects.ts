import type { ObjectId, OracleId, PlayerId } from './ids';
import type { ManaCostString } from './mana';
import type { Zone } from './enums';

/**
 * A game object: an identity-stable entity (brief §5.2, CR 400.7). Changing zones creates
 * a NEW object with a new `id`; `oracleId` links back to immutable card data. `ownerId`
 * never changes; a permanent's controller can (see `PermanentState`).
 */
export interface GameObject {
  id: ObjectId;
  oracleId: OracleId;
  ownerId: PlayerId;
  name: string;
  typeLine: string;
  oracleText: string;
  manaCost: ManaCostString | null;
  zone: Zone;
}

/** Boolean-ish battlefield statuses tracked as flags (brief §7.3 sample uses a status list). */
export const PERMANENT_STATUSES = [
  'attacking',
  'blocking',
  'phasedOut',
  'flipped',
  'faceDown',
  'monstrous',
] as const;
export type PermanentStatus = (typeof PERMANENT_STATUSES)[number];

/**
 * A permanent on the battlefield. Effective power/toughness and granted abilities are
 * computed via the continuous-effect layer system in Phase 2; the fields here are the
 * printed/base values plus mutable game state.
 */
export interface PermanentState extends GameObject {
  zone: 'battlefield';
  /** May differ from `ownerId` (brief §5.2). */
  controllerId: PlayerId;
  tapped: boolean;
  /** Base printed P/T; `null` for non-creatures. Effective P/T is layer-computed (Phase 2). */
  power: number | null;
  toughness: number | null;
  /** Damage marked this turn (cleared in cleanup). */
  damageMarked: number;
  /** Counters by kind, e.g. `{ "+1/+1": 2, loyalty: 3 }`. */
  counters: Record<string, number>;
  statuses: PermanentStatus[];
  /**
   * True while the controller has not controlled this continuously since the start of
   * their most recent turn (CR 302.6). Blocks attacking and {T} abilities without haste.
   */
  summoningSick: boolean;
  /** For Auras/Equipment/Fortifications: the permanent this is attached to, if any. */
  attachedTo: ObjectId | null;
}

/** The kind of thing sitting on the stack. Mana abilities never use the stack (CR 605). */
export type StackObjectKind = 'spell' | 'activatedAbility' | 'triggeredAbility';

/** An object on the stack (brief §5.5). Resolves LIFO once all players pass priority. */
export interface StackObject {
  id: ObjectId;
  /** The object that is/produced this: the spell's card, or the ability's source. */
  sourceId: ObjectId;
  controllerId: PlayerId;
  kind: StackObjectKind;
  description: string;
  /** Chosen targets (object ids). Legality is rechecked on resolution (brief §5.5). */
  targets: ObjectId[];
}

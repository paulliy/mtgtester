import type { Color, ObjectId, PlayerId } from '@mtg/shared';

/** Domain/characteristic checks share this context; assignment checks remain separate. */
export interface TargetContext {
  controllerId: PlayerId;
  sourceCardId?: string;
  sourceColors?: readonly Color[];
  eventPlayerId?: PlayerId;
  chosenTargets?: readonly ObjectId[];
  /** Preview can describe an unresolved dependent slot; announcement/resolution cannot. */
  phase?: 'preview' | 'announcement' | 'resolution';
  /** Choices are not targets and ignore shroud, hexproof, and protection. */
  targeting?: boolean;
}

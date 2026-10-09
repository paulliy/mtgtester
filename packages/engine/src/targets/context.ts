import type { Color, ObjectId, PlayerId } from '@mtg/shared';
import type { ObjectFacts } from '../cards/source-identity';

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
  /**
   * The source's last-known facts once it has left the battlefield (a dies trigger's own
   * source), for a filter relative to it ("with equal or lesser power", CR 608.2h).
   */
  sourceFacts?: ObjectFacts;
}

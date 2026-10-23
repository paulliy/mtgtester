import type { ObjectId, PlayerId } from '@mtg/shared';
import type { ObjectFacts } from '../cards/source-identity';
import type { ProtectionSource } from '../state/queries';

/** Who is targeting, for protection and "abilities your opponents control" (CR 115.1, 702.16b). */
export interface TargetingSource {
  traits: ProtectionSource;
  kind: 'spell' | 'ability';
}

/** Spread a targeting source into a `TargetContext`. */
export function targetingSourceFields(
  source: TargetingSource | undefined,
): Pick<TargetContext, 'sourceTraits' | 'sourceKind'> {
  return source === undefined ? {} : { sourceTraits: source.traits, sourceKind: source.kind };
}

/** Domain/characteristic checks share this context; assignment checks remain separate. */
export interface TargetContext {
  controllerId: PlayerId;
  sourceCardId?: string;
  /** The source's colors and card types, for protection (CR 702.16b). Omitted: none applies. */
  sourceTraits?: ProtectionSource;
  /**
   * Whether a spell or an ability is targeting (CR 115.1). Omitted for a choice or a preview with
   * no stack object yet; "can't be the target of abilities" then cannot be decided and refuses.
   */
  sourceKind?: 'spell' | 'ability';
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

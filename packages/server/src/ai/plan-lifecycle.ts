import { createHash } from 'node:crypto';
import type { Phase, PlannedAction, PlayerId, Step } from '@mtg/shared';

export type PlanLifecycleStatus =
  | 'generated'
  | 'installed'
  | 'impossible_at_source'
  | 'waiting_for_prerequisite'
  | 'already_accomplished'
  | 'expired_before_installation'
  | 'matched'
  | 'submitted'
  | 'accepted'
  | 'invalidated_by_opponent'
  | 'invalidated_by_own_deviation'
  | 'unsupported_by_engine'
  | 'ambiguous'
  | 'superseded'
  | 'cancelled';

export interface PlanSourceObservation {
  eventSequence: number;
  hash: string;
  turn: number;
  phase: Phase;
  step: Step | null;
}

export interface PlanArtifactMetadata {
  planId: string;
  generationId: number;
  observerSeat: PlayerId;
  source: PlanSourceObservation;
  promptVersion: string;
  configVersion: string;
  generationStartedAt: string;
  generationCompletedAt: string;
  installationSequence?: number;
}

export interface PlanLifecycleEvent {
  planId: string;
  generationId: number;
  actionId?: string;
  status: PlanLifecycleStatus;
  turn: number;
  phase: Phase;
  step: Step | null;
  eventSequence: number;
  evidence: string;
  evidenceEventSequences: number[];
}

export interface TrackedPlannedAction extends PlannedAction {
  id: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function observationHash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function stablePlanActions(
  planId: string,
  actions: readonly PlannedAction[],
): TrackedPlannedAction[] {
  const used = new Set<string>();
  return actions.map((action, index) => {
    const requested = action.id?.trim();
    const id = requested && !used.has(requested) ? requested : `${planId}:a${index + 1}`;
    used.add(id);
    return { ...action, id };
  });
}

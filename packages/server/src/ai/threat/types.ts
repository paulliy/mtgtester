import type { PlayerId, ObjectId, Phase, Step } from '@mtg/shared';

export const SCORING_VERSION = 'threat-v1.0.0';
export type Status = 'exact' | 'estimated' | 'unsupported' | 'unknown';
export type Dimension = 'W' | 'E' | 'C' | 'M' | 'H' | 'R' | 'D' | 'L';
export interface Feature {
  value: number | null;
  range: [number, number];
  status: Status;
  sources: ObjectId[];
  sequence: number | null;
  reason: string;
}
export interface Pressure {
  actor: PlayerId;
  recipient: PlayerId;
  damage: number;
  upperDamage: number;
  nextCombatUpperDamage: number;
  historical: number;
  sources: ObjectId[];
  status: Status;
  assumptions: string[];
}
export interface UrgentEvent {
  controller: PlayerId;
  affected: PlayerId[];
  sources: ObjectId[];
  /** 1 pending terminal; 2 feasible future; 3 credible; 4 no supported event. */
  urgency: 1 | 2 | 3;
  outcome: 'elimination';
  deadline: 'before-stack-resolution' | 'before-combat-damage' | 'before-next-combat';
  deadlineOrder: number;
  search: 'proven' | 'possible' | 'not-found-within-bound' | 'unknown';
  forced: boolean;
  assumptions: string[];
}
export interface OpponentAssessment {
  seat: PlayerId;
  rank: number;
  tieGroup: number;
  strategicScore: number;
  scoreRange: [number, number];
  components: Record<Dimension, Feature>;
  urgency: 1 | 2 | 3 | 4;
  urgentEvents: UrgentEvent[];
  directDanger: number;
  interference: Feature;
  vulnerability: Feature;
  reasons: string[];
  sources: ObjectId[];
  uncertainty: string[];
  changes: string[];
}
export interface ThreatAssessment {
  observer: PlayerId;
  sequence: number | null;
  turn: number;
  phase: Phase;
  step: Step | null;
  version: string;
  opponents: OpponentAssessment[];
  pressure: Pressure[];
  overallTopSet: PlayerId[];
  strategicTopSet: PlayerId[];
  directTopSet: PlayerId[];
  interferenceTopSet: PlayerId[];
  displayedLeader: PlayerId | null;
  coverage: string[];
  search: 'not-found-within-bound' | 'possible' | 'unknown';
}

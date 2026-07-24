/**
 * Internal decision plumbing. Flow code is written as generators that yield
 * `PendingDecision`s and receive `DecisionOutcome`s; the `Engine` pump either surfaces a
 * decision to the caller as a `DecisionRequest` or auto-resolves it when there is exactly
 * one legal option with no real target choice (brief §5.1 — no AI call for forced moves).
 */

import type { DecisionType, ObjectId, PlayerId } from '@mtg/shared';

/** One legal option, engine-internal. `payload` is interpreted by the yielding code. */
export interface EngineActionOption {
  /** Coarse discriminator mirrored into `LegalAction.type` ('pass', 'castSpell', …). */
  type: string;
  description: string;
  /** Target slots this option requires; each choice must come from `options`. */
  targets?: { slot: number; options: ObjectId[] }[];
  payload?: unknown;
}

export interface PendingDecision {
  decisionType: DecisionType;
  player: PlayerId;
  prompt: string;
  options: EngineActionOption[];
}

/** The resolved choice fed back into the generator. */
export interface DecisionOutcome {
  /** Index into `PendingDecision.options`. */
  index: number;
  /** Chosen target per slot. */
  targets: ReadonlyMap<number, ObjectId>;
}

/** Generator type for all engine flow code. */
export type GameGen<T> = Generator<PendingDecision, T, DecisionOutcome>;

/**
 * True when a pending decision has no real choice: a single option whose every target
 * slot has at most one candidate. The pump resolves these itself (brief §5.1).
 */
export function isForced(decision: PendingDecision): boolean {
  if (decision.options.length !== 1) return false;
  const only = decision.options[0] as EngineActionOption;
  return (only.targets ?? []).every((t) => t.options.length <= 1);
}

/** Build the outcome for a forced decision. */
export function forcedOutcome(decision: PendingDecision): DecisionOutcome {
  const only = decision.options[0] as EngineActionOption;
  const targets = new Map<number, ObjectId>();
  for (const slot of only.targets ?? []) {
    if (slot.options.length === 1) targets.set(slot.slot, slot.options[0] as ObjectId);
  }
  return { index: 0, targets };
}

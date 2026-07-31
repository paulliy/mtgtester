/**
 * Internal decision plumbing. Flow code is written as generators that yield
 * `PendingDecision`s and receive `DecisionOutcome`s; the `Engine` pump either surfaces a
 * decision to the caller as a `DecisionRequest` or auto-resolves it when there is exactly
 * one legal option with no real target choice (brief §5.1 — no AI call for forced moves).
 */

import type {
  ActionInteraction,
  ActionPresentation,
  CombatDeclaration,
  DecisionType,
  ObjectId,
  PlayerId,
  PresentedSource,
} from '@mtg/shared';

/** One legal option, engine-internal. `payload` is interpreted by the yielding code. */
export interface EngineActionOption {
  /** Coarse discriminator mirrored into `LegalAction.type` ('pass', 'castSpell', …). */
  type: string;
  description: string;
  /** Target slots this option requires; each choice must come from `options`. */
  targets?: { slot: number; options: ObjectId[] }[];
  payload?: unknown;
  /**
   * Structured facts about this option, mirrored into `LegalAction.data` and sent to the
   * decision provider. Purely descriptive — the engine never reads it back, and legality
   * never depends on it. It exists so a consumer can reason about an option numerically
   * (is this instant-speed? what is this attacker's power?) instead of parsing `description`.
   */
  data?: Record<string, unknown>;
  /** Structured player-UI affordance. Never consulted for legality. */
  interaction?: ActionInteraction;
  /**
   * Player-facing verb + subject for this option, hoisted into `DecisionRequest.presentation`
   * (never `LegalAction` — see `PresentedCard`'s doc comment for why). Built with the helpers
   * in `present.ts`. Absence is a UI gap, not a rules gap: the generic panel falls back to
   * `description` when it's missing.
   */
  presentation?: ActionPresentation;
}

export interface PendingDecision {
  decisionType: DecisionType;
  player: PlayerId;
  prompt: string;
  options: EngineActionOption[];
  /** The card/permanent this whole decision concerns, e.g. what triggered it. */
  presentationSource?: PresentedSource;
  /** Batch hint for a declare-attackers/blockers decision (`present.ts` docs the contract). */
  presentationCombat?: CombatDeclaration;
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

function isPassOption(opt: EngineActionOption): boolean {
  return opt.type === 'pass' || opt.type === 'passAndYieldTurn' || opt.type === 'yieldToAbility';
}

/**
 * True when a pending decision has no real choice: a single option whose every target
 * slot has at most one candidate, or a priority window where all options are pass variations.
 * The pump resolves these itself (brief §5.1).
 */
export function isForced(decision: PendingDecision): boolean {
  if (decision.decisionType === 'priority' && decision.options.every(isPassOption)) {
    return true;
  }
  if (decision.options.length !== 1) return false;
  const only = decision.options[0] as EngineActionOption;
  return (only.targets ?? []).every((t) => t.options.length <= 1);
}

/** Build the outcome for a forced decision. */
export function forcedOutcome(decision: PendingDecision): DecisionOutcome {
  if (decision.decisionType === 'priority' && decision.options.every(isPassOption)) {
    return { index: 0, targets: new Map() };
  }
  const only = decision.options[0] as EngineActionOption;
  const targets = new Map<number, ObjectId>();
  for (const slot of only.targets ?? []) {
    if (slot.options.length === 1) targets.set(slot.slot, slot.options[0] as ObjectId);
  }
  return { index: 0, targets };
}

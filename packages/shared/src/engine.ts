import type { GameId, ObjectId, PlayerId } from './ids';
import type { DecisionType, Phase, Step } from './enums';
import type { GameResult } from './state';

/**
 * One step of the engine driver (brief §5.1). The orchestrator loops:
 * `advance()` → if `decision`, obtain a choice → `submit()` → repeat.
 * The engine auto-resolves any decision with exactly one legal option and does NOT yield
 * it (brief §5.1) — the single biggest cost lever in the project.
 */
export type EngineStep =
  | { kind: 'continue' }
  | { kind: 'decision'; request: DecisionRequest }
  | { kind: 'gameOver'; result: GameResult };

/** One target slot an action requires, with the exact set of legal choices for it. */
export interface TargetSlot {
  slot: number;
  options: ObjectId[];
}

/**
 * A single legal option the engine offers at a decision point (brief §7.3). The engine
 * generates the COMPLETE set; the AI must pick one by `id`. `type` is a coarse discriminator
 * (`'pass'`, `'castSpell'`, `'playLand'`, `'activateAbility'`, …); `data` carries
 * action-specific detail. Refined into a proper discriminated union in Phase 2.
 */
export interface LegalAction {
  id: number;
  type: string;
  description: string;
  targets?: TargetSlot[];
  data?: Record<string, unknown>;
}

/**
 * Emitted by the engine when it needs a choice (brief §5.1, §7.3). This is the ENGINE's
 * view — the deciding player and the legal menu. The server enriches it with the player's
 * `PlayerView` before sending to the AI; the engine itself has no knowledge of the AI.
 */
export interface DecisionRequest {
  requestId: string;
  gameId: GameId;
  turn: number;
  activePlayer: PlayerId;
  decidingPlayer: PlayerId;
  phase: Phase;
  step: Step | null;
  decisionType: DecisionType;
  prompt: string;
  legalActions: LegalAction[];
}

/** A chosen target for one slot. */
export interface TargetChoice {
  slot: number;
  choice: ObjectId;
}

/** A planned future action returned by an active player's AI decision during turn planning. */
export interface PlannedAction {
  type: string;
  name?: string;
  description?: string;
  targets?: TargetChoice[];
}

/**
 * A player's decision (brief §7.3). Must reference a `LegalAction.id`. Anything not on the
 * menu is rejected (brief §7.7 handles retry → user prompt → safest fallback). `note` is
 * debug-log only and never shown in the spectator log (brief §7.3, §10.2).
 */
export interface DecisionResponse {
  requestId: string;
  actionId: number;
  targets?: TargetChoice[];
  /** Chosen modes for a modal spell/ability. */
  modes?: number[];
  /** Chosen value of X. */
  xValue?: number;
  /** An ordering the decision asked for (e.g. trigger order, damage assignment). */
  order?: number[];
  /** Optional sequence of planned future actions for turn pre-planning. */
  plannedActions?: PlannedAction[];
  /** One-sentence rationale; stored in the debug log only. */
  note?: string;
}

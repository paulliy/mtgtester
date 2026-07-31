import type { GameId, ObjectId, PlayerId } from './ids';
import type { DecisionType, Phase, Step, Zone } from './enums';
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
 * Stable UI affordance for a legal action. Descriptive only: the engine still validates the
 * selected action and targets, while the player UI never has to parse `description`.
 */
export type ActionInteraction =
  | { kind: 'immediate' }
  | {
      kind: 'source';
      sourceId: ObjectId;
      /** Present for activated abilities so player preferences survive object-id changes. */
      sourceCardId?: ObjectId;
      abilityIndex?: number;
      targetSlots?: TargetSlot[];
    }
  | {
      kind: 'attack';
      attackerId: ObjectId;
      defenderId?: PlayerId;
      appliesToRemaining?: boolean;
    }
  | {
      kind: 'block';
      blockerId: ObjectId;
      attackerId?: ObjectId;
      appliesToRemaining?: boolean;
    }
  | { kind: 'order'; subjectIds: ObjectId[] }
  | { kind: 'choice'; subjectId?: ObjectId; targetSlots?: TargetSlot[] };

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
  interaction?: ActionInteraction;
}

/**
 * Enough to draw a card without a lookup table — deliberately mirrors `SpectatorCard`. Carried
 * on `DecisionPresentation`, NOT on `LegalAction`: `legalActions` is serialized verbatim into
 * every AI prompt (`server/src/ai/context.ts`), so per-option `scryfallId`/`typeLine`/`zone`
 * would charge every AI decision, forever, for data only the browser needs.
 */
export interface PresentedCard {
  objectId: ObjectId;
  name: string;
  scryfallId: string | null;
  typeLine: string;
  zone: Zone;
  controller?: PlayerId;
}

/** The card or permanent a whole decision is about — e.g. the source of an activated ability. */
export interface PresentedSource {
  cardId: string;
  name: string;
  scryfallId: string | null;
}

/** What one `LegalAction` refers to, for rendering — never consulted for legality. */
export type ActionSubject =
  | { kind: 'card'; card: PresentedCard }
  | { kind: 'player'; playerId: PlayerId; label: string }
  | { kind: 'value'; label: string; value: number };

/** Player-facing presentation for one option, keyed by `LegalAction.id` on `DecisionPresentation`. */
export interface ActionPresentation {
  /** Short verb phrase for the button: "Discard", "Keep on top", "Proliferate". */
  verb: string;
  /** Usually 0 or 1 entries; more for "return A and B" style options. */
  subjects: ActionSubject[];
  /** Layout/emphasis hint — e.g. `'decline'` renders muted rather than primary. */
  role?: 'affirm' | 'decline' | 'select' | 'order' | 'immediate';
}

/**
 * One creature the current declare-attackers/blockers step will still ask about after the
 * current decision. A HINT for client-side batching (brief — Workstream 5): every assignment
 * is still submitted one engine decision at a time and re-validated: nothing here is consulted
 * for legality. `optionIds` (not just ids) matters for blockers — the legal attacker set
 * differs per blocker (evasion, protection), so a bare id list would let the browser compose an
 * assignment the engine will never offer.
 */
export interface CombatSubject {
  subjectId: ObjectId;
  /** Attackers: the defending players it may attack. Blockers: the attackers it may block. */
  optionIds: string[];
}

/** Batch context for one declare-attackers/blockers step (CR 508.1 / 509.1). */
export interface CombatDeclaration {
  kind: 'attackers' | 'blockers';
  /** The creature THIS decision is about. */
  subjectId: ObjectId;
  /** Subjects this step will still ask about after this one, in engine order. */
  remaining: CombatSubject[];
}

/**
 * Descriptive-only UI payload for a whole decision. Deliberately its own top-level field on
 * `DecisionRequest`, not folded into `LegalAction`, for the same AI-prompt-cost reason as
 * `PresentedCard` above.
 */
export interface DecisionPresentation {
  layout: 'choices' | 'cards' | 'order' | 'value' | 'combat';
  /** The card/permanent the whole decision concerns, e.g. what triggered it. */
  source?: PresentedSource;
  /** Per-option presentation, keyed by `LegalAction.id`. */
  actions?: Record<number, ActionPresentation>;
  /** Present only when `layout === 'combat'`. */
  combat?: CombatDeclaration;
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
  /** UI-only; see `DecisionPresentation`. Never sent to the AI (brief — Workstream 3). */
  presentation?: DecisionPresentation;
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
  /** Turn window where this action is intended; prevents stale cross-phase execution. */
  phase?: Phase;
  step?: Step | null;
}

/** Non-authoritative, hidden-information-safe plan produced once for an active turn. */
export interface TurnStrategy {
  intent: string;
  threatOrder?: PlayerId[];
  manaPlan?: string;
  plannedActions: PlannedAction[];
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
  /** Strategist-only structured plan. Tactical decisions do not use this field. */
  turnStrategy?: TurnStrategy;
  /** One-sentence rationale; stored in the debug log only. */
  note?: string;
}

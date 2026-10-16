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
 * Sentinel `TargetChoice.choice` value meaning "this creature does not attack" — one of a slot's
 * legal `options` in an `attackDeclaration` `LegalAction`, exactly like any other target choice
 * (ADR 0023 items 13/14). Never a real `ObjectId`/`PlayerId`, so it can't collide with one; absent
 * from a slot entirely when the creature has a mandatory requirement (CR 508.1d — see `mustAttack`
 * below), which is what makes "does not attack" illegal for that creature without a separate check.
 */
export const NO_ATTACK_TARGET = '__no_attack__';

/**
 * Sentinel `TargetChoice.choice` value meaning "this creature does not block" — the blocker-side
 * mirror of `NO_ATTACK_TARGET` (ADR 0023 Phase 4). Absent from a slot entirely when the creature
 * is under a "must block" requirement, for the same reason `NO_ATTACK_TARGET` is.
 */
export const NO_BLOCK_TARGET = '__no_block__';

/**
 * One eligible attacker in a batched attack declaration, and the legal defenders for IT ALONE
 * (restrictions/costs, CR 508.1c — item 15). `mustAttack` is whether a requirement (goad) makes
 * declining illegal (CR 508.1d — item 19); when true, `NO_ATTACK_TARGET` is not among that
 * creature's slot options, so a compliant proposal can't decline it. What is NOT checked per-slot
 * is the *joint* cost across every creature attacking the same taxed defender at once (attack tax
 * scales with attacker count) — that can only be validated once the whole declaration is known,
 * which is exactly why this is a propose-and-validate decision (item 14) rather than a menu.
 */
export interface AttackDeclarationSubject {
  subjectId: ObjectId;
  name: string;
  power: number;
  toughness: number;
  /** Legal defenders for this creature alone. `attackTax` is what THIS creature pays to attack
   * that defender (it can differ by creature, e.g. by its counters); the total for a defender
   * receiving several attackers is the sum over them, checked jointly on submission. */
  defenders: Array<{ playerId: PlayerId; life: number; attackTax: number }>;
  /**
   * Legal planeswalkers for this creature alone (CR 508.1b): planeswalkers its opponents control,
   * each offered as a slot option by its `objectId` alongside the `defenders` player ids.
   * `attackTax` is the tax for attacking this planeswalker specifically.
   */
  planeswalkers: Array<{
    objectId: ObjectId;
    controllerId: PlayerId;
    name: string;
    loyalty: number;
    attackTax: number;
  }>;
  mustAttack: boolean;
  /** A creature that puts something on the stack when it attacks is worth attacking with at
   * any power — counts *every* trigger on the creature, not only attack triggers, so it
   * over-reports (a hint, never a rule). Mirrors the old per-creature `EngineActionOption.data`. */
  hasTriggers: boolean;
}

/**
 * One eligible blocker in a batched block declaration, and the legal attackers for IT ALONE
 * (evasion/protection, CR 509.1b) — the blocker-side mirror of `AttackDeclarationSubject`
 * (ADR 0023 Phase 4). `mustBlock` is whether a "must block" requirement makes declining illegal
 * for this creature; when true, `NO_BLOCK_TARGET` is not among its slot options. Unlike attacking,
 * blocking has no joint per-defender cost to validate after the fact — the one thing that can't
 * be checked per-slot is menace (CR 702.111b: an attacker with menace can't be blocked by fewer
 * than two creatures), which is a property of how many blockers land on the SAME attacker, so it
 * is validated the same way attack tax is (`CombatViolation`'s `'menace'` kind).
 */
export interface BlockDeclarationSubject {
  subjectId: ObjectId;
  name: string;
  power: number;
  toughness: number;
  /** Legal attackers for this creature alone. */
  attackers: Array<{ attackerId: ObjectId; name: string; power: number; toughness: number }>;
  mustBlock: boolean;
}

/** Why a proposed declaration was rejected — a constraint packet, not a claimed legal set (item 16):
 * the full legal option space for a batched declaration is combinatorial and the engine never
 * claims to enumerate it, only to say what was wrong with what was tried. */
export interface CombatViolation {
  subjectId: ObjectId;
  kind: 'attackTax' | 'menace' | 'attackAlone' | 'blockAlone' | 'minBlockers' | 'attackWithAll';
  message: string;
}
export interface CombatRejection {
  violations: CombatViolation[];
}

/**
 * Presentation for the one-shot batched attack declaration (ADR 0023 items 13-17). Wire
 * submission still rides the existing `LegalAction.targets`/`TargetChoice[]` machinery — one slot
 * per `subjects[i]`, in the same order — this is the descriptive layer a UI renders from instead
 * of reverse-engineering raw target-slot ids.
 */
export interface AttackDeclarationPresentation {
  subjects: AttackDeclarationSubject[];
  /** Present only on the one informed retry (item 17), after a first proposal was rejected. */
  rejection?: CombatRejection;
}

/** Presentation for the one-shot batched block declaration (ADR 0023 Phase 4) — the blocker-side
 * mirror of `AttackDeclarationPresentation`. */
export interface BlockDeclarationPresentation {
  subjects: BlockDeclarationSubject[];
  /** Present only on the one informed retry, after a first proposal was rejected (menace). */
  rejection?: CombatRejection;
}

/**
 * Descriptive-only UI payload for a whole decision. Deliberately its own top-level field on
 * `DecisionRequest`, not folded into `LegalAction`, for the same AI-prompt-cost reason as
 * `PresentedCard` above.
 */
export interface DecisionPresentation {
  layout: 'choices' | 'cards' | 'order' | 'value' | 'attackDeclaration' | 'blockDeclaration';
  /** The card/permanent the whole decision concerns, e.g. what triggered it. */
  source?: PresentedSource;
  /** Per-option presentation, keyed by `LegalAction.id`. */
  actions?: Record<number, ActionPresentation>;
  /** Present only when `layout === 'attackDeclaration'` (ADR 0023 items 13/14). */
  attackDeclaration?: AttackDeclarationPresentation;
  /** Present only when `layout === 'blockDeclaration'` (ADR 0023 Phase 4). */
  blockDeclaration?: BlockDeclarationPresentation;
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
  /** One-call distribution request, currently used by Klauth's mana trigger. */
  manaSplit?: { amount: number; colors: string[] };
  /** One-call combat-damage-division request (CR 510.1c-d, 702.19b — ADR 0023 Phase 4): a source
   * blocked/blocking by 2+ creatures divides its damage among `targets` however its controller
   * chooses, rather than picking an order (the pre-2018 mechanic; see the ADR's Context section).
   * `targets` is blocker ids, plus the defending player's id appended last when the source has
   * trample — CR 702.19b only allows assigning to the player once every blocker already has
   * lethal, which `DecisionResponse.combatDamageSplit` is validated against. */
  combatDamageSplit?: { amount: number; targets: ObjectId[] };
  /** UI-only; see `DecisionPresentation`. Never sent to the AI (brief — Workstream 3). */
  presentation?: DecisionPresentation;
}

/** A chosen target for one slot. */
export interface TargetChoice {
  slot: number;
  choice: ObjectId;
}

/** A planned future action returned by an active player's AI decision during turn planning. */
export interface PlannedSourceReference {
  /** Stable object identity when the object already exists in the source observation. */
  objectId?: ObjectId;
  /** Stable physical-card identity when exposed by a legal-action interaction. */
  cardId?: ObjectId;
  /** Human-readable fallback only; never preferred over an identity above. */
  name?: string;
}

export type PlanPrecondition =
  | { kind: 'phaseReached'; phase: Phase; step?: Step | null }
  | { kind: 'actionCompleted'; actionId: string }
  | { kind: 'sourceAvailable'; source: PlannedSourceReference }
  | { kind: 'targetAvailable'; objectId: ObjectId }
  | { kind: 'legalActionAvailable'; actionType: string; source?: PlannedSourceReference };

export interface PlannedAction {
  /** Stable within one plan artifact. Generated by the coordinator when omitted by the model. */
  id?: string;
  type: string;
  name?: string;
  description?: string;
  targets?: TargetChoice[];
  source?: PlannedSourceReference;
  preconditions?: PlanPrecondition[];
  dependencies?: string[];
  expectedEffect?: string;
  objective?: string;
  alternative?: string;
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
  /** Counts by color for a batched mana distribution decision. */
  manaSplit?: Record<string, number>;
  /** Amounts by target id for a batched combat-damage-division decision (`combatDamageSplit`
   * on `DecisionRequest` — ADR 0023 Phase 4). Sum must equal the request's `amount` exactly. */
  combatDamageSplit?: Record<ObjectId, number>;
  /** An ordering the decision asked for (e.g. trigger order). */
  order?: number[];
  /** Optional sequence of planned future actions for turn pre-planning. */
  plannedActions?: PlannedAction[];
  /** Strategist-only structured plan. Tactical decisions do not use this field. */
  turnStrategy?: TurnStrategy;
  /** One-sentence rationale; stored in the debug log only. */
  note?: string;
}

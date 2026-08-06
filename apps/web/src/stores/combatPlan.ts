/**
 * Batched attacker/blocker declaration (brief — player-experience overhaul, Workstream 5).
 *
 * Attackers and blockers are BOTH real batched decisions on the engine side now (ADR 0023 items
 * 13/14, landed for attackers in Phase 3b and for blockers in Phase 4): the player composes the
 * whole assignment here exactly as before, but `confirm()` submits it in ONE call
 * (`pendingSubmission`) instead of replaying it one already-validated engine decision at a time —
 * there is no per-creature decision to replay for either side any more. If the engine rejects the
 * proposal (a combined attack tax several creatures share not fitting the attacking player's mana
 * for attackers, item 16; a menace attacker ending up with only one blocker for blockers), it
 * re-asks once; `onRequest` detects that retry (`rejection` present on the matching presentation
 * field) and drops the store straight back into `composing`, seeded with whatever of the prior
 * assignment is still legal, with `rejectionMessage` explaining what to fix. A second failure is
 * repaired by the engine itself (item 17) without asking again — the store just sees combat move
 * on to whatever's next.
 *
 * Because both sides are now one-shot proposals, there is nothing left here that can go stale
 * mid-declaration (the old blocker path's `interrupted` mode existed only for its sequential
 * per-creature replay, where an earlier submit in the same step could change what a later one
 * could legally do) — composing is always against a live, complete menu, and confirming always
 * submits the whole thing in a single call the engine either accepts, rejects-and-reasks, or
 * repairs. A non-combat decision interleaved mid-declaration (a triggered ability's own choice, a
 * cost) is simply not this store's concern: `onRequest` no-ops whenever neither declaration shape
 * is present, so `PlayerGameView`'s ordinary decision flow handles it — and resets the store if a
 * plan had been left active, since the combat step it belonged to is over.
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { CombatRejection, DecisionRequest, ObjectId, TargetChoice } from '@mtg/shared';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';

export type CombatPlanMode = 'idle' | 'composing' | 'replaying';
export type CombatPlanKind = 'attackers' | 'blockers';

export interface CombatPlanEntry {
  subjectId: ObjectId;
  /** Attackers: legal defending players. Blockers: legal attackers. A hint, never authoritative
   * — the engine's own per-slot `targets` on the submitted `LegalAction` is what's actually
   * validated; this only drives what the composing UI offers to click. */
  optionIds: string[];
  /** True when this creature has no legal "decline" choice at all (CR 508.1d for attackers; a
   * "must block" requirement for blockers) — ADR 0023 item 19. `optionIds` never includes a
   * synthetic decline value either way; this is what the composing UI checks before offering a
   * "stay home"/"no block" control for that creature. */
  mustAct: boolean;
}

/** What `confirm()` hands back to submit for the batched declaration. */
export interface CombatSubmission {
  actionId: number;
  targets: TargetChoice[];
}

export const useCombatPlanStore = defineStore('combatPlan', () => {
  const mode = ref<CombatPlanMode>('idle');
  const kind = ref<CombatPlanKind | null>(null);
  const order = ref<CombatPlanEntry[]>([]);
  /** subjectId -> chosen defender/attacker id; absent entry means "decline" for that subject. */
  const assignment = ref<Map<ObjectId, string>>(new Map());
  /** Why the last proposal was rejected, shown alongside the still-editable tray. */
  const rejectionMessage = ref<string | null>(null);
  let lastRequestId: string | null = null;

  const isActive = computed(() => mode.value === 'composing' || mode.value === 'replaying');

  function reset(): void {
    mode.value = 'idle';
    kind.value = null;
    order.value = [];
    assignment.value = new Map();
    rejectionMessage.value = null;
    lastRequestId = null;
  }

  /** Preserve whatever of a prior assignment is still a legal choice for the new subject list —
   * used only when re-entering `composing` after a rejected proposal, so the player only has to
   * fix what was flagged rather than redo the whole board. */
  function carryOverAssignment(nextOrder: CombatPlanEntry[]): Map<ObjectId, string> {
    const prior = assignment.value;
    const next = new Map<ObjectId, string>();
    for (const entry of nextOrder) {
      const chosen = prior.get(entry.subjectId);
      if (chosen !== undefined && entry.optionIds.includes(chosen))
        next.set(entry.subjectId, chosen);
    }
    return next;
  }

  /** Shared by both declaration shapes below: start composing a fresh plan, or — if this is the
   * engine's one informed retry after a rejection — drop back into composing with whatever of
   * the prior assignment is still legal. */
  function startOrRetry(
    newKind: CombatPlanKind,
    nextOrder: CombatPlanEntry[],
    rejection: CombatRejection | undefined,
  ): void {
    const isRetry = rejection !== undefined && mode.value !== 'idle' && kind.value === newKind;
    kind.value = newKind;
    assignment.value = isRetry ? carryOverAssignment(nextOrder) : new Map();
    order.value = nextOrder;
    mode.value = 'composing';
    rejectionMessage.value =
      rejection !== undefined ? rejection.violations.map((v) => v.message).join(' ') : null;
  }

  /** Call once per freshly received `playerActionRequired`. Builds a plan; never submits. */
  function onRequest(request: DecisionRequest): void {
    if (lastRequestId === request.requestId) return;
    lastRequestId = request.requestId;

    const attackDeclaration = request.presentation?.attackDeclaration;
    if (attackDeclaration !== undefined) {
      startOrRetry(
        'attackers',
        attackDeclaration.subjects.map((s) => ({
          subjectId: s.subjectId,
          optionIds: s.defenders.map((d) => d.playerId),
          mustAct: s.mustAttack,
        })),
        attackDeclaration.rejection,
      );
      return;
    }

    const blockDeclaration = request.presentation?.blockDeclaration;
    if (blockDeclaration !== undefined) {
      startOrRetry(
        'blockers',
        blockDeclaration.subjects.map((s) => ({
          subjectId: s.subjectId,
          optionIds: s.attackers.map((a) => a.attackerId),
          mustAct: s.mustBlock,
        })),
        blockDeclaration.rejection,
      );
      return;
    }

    // Neither combat shape: this request isn't a combat decision. If a plan was still active,
    // the combat step it belonged to is over (the engine accepted the last submission) — don't
    // leave the tray parked on a stale mode for whatever comes next.
    if (mode.value !== 'idle') reset();
  }

  function assign(subjectId: ObjectId, targetId: string): void {
    if (mode.value !== 'composing') return;
    assignment.value = new Map(assignment.value).set(subjectId, targetId);
  }
  function clear(subjectId: ObjectId): void {
    if (mode.value !== 'composing') return;
    const next = new Map(assignment.value);
    next.delete(subjectId);
    assignment.value = next;
  }
  function isLegalTarget(subjectId: ObjectId, targetId: string): boolean {
    return (
      order.value.find((e) => e.subjectId === subjectId)?.optionIds.includes(targetId) ?? false
    );
  }

  /**
   * The one entry point PlayerGameView calls to submit a composed plan, for either kind. `null`
   * unless a confirmed (`mode === 'replaying'`) plan matches the request currently pending, so a
   * caller that invokes this before `confirm()`, or for a stale/mismatched request, gets nothing
   * to submit rather than a guess. A subject left unassigned submits as declining, UNLESS it's
   * `mustAct`, in which case declining isn't one of its legal slot options at all — it defaults
   * to its first legal option instead of producing a submission the engine would refuse outright.
   */
  function pendingSubmission(request: DecisionRequest): CombatSubmission | null {
    if (mode.value !== 'replaying') return null;

    if (kind.value === 'attackers') {
      const decl = request.presentation?.attackDeclaration;
      const action = request.legalActions.find((a) => a.type === 'attackDeclaration');
      if (decl === undefined || action === undefined) return null;
      const targets: TargetChoice[] = decl.subjects.map((subject, slot) => {
        const chosen = assignment.value.get(subject.subjectId);
        const fallback = subject.mustAttack
          ? (subject.defenders[0]?.playerId ?? NO_ATTACK_TARGET)
          : NO_ATTACK_TARGET;
        return { slot, choice: chosen ?? fallback };
      });
      return { actionId: action.id, targets };
    }

    if (kind.value === 'blockers') {
      const decl = request.presentation?.blockDeclaration;
      const action = request.legalActions.find((a) => a.type === 'blockDeclaration');
      if (decl === undefined || action === undefined) return null;
      const targets: TargetChoice[] = decl.subjects.map((subject, slot) => {
        const chosen = assignment.value.get(subject.subjectId);
        const fallback = subject.mustBlock
          ? (subject.attackers[0]?.attackerId ?? NO_BLOCK_TARGET)
          : NO_BLOCK_TARGET;
        return { slot, choice: chosen ?? fallback };
      });
      return { actionId: action.id, targets };
    }

    return null;
  }

  /** Player pressed Confirm on the composed board — the caller submits `pendingSubmission` next. */
  function confirm(): void {
    if (mode.value === 'composing') mode.value = 'replaying';
  }

  function cancel(): void {
    reset();
  }

  return {
    mode,
    kind,
    order,
    assignment,
    rejectionMessage,
    isActive,
    onRequest,
    assign,
    clear,
    isLegalTarget,
    pendingSubmission,
    confirm,
    cancel,
    reset,
  };
});

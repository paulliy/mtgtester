/**
 * Batched attacker/blocker declaration (brief — player-experience overhaul, Workstream 5).
 *
 * The engine still asks one decision per creature (`combat.ts`'s `declareAttackers`/
 * `declareBlockers`) — that never changes, and this store never batch-submits. It reacts to
 * each freshly pushed `playerActionRequired`, because `requestId`/`revision` change per
 * decision and `game.submitPlayerAction` reads whatever was just installed. What changes is
 * *when* the player is asked to confirm: they assign the whole board first (`composing`,
 * nothing submitted), then `confirm()` starts a replay that answers each subsequent engine
 * decision from that assignment — one call per subject, compressed to one submit when the
 * `*Rest` shortcuts apply.
 *
 * It never guesses. `answerCurrent` matches by `interaction` fields alone, never by index or
 * description. If the expected option is missing — an attack cost, a "can't attack alone"
 * restriction, anything this store does not model — it aborts to `interrupted` and hands the
 * decision back to the normal single-decision UI. The store models no restriction, so it
 * cannot be wrong about one; it can only fail to find its option and stop.
 *
 * A non-combat decision interleaved mid-declaration (a triggered ability's own choice, a cost)
 * is simply not this store's concern: `onRequest`/`answerCurrent` both no-op when
 * `request.presentation?.combat` is absent, so `PlayerGameView`'s ordinary decision flow
 * handles it, and the next `declareAttackers`/`declareBlockers` request for a subject still in
 * `order` resumes the plan.
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { ActionInteraction, DecisionRequest, LegalAction, ObjectId } from '@mtg/shared';

export type CombatPlanMode = 'idle' | 'composing' | 'replaying' | 'interrupted';

export interface CombatPlanEntry {
  subjectId: ObjectId;
  /** Attackers: legal defending players. Blockers: legal attackers. A hint, never authoritative. */
  optionIds: string[];
}

function attackInteraction(action: LegalAction): Extract<ActionInteraction, { kind: 'attack' }> | null {
  return action.interaction?.kind === 'attack' ? action.interaction : null;
}
function blockInteraction(action: LegalAction): Extract<ActionInteraction, { kind: 'block' }> | null {
  return action.interaction?.kind === 'block' ? action.interaction : null;
}

export const useCombatPlanStore = defineStore('combatPlan', () => {
  const mode = ref<CombatPlanMode>('idle');
  const kind = ref<'attackers' | 'blockers' | null>(null);
  const order = ref<CombatPlanEntry[]>([]);
  /** subjectId -> chosen defender/attacker id; absent entry means "decline" for that subject. */
  const assignment = ref<Map<ObjectId, string>>(new Map());
  const answered = ref<Set<ObjectId>>(new Set());
  const interruptedMessage = ref<string | null>(null);
  let lastRequestId: string | null = null;

  const currentEntry = computed<CombatPlanEntry | null>(
    () => order.value.find((entry) => !answered.value.has(entry.subjectId)) ?? null,
  );
  const isActive = computed(() => mode.value === 'composing' || mode.value === 'replaying');

  function reset(): void {
    mode.value = 'idle';
    kind.value = null;
    order.value = [];
    assignment.value = new Map();
    answered.value = new Set();
    interruptedMessage.value = null;
    lastRequestId = null;
  }

  function optionIdsFor(request: DecisionRequest, subjectId: ObjectId, declKind: 'attackers' | 'blockers'): string[] {
    const ids = new Set<string>();
    for (const action of request.legalActions) {
      if (declKind === 'attackers') {
        const interaction = attackInteraction(action);
        if (interaction?.attackerId === subjectId && interaction.defenderId !== undefined) {
          ids.add(interaction.defenderId);
        }
      } else {
        const interaction = blockInteraction(action);
        if (interaction?.blockerId === subjectId && interaction.attackerId !== undefined) {
          ids.add(interaction.attackerId);
        }
      }
    }
    return [...ids];
  }

  /** Call once per freshly received `playerActionRequired`. Builds a plan; never submits. */
  function onRequest(request: DecisionRequest): void {
    if (lastRequestId === request.requestId) return;
    lastRequestId = request.requestId;

    const combat = request.presentation?.combat;
    if (combat === undefined) return; // not a combat decision — not this store's concern

    if (mode.value === 'idle' || kind.value !== combat.kind) {
      kind.value = combat.kind;
      order.value = [
        { subjectId: combat.subjectId, optionIds: optionIdsFor(request, combat.subjectId, combat.kind) },
        ...combat.remaining,
      ];
      assignment.value = new Map();
      answered.value = new Set();
      mode.value = 'composing';
      interruptedMessage.value = null;
    }
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
    return order.value.find((e) => e.subjectId === subjectId)?.optionIds.includes(targetId) ?? false;
  }

  function unansweredEntries(): CombatPlanEntry[] {
    return order.value.filter((e) => !answered.value.has(e.subjectId));
  }
  function markAnswered(...ids: ObjectId[]): void {
    const next = new Set(answered.value);
    for (const id of ids) next.add(id);
    answered.value = next;
  }

  /**
   * The one entry point PlayerGameView calls for every `declareAttackers`/`declareBlockers`
   * request while a plan is active. Returns the `LegalAction.id` to submit, or `null` if this
   * request isn't part of the plan (caller falls back to the normal single-decision UI).
   */
  function answerCurrent(request: DecisionRequest): number | null {
    // Composing means "not yet confirmed" — nothing may be submitted regardless of what's
    // asked, even if the caller mistakenly invokes this before `confirm()`.
    if (mode.value !== 'replaying') return null;
    const combat = request.presentation?.combat;
    if (combat === undefined) return null;
    if (currentEntry.value === null || combat.subjectId !== currentEntry.value.subjectId) return null;

    const subject = combat.subjectId;
    const rest = unansweredEntries();
    const declKind = combat.kind;

    // Tail compression #1: nothing left is assigned to anything → the engine's "no further
    // attacks/blocks" shortcut answers the whole remaining plan in one submit.
    if (rest.every((e) => !assignment.value.has(e.subjectId))) {
      const restOption = request.legalActions.find((action) => {
        if (declKind === 'attackers') {
          const i = attackInteraction(action);
          return i?.attackerId === subject && i.appliesToRemaining === true && i.defenderId === undefined;
        }
        const i = blockInteraction(action);
        return i?.blockerId === subject && i.appliesToRemaining === true;
      });
      if (restOption !== undefined) {
        markAnswered(...rest.map((e) => e.subjectId));
        return restOption.id;
      }
    }

    // Tail compression #2 (attackers only): everything left is assigned to the SAME defender →
    // the "all undeclared attack X" shortcut.
    if (declKind === 'attackers') {
      const desired = assignment.value.get(subject);
      if (desired !== undefined && rest.every((e) => assignment.value.get(e.subjectId) === desired)) {
        const restOption = request.legalActions.find((action) => {
          const i = attackInteraction(action);
          return i?.attackerId === subject && i.appliesToRemaining === true && i.defenderId === desired;
        });
        if (restOption !== undefined) {
          markAnswered(...rest.map((e) => e.subjectId));
          return restOption.id;
        }
      }
    }

    // The exact single-subject option — matched by interaction fields only, never by index.
    const desired = assignment.value.get(subject);
    const exact = request.legalActions.find((action) => {
      if (declKind === 'attackers') {
        const i = attackInteraction(action);
        if (i === null || i.attackerId !== subject || i.appliesToRemaining === true) return false;
        return desired === undefined ? i.defenderId === undefined : i.defenderId === desired;
      }
      const i = blockInteraction(action);
      if (i === null || i.blockerId !== subject || i.appliesToRemaining === true) return false;
      return desired === undefined ? i.attackerId === undefined : i.attackerId === desired;
    });

    if (exact === undefined) {
      mode.value = 'interrupted';
      interruptedMessage.value =
        'The board changed and that assignment is no longer available — choose again.';
      return null;
    }
    markAnswered(subject);
    return exact.id;
  }

  /** Player pressed Confirm on the composed board — start answering the live decision. */
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
    answered,
    interruptedMessage,
    currentEntry,
    isActive,
    onRequest,
    assign,
    clear,
    isLegalTarget,
    answerCurrent,
    confirm,
    cancel,
    reset,
  };
});

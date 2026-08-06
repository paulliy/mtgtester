/**
 * `combatPlan` composition and submission (brief — player-experience overhaul, Workstream 5).
 * Pure TS, no DOM — mirrors `game.test.ts`'s conventions.
 *
 * Both attackers and blockers are batched now (ADR 0023 items 13/14, landed for attackers in
 * Phase 3b and for blockers in Phase 4): requests are built to match exactly what `combat.ts`'s
 * `declareAttackers`/`declareBlockers` actually generate — one `attackDeclaration`/
 * `blockDeclaration` `LegalAction` with a target slot per eligible creature, and
 * `presentation.attackDeclaration`/`presentation.blockDeclaration` describing each one.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { DecisionRequest, LegalAction } from '@mtg/shared';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import { useCombatPlanStore } from './combatPlan';

const OPPONENTS = ['P2', 'P3'];

/** One batched `declareAttackers` request for `subjectIds`, each with `OPPONENTS` as legal
 * defenders unless `mustAttack` names it. */
function attackRequest(
  subjectIds: string[],
  opts: { requestId?: string; rejection?: { subjectId: string; message: string }[] } = {},
): DecisionRequest {
  const legalActions: LegalAction[] = [
    {
      id: 0,
      type: 'attackDeclaration',
      description: `Declare attackers (${subjectIds.length} eligible creature(s))`,
      data: { subjectIds },
      targets: subjectIds.map((_, i) => ({ slot: i, options: [...OPPONENTS, NO_ATTACK_TARGET] })),
    },
  ];
  return {
    requestId: opts.requestId ?? `req-${subjectIds.join('-')}`,
    gameId: 'g1',
    turn: 3,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'combat',
    step: 'declareAttackers',
    decisionType: 'declareAttackers',
    prompt: 'Declare attackers',
    legalActions,
    presentation: {
      layout: 'attackDeclaration',
      attackDeclaration: {
        subjects: subjectIds.map((id) => ({
          subjectId: id,
          name: id,
          power: 2,
          toughness: 2,
          defenders: OPPONENTS.map((p) => ({ playerId: p, life: 40, attackTax: 0 })),
          mustAttack: false,
          hasTriggers: false,
        })),
        ...(opts.rejection !== undefined
          ? {
              rejection: {
                violations: opts.rejection.map((v) => ({ ...v, kind: 'attackTax' as const })),
              },
            }
          : {}),
      },
    },
  };
}

const ATTACKERS = ['A1', 'A2'];

/** One batched `declareBlockers` request for `subjectIds`, each with `ATTACKERS` as legal
 * attackers unless `mustBlock` names it. */
function blockRequest(
  subjectIds: string[],
  opts: { requestId?: string; rejection?: { subjectId: string; message: string }[] } = {},
): DecisionRequest {
  const legalActions: LegalAction[] = [
    {
      id: 0,
      type: 'blockDeclaration',
      description: `Declare blockers (${subjectIds.length} eligible creature(s))`,
      data: { subjectIds },
      targets: subjectIds.map((_, i) => ({ slot: i, options: [...ATTACKERS, NO_BLOCK_TARGET] })),
    },
  ];
  return {
    requestId: opts.requestId ?? `req-${subjectIds.join('-')}`,
    gameId: 'g1',
    turn: 3,
    activePlayer: 'P1',
    decidingPlayer: 'P2',
    phase: 'combat',
    step: 'declareBlockers',
    decisionType: 'declareBlockers',
    prompt: 'Declare blockers',
    legalActions,
    presentation: {
      layout: 'blockDeclaration',
      blockDeclaration: {
        subjects: subjectIds.map((id) => ({
          subjectId: id,
          name: id,
          power: 2,
          toughness: 2,
          attackers: ATTACKERS.map((a) => ({ attackerId: a, name: a, power: 3, toughness: 3 })),
          mustBlock: false,
        })),
        ...(opts.rejection !== undefined
          ? {
              rejection: {
                violations: opts.rejection.map((v) => ({ ...v, kind: 'menace' as const })),
              },
            }
          : {}),
      },
    },
  };
}

describe('combatPlan — attackers', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('composes without submitting, then submits the whole declaration in one call on confirm', () => {
    const store = useCombatPlanStore();
    const req = attackRequest(['A', 'B', 'C']);
    store.onRequest(req);
    expect(store.mode).toBe('composing');
    expect(store.kind).toBe('attackers');
    expect(store.pendingSubmission(req)).toBeNull(); // not confirmed yet

    store.assign('A', 'P2');
    store.assign('B', 'P3');
    // 'C' left unassigned — declines.
    store.confirm();
    expect(store.mode).toBe('replaying');

    const submission = store.pendingSubmission(req);
    expect(submission?.actionId).toBe(0);
    expect(submission?.targets).toEqual([
      { slot: 0, choice: 'P2' },
      { slot: 1, choice: 'P3' },
      { slot: 2, choice: NO_ATTACK_TARGET },
    ]);
  });

  it('leaving everything unassigned submits an all-decline declaration', () => {
    const store = useCombatPlanStore();
    const req = attackRequest(['A', 'B']);
    store.onRequest(req);
    store.confirm();

    expect(store.pendingSubmission(req)?.targets).toEqual([
      { slot: 0, choice: NO_ATTACK_TARGET },
      { slot: 1, choice: NO_ATTACK_TARGET },
    ]);
  });

  it('a mustAct subject left unassigned defaults to its first legal defender, never a decline', () => {
    const store = useCombatPlanStore();
    const req = attackRequest(['A']);
    // Hand-craft a mustAttack subject (no NO_ATTACK_TARGET among its slot options).
    req.presentation!.attackDeclaration!.subjects[0]!.mustAttack = true;
    req.legalActions[0]!.targets![0]!.options = ['P2', 'P3'];
    store.onRequest(req);
    expect(store.order[0]?.mustAct).toBe(true);
    store.confirm();

    expect(store.pendingSubmission(req)?.targets).toEqual([{ slot: 0, choice: 'P2' }]);
  });

  it('never submits while composing, even if pendingSubmission is called', () => {
    const store = useCombatPlanStore();
    const req = attackRequest(['A']);
    store.onRequest(req);
    expect(store.pendingSubmission(req)).toBeNull();
    store.assign('A', 'P2');
    expect(store.pendingSubmission(req)).toBeNull();
    expect(store.mode).toBe('composing');
  });

  it('a rejected retry drops back into composing, seeded from the prior assignment, with rejectionMessage set', () => {
    const store = useCombatPlanStore();
    const req = attackRequest(['A', 'B']);
    store.onRequest(req);
    store.assign('A', 'P2');
    store.assign('B', 'P2');
    store.confirm();
    expect(store.pendingSubmission(req)).not.toBeNull();

    // Engine rejects: the combined attack tax for A+B on P2 isn't payable. New requestId, same
    // subjects, `rejection` populated.
    const retry = attackRequest(['A', 'B'], {
      requestId: 'req-retry',
      rejection: [
        { subjectId: 'A', message: "Not enough mana to pay P2's combined attack tax." },
        { subjectId: 'B', message: "Not enough mana to pay P2's combined attack tax." },
      ],
    });
    store.onRequest(retry);

    expect(store.mode).toBe('composing');
    expect(store.rejectionMessage).toContain('combined attack tax');
    // The prior assignment survived the retry — the player only needs to fix what was flagged.
    expect(store.assignment.get('A')).toBe('P2');
    expect(store.assignment.get('B')).toBe('P2');
  });

  it('a fresh (non-retry) attackDeclaration request resets any prior assignment', () => {
    const store = useCombatPlanStore();
    const req = attackRequest(['A']);
    store.onRequest(req);
    store.assign('A', 'P2');
    store.confirm();

    // Next combat's declareAttackers — a brand new request, no rejection.
    const next = attackRequest(['C'], { requestId: 'req-next' });
    store.onRequest(next);

    expect(store.mode).toBe('composing');
    expect(store.rejectionMessage).toBeNull();
    expect(store.assignment.size).toBe(0);
  });

  it('a non-combat request after a confirmed attacker plan resets the store instead of staying stuck', () => {
    const store = useCombatPlanStore();
    const req = attackRequest(['A']);
    store.onRequest(req);
    store.confirm();
    expect(store.mode).toBe('replaying');

    const nonCombat: DecisionRequest = {
      requestId: 'req-priority',
      gameId: 'g1',
      turn: 3,
      activePlayer: 'P1',
      decidingPlayer: 'P1',
      phase: 'combat',
      step: 'declareBlockers',
      decisionType: 'priority',
      prompt: 'You have priority.',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass' }],
    };
    store.onRequest(nonCombat);

    expect(store.mode).toBe('idle');
    expect(store.kind).toBeNull();
  });
});

describe('combatPlan — blockers (batched, ADR 0023 Phase 4)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('composes without submitting, then submits the whole declaration in one call on confirm', () => {
    const store = useCombatPlanStore();
    const req = blockRequest(['X', 'Y', 'Z']);
    store.onRequest(req);
    expect(store.mode).toBe('composing');
    expect(store.kind).toBe('blockers');
    expect(store.pendingSubmission(req)).toBeNull();

    store.assign('X', 'A1');
    store.assign('Y', 'A2');
    // 'Z' left unassigned — does not block.
    store.confirm();
    expect(store.mode).toBe('replaying');

    const submission = store.pendingSubmission(req);
    expect(submission?.actionId).toBe(0);
    expect(submission?.targets).toEqual([
      { slot: 0, choice: 'A1' },
      { slot: 1, choice: 'A2' },
      { slot: 2, choice: NO_BLOCK_TARGET },
    ]);
  });

  it('leaving everything unassigned submits an all-decline declaration', () => {
    const store = useCombatPlanStore();
    const req = blockRequest(['X', 'Y']);
    store.onRequest(req);
    store.confirm();

    expect(store.pendingSubmission(req)?.targets).toEqual([
      { slot: 0, choice: NO_BLOCK_TARGET },
      { slot: 1, choice: NO_BLOCK_TARGET },
    ]);
  });

  it('a mustAct subject left unassigned defaults to its first legal attacker, never a decline', () => {
    const store = useCombatPlanStore();
    const req = blockRequest(['X']);
    req.presentation!.blockDeclaration!.subjects[0]!.mustBlock = true;
    req.legalActions[0]!.targets![0]!.options = ['A1', 'A2'];
    store.onRequest(req);
    expect(store.order[0]?.mustAct).toBe(true);
    store.confirm();

    expect(store.pendingSubmission(req)?.targets).toEqual([{ slot: 0, choice: 'A1' }]);
  });

  it('a rejected retry (menace) drops back into composing, seeded from the prior assignment', () => {
    const store = useCombatPlanStore();
    const req = blockRequest(['X']);
    store.onRequest(req);
    store.assign('X', 'A1');
    store.confirm();
    expect(store.pendingSubmission(req)).not.toBeNull();

    const retry = blockRequest(['X'], {
      requestId: 'req-retry',
      rejection: [{ subjectId: 'X', message: 'A1 has menace and needs at least two blockers.' }],
    });
    store.onRequest(retry);

    expect(store.mode).toBe('composing');
    expect(store.rejectionMessage).toContain('menace');
    expect(store.assignment.get('X')).toBe('A1');
  });

  it('a non-combat request after a confirmed blocker plan resets the store instead of staying stuck', () => {
    const store = useCombatPlanStore();
    const req = blockRequest(['X']);
    store.onRequest(req);
    store.confirm();
    expect(store.mode).toBe('replaying');

    const nonCombat: DecisionRequest = {
      requestId: 'req-priority',
      gameId: 'g1',
      turn: 3,
      activePlayer: 'P1',
      decidingPlayer: 'P2',
      phase: 'combat',
      step: 'declareBlockers',
      decisionType: 'priority',
      prompt: 'You have priority.',
      legalActions: [{ id: 0, type: 'pass', description: 'Pass' }],
    };
    store.onRequest(nonCombat);

    expect(store.mode).toBe('idle');
    expect(store.kind).toBeNull();
  });
});
